import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { ConversationState } from '@zend/shared';
import type { ZendContext } from '../session/types.js';
import { evictStaleSessions } from '../session/store.js';

interface TrackedMessage {
  chatId: number | string;
  messageId: number;
  deleteAt: number;
}

const messageQueue: TrackedMessage[] = [];

/** Default 12 min. Override: MESSAGE_TTL_MINUTES */
export const MESSAGE_TTL_MS = parseInt(process.env.MESSAGE_TTL_MINUTES || '12', 10) * 60 * 1000;
/** PIN / OTP: default 2 min. Override: PIN_TTL_MINUTES */
export const PIN_TTL_MS = parseInt(process.env.PIN_TTL_MINUTES || '2', 10) * 60 * 1000;

const MAX_QUEUE_SIZE = 5000;
const CLEANUP_INTERVAL_MS = 30_000;

const SHORT_TTL_STATES = new Set<ConversationState>([
  ConversationState.AWAITING_PIN,
  ConversationState.AWAITING_PIN_VERIFY,
  ConversationState.ONBOARDING_AWAITING_PIN,
  ConversationState.AWAITING_OTP,
  ConversationState.ONBOARDING_AWAITING_OTP,
]);

export function usesShortTtl(state: ConversationState): boolean {
  return SHORT_TTL_STATES.has(state);
}

function isPrivateChat(ctx: { chat?: { type?: string } }): boolean {
  return ctx.chat?.type === 'private';
}

function trackMessage(chatId: number | string, messageId: number, shortTtl = false) {
  const deleteAt = Date.now() + (shortTtl ? PIN_TTL_MS : MESSAGE_TTL_MS);
  const existingIdx = messageQueue.findIndex(
    (m) => m.chatId === chatId && m.messageId === messageId
  );
  if (existingIdx >= 0) {
    messageQueue[existingIdx].deleteAt = deleteAt;
    return;
  }
  if (messageQueue.length >= MAX_QUEUE_SIZE) {
    messageQueue.shift();
  }
  messageQueue.push({ chatId, messageId, deleteAt });
}

function trackUserMessage(ctx: ZendContext, state: ConversationState) {
  if (!isPrivateChat(ctx) || !ctx.chat || !ctx.message?.message_id) return;
  trackMessage(ctx.chat.id, ctx.message.message_id, usesShortTtl(state));
}

/** Wrap ctx.reply / editMessageText to queue bot messages for deletion. */
export function autoDeleteMiddleware(
  resolveState: (userId: string | undefined) => ConversationState
) {
  return async (ctx: ZendContext, next: () => Promise<void>) => {
    const resolveShortTtl = () => {
      const state = resolveState(ctx.from?.id?.toString());
      return usesShortTtl(state);
    };

    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = async function (text: any, extra?: any) {
      const sensitive = extra?.__sensitive === true;
      if (sensitive && extra && typeof extra === 'object') {
        const { __sensitive, ...cleanExtra } = extra;
        extra = cleanExtra;
      }
      const msg = await originalReply(text, extra);
      if (isPrivateChat(ctx) && msg && typeof msg === 'object' && 'message_id' in msg && ctx.chat) {
        if (resolveShortTtl() || sensitive) {
          trackMessage(ctx.chat.id, msg.message_id, true);
        }
      }
      return msg;
    };

    const originalEdit = ctx.editMessageText.bind(ctx);
    ctx.editMessageText = async function (text: any, extra?: any) {
      const sensitive = extra?.__sensitive === true;
      if (sensitive && extra && typeof extra === 'object') {
        const { __sensitive, ...cleanExtra } = extra;
        extra = cleanExtra;
      }
      const result = await originalEdit(text, extra);
      if (isPrivateChat(ctx) && result && typeof result === 'object' && 'message_id' in result && ctx.chat) {
        if (resolveShortTtl() || sensitive) {
          trackMessage(ctx.chat.id, result.message_id, true);
        }
      }
      return result;
    };

    await next();
  };
}

/** Register handlers that track user text + voice in private chats. */
export function registerUserMessageTracking(
  bot: Telegraf<ZendContext>,
  getState: (userId: string) => ConversationState
) {
  const track = async (ctx: ZendContext, next: () => Promise<void>) => {
    const userId = ctx.from?.id?.toString();
    if (userId) {
      const state = getState(userId);
      if (usesShortTtl(state)) {
        trackUserMessage(ctx, state);
      }
    }
    await next();
  };
  bot.on(message('text'), track);
  bot.on(message('voice'), track);
}

/** Background cleanup of expired messages + stale sessions. */
export function startAutoDeleteCleanup(bot: Telegraf<ZendContext>) {
  setInterval(async () => {
    const now = Date.now();
    const toDelete: TrackedMessage[] = [];
    for (let i = messageQueue.length - 1; i >= 0; i--) {
      if (messageQueue[i].deleteAt <= now) {
        toDelete.push(messageQueue[i]);
        messageQueue.splice(i, 1);
      }
    }
    for (const m of toDelete) {
      try {
        await bot.telegram.deleteMessage(m.chatId, m.messageId);
      } catch {
        // already deleted or too old
      }
    }
    evictStaleSessions();
  }, CLEANUP_INTERVAL_MS);
}