import { Markup } from 'telegraf';
import { db, users, savedBankAccounts, scheduledTransfers } from '@zend/db';
import { eq, and } from 'drizzle-orm';
import { ConversationState, NIGERIAN_BANKS } from '@zend/shared';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { md } from '../lib/telegram.js';
import { formatNgn } from '../lib/format.js';
import { isGroupChat, promptPrivateChat } from '../lib/group.js';
import { getSession, setSession } from '../session/store.js';
import { verifyBankAccount } from '../services/paj.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showScheduleMenu(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'schedule transfers');
    return;
  }

  // Get saved bank accounts
  const accounts = await db.select().from(savedBankAccounts).where(eq(savedBankAccounts.userId, userId));

  // Show saved accounts + add new + view schedules
  const rows: any[] = accounts.map(acc =>
    [Markup.button.callback(`${acc.bankName} • ${acc.accountNumber}`, `schedule_recipient:${acc.id}`)]
  );
  rows.push([Markup.button.callback('➕ Add New Recipient', 'schedule_add_recipient')]);
  rows.push([Markup.button.callback('📋 View My Schedules', 'schedule_view')]);

  await ctx.reply(
    `📅 *Schedule Transfer*\n\n` +
    (accounts.length > 0
      ? `Select a saved recipient:`
      : `You don't have any saved recipients yet.\n\nTap *➕ Add New Recipient* to add one.`),
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
}


