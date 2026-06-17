import { Markup } from 'telegraf';
import { db, users, transactions, ambassadorApplications, deviceSuspensionRequests, botFeatures, feedback } from '@zend/db';
import { eq, sql, and, desc } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { escapeTelegramMarkdown } from '../../lib/telegram.js';
import { setSession } from '../../session/store.js';
import { invalidateBotFeaturesCache } from '../../services/bot-features.js';
import { adminMainKeyboard } from './keyboards.js';
import { buildTxnDetailText, buildUserDetailText } from './detail.js';
import { checkAdmin } from './auth.js';
import { registerAdminSearchHandlers } from './search.js';
import {
  getAmbassadorActiveUserCount,
  getAmbassadorTotalVolume,
  getAmbassadorTierFromCount,
  getCommissionRateBps,
  calculateCommissionNgn,
  formatAmbassadorTier,
  formatAmbassadorStatus,
} from './ambassador-helpers.js';
import type { HandlerContext } from '../types.js';

export function registerAdminPanelHandlers(ctx: HandlerContext): void {
  const { bot: b } = ctx;

  b.command('admin', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) {
    await ctx.reply('❌ You do not have permission to access the admin panel.');
    return;
  }
  await ctx.reply('🛠 *ZendPay Admin Panel*\n\nChoose a section:', { parse_mode: 'Markdown', ...adminMainKeyboard });
});

b.action('admin_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }
  await ctx.editMessageText('🛠 *ZendPay Admin Panel*\n\nChoose a section:', { parse_mode: 'Markdown', ...adminMainKeyboard });
  await ctx.answerCbQuery();
});

// ─── Overview ───
b.action('admin_page:overview', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const userCount = await db.select({ count: sql`count(*)` }).from(users);
  const txCount = await db.select({ count: sql`count(*)` }).from(transactions);
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_send'));
  const totalNgnIn = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));
  const totalZendFee = await db.select({ sum: sql`coalesce(sum(zend_fee_usdt), 0)` }).from(transactions).where(eq(transactions.status, 'completed'));
  const activeFeatures = await db.select().from(botFeatures).where(eq(botFeatures.isActive, true));

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const newToday = await db.select({ count: sql`count(*)` }).from(users).where(sql`${users.createdAt} >= ${todayStart.toISOString()}`);

  const text =
    `📊 *Overview*\n\n` +
    `👤 Total Users: ${userCount[0]?.count || 0} (+${newToday[0]?.count || 0} today)\n` +
    `📋 Total Transactions: ${txCount[0]?.count || 0}\n` +
    `💰 Total NGN In: ₦${Number(totalNgnIn[0]?.sum || 0).toLocaleString()}\n` +
    `💸 Total NGN Out: ₦${Number(totalNgnOut[0]?.sum || 0).toLocaleString()}\n` +
    `🪙 ZendPay Fees (USDT): $${Number(totalZendFee[0]?.sum || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\n` +
    `✅ Active Features: ${activeFeatures.length}\n`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Users (paginated) ───
const USERS_PER_PAGE = 20;

