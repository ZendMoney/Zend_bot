import type { Telegraf } from 'telegraf';
import { db, users, savedBankAccounts, scheduledTransfers } from '@zend/db';
import { eq, and, sql } from 'drizzle-orm';
import { mainMenu } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';
import { md } from '../lib/telegram.js';
import { calculateSendFee } from '../services/gas.js';
import { getPAJRates } from '../services/paj.js';
import { executeSendCore } from '../services/send.js';
import { checkMilestones } from '../services/milestones.js';

let _scheduledRunning = false;

export async function runScheduledTransfers(bot: Telegraf<any>): Promise<void> {
  if (_scheduledRunning) {
    console.log('[Schedule] Skipping: previous run still in progress');
    return;
  }
  _scheduledRunning = true;

  try {
    const now = new Date();
    const due = await db.select().from(scheduledTransfers)
      .where(and(eq(scheduledTransfers.isActive, true), sql`${scheduledTransfers.nextRunAt} <= ${now.toISOString()}`));

    for (const s of due) {
      try {
        const accounts = await db.select().from(savedBankAccounts)
          .where(eq(savedBankAccounts.id, s.recipientBankAccountId))
          .limit(1);

        if (accounts.length === 0) {
          console.log(`[Schedule] Skipping #${s.id}: recipient account not found`);
          continue;
        }

        const acc = accounts[0];

        let rate = 1550;
        try {
          const rates = await getPAJRates();
          rate = rates.offRampRate;
        } catch { /* use fallback */ }

        const transferUsdt = Number(s.amountNgn) / rate;

        const userRow = await db.select().from(users).where(eq(users.id, s.userId)).limit(1);
        const feeInfo = userRow[0]?.walletAddress
          ? await calculateSendFee(transferUsdt, userRow[0].walletAddress, s.userId)
          : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
        const amountUsdt = transferUsdt + feeInfo.zendFeeUsdt;

        const result = await executeSendCore(s.userId, {
          amountNgn: Number(s.amountNgn),
          amountUsdt,
          ngnRate: rate,
          zendFeeUsdt: feeInfo.zendFeeUsdt,
          feeSol: feeInfo.feeSol,
          recipientBankCode: acc.bankCode,
          recipientBankName: acc.bankName,
          recipientAccountNumber: acc.accountNumber,
          recipientAccountName: acc.accountName,
        });

        try {
          if (result.success) {
            await bot.telegram.sendMessage(
              s.userId,
              `✅ *Scheduled Transfer Executed*\n\n` +
              `Amount: ${formatNgn(Number(s.amountNgn))}\n` +
              `To: ${md(acc.accountName)}\n` +
              `Bank: ${md(acc.bankName)} • \`${acc.accountNumber}\`\n\n` +
              `Reference: \`${result.txId}\`\n` +
              (result.solanaTxHash ? `Tx: \`https://solscan.io/tx/${result.solanaTxHash}\`\n` : '') +
              `Time: ~2 minutes`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
            await checkMilestones(s.userId, (text) => bot.telegram.sendMessage(s.userId, text, { parse_mode: 'Markdown', ...mainMenu }));
          } else {
            await bot.telegram.sendMessage(
              s.userId,
              `❌ *Scheduled Transfer Failed*\n\n` +
              `Amount: ${formatNgn(Number(s.amountNgn))}\n` +
              `To: ${md(acc.accountName)}\n` +
              `Bank: ${md(acc.bankName)} • \`${acc.accountNumber}\`\n\n` +
              `Error: ${result.error || 'Unknown error'}\n` +
              `No funds were deducted.`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
          }
        } catch (notifyErr) {
          console.log('[Schedule] Could not notify user:', notifyErr);
        }

        const newRunCount = s.runCount + 1;
        const updates: Record<string, unknown> = { runCount: newRunCount };

        if (s.frequency === 'once') {
          updates.isActive = false;
        } else {
          const next = new Date();
          if (s.frequency === 'daily') next.setDate(next.getDate() + 1);
          else if (s.frequency === 'weekly') next.setDate(next.getDate() + 7);
          else if (s.frequency === 'monthly') next.setMonth(next.getMonth() + 1);
          updates.nextRunAt = next;
        }

        if (s.maxRuns && newRunCount >= s.maxRuns) {
          updates.isActive = false;
        }
        if (s.endAt && now >= s.endAt) {
          updates.isActive = false;
        }

        await db.update(scheduledTransfers)
          .set(updates)
          .where(eq(scheduledTransfers.id, s.id));

        console.log(`[Schedule] Executed #${s.id} for user ${s.userId}`);
      } catch (err) {
        console.error(`[Schedule] Error processing #${s.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[Schedule] Executor error:', err);
  } finally {
    _scheduledRunning = false;
  }
}