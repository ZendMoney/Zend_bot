import './env.js';

import { bot } from './bot.js';
import { deps } from './deps.js';
import { mainMenu } from './keyboards/index.js';
import { installProcessErrorLogging, logError, logWarn } from './lib/logger.js';
import { registerAllHandlers } from './handlers/register.js';
import { run } from './launch/main.js';

installProcessErrorLogging();
registerAllHandlers({ bot, deps });

bot.catch((err, ctx) => {
  const msg = String((err as any)?.message || err || '');
  const desc = String((err as any)?.response?.description || '');
  const userId = ctx.from?.id?.toString() || 'unknown';
  const username = ctx.from?.username ? `@${ctx.from.username}` : '';
  const updateType = ctx.updateType || 'unknown';
  const chatType = ctx.chat?.type || '';
  const text =
    ctx.message && 'text' in ctx.message
      ? String(ctx.message.text).slice(0, 120)
      : ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? `cb:${String(ctx.callbackQuery.data).slice(0, 80)}`
        : '';

  // Stale inline-button clicks after a slow handler — not a user-facing failure
  if (
    /query is too old/i.test(msg) ||
    /query is too old/i.test(desc) ||
    /response timeout expired/i.test(msg) ||
    /response timeout expired/i.test(desc) ||
    /query ID is invalid/i.test(msg)
  ) {
    logWarn('Bot', 'stale callback query ignored', {
      userId,
      username,
      desc: desc || msg,
      text,
    });
    return;
  }

  logError('Bot', 'handler error', err, {
    userId,
    username,
    type: updateType,
    chat: chatType,
    text,
  });

  void ctx
    .reply('❌ Something went wrong. Please try again or contact support.', mainMenu)
    .catch((replyErr) => {
      logError('Bot', 'failed to send error reply to user', replyErr, { userId });
    });
});

run().catch((err) => {
  logError('Bot', 'fatal startup error', err);
  process.exit(1);
});