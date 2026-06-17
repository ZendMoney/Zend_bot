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

export function createBot(): Telegraf<ZendContext> {
  const bot = new Telegraf<ZendContext>(BOT_TOKEN);

  bot.use(rateLimitMiddleware);
  bot.use(sessionMiddleware);
  bot.use(autoDeleteMiddleware((userId) =>
    userId ? getSession(userId).state : ConversationState.IDLE
  ));
  registerUserMessageTracking(bot, (userId) => getSession(userId).state);
  startAutoDeleteCleanup(bot);

  // Group chat: reply only when tagged or replied to
  bot.use(async (ctx, next) => {
    const chatType = ctx.chat?.type;
    if (chatType === 'group' || chatType === 'supergroup') {
      const msg = ctx.message;
      if (!msg || !('text' in msg)) {
        return;
      }

      const text = msg.text;
      const username = ctx.botInfo?.username;
      const isMentioned = username ? text.includes(`@${username}`) : false;
      const isReplyToBot = msg.reply_to_message?.from?.id === ctx.botInfo?.id;

      if (!isMentioned && !isReplyToBot) {
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