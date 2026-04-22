import type { ZendContext } from '../middleware/session.js';

export async function helpHandler(ctx: ZendContext) {
  await ctx.reply(
    `❓ *Help Center*\n\n` +
    `*Quick commands:*\n` +
    `• /balance — Check your balance\n` +
    `• /send — Send money\n` +
    `• /buy — Add naira\n` +
    `• /sell — Cash out\n` +
    `• /swap — Swap tokens\n` +
    `• /vault — Savings\n` +
    `• /history — Transactions\n` +
    `• /settings — Preferences\n\n` +
    `*Or just type naturally:*\n` +
    `• "Send 50k to Tunde"\n` +
    `• "What's my balance?"\n` +
    `• "Swap SOL to USDT"\n\n` +
    `[💬 Contact Support]  [📚 Full Guide]`,
    { parse_mode: 'Markdown' }
  );
}