b.action('admin_page:users', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(users);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const newToday = await db.select({ count: sql`count(*)` }).from(users).where(sql`${users.createdAt} >= ${todayStart.toISOString()}`);
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const newWeek = await db.select({ count: sql`count(*)` }).from(users).where(sql`${users.createdAt} >= ${weekStart.toISOString()}`);

  const recentUsers = await db.select({
    id: users.id,
    name: users.firstName,
    username: users.telegramUsername,
    createdAt: users.createdAt,
    wallet: users.walletAddress,
  }).from(users).orderBy(sql`${users.createdAt} desc`).limit(USERS_PER_PAGE);

  let userList = recentUsers.map(u =>
    `- ${escapeTelegramMarkdown(u.name || 'Unknown')}${u.username ? ` (@${escapeTelegramMarkdown(u.username.replace(/^@/, ''))})` : ''} | \`${u.wallet?.slice(0, 6)}...${u.wallet?.slice(-4)}\``
  ).join('\n');

  const text =
    `👤 *Users* (page 1)\n\n` +
    `Total: ${total[0]?.count || 0} | New today: ${newToday[0]?.count || 0} | This week: ${newWeek[0]?.count || 0}\n\n` +
    `${userList || 'No users yet.'}`;

  const navButtons = [];
  if (Number(total[0]?.count || 0) > USERS_PER_PAGE) {
    navButtons.push(Markup.button.callback('➡️ Next', 'admin_users_page:1'));
  }
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

b.action(/admin_users_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * USERS_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(users);
  const pageUsers = await db.select({
    id: users.id,
    name: users.firstName,
    username: users.telegramUsername,
    wallet: users.walletAddress,
  }).from(users).orderBy(sql`${users.createdAt} desc`).limit(USERS_PER_PAGE).offset(offset);

  let userList = pageUsers.map(u =>
    `- ${escapeTelegramMarkdown(u.name || 'Unknown')}${u.username ? ` (@${escapeTelegramMarkdown(u.username.replace(/^@/, ''))})` : ''} | \`${u.wallet?.slice(0, 6)}...${u.wallet?.slice(-4)}\``
  ).join('\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `👤 *Users* (page ${page + 1})\n\n${userList || 'No more users.'}`;

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_users_page:${page - 1}`));
  if (totalCount > offset + USERS_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_users_page:${page + 1}`));

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Ambassadors (paginated) ───
const AMBS_PER_PAGE = 10;

b.action('admin_page:ambassadors', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const apps = await db.select().from(ambassadorApplications).orderBy(sql`${ambassadorApplications.createdAt} desc`).limit(AMBS_PER_PAGE);

  let list = apps.map((a, i) =>
    `${i + 1}. *${escapeTelegramMarkdown(a.name)}* (@${escapeTelegramMarkdown(a.tgHandle.replace(/^@/, ''))})\n` +
    `   Student: ${escapeTelegramMarkdown(a.isStudent)} | Focus: ${escapeTelegramMarkdown(a.focus)}`
  ).join('\n\n');

  const text = `🧑‍🎓 *Ambassadors* (page 1) — ${total[0]?.count || 0} total\n\n${list || 'No applications yet.'}`;

  const navButtons = [];
  if (Number(total[0]?.count || 0) > AMBS_PER_PAGE) {
    navButtons.push(Markup.button.callback('➡️ Next', 'admin_ambassadors_page:1'));
  }
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

b.action(/admin_ambassadors_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * AMBS_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const apps = await db.select().from(ambassadorApplications).orderBy(sql`${ambassadorApplications.createdAt} desc`).limit(AMBS_PER_PAGE).offset(offset);

  let list = apps.map((a, i) =>
    `${offset + i + 1}. *${escapeTelegramMarkdown(a.name)}* (@${escapeTelegramMarkdown(a.tgHandle.replace(/^@/, ''))})\n` +
    `   Student: ${escapeTelegramMarkdown(a.isStudent)} | Focus: ${escapeTelegramMarkdown(a.focus)}`
  ).join('\n\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `🧑‍🎓 *Ambassadors* (page ${page + 1}) — ${totalCount} total\n\n${list || 'No more applications.'}`;

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_ambassadors_page:${page - 1}`));
  if (totalCount > offset + AMBS_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_ambassadors_page:${page + 1}`));

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Suspensions (paginated) ───
const SUSP_PER_PAGE = 20;

b.action('admin_page:suspensions', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(deviceSuspensionRequests);
  const reqs = await db.select().from(deviceSuspensionRequests).orderBy(sql`${deviceSuspensionRequests.createdAt} desc`).limit(SUSP_PER_PAGE);

  let list = reqs.map((r, i) =>
    `${i + 1}. *${escapeTelegramMarkdown(r.fullName)}* (@${escapeTelegramMarkdown(r.handle.replace(/^@/, ''))})\n` +
    `   📧 ${escapeTelegramMarkdown(r.email)} | 📱 ${escapeTelegramMarkdown(r.phone)}\n` +
    `   Device: ${escapeTelegramMarkdown(r.deviceLost)}${r.details ? `\n   Details: ${escapeTelegramMarkdown(r.details.slice(0, 100))}` : ''}`
  ).join('\n\n');

  const text = `🚨 *Suspensions* (page 1) — ${total[0]?.count || 0} total\n\n${list || 'No requests yet.'}`;

  const navButtons = [];
  if (Number(total[0]?.count || 0) > SUSP_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', 'admin_suspensions_page:1'));
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

b.action(/admin_suspensions_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * SUSP_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(deviceSuspensionRequests);
  const reqs = await db.select().from(deviceSuspensionRequests).orderBy(sql`${deviceSuspensionRequests.createdAt} desc`).limit(SUSP_PER_PAGE).offset(offset);

  let list = reqs.map((r, i) =>
    `${offset + i + 1}. *${escapeTelegramMarkdown(r.fullName)}* (@${escapeTelegramMarkdown(r.handle.replace(/^@/, ''))})\n` +
    `   📧 ${escapeTelegramMarkdown(r.email)} | 📱 ${escapeTelegramMarkdown(r.phone)}\n` +
    `   Device: ${escapeTelegramMarkdown(r.deviceLost)}${r.details ? `\n   Details: ${escapeTelegramMarkdown(r.details.slice(0, 100))}` : ''}`
  ).join('\n\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `🚨 *Suspensions* (page ${page + 1}) — ${totalCount} total\n\n${list || 'No more requests.'}`;

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_suspensions_page:${page - 1}`));
  if (totalCount > offset + SUSP_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_suspensions_page:${page + 1}`));

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Fees & Revenue ───
b.action('admin_page:fees', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const totalZendFee = await db.select({ sum: sql`coalesce(sum(zend_fee_usdt), 0)` }).from(transactions).where(eq(transactions.status, 'completed'));
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_send'));
  const totalNgnIn = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));

  const offrampCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'ngn_send'));
  const onrampCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));
  const swapCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'swap'));
  const billCount = await db.select({ count: sql`count(*)` }).from(billPayments);
  const billVolume = await db.select({ sum: sql`coalesce(sum(amount_ngn), 0)` }).from(billPayments).where(eq(billPayments.status, 'success'));

  const text =
    `💰 *Fees & Revenue*\n\n` +
    `🪙 Total ZendPay Fees: $${Number(totalZendFee[0]?.sum || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\n` +
    `📐 Fee config: ${ZEND_FEE_NORMAL_BPS / 100}% (normal) / max(${ZEND_FEE_FUNDED_BPS / 100}%, gas+$flat) (sponsored)\n\n` +
    `📊 *Volume by Type:*\n` +
    `📤 Off-Ramp: ${offrampCount[0]?.count || 0} tx | ₦${Number(totalNgnOut[0]?.sum || 0).toLocaleString()}\n` +
    `📥 On-Ramp: ${onrampCount[0]?.count || 0} tx | ₦${Number(totalNgnIn[0]?.sum || 0).toLocaleString()}\n` +
    `🔄 Swaps: ${swapCount[0]?.count || 0} tx\n` +
    `📱 Bill Payments: ${billCount[0]?.count || 0} | ₦${Number(billVolume[0]?.sum || 0).toLocaleString()}\n`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Features ───
