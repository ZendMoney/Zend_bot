import type { Telegraf } from 'telegraf';
import { db, transactions } from '@zend/db';
import { and, sql, eq } from 'drizzle-orm';
import { getNearIntentsClient } from '@zend/near-intents-client';
import { mainMenu } from '../keyboards/index.js';

let _nearIntentPollRunning = false;

export async function pollNearIntentTransactions(botInstance: Telegraf<any>): Promise<void> {
  if (_nearIntentPollRunning) return;
  _nearIntentPollRunning = true;
  try {
    const client = getNearIntentsClient();
    if (!client) return;

    const pending = await db.select().from(transactions)
      .where(and(
        sql`${transactions.nearIntentDepositAddress} IS NOT NULL`,
        sql`${transactions.status} IN ('pending', 'processing')`
      ))
      .limit(20);

    for (const tx of pending) {
      if (!tx.nearIntentDepositAddress) continue;
      try {
        const status = await client.getStatus(tx.nearIntentDepositAddress);
        const txStatus = status.status === 'SUCCESS' ? 'completed'
          : status.status === 'FAILED' || status.status === 'REFUNDED' ? 'failed'
          : 'processing';

        if (txStatus === tx.status) continue;

        await db.update(transactions)
          .set({
            status: txStatus,
            toAmount: status.amountOut || tx.toAmount,
            completedAt: txStatus === 'completed' ? new Date() : undefined,
            solanaTxHash: status.destinationTxHash || tx.solanaTxHash,
          })
          .where(eq(transactions.id, tx.id));

        const isWithdraw = tx.type === 'crypto_send';
        if (txStatus === 'completed') {
          const msg = isWithdraw
            ? `✅ *Withdrawal Complete!*\n\nYour cross-chain withdrawal has been delivered.\nReference: \`${tx.id}\``
            : `✅ *Deposit Received!*\n\nFunds have arrived in your ZendPay account.\nReference: \`${tx.id}\``;
          await botInstance.telegram.sendMessage(tx.userId, msg, { parse_mode: 'Markdown', ...mainMenu });
        } else if (txStatus === 'failed' && isWithdraw) {
          await botInstance.telegram.sendMessage(
            tx.userId,
            `❌ *Withdrawal Failed*\n\nReference: \`${tx.id}\``,
            { parse_mode: 'Markdown', ...mainMenu }
          );
        }
      } catch (pollErr) {
        console.warn('[NEAR Poll] Error for', tx.id, pollErr);
      }
    }
  } catch (err) {
    console.error('[NEAR Poll] Error:', err);
  } finally {
    _nearIntentPollRunning = false;
  }
}