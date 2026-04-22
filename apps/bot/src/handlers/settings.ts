import { Markup } from 'telegraf';
import type { ZendContext } from '../middleware/session.js';

export async function settingsHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  const emailStatus = user.emailVerified ? '✓' : '';
  const pinStatus = user.transactionPin ? '✓' : '';

  await ctx.reply(
    `⚙️ *Settings*\n\n` +
    `👤 *Profile*\n` +
    `   Name: ${user.firstName}\n` +
    `   Email: ${user.email ? '***@gmail.com ' + emailStatus : 'Not set'}\n\n` +
    `🔐 *Security*\n` +
    `   [🔑 Change Recovery Email]\n` +
    `   [📱 Active Sessions]\n` +
    `   [🔢 Transaction PIN ${pinStatus}]\n\n` +
    `💳 *Saved Banks*\n` +
    `   [➕ Add Bank Account]\n\n` +
    `🔔 *Notifications*\n` +
    `   [✓ Transaction alerts]\n` +
    `   [✓ Vault unlock reminders]\n\n` +
    `🎙️ *Voice*\n` +
    `   [${user.voiceRepliesEnabled ? '✓' : '  '} Voice replies (TTS)]\n` +
    `   [${user.voiceInputEnabled ? '✓' : '  '} Voice input (STT)]\n\n` +
    `🌐 *Language*\n` +
    `   [English ▼]\n\n` +
    `[🚪 Log Out]  [💬 Contact Support]`,
    { parse_mode: 'Markdown' }
  );
}
