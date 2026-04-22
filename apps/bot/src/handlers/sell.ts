import { Markup } from 'telegraf';
import { db, savedBankAccounts } from '@zend/db';
import { eq } from 'drizzle-orm';
import type { ZendContext } from '../middleware/session.js';

export async function sellHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  // Get saved bank accounts
  const accounts = await db.query.savedBankAccounts.findMany({
    where: eq(savedBankAccounts.userId, user.id),
  });

  const accountButtons = accounts.map(acc => [
    Markup.button.callback(
      `🏦 ${acc.bankName} • ${acc.accountNumber} • ${acc.accountName}`,
      `sell_to:${acc.id}`
    )
  ]);

  await ctx.reply(
    `💴 *Cash Out to Bank*\n\n` +
    `How much do you want to withdraw?\n\n` +
    `Select destination:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...accountButtons,
        [Markup.button.callback('➕ Add New Bank Account', 'add_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_tx')],
      ]),
    }
  );
}
