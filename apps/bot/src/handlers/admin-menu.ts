import { db, users, transactions, savedBankAccounts, scheduledTransfers } from '@zend/db';
import { eq, sql } from 'drizzle-orm';
import { adminMenu, mainMenu } from '../keyboards/index.js';
import { escapeTelegramMarkdown } from '../lib/telegram.js';
import { getAdminStats, isSuperAdmin, isAdminUser } from '../services/admin.js';
import { getQVACStatus } from '../services/qvac/index.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

async function requireAdmin(ctx: ZendContext): Promise<boolean> {
  const userId = ctx.from!.id.toString();
  const hasAccess = isSuperAdmin(userId) || await isAdminUser(userId);
  if (!hasAccess) {
    await ctx.reply('❌ Admin access required.');
  }
  return hasAccess;
}



export function registerAdminMenuHandlers({ bot: b }: HandlerContext): void {
b.hears('📊 Stats', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const stats = await getAdminStats();
    await ctx.reply(
      `📊 *Admin Stats*\n\n` +
      `*Users*\n` +
      `• Total: ${stats.totalUsers}\n` +
      `• Today: ${stats.usersToday}\n` +
      `• This Week: ${stats.usersThisWeek}\n` +
      `• This Month: ${stats.usersThisMonth}\n\n` +
      `*Transactions*\n` +
      `• Total: ${stats.totalTransactions}\n` +
      `• Today: ${stats.transactionsToday}\n` +
      `• Volume (₦): ${stats.totalVolumeNgn.toLocaleString()}\n\n` +
      `*Other*\n` +
      `• Saved Bank Accounts: ${stats.totalSavedBankAccounts}\n` +
      `• Scheduled Transfers: ${stats.totalScheduledTransfers}\n` +
      `• Active Scheduled: ${stats.activeScheduledTransfers}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Stats error:', err);
    await ctx.reply('❌ Could not fetch stats.', adminMenu);
  }
});

b.hears('👤 Users', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const allUsers = await db.select().from(users).orderBy(sql`created_at DESC`).limit(20);
    if (allUsers.length === 0) {
      await ctx.reply('No users yet.', adminMenu);
      return;
    }
    const lines = allUsers.map((u, i) =>
      `${i + 1}. ${escapeTelegramMarkdown(u.firstName)}${u.telegramUsername ? ' (@' + escapeTelegramMarkdown(u.telegramUsername.replace(/^@/, '')) + ')' : ''} — ${u.walletAddress.slice(0, 6)}...${u.walletAddress.slice(-4)} | ${u.createdAt.toISOString().split('T')[0]}`
    );
    await ctx.reply(
      `👤 *Last 20 Users*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Users error:', err);
    await ctx.reply('❌ Could not fetch users.', adminMenu);
  }
});

b.hears('💸 Transactions', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const txs = await db.select().from(transactions).orderBy(sql`created_at DESC`).limit(20);
    if (txs.length === 0) {
      await ctx.reply('No transactions yet.', adminMenu);
      return;
    }
    const lines = txs.map((t, i) =>
      `${i + 1}. ${t.type.toUpperCase()} | ${t.status} | ₦${Number(t.ngnAmount || 0).toLocaleString()} | ${t.createdAt.toISOString().split('T')[0]}`
    );
    await ctx.reply(
      `💸 *Last 20 Transactions*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Transactions error:', err);
    await ctx.reply('❌ Could not fetch transactions.', adminMenu);
  }
});

b.hears('🏦 Bank Accounts', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const count = await db.select({ count: sql<number>`count(*)` }).from(savedBankAccounts);
    const list = await db.select().from(savedBankAccounts).orderBy(sql`created_at DESC`).limit(20);
    const lines = list.map((b, i) =>
      `${i + 1}. ${b.bankName} | ****${b.accountNumber.slice(-4)} | ${b.accountName}`
    );
    await ctx.reply(
      `🏦 *Bank Accounts* (Total: ${count[0]?.count ?? 0})\n\n${lines.join('\n') || 'No bank accounts saved.'}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Bank accounts error:', err);
    await ctx.reply('❌ Could not fetch bank accounts.', adminMenu);
  }
});

b.hears('📅 Scheduled', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const list = await db.select().from(scheduledTransfers).orderBy(sql`created_at DESC`).limit(20);
    if (list.length === 0) {
      await ctx.reply('No scheduled transfers.', adminMenu);
      return;
    }
    const lines = list.map((s, i) =>
      `${i + 1}. ₦${Number(s.amountNgn).toLocaleString()} | ${s.frequency} | ${s.isActive ? '✅ Active' : '⏸️ Paused'} | Next: ${s.nextRunAt.toISOString().split('T')[0]}`
    );
    await ctx.reply(
      `📅 *Scheduled Transfers*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Scheduled error:', err);
    await ctx.reply('❌ Could not fetch scheduled transfers.', adminMenu);
  }
});

b.hears('🤖 QVAC Status', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  const status = getQVACStatus();
  const statusLines = Object.entries(status.models)
    .map(([name, loaded]) => `• ${name}: ${loaded ? '✅' : '❌'}`)
    .join('\n');
  await ctx.reply(
    `🤖 *QVAC AI Stack*\n\n` +
    `Ready: ${status.ready ? '✅' : '❌'}\n\n` +
    `${statusLines}\n\n` +
    `${status.errors.length ? 'Errors:\n' + status.errors.join('\n') : 'No errors.'}`,
    { parse_mode: 'Markdown', ...adminMenu }
  );
});

b.hears('🔙 Back to Menu', async (ctx) => {
  await ctx.reply('Main menu:', mainMenu);
});
}