export function registerScheduleHandlers({ bot: b }: HandlerContext): void {

  b.hears('📅 Schedule', async (ctx) => {
  await showScheduleMenu(ctx, ctx.from.id.toString());
});

  b.action('schedule_start', async (ctx) => {
  await ctx.answerCbQuery();
  await showScheduleMenu(ctx, ctx.from!.id.toString());
});

  b.action('schedule_add_recipient', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, {
    state: ConversationState.AWAITING_SCHEDULE_RECIPIENT,
    scheduleData: {},
  });
  await ctx.editMessageText(
    `📅 *Add New Recipient*\n\n` +
    `Enter the bank name and account number.\n\n` +
    `Example: *GTB 0123456789*\n` +
    `Or: *Opay 7082406410*`,
    { parse_mode: 'Markdown' }
  );
  await ctx.reply('Waiting for recipient details...', cancelKeyboard);
});

  b.action(/schedule_bank:([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  const bankCode = ctx.match[1];

  if (session.state !== ConversationState.AWAITING_BANK_DETAILS || !session.scheduleData?.pendingAccountNumber) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  const bank = NIGERIAN_BANKS.find(b => b.code === bankCode);
  if (!bank) {
    await ctx.editMessageText('❌ Invalid bank selected.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  const accountNumber = session.scheduleData.pendingAccountNumber;

  // Try to verify account name via PAJ if linked
  let accountName = 'Unknown';
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user[0]?.pajSessionToken) {
    try {
      const verification = await verifyBankAccount(user[0].pajSessionToken, bank.code, accountNumber);
      if (verification.verified && verification.accountName) {
        accountName = verification.accountName;
      }
    } catch {
      // Non-critical
    }
  }

  // Save to savedBankAccounts
  const saved = await db.insert(savedBankAccounts).values({
    userId,
    bankCode: bank.code,
    bankName: bank.name,
    accountNumber,
    accountName,
    verified: accountName !== 'Unknown',
  }).returning();

  const savedId = saved[0]?.id;
  setSession(userId, {
    state: ConversationState.AWAITING_SCHEDULE_AMOUNT,
    scheduleData: {
      recipientBankAccountId: savedId,
      recipientName: accountName,
      bankName: bank.name,
      accountNumber,
    },
  });

  await ctx.editMessageText(
    `✅ *Recipient Saved*\n\n` +
    `Name: ${md(accountName)}\n` +
    `Bank: ${md(bank.name)}\n` +
    `Account: \`${accountNumber}\`\n\n` +
    `How much NGN do you want to send each time?\n` +
    `Example: 50000`,
    { parse_mode: 'Markdown' }
  );
});

  b.action(/schedule_recipient:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const accountId = parseInt(ctx.match[1], 10);

  const accounts = await db.select().from(savedBankAccounts)
    .where(and(eq(savedBankAccounts.userId, userId), eq(savedBankAccounts.id, accountId)))
    .limit(1);

  if (accounts.length === 0) {
    await ctx.editMessageText('❌ Account not found.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  const acc = accounts[0];
  setSession(userId, {
    state: ConversationState.AWAITING_SCHEDULE_AMOUNT,
    scheduleData: {
      recipientBankAccountId: acc.id,
      recipientName: acc.accountName,
      bankName: acc.bankName,
      accountNumber: acc.accountNumber,
    },
  });

  await ctx.editMessageText(
    `📅 *Schedule Transfer*\n\n` +
    `Recipient: ${md(acc.accountName)}\n` +
    `Bank: ${md(acc.bankName)}\n` +
    `Account: \`${acc.accountNumber}\`\n\n` +
    `How much NGN do you want to send each time?\n` +
    `Example: 50000`,
    { parse_mode: 'Markdown' }
  );
  await ctx.reply('Waiting for amount...', cancelKeyboard);
});

  b.action(/schedule_freq:(\w+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);

  if (session.state !== ConversationState.AWAITING_SCHEDULE_FREQUENCY || !session.scheduleData) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    return;
  }

  const freq = ctx.match[1] as 'once' | 'daily' | 'weekly' | 'monthly';
  session.scheduleData.frequency = freq;
  session.state = ConversationState.AWAITING_SCHEDULE_START;
  setSession(userId, session);

  await ctx.editMessageText(
    `📅 *Schedule Transfer*\n\n` +
    `Frequency: *${freq}*\n\n` +
    `When should the first transfer happen?\n` +
    `Enter a date (YYYY-MM-DD) or type *now* to start immediately.`,
    { parse_mode: 'Markdown' }
  );
  await ctx.reply('Waiting for start date...', cancelKeyboard);
});

  b.action('cancel_schedule', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Schedule creation cancelled.');
  await ctx.reply('Menu:', mainMenu);
});

  b.action('schedule_view', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();

    const schedules = await db.select().from(scheduledTransfers)
      .where(eq(scheduledTransfers.userId, userId))
      .orderBy(scheduledTransfers.nextRunAt);

    console.log(`[Schedule] View requested by user ${userId}. Found ${schedules.length} schedules:`, schedules.map(s => ({ id: s.id, active: s.isActive, freq: s.frequency, next: s.nextRunAt })));

    if (schedules.length === 0) {
      await ctx.editMessageText('📅 You have no scheduled transfers.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    let msg = `📅 *Your Scheduled Transfers*\n\n`;
    const rows: any[] = [];

    for (const s of schedules) {
      const status = s.isActive ? '🟢 Active' : '🔴 Paused';
      let next = '—';
      try {
        if (s.nextRunAt) {
          const d = s.nextRunAt instanceof Date ? s.nextRunAt : new Date(s.nextRunAt as any);
          next = d.toLocaleDateString('en-NG');
        }
      } catch (e) {
        console.error(`[Schedule] Failed to format nextRunAt for schedule ${s.id}:`, e);
      }
      msg += `${status} • ${formatNgn(Number(s.amountNgn))} • ${s.frequency}\n`;
      msg += `   Next: ${next}  •  Runs: ${s.runCount}\n\n`;
      if (s.isActive) {
        rows.push([Markup.button.callback(`❌ Cancel #${s.id}`, `schedule_cancel:${s.id}`)]);
      }
    }

    // Telegram message text limit is 4096 chars — truncate if needed
    if (msg.length > 4000) {
      msg = msg.substring(0, 4000) + '\n\n... (more schedules — contact support if needed)';
    }

    await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
    if (rows.length > 0) {
      await ctx.reply('Tap to cancel:', Markup.inlineKeyboard(rows));
    }
    await ctx.reply('Menu:', mainMenu);
  } catch (err) {
    console.error('[Schedule] Error in schedule_view:', err);
    await ctx.reply('❌ Something went wrong loading your schedules. Please try again.', mainMenu);
  }
});

  b.action(/schedule_cancel:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const scheduleId = parseInt(ctx.match[1], 10);

  console.log(`[Schedule] Cancel requested by user ${userId} for schedule #${scheduleId}`);

  const result = await db.update(scheduledTransfers)
    .set({ isActive: false })
    .where(and(eq(scheduledTransfers.id, scheduleId), eq(scheduledTransfers.userId, userId)))
    .returning();

  console.log(`[Schedule] Cancel result for #${scheduleId}:`, result.length > 0 ? 'success' : 'not found');

  await ctx.editMessageText(`✅ Scheduled transfer #${scheduleId} has been cancelled.`);
  await ctx.reply('Menu:', mainMenu);
});
}