b.action('admin_page:features', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const features = await db.select().from(botFeatures).orderBy(botFeatures.sortOrder);
  const buttons = features.map(f => [
    Markup.button.callback(`${f.isActive ? '🟢' : '🔴'} ${f.name}`, `admin_toggle_feature:${f.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  const activeCount = features.filter(f => f.isActive).length;
  const text = `⚙️ *Features* — ${activeCount} / ${features.length} active\n\nTap to toggle:`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action(/admin_toggle_feature:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const featureId = parseInt(ctx.match[1], 10);
  const feature = await db.select().from(botFeatures).where(eq(botFeatures.id, featureId)).limit(1);
  if (feature.length === 0) { await ctx.answerCbQuery('Feature not found'); return; }

  const newState = !feature[0].isActive;
  await db.update(botFeatures).set({ isActive: newState }).where(eq(botFeatures.id, featureId));
  invalidateBotFeaturesCache();

  await ctx.answerCbQuery(`${feature[0].name} is now ${newState ? 'ON' : 'OFF'}`);

  // Refresh features page
  const features = await db.select().from(botFeatures).orderBy(botFeatures.sortOrder);
  const buttons = features.map(f => [
    Markup.button.callback(`${f.isActive ? '🟢' : '🔴'} ${f.name}`, `admin_toggle_feature:${f.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);
  const activeCount = features.filter(f => f.isActive).length;
  const text = `⚙️ *Features* — ${activeCount} / ${features.length} active\n\nTap to toggle:`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ─── Feedback (admin view) ───

const FEEDBACK_PER_PAGE = 10;

b.action('admin_page:feedback', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(feedback);
  const openCount = await db.select({ count: sql`count(*)` }).from(feedback).where(eq(feedback.status, 'open'));
  const rows = await db.select().from(feedback).orderBy(desc(feedback.createdAt)).limit(FEEDBACK_PER_PAGE);

  let list = rows.map((f, i) => {
    const statusIcon = f.status === 'open' ? '🟡' : f.status === 'resolved' ? '✅' : f.status === 'in_progress' ? '🔵' : '⚪';
    const preview = escapeTelegramMarkdown(f.message.slice(0, 80));
    return `${i + 1}. ${statusIcon} #${f.id} | U\_${f.userId} | ${preview}${f.message.length > 80 ? '…' : ''}`;
  }).join('\n\n');

  const text =
    `📝 *User Feedback* (page 1)\n\n` +
    `Total: ${total[0]?.count || 0} | Open: ${openCount[0]?.count || 0}\n\n` +
    `${list || 'No feedback yet.'}\n\n` +
    `Tap a number to view / resolve.`;

  const buttons = rows.map(f => [
    Markup.button.callback(`#${f.id}`, `admin_feedback_detail:${f.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action(/admin_feedback_detail:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const feedbackId = parseInt(ctx.match[1], 10);
  const rows = await db.select().from(feedback).where(eq(feedback.id, feedbackId)).limit(1);
  if (rows.length === 0) { await ctx.answerCbQuery('Feedback not found'); return; }
  const f = rows[0];

  const statusIcon = f.status === 'open' ? '🟡' : f.status === 'resolved' ? '✅' : f.status === 'in_progress' ? '🔵' : '⚪';
  const text =
    `📝 *Feedback #${f.id}* ${statusIcon}\n\n` +
    `*User:* \`${f.userId}\`\n` +
    `*Category:* ${f.category}\n` +
    `*Status:* ${f.status}\n` +
    `*Created:* ${f.createdAt ? new Date(f.createdAt).toLocaleString('en-NG') : '—'}\n\n` +
    `*Message:*\n${escapeTelegramMarkdown(f.message)}`;

  const buttons: any[] = [];
  if (f.status !== 'resolved') {
    buttons.push([Markup.button.callback('✅ Mark Resolved', `admin_feedback_resolve:${f.id}`)]);
  }
  if (f.status !== 'in_progress' && f.status !== 'resolved') {
    buttons.push([Markup.button.callback('🔵 Mark In Progress', `admin_feedback_progress:${f.id}`)]);
  }
  buttons.push([Markup.button.callback('◀️ Back', 'admin_page:feedback')]);

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action(/admin_feedback_resolve:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const feedbackId = parseInt(ctx.match[1], 10);
  await db.update(feedback).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(feedback.id, feedbackId));
  await ctx.answerCbQuery('Marked resolved');
  await ctx.editMessageText(`✅ Feedback #${feedbackId} marked as resolved.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Back to Feedback', 'admin_page:feedback')]]));
});

b.action(/admin_feedback_progress:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const feedbackId = parseInt(ctx.match[1], 10);
  await db.update(feedback).set({ status: 'in_progress' }).where(eq(feedback.id, feedbackId));
  await ctx.answerCbQuery('Marked in progress');
  await ctx.editMessageText(`🔵 Feedback #${feedbackId} marked as in progress.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Back to Feedback', 'admin_page:feedback')]]));
});

// ─── Ambassador Referrals ───

const REFS_PER_PAGE = 15;

b.action('admin_page:ambassador_refs', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const ambassadors = await db.select().from(ambassadorApplications).orderBy(desc(ambassadorApplications.createdAt)).limit(REFS_PER_PAGE);

  // Compute stats per page
  const stats: Record<number, { signups: number; active: number; volume: number }> = {};
  for (const a of ambassadors) {
    if (a.customReferralCode) {
      const signups = await db.select({ count: sql`count(*)` }).from(users).where(eq(users.ambassadorReferralCode, a.customReferralCode));
      const active = await getAmbassadorActiveUserCount(a.customReferralCode);
      const volume = await getAmbassadorTotalVolume(a.customReferralCode);
      stats[a.id] = { signups: Number(signups[0]?.count || 0), active, volume };
    } else {
      stats[a.id] = { signups: 0, active: 0, volume: 0 };
    }
  }

  let list = ambassadors.map((a, i) => {
    const s = stats[a.id];
    const tierBadge = a.tier === 'elite' ? '🥇' : a.tier === 'pro' ? '🥈' : '🥉';
    const statusIcon = a.status === 'confirmed' ? '✅' : a.status === 'removed' ? '❌' : '⏳';
    return `${i + 1}. ${tierBadge} ${statusIcon} *${escapeTelegramMarkdown(a.name)}*\n   Active: ${s.active} | Vol: ₦${s.volume.toLocaleString()} | Code: ${a.customReferralCode ? `\`${a.customReferralCode}\`` : '—'}`;
  }).join('\n\n');

  const text = `🎯 *Ambassador Programme* (page 1) — ${total[0]?.count || 0} total\n\n${list || 'No ambassadors yet.'}\n\nTap an ambassador for details:`;

  const buttons = ambassadors.map(a => [
    Markup.button.callback(`${escapeTelegramMarkdown(a.name)}`, `admin_ambassador_detail:${a.id}`)
  ]);

  const navButtons = [];
  if (Number(total[0]?.count || 0) > REFS_PER_PAGE) {
    navButtons.push(Markup.button.callback('➡️ Next', 'admin_ref_page:1'));
  }
  if (navButtons.length) buttons.push(navButtons);
  buttons.push([Markup.button.callback('🏆 Leaderboard', 'admin_ambassador_leaderboard')]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action(/admin_ref_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * REFS_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const ambassadors = await db.select().from(ambassadorApplications).orderBy(desc(ambassadorApplications.createdAt)).limit(REFS_PER_PAGE).offset(offset);

  // Compute stats per page
  const stats: Record<number, { signups: number; active: number; volume: number }> = {};
  for (const a of ambassadors) {
    if (a.customReferralCode) {
      const signups = await db.select({ count: sql`count(*)` }).from(users).where(eq(users.ambassadorReferralCode, a.customReferralCode));
      const active = await getAmbassadorActiveUserCount(a.customReferralCode);
      const volume = await getAmbassadorTotalVolume(a.customReferralCode);
      stats[a.id] = { signups: Number(signups[0]?.count || 0), active, volume };
    } else {
      stats[a.id] = { signups: 0, active: 0, volume: 0 };
    }
  }

  let list = ambassadors.map((a, i) => {
    const s = stats[a.id];
    const tierBadge = a.tier === 'elite' ? '🥇' : a.tier === 'pro' ? '🥈' : '🥉';
    const statusIcon = a.status === 'confirmed' ? '✅' : a.status === 'removed' ? '❌' : '⏳';
    return `${offset + i + 1}. ${tierBadge} ${statusIcon} *${escapeTelegramMarkdown(a.name)}*\n   Active: ${s.active} | Vol: ₦${s.volume.toLocaleString()} | Code: ${a.customReferralCode ? `\`${a.customReferralCode}\`` : '—'}`;
  }).join('\n\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `🎯 *Ambassador Programme* (page ${page + 1}) — ${totalCount} total\n\n${list || 'No more ambassadors.'}\n\nTap an ambassador for details:`;

  const buttons = ambassadors.map(a => [
    Markup.button.callback(`${escapeTelegramMarkdown(a.name)}`, `admin_ambassador_detail:${a.id}`)
  ]);

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_ref_page:${page - 1}`));
  if (totalCount > offset + REFS_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_ref_page:${page + 1}`));
  if (navButtons.length) buttons.push(navButtons);
  buttons.push([Markup.button.callback('🏆 Leaderboard', 'admin_ambassador_leaderboard')]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action('admin_ambassador_leaderboard', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambassadors = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.status, 'confirmed'));

  const board = [];
  for (const a of ambassadors) {
    if (!a.customReferralCode) continue;
    const active = await getAmbassadorActiveUserCount(a.customReferralCode);
    const volume = await getAmbassadorTotalVolume(a.customReferralCode);
    board.push({ ...a, active, volume });
  }
  board.sort((a, b) => b.active - a.active);

  let list = board.slice(0, 10).map((a, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} *${escapeTelegramMarkdown(a.name)}* — ${a.active} active | ₦${a.volume.toLocaleString()}`;
  }).join('\n\n');

  const text = `🏆 *ZendPayER Leaderboard* — Top ${board.length}\n\n${list || 'No confirmed ambassadors yet.'}`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:ambassador_refs')]]) });
  await ctx.answerCbQuery();
});

b.action(/admin_ambassador_detail:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  const ambRows = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.id, ambId)).limit(1);
  if (ambRows.length === 0) { await ctx.answerCbQuery('Ambassador not found'); return; }
  const amb = ambRows[0];

  let activeCount = 0;
  let totalVolume = 0;
  if (amb.customReferralCode) {
    activeCount = await getAmbassadorActiveUserCount(amb.customReferralCode);
    totalVolume = await getAmbassadorTotalVolume(amb.customReferralCode);
  }

  const computedTier = getAmbassadorTierFromCount(activeCount);
  const rate = getCommissionRateBps(computedTier);
  const commission = calculateCommissionNgn(totalVolume, computedTier);

  const text =
    `🧑‍🎓 *Ambassador Detail*\n\n` +
    `*Name:* ${escapeTelegramMarkdown(amb.name)}\n` +
    `*Handle:* @${escapeTelegramMarkdown(amb.tgHandle.replace(/^@/, ''))}\n` +
    `*Focus:* ${escapeTelegramMarkdown(amb.focus)}\n` +
    `*Student:* ${escapeTelegramMarkdown(amb.isStudent)}\n` +
    `*Status:* ${formatAmbassadorStatus(amb.status)}\n` +
    `*Tier:* ${formatAmbassadorTier(amb.tier)} (computed: ${formatAmbassadorTier(computedTier)})\n\n` +
    `*Referral Code:* ${amb.customReferralCode ? `\`${amb.customReferralCode}\`` : '_(not set)_'}\n` +
    `*Active Users:* ${activeCount}\n` +
    `*Total Volume:* ₦${totalVolume.toLocaleString()}\n` +
    `*Commission Rate:* ${(rate / 100).toFixed(2)}%\n` +
    `*Est. Commission:* ₦${Math.round(commission).toLocaleString()}\n` +
    `${amb.customReferralCode ? `*Link:* \`t.me/zend_money_bot?start=${amb.customReferralCode}\`` : ''}`;

  const buttons = [
    [Markup.button.callback('✏️ Set Code', `admin_set_ambassador_code:${amb.id}`)],
    [Markup.button.callback('👥 View Active Users', `admin_ambassador_signups:${amb.id}`)],
  ];
  if (amb.status === 'pending') {
    buttons.push([Markup.button.callback('✅ Confirm', `admin_confirm_ambassador:${amb.id}`)]);
  }
  if (amb.status !== 'removed') {
    buttons.push([Markup.button.callback('❌ Remove', `admin_remove_ambassador:${amb.id}`)]);
  }
  buttons.push([Markup.button.callback('◀️ Back', 'admin_page:ambassador_refs')]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action(/admin_confirm_ambassador:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  await db.update(ambassadorApplications)
    .set({ status: 'confirmed', confirmedAt: new Date() })
    .where(eq(ambassadorApplications.id, ambId));

  await ctx.answerCbQuery('✅ Ambassador confirmed');
  await ctx.editMessageText('✅ Ambassador confirmed successfully.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]));
});

b.action(/admin_remove_ambassador:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  await db.update(ambassadorApplications)
    .set({ status: 'removed' })
    .where(eq(ambassadorApplications.id, ambId));

  await ctx.answerCbQuery('❌ Ambassador removed');
  await ctx.editMessageText('❌ Ambassador removed. Their referral link is now deactivated.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]));
});

b.action(/admin_set_ambassador_code:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  const ambRows = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.id, ambId)).limit(1);
  if (ambRows.length === 0) { await ctx.answerCbQuery('Ambassador not found'); return; }

  setSession(userId, { state: ConversationState.AWAITING_ADMIN_SET_AMBASSADOR_CODE, pendingTransaction: { recipientName: String(ambId) } as any });

  await ctx.editMessageText(
    `✏️ *Set Referral Code*\n\n` +
    `Ambassador: *${escapeTelegramMarkdown(ambRows[0].name)}*\n\n` +
    `Enter a unique code (lowercase, no spaces, e.g., \`ajemark\`, \`ghali\`):\n\n` +
    `Current: ${ambRows[0].customReferralCode ? `\`${ambRows[0].customReferralCode}\`` : '_(none)_'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `admin_ambassador_detail:${ambId}`)]]) }
  );
  await ctx.answerCbQuery();
});


