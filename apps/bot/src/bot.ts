import { Telegraf } from 'telegraf';
import { ConversationState } from '@zend/shared';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { sessionMiddleware } from './middleware/session.js';
import {
  autoDeleteMiddleware,
  registerUserMessageTracking,
  startAutoDeleteCleanup,
} from './middleware/auto-delete.js';
import { getSession } from './session/store.js';
import type { ZendContext } from './session/types.js';
import { BOT_TOKEN } from './deps.js';
import { isGroupChat } from './lib/group.js';
import { logDrop, logInfo, logWarn } from './lib/logger.js';

export function createBot(): Telegraf<ZendContext> {
  // Default Telegraf handlerTimeout is 90s — keep high for rare slow PAJ/Solana paths.
  // Critical work must still answer callbacks immediately (see middleware below).
  const handlerTimeout = parseInt(process.env.BOT_HANDLER_TIMEOUT_MS || '180000', 10) || 180000;
  const bot = new Telegraf<ZendContext>(BOT_TOKEN, { handlerTimeout });

  // FIRST middleware: log every update before session/Redis/handlers.
  // Without this, "user not in logs" only means they never hit NLP/error lines — not that Telegram is silent.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString() || '?';
    const username = ctx.from?.username ? `@${ctx.from.username}` : '';
    const chatType = ctx.chat?.type || '?';
    let detail = String(ctx.updateType || '?');
    if (ctx.message && 'text' in ctx.message) {
      detail = `text="${String(ctx.message.text).slice(0, 100).replace(/\n/g, ' ')}"`;
    } else if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      detail = `cb=${String(ctx.callbackQuery.data).slice(0, 80)}`;
    } else if (ctx.message && 'voice' in ctx.message) {
      detail = 'voice';
    } else if (ctx.message && 'photo' in ctx.message) {
      detail = 'photo';
    }
    logInfo('Update', 'inbound', { userId, username, chat: chatType, detail });
    const started = Date.now();
    try {
      await next();
    } catch (err) {
      // Ensure middleware failures are never silent (bot.catch may not see these)
      logWarn('Update', 'middleware/handler threw', {
        userId,
        username,
        detail,
        err: String((err as any)?.message || err),
      });
      throw err;
    } finally {
      const ms = Date.now() - started;
      if (ms > 5000) {
        logWarn('Update', 'slow', { userId, ms, detail });
      }
    }
  });

  // Telegram requires answerCallbackQuery within ~seconds. Answer first so Confirm/Cancel
  // never show a spinning clock while we talk to PAJ/Solana/QVAC. Handlers may call
  // answerCbQuery again — make subsequent calls no-ops so they don't throw.
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && 'id' in ctx.callbackQuery) {
      const original = ctx.answerCbQuery.bind(ctx);
      let answered = false;
      ctx.answerCbQuery = (async (...args: Parameters<typeof ctx.answerCbQuery>) => {
        if (answered) return true as any;
        answered = true;
        try {
          return await original(...args);
        } catch (err: any) {
          const m = String(err?.message || err || '');
          if (!/query is too old|query ID is invalid|response timeout|already answered/i.test(m)) {
            console.warn('[Bot] answerCbQuery failed:', m);
          }
          return true as any;
        }
      }) as typeof ctx.answerCbQuery;

      try {
        await ctx.answerCbQuery();
      } catch {
        // already logged above
      }
    }
    return next();
  });

  bot.use(rateLimitMiddleware);
  bot.use(sessionMiddleware);
  bot.use(autoDeleteMiddleware((userId) =>
    userId ? getSession(userId).state : ConversationState.IDLE
  ));
  registerUserMessageTracking(bot, (userId) => getSession(userId).state);
  startAutoDeleteCleanup(bot);

  // Group chat: reply only when tagged or replied to (private chats always pass through)
  bot.use(async (ctx, next) => {
    const chatType = ctx.chat?.type;
    if (chatType === 'group' || chatType === 'supergroup') {
      const msg = ctx.message;
      if (!msg || !('text' in msg)) {
        logDrop('group non-text ignored', {
          userId: ctx.from?.id?.toString(),
          chat: ctx.chat?.id,
        });
        return;
      }

      const text = msg.text;
      const username = ctx.botInfo?.username;
      const isMentioned = username ? text.includes(`@${username}`) : false;
      const isReplyToBot = msg.reply_to_message?.from?.id === ctx.botInfo?.id;

      if (!isMentioned && !isReplyToBot) {
        logDrop('group message without @mention or reply-to-bot', {
          userId: ctx.from?.id?.toString(),
          chat: ctx.chat?.id,
          text: text.slice(0, 80),
        });
        return;
      }

      if (username && isMentioned) {
        msg.text = text.replace(new RegExp(`\\s?@${username}\\b`, 'g'), '').trim();
      }
    }
    await next();
  });

  // Strip reply keyboards in groups (keep inline keyboards)
  bot.use(async (ctx, next) => {
    if (isGroupChat(ctx)) {
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = async (text: any, extra?: any) => {
        if (extra && extra.reply_markup && 'keyboard' in extra.reply_markup) {
          const { reply_markup, ...cleaned } = extra;
          return originalReply(text, cleaned);
        }
        return originalReply(text, extra);
      };
    }
    await next();
  });

  return bot;
}

/** Singleton bot instance — handlers register on this during migration from index.ts */
export const bot = createBot();