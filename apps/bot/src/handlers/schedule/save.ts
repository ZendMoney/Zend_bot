import { db, scheduledTransfers } from '@zend/db';
import type { ZendSession } from '../../session/types.js';

export async function saveScheduledTransfer(userId: string, sd: NonNullable<ZendSession['scheduleData']>, startAt: Date) {
  let nextRunAt = new Date(startAt);
  const freq = sd.frequency!;
  if (freq === 'daily') nextRunAt.setDate(nextRunAt.getDate() + 1);
  else if (freq === 'weekly') nextRunAt.setDate(nextRunAt.getDate() + 7);
  else if (freq === 'monthly') nextRunAt.setMonth(nextRunAt.getMonth() + 1);

  const result = await db.insert(scheduledTransfers).values({
    userId,
    recipientBankAccountId: sd.recipientBankAccountId!,
    amountNgn: sd.amountNgn!.toString(),
    frequency: freq,
    startAt,
    nextRunAt,
    isActive: true,
  }).returning();

  console.log(`[Schedule] Created schedule #${result[0]?.id} for user ${userId}:`, {
    recipientBankAccountId: sd.recipientBankAccountId,
    amountNgn: sd.amountNgn,
    frequency: freq,
    startAt,
    nextRunAt,
  });
}