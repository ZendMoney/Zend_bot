import { Markup } from 'telegraf';
import { db, users, transactions, pushNotifications } from '@zend/db';
import { eq, and, gte, lt, sql, inArray, notInArray } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { setSession, getSession } from '../../session/store.js';
import { requireAdminAction } from './auth.js';
import type { HandlerContext } from '../types.js';

const BATCH_SIZE = 50;

export const PUSH_SEGMENTS = [
  { key: 'all', label: '👥 All Users' },
  { key: 'new_users', label: '🆕 New Users (last 7 days)' },
  { key: 'old_users', label: '📅 Old Users (7+ days)' },
  { key: 'active', label: '⚡ Active (tx in last 30 days)' },
  { key: 'inactive', label: '💤 Inactive (no tx in 30 days)' },
  { key: 'tier_1', label: '🔰 Tier 1' },
  { key: 'tier_2', label: '⭐ Tier 2' },
  { key: 'tier_3', label: '💎 Tier 3' },
  { key: 'language_en', label: '🌐 English' },
  { key: 'language_es', label: '🌐 Spanish' },
];

function segmentLabel(key: string): string {
  return PUSH_SEGMENTS.find((s) => s.key === key)?.label || key;
}

async function getTargetUserIds(segment: string): Promise<string[]> {
  const now = new Date();

  if (segment === 'all') {
    const rows = await db.select({ id: users.id }).from(users);
    return rows.map((r) => r.id);
  }

  if (segment === 'new_users') {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db.select({ id: users.id }).from(users).where(gte(users.createdAt, cutoff));
    return rows.map((r) => r.id);
  }

  if (segment === 'old_users') {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db.select({ id: users.id }).from(users).where(lt(users.createdAt, cutoff));
    return rows.map((r) => r.id);
  }

  if (segment === 'active' || segment === 'inactive') {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const activeRows = await db
      .selectDistinct({ userId: transactions.userId })
      .from(transactions)
      .where(and(eq(transactions.status, 'completed'), gte(transactions.createdAt, cutoff)));
    const activeIds = activeRows.map((r) => r.userId).filter(Boolean) as string[];

    if (segment === 'active') return activeIds;

    const allRows = await db.select({ id: users.id }).from(users);
    const activeSet = new Set(activeIds);
    return allRows.map((r) => r.id).filter((id) => !activeSet.has(id));
  }

  if (segment.startsWith('tier_')) {
    const tier = parseInt(segment.replace('tier_', ''), 10);
    if (isNaN(tier)) return [];
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.tier, tier));
    return rows.map((r) => r.id);
  }

  if (segment.startsWith('language_')) {
    const lang = segment.replace('language_', '');
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.language, lang));
    return rows.map((r) => r.id);
  }

  return [];
}

export function registerAdminPushHandlers({ bot: b }: HandlerContext): void {
  b.action('admin_page:push', async (ctx) => {
    if (!(await requireAdminAction(ctx))) return;
    await ctx.editMessageText(
      '📢 *Push Notifications*\n\n' +
      'Send a broadcast message to a selected group of users.\n\n' +
      'Messages are sent from the bot directly to each user.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✍️ Compose Message', 'admin_push:start')], [Markup.button.callback('◀️ Back', 'admin_back')]]),
      }
    );
    await ctx.answerCbQuery();
  });

  b.action('admin_push:start', async (ctx) => {
    if (!(await requireAdminAction(ctx))) return;
    const userId = ctx.from!.id.toString();
    setSession(userId, { state: ConversationState.AWAITING_ADMIN_PUSH_MESSAGE });
    await ctx.editMessageText(
      '📝 *Compose Push Message*\n\n' +
      'Enter the message you want to broadcast. Markdown is supported.\n\n' +
      'Example: `🎉 New feature: you can now buy airtime with USDT!`',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_back')]]) }
    );
    await ctx.answerCbQuery();
  });

  b.action(/^admin_push:segment:(.+)$/, async (ctx) => {
    if (!(await requireAdminAction(ctx))) return;
    const userId = ctx.from!.id.toString();
    const segment = ctx.match![1];
    const session = getSession(userId);
    const message = session.pendingTransaction?.pushMessage;
    if (!message) {
      await ctx.editMessageText('❌ Message missing. Please start over.', { ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:push')]]) });
      await ctx.answerCbQuery();
      return;
    }

    session.pendingTransaction = { ...session.pendingTransaction, pushSegment: segment };
    session.state = ConversationState.AWAITING_ADMIN_PUSH_CONFIRM;
    setSession(userId, session);

    const targetIds = await getTargetUserIds(segment);
    const preview =
      `📢 *Confirm Push Notification*\n\n` +
      `*Segment:* ${segmentLabel(segment)}\n` +
      `*Recipients:* ${targetIds.length.toLocaleString()}\n\n` +
      `*Message:*\n${message}\n\n` +
      `Send now?`;

    await ctx.editMessageText(preview, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Send', 'admin_push:confirm')],
        [Markup.button.callback('◀️ Change Segment', 'admin_push:start')],
        [Markup.button.callback('❌ Cancel', 'admin_back')],
      ]),
    });
    await ctx.answerCbQuery();
  });

  b.action('admin_push:confirm', async (ctx) => {
    if (!(await requireAdminAction(ctx))) return;
    const userId = ctx.from!.id.toString();
    const session = getSession(userId);
    const message = session.pendingTransaction?.pushMessage;
    const segment = session.pendingTransaction?.pushSegment as string | undefined;

    if (!message || !segment) {
      await ctx.editMessageText('❌ Session expired. Please start over.', { ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:push')]]) });
      await ctx.answerCbQuery();
      return;
    }

    setSession(userId, { state: ConversationState.IDLE });
    const loading = await ctx.editMessageText('⏳ Sending push notification...');

    try {
      const targetIds = await getTargetUserIds(segment);
      let sent = 0;
      let failed = 0;

      for (let i = 0; i < targetIds.length; i += BATCH_SIZE) {
        const batch = targetIds.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (id) => {
            try {
              await ctx.telegram.sendMessage(id, message, { parse_mode: 'Markdown' });
              sent++;
            } catch (err: any) {
              console.warn(`[Push] Failed to send to ${id}:`, err.message);
              failed++;
            }
          })
        );
      }

      await db.insert(pushNotifications).values({
        adminId: userId,
        message,
        segment,
        status: 'sent',
        recipientCount: sent,
        sentAt: new Date(),
      });

      await ctx.editMessageText(
        `✅ *Push Sent*\n\n` +
        `Segment: ${segmentLabel(segment)}\n` +
        `Delivered: ${sent.toLocaleString()}\n` +
        `Failed: ${failed.toLocaleString()}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:push')]]) }
      );
    } catch (err: any) {
      console.error('[Push] Broadcast failed:', err);
      await ctx.editMessageText(
        `❌ *Push Failed*\n\nError: ${err.message || 'Unknown error'}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:push')]]) }
      );
    }
    await ctx.answerCbQuery();
  });
}
