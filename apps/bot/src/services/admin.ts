/**
 * Admin Stats Service
 * Provides aggregated stats for admin dashboard.
 */

import { db, users, transactions, savedBankAccounts, scheduledTransfers } from '@zend/db';
import { sql, eq, gte } from 'drizzle-orm';

export interface AdminStats {
  totalUsers: number;
  usersToday: number;
  usersThisWeek: number;
  usersThisMonth: number;
  totalTransactions: number;
  transactionsToday: number;
  totalVolumeNgn: number;
  totalSavedBankAccounts: number;
  totalScheduledTransfers: number;
  activeScheduledTransfers: number;
}

export async function getAdminStats(): Promise<AdminStats> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalUsersRes,
    usersTodayRes,
    usersThisWeekRes,
    usersThisMonthRes,
    totalTransactionsRes,
    transactionsTodayRes,
    totalVolumeRes,
    totalBankAccountsRes,
    totalScheduledRes,
    activeScheduledRes,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(users),
    db.select({ count: sql<number>`count(*)` }).from(users).where(gte(users.createdAt, todayStart)),
    db.select({ count: sql<number>`count(*)` }).from(users).where(gte(users.createdAt, weekStart)),
    db.select({ count: sql<number>`count(*)` }).from(users).where(gte(users.createdAt, monthStart)),
    db.select({ count: sql<number>`count(*)` }).from(transactions),
    db.select({ count: sql<number>`count(*)` }).from(transactions).where(gte(transactions.createdAt, todayStart)),
    db.select({ total: sql<number>`COALESCE(SUM(ngn_amount), 0)` }).from(transactions).where(eq(transactions.status, 'completed')),
    db.select({ count: sql<number>`count(*)` }).from(savedBankAccounts),
    db.select({ count: sql<number>`count(*)` }).from(scheduledTransfers),
    db.select({ count: sql<number>`count(*)` }).from(scheduledTransfers).where(eq(scheduledTransfers.isActive, true)),
  ]);

  return {
    totalUsers: totalUsersRes[0]?.count ?? 0,
    usersToday: usersTodayRes[0]?.count ?? 0,
    usersThisWeek: usersThisWeekRes[0]?.count ?? 0,
    usersThisMonth: usersThisMonthRes[0]?.count ?? 0,
    totalTransactions: totalTransactionsRes[0]?.count ?? 0,
    transactionsToday: transactionsTodayRes[0]?.count ?? 0,
    totalVolumeNgn: Number(totalVolumeRes[0]?.total ?? 0),
    totalSavedBankAccounts: totalBankAccountsRes[0]?.count ?? 0,
    totalScheduledTransfers: totalScheduledRes[0]?.count ?? 0,
    activeScheduledTransfers: activeScheduledRes[0]?.count ?? 0,
  };
}

/** Hardcoded super-admin usernames for bootstrap access */
const SUPER_ADMINS = new Set(['israel_igboze', 'Ajemark']);

export function isSuperAdmin(username?: string): boolean {
  if (!username) return false;
  return SUPER_ADMINS.has(username);
}

export async function isAdminUser(userId: string): Promise<boolean> {
  const res = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId)).limit(1);
  return res[0]?.isAdmin ?? false;
}
