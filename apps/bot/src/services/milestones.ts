import { db, transactions } from '@zend/db';
import { eq, and } from 'drizzle-orm';
import { formatNgn } from '../lib/format.js';

const MILESTONE_AMOUNTS = [10000, 50000, 100000, 500000, 1000000, 5000000, 10000000];
const MILESTONE_COUNTS = [1, 5, 10, 25, 50, 100];

export async function checkMilestones(userId: string, notifyFn: (text: string) => Promise<unknown>): Promise<void> {
  try {
    const completed = await db.select().from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));

    const sendTxs = completed.filter(t => t.type === 'ngn_send');
    const totalNgn = sendTxs.reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
    const count = sendTxs.length;

    for (const milestone of MILESTONE_AMOUNTS) {
      if (totalNgn >= milestone && totalNgn < milestone + 1000) {
        await notifyFn(
          `🎉 *Milestone Reached!*\n\n` +
          `You've sent a total of *${formatNgn(milestone)}* across ${count} transactions!\n\n` +
          `Keep it going 🚀`
        );
        break;
      }
    }

    for (const milestone of MILESTONE_COUNTS) {
      if (count === milestone) {
        await notifyFn(
          `🎉 *Milestone Reached!*\n\n` +
          `You've completed *${milestone}* successful transfers!\n\n` +
          `Total sent: ${formatNgn(totalNgn)}\n` +
          `Keep it going 🚀`
        );
        break;
      }
    }
  } catch (err) {
    console.error('[Milestone] Error checking milestones:', err);
  }
}