import { Markup } from 'telegraf';
import type { ZendContext } from '../middleware/session.js';

export async function receiveHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  const virtualAccount = user.virtualAccount;

  await ctx.reply(
    `📥 *Receive Money*\n\n` +
    `Share your details to get paid:\n\n` +
    `┌─ *Crypto* ───────────────────┐\n` +
    `│ Solana Address:\n` +
    `│ \`${user.walletAddress}\`\n` +
    `│ [📋 Copy] [📷 QR Code]\n` +
    `└──────────────────────────────┘\n\n` +
    (virtualAccount
      ? `┌─ *Naira (Bank Transfer)* ────┐\n` +
        `│ Bank: ${virtualAccount.bankName}\n` +
        `│ Account: \`${virtualAccount.accountNumber}\`\n` +
        `│ Name: ${virtualAccount.accountName}\n` +
        `│ [📋 Copy Account Number]\n` +
        `└──────────────────────────────┘\n\n`
      : '') +
    `💡 Anyone can send to either. Crypto arrives instantly. Naira arrives in 2-5 minutes.`,
    { parse_mode: 'Markdown' }
  );
}