b.action(/admin_ambassador_signups:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  const ambRows = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.id, ambId)).limit(1);
  if (ambRows.length === 0) { await ctx.answerCbQuery('Ambassador not found'); return; }
  const amb = ambRows[0];

  if (!amb.customReferralCode) {
    await ctx.editMessageText('❌ This ambassador has no referral code set.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]));
    await ctx.answerCbQuery();
    return;
  }

  // Show ACTIVE users only (users with ≥1 completed transaction)
  const activeUsers = await db.select({
    id: users.id,
    name: users.firstName,
    username: users.telegramUsername,
    createdAt: users.createdAt,
  }).from(users)
    .where(
      and(
        eq(users.ambassadorReferralCode, amb.customReferralCode),
        sql`exists (select 1 from ${transactions} where ${transactions.userId} = ${users.id} and ${transactions.status} = 'completed')`
      )
    )
    .orderBy(desc(users.createdAt))
    .limit(20);

  const totalActive = await getAmbassadorActiveUserCount(amb.customReferralCode);

  let list = activeUsers.map((u, i) =>
    `${i + 1}. ${escapeTelegramMarkdown(u.name || 'Unknown')}${u.username ? ` (@${escapeTelegramMarkdown(u.username.replace(/^@/, ''))})` : ''} — ${new Date(u.createdAt).toLocaleDateString('en-NG')}`
  ).join('\n');

  const text =
    `👥 *Active Users via ${escapeTelegramMarkdown(amb.name)}*\n` +
    `Code: \`${amb.customReferralCode}\` | Active: ${totalActive}\n\n` +
    (list || 'No active users yet.');

  const buttons = activeUsers.map(u => [Markup.button.callback(`View ${escapeTelegramMarkdown(u.name || 'User')}`, `admin_user:${u.id}`)]);
  buttons.push([Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action(/admin_txn:(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const txnId = ctx.match[1];
  const txnRows = await db.select().from(transactions).where(eq(transactions.id, txnId)).limit(1);
  if (txnRows.length === 0) {
    await ctx.editMessageText('❌ Transaction not found.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:search')]]));
    await ctx.answerCbQuery();
    return;
  }

  const text = await buildTxnDetailText(txnRows[0]);
  const buttons = [
    [Markup.button.callback('👤 View User', `admin_user:${txnRows[0].userId}`)],
    [Markup.button.callback('🔍 New Search', 'admin_page:search')],
  ];
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

b.action(/admin_user:(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const targetId = ctx.match[1];
  const userRows = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (userRows.length === 0) {
    await ctx.editMessageText('❌ User not found.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:search')]]));
    await ctx.answerCbQuery();
    return;
  }

  const text = await buildUserDetailText(userRows[0]);
  const buttons = [
    [Markup.button.url('💬 Open Chat', `tg://user?id=${targetId}`)],
    [Markup.button.callback('🔍 New Search', 'admin_page:search')],
  ];
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

  registerAdminSearchHandlers(ctx);
}
