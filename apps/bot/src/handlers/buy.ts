import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { PAJ_MIN_DEPOSIT_NGN } from '@zend/shared';
import type { ZendContext } from '../middleware/session.js';

export async function buyHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  const virtualAccount = user.virtualAccount;
  
  if (!virtualAccount) {
    await ctx.reply(
      '⚠️ Your NGN account is still being set up.\n\n' +
      'Please try again in a few minutes.',
    );
    return;
  }

  await ctx.reply(
    `💵 *Add Naira to Your Wallet*\n\n` +
    `Send a bank transfer to this account:\n\n` +
    `🏦 *${virtualAccount.bankName}*\n` +
    `🔢 \`${virtualAccount.accountNumber}\`\n` +
    `👤 *${virtualAccount.accountName}*\n\n` +
    `💡 Minimum: ₦${PAJ_MIN_DEPOSIT_NGN.toLocaleString()}\n` +
    `⏱️ Arrives in: 2-5 minutes\n\n` +
    `📋 Tap to copy account number`,
    { parse_mode: 'Markdown' }
  );
}
