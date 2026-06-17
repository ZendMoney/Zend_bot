import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { ConversationState, NIGERIAN_BANKS } from '@zend/shared';
import { getPAJClient } from '../deps.js';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { escapeTelegramMarkdown } from '../lib/telegram.js';
import { showLoading, updateLoading, finishLoading } from '../lib/loading.js';
import { getSession, setSession } from '../session/store.js';
import { calculateSendFee } from '../services/gas.js';
import { getPAJRates } from '../services/paj.js';
import { executeSendCore } from '../services/send.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export function parseBulkRecipient(line: string): { amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 4) return null;

  const amount = parseInt(tokens[0].replace(/[^0-9]/g, ''), 10);
  if (!amount || amount < 100) return null;

  const bankCodeInput = tokens[1].toUpperCase();
  const bank = NIGERIAN_BANKS.find(b => b.code === bankCodeInput);
  if (!bank) return null;

  const accountNumber = tokens[2];
  if (!/^\d{10}$/.test(accountNumber)) return null;

  const accountName = tokens.slice(3).join(' ');
  if (accountName.length < 2) return null;

  return { amountNgn: amount, bankCode: bank.code, bankName: bank.name, accountNumber, accountName };
}

export async function executeBulkSend(
  ctx: ZendContext,
  userId: string,
  recipients: Array<{ amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string }>
): Promise<void> {
  const loading = await showLoading(ctx, `Executing ${recipients.length} transfers...`);

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const walletAddress = user[0]?.walletAddress;

  const pajClient = await getPAJClient();
  let rate = 1550;
  try {
    if (pajClient) {
      const rates = await getPAJRates();
      rate = rates.offRampRate;
    }
  } catch { /* fallback */ }

  const results: Array<{ success: boolean; recipient: string; amountNgn: number; error?: string; txId?: string }> = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const transferUsdt = r.amountNgn / rate;

    const feeInfo = walletAddress
      ? await calculateSendFee(transferUsdt, walletAddress, userId)
      : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
    const amountUsdt = transferUsdt + feeInfo.zendFeeUsdt;

    await updateLoading(ctx, loading.message_id, `Transfer ${i + 1}/${recipients.length}: ${r.accountName}...`);

    try {
      const result = await executeSendCore(userId, {
        amountNgn: r.amountNgn,
        amountUsdt,
        ngnRate: rate,
        zendFeeUsdt: feeInfo.zendFeeUsdt,
        feeSol: feeInfo.feeSol,
        recipientBankCode: r.bankCode,
        recipientBankName: r.bankName,
        recipientAccountNumber: r.accountNumber,
        recipientAccountName: r.accountName,
        recipientName: r.accountName,
      });

      results.push({
        success: result.success,
        recipient: r.accountName,
        amountNgn: r.amountNgn,
        txId: result.txId,
        error: result.error,
      });
    } catch (err: any) {
      results.push({
        success: false,
        recipient: r.accountName,
        amountNgn: r.amountNgn,
        error: err.message || 'Transfer failed',
      });
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const totalSent = results.filter(r => r.success).reduce((sum, r) => sum + r.amountNgn, 0);

  let report = `📦 *Bulk Send Complete*\n\n`;
  report += `✅ Successful: ${successCount}\n`;
  report += `❌ Failed: ${failCount}\n`;
  report += `💰 Total Sent: ₦${totalSent.toLocaleString()}\n\n`;

  if (failCount > 0) {
    report += `*Failed transfers:*\n`;
    report += results.filter(r => !r.success).map(r =>
      `• ${escapeTelegramMarkdown(r.recipient)} — ₦${r.amountNgn.toLocaleString()}: ${escapeTelegramMarkdown(r.error || 'Unknown error')}`
    ).join('\n');
    report += '\n\n';
  }

  if (successCount > 0) {
    report += `*Successful transfers:*\n`;
    report += results.filter(r => r.success).map(r =>
      `• ${escapeTelegramMarkdown(r.recipient)} — ₦${r.amountNgn.toLocaleString()}${r.txId ? ` (\`${r.txId}\`)` : ''}`
    ).join('\n');
  }

  await finishLoading(ctx, loading.message_id, report, 'Markdown');
  await ctx.reply('Menu:', mainMenu);
}

export async function startBulkSend(ctx: ZendContext, userId: string) {
  setSession(userId, { state: ConversationState.AWAITING_BULK_SEND_INPUT, pendingTransaction: { bulkRecipients: [] } as any });
  await ctx.reply(
    `📦 *Bulk Send*\n\n` +
    `Send money to multiple people at once.\n\n` +
    `Paste your recipient list. One per line, format:\n` +
    `\`AMOUNT BANK_CODE ACCOUNT_NUMBER ACCOUNT_NAME\`\n\n` +
    `*Example:*\n` +
    `\`\`\`\n` +
    `50000 GTB 0123456789 John Doe\n` +
    `30000 UBA 9876543210 Jane Smith\n` +
    `25000 OPY 1234567890 Mike Johnson\n` +
    `\`\`\`\n\n` +
    `Supported banks: GTB, UBA, ACC, ZEN, FBN, ECO, OPY, KUD, MON, etc.`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

export function registerBulkSendHandlers({ bot: b }: HandlerContext): void {
  b.command('bulksend', async (ctx) => {
    await startBulkSend(ctx, ctx.from.id.toString());
  });

  b.hears('📦 Bulk Send', async (ctx) => {
    await startBulkSend(ctx, ctx.from.id.toString());
  });

  b.action('bulk_send_confirm', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = getSession(userId);
    const recipients = (session.pendingTransaction as any)?.bulkRecipients as Array<{ amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string }> | undefined;

    if (!recipients || recipients.length === 0) {
      await ctx.answerCbQuery('Session expired');
      await ctx.editMessageText('❌ Session expired. Please start over.');
      return;
    }

    setSession(userId, { state: ConversationState.IDLE });
    await ctx.answerCbQuery('Executing...');
    await executeBulkSend(ctx, userId, recipients);
  });

  b.action('bulk_send_cancel', async (ctx) => {
    const userId = ctx.from.id.toString();
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageText('❌ Bulk send cancelled.');
  });
}