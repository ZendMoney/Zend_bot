import { db, transactions } from '@zend/db';
import { eq, desc } from 'drizzle-orm';
import { formatNgn, formatDate } from '@zend/shared';
import type { ZendContext } from '../middleware/session.js';

export async function historyHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  const txs = await db.query.transactions.findMany({
    where: eq(transactions.userId, user.id),
    orderBy: [desc(transactions.createdAt)],
    limit: 10,
  });

  if (txs.length === 0) {
    await ctx.reply(
      `📋 *Transaction History*\n\n` +
      `No transactions yet.\n\n` +
      `Send your first payment with /send`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const lines = txs.map(tx => {
    const emoji = tx.status === 'completed' ? '✅' : tx.status === 'failed' ? '❌' : '⏳';
    const typeLabel = tx.type === 'ngn_send' ? 'Send NGN' : 
                      tx.type === 'ngn_receive' ? 'Deposit' :
                      tx.type === 'swap' ? 'Swap' :
                      tx.type === 'crypto_send' ? 'Send Crypto' : tx.type;
    
    const amount = tx.ngnAmount 
      ? formatNgn(Number(tx.ngnAmount))
      : tx.fromAmount 
        ? `${tx.fromAmount} ${tx.fromMint ? 'USDT' : ''}`
        : '';
    
    const date = formatDate(new Date(tx.createdAt));
    
    return `${emoji} ${typeLabel.padEnd(12)} ${amount.padStart(12)}  ${date}`;
  });

  await ctx.reply(
    `📋 *Transaction History*\n\n` +
    `${lines.join('\n')}\n\n` +
    `[⬇️ Load More]  [📊 Export CSV]`,
    { parse_mode: 'Markdown' }
  );
}
