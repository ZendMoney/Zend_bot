import { db, transactions } from '@zend/db';
import { eq, and, sql } from 'drizzle-orm';
import { SOLANA_TOKENS } from '@zend/shared';
import { mainMenu } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';
import { isGroupChat } from '../lib/group.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function buildHistoryMessage(userId: string): Promise<string | null> {
  const txs = await db.select().from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(sql`${transactions.createdAt} desc`)
    .limit(10);

  if (txs.length === 0) {
    return '📋 *No transactions yet*\n\nSend or receive money to see your history here.';
  }

  const allTxs = await db.select().from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));
  const totalSent = allTxs.filter(t => t.type === 'ngn_send').reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
  const totalCount = allTxs.length;

  let msg = `📋 *Transaction History*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 Total Sent: ${formatNgn(totalSent)}  •  📊 ${totalCount} txs\n\n`;

  for (const tx of txs) {
    const statusEmoji = tx.status === 'completed' ? '✅' : tx.status === 'processing' ? '⏳' : tx.status === 'pending' ? '🕐' : '❌';
    const typeEmoji = tx.type === 'ngn_send' ? '📤' : tx.type === 'ngn_receive' ? '📥' : tx.type === 'swap' ? '🔄' : tx.type === 'scheduled' ? '📅' : '💱';
    const typeLabel = tx.type === 'ngn_send' ? 'Send' : tx.type === 'ngn_receive' ? 'Deposit' : tx.type === 'swap' ? 'Convert' : tx.type === 'scheduled' ? 'Scheduled' : tx.type;

    const meta = tx.metadata as Record<string, string> | null;
    const tokenLabel =
      meta?.sourceToken ||
      meta?.destinationSymbol ||
      (tx.fromMint === SOLANA_TOKENS.USDT.mint ? 'USDT'
        : tx.fromMint === SOLANA_TOKENS.USDC.mint ? 'USDC'
        : tx.fromMint === SOLANA_TOKENS.SOL.mint ? 'SOL'
        : meta?.nearIntents ? 'crypto' : '');
    const amountLine = tx.ngnAmount
      ? `${formatNgn(Number(tx.ngnAmount))}`
      : tx.fromAmount && tokenLabel
        ? `${Number(tx.fromAmount).toFixed(2)} ${tokenLabel}`
        : tx.fromAmount
          ? `${Number(tx.fromAmount).toFixed(2)}`
          : '';

    const date = tx.createdAt.toLocaleDateString('en-NG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    msg += `${typeEmoji} *${typeLabel}*  ${statusEmoji}\n`;
    msg += `💵 ${amountLine}\n`;

    if (tx.recipientBankName || tx.recipientAccountName) {
      msg += `👤 ${tx.recipientAccountName || 'Recipient'} · ${tx.recipientBankName || ''}\n`;
      if (tx.recipientAccountNumber) {
        msg += `🔢 \`${tx.recipientAccountNumber}\`\n`;
      }
    }
    if (tx.solanaTxHash) {
      msg += `🔗 [View on Solscan](https://solscan.io/tx/${tx.solanaTxHash})\n`;
    }
    msg += `🆔 \`${tx.id}\` · ${date}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  }

  return msg;
}

export async function showHistory(ctx: ZendContext, userId: string) {
  const msg = await buildHistoryMessage(userId);
  if (msg) {
    await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
  }
}

export function registerHistoryHandlers({ bot: b }: HandlerContext): void {
  b.hears('📋 History', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (isGroupChat(ctx)) {
      const name = ctx.from?.first_name || 'there';
      await ctx.reply(`📩 ${name}, check your DM for your history.`);
      const msg = await buildHistoryMessage(userId);
      if (msg) {
        await ctx.telegram.sendMessage(ctx.from!.id, msg, { parse_mode: 'Markdown', ...mainMenu });
      }
      return;
    }
    await showHistory(ctx, userId);
  });
}