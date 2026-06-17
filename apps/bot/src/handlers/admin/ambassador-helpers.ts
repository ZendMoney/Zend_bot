import { db, users, transactions } from '@zend/db';
import { eq, and, sql } from 'drizzle-orm';

export async function getAmbassadorActiveUserCount(code: string): Promise<number> {
  const result = await db.select({ count: sql`count(distinct ${users.id})` })
    .from(users)
    .where(
      and(
        eq(users.ambassadorReferralCode, code),
        sql`exists (select 1 from ${transactions} where ${transactions.userId} = ${users.id} and ${transactions.status} = 'completed')`
      )
    );
  return Number(result[0]?.count || 0);
}

export async function getAmbassadorMonthlyVolume(code: string, year: number, month: number): Promise<number> {
  const start = new Date(year, month - 1, 1).toISOString();
  const end = new Date(year, month, 1).toISOString();
  const result = await db.select({ sum: sql`coalesce(sum(${transactions.ngnAmount}), 0)` })
    .from(transactions)
    .innerJoin(users, eq(transactions.userId, users.id))
    .where(
      and(
        eq(users.ambassadorReferralCode, code),
        eq(transactions.status, 'completed'),
        sql`${transactions.createdAt} >= ${start}`,
        sql`${transactions.createdAt} < ${end}`
      )
    );
  return Number(result[0]?.sum || 0);
}

export async function getAmbassadorTotalVolume(code: string): Promise<number> {
  const result = await db.select({ sum: sql`coalesce(sum(${transactions.ngnAmount}), 0)` })
    .from(transactions)
    .innerJoin(users, eq(transactions.userId, users.id))
    .where(
      and(
        eq(users.ambassadorReferralCode, code),
        eq(transactions.status, 'completed')
      )
    );
  return Number(result[0]?.sum || 0);
}

export function getAmbassadorTierFromCount(activeCount: number): 'entry' | 'pro' | 'elite' {
  if (activeCount >= 300) return 'elite';
  if (activeCount >= 75) return 'pro';
  return 'entry';
}

export function getCommissionRateBps(tier: string): number {
  const map: Record<string, number> = { entry: 25, pro: 30, elite: 35 };
  return map[tier] || 25;
}

export function calculateCommissionNgn(volumeNgn: number, tier: string): number {
  return volumeNgn * (getCommissionRateBps(tier) / 10000);
}

export function formatAmbassadorTier(tier: string): string {
  const map: Record<string, string> = {
    entry: '🥉 ZendER (Entry)',
    pro: '🥈 ZendER Pro',
    elite: '🥇 ZendER Elite',
  };
  return map[tier] || tier;
}

export function formatAmbassadorStatus(status: string): string {
  const map: Record<string, string> = {
    pending: '⏳ Pending',
    confirmed: '✅ Confirmed',
    removed: '❌ Removed',
  };
  return map[status] || status;
}