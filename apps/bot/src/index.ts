import './env.js';

import { bot } from './bot.js';
import { deps } from './deps.js';
import { mainMenu } from './keyboards/index.js';
import { registerAllHandlers } from './handlers/register.js';
import { run } from './launch/main.js';

registerAllHandlers({ bot, deps });

bot.catch((err, ctx) => {
  const msg = String((err as any)?.message || err || '');
  const desc = String((err as any)?.response?.description || '');
  const userId = ctx.from?.id?.toString() || 'unknown';
  const username = ctx.from?.username ? `@${ctx.from.username}` : '';
  const updateType = ctx.updateType || 'unknown';
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
    console.warn(`[Bot] Ignoring stale callback query user=${userId} ${username}:`, desc || msg);
    return;
  }

  // Always log WHO failed — previous TimeoutErrors had no user id in logs
  console.error(
    `[Bot] error user=${userId} ${username} type=${updateType}` +
      (text ? ` text="${text.replace(/\n/g, ' ')}"` : '') +
      `:` ,
    err
  );

  // Don't stack "something went wrong" on top of a timeout if we already replied mid-flow
  try {
    void ctx.reply('❌ Something went wrong. Please try again or contact support.', mainMenu);
  } catch {
    // ignore
  }
});

run().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});