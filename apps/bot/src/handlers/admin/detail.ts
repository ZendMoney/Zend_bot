import { db, users, transactions } from '@zend/db';
import { eq, and, sql, desc } from 'drizzle-orm';
import { escapeTelegramMarkdown } from '../../lib/telegram.js';

function formatTxnStatus(status: string): string {
  const map: Record<string, string> = {
    pending: '⏳ Pending',
    processing: '⏳ Processing',
    completed: '✅ Completed',
    failed: '❌ Failed',
    cancelled: '🚫 Cancelled',
  };
  return map[status] || status;
}

function formatTxnType(type: string): string {
  const map: Record<string, string> = {
    offramp: '📤 Off-Ramp',
    ngn_receive: '📥 On-Ramp',
    swap: '🔄 Swap',
    deposit: '⬇️ Deposit',
    withdraw: '⬆️ Withdraw',
  };
  return map[type] || type;
}

export async function buildTxnDetailText(txn: any): Promise<string> {
  const userRows = await db.select({ firstName: users.firstName, telegramUsername: users.telegramUsername }).from(users).where(eq(users.id, txn.userId)).limit(1);
  const u = userRows[0];

  let text = `📋 *Transaction Detail*\n\n`;
  text += `*ID:* \`${txn.id}\`\n`;
  text += `*Type:* ${formatTxnType(txn.type)}\n`;
  text += `*Status:* ${formatTxnStatus(txn.status)}\n`;
  text += `*User:* ${escapeTelegramMarkdown(u?.firstName || 'Unknown')}${u?.telegramUsername ? ` (@${escapeTelegramMarkdown(u.telegramUsername.replace(/^@/, ''))})` : ''}\n`;
  text += `*User ID:* \`${txn.userId}\`\n`;

  if (txn.ngnAmount) {
    text += `\n💰 *Fiat:*\n`;
    text += `   NGN Amount: ₦${Number(txn.ngnAmount).toLocaleString()}\n`;
    if (txn.ngnRate) text += `   Rate: ₦${Number(txn.ngnRate).toLocaleString()}\n`;
  }

  if (txn.fromAmount || txn.toAmount) {
    text += `\n🪙 *Crypto:*\n`;
    if (txn.fromAmount && txn.fromMint) text += `   From: ${Number(txn.fromAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${txn.fromMint.slice(0, 4)}...\n`;
    if (txn.toAmount && txn.toMint) text += `   To: ${Number(txn.toAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${txn.toMint.slice(0, 4)}...\n`;
  }

  text += `\n📊 *Fees:*\n`;
  if (txn.pajFeeBps) text += `   PAJ Fee: ${(txn.pajFeeBps / 100).toFixed(2)}%\n`;
  if (txn.zendSpreadBps) text += `   Zend Spread: ${(txn.zendSpreadBps / 100).toFixed(2)}%\n`;
  if (txn.zendFeeUsdt) text += `   Zend Fee: $${Number(txn.zendFeeUsdt).toLocaleString(undefined, { maximumFractionDigits: 6 })}\n`;

  if (txn.recipientBankName || txn.recipientAccountNumber) {
    text += `\n🏦 *Recipient:*\n`;
    if (txn.recipientBankName) text += `   Bank: ${escapeTelegramMarkdown(txn.recipientBankName)}\n`;
    if (txn.recipientAccountNumber) text += `   Account: \`${txn.recipientAccountNumber}\`\n`;
    if (txn.recipientAccountName) text += `   Name: ${escapeTelegramMarkdown(txn.recipientAccountName)}\n`;
  }

  if (txn.recipientWalletAddress) {
    text += `\n📬 *Wallet Recipient:*\n   \`${txn.recipientWalletAddress}\`\n`;
  }

  if (txn.solanaTxHash) {
    text += `\n🔗 *Solana Tx:*\n   [View on Solscan](https://solscan.io/tx/${txn.solanaTxHash})\n`;
  }

  if (txn.pajReference) text += `\n📌 *PAJ Ref:* \`${txn.pajReference}\`\n`;
  if (txn.nearIntentDepositAddress) text += `📌 *NEAR Intents:* \`${txn.nearIntentDepositAddress}\`\n`;

  if (txn.createdAt) text += `\n🕐 *Created:* ${new Date(txn.createdAt).toLocaleString('en-NG')}\n`;
  if (txn.completedAt) text += `🕐 *Completed:* ${new Date(txn.completedAt).toLocaleString('en-NG')}\n`;

  if (txn.metadata) {
    try {
      const meta = typeof txn.metadata === 'string' ? JSON.parse(txn.metadata) : txn.metadata;
      const metaStr = JSON.stringify(meta, null, 2).slice(0, 300);
      if (metaStr.length > 10) text += `\n📝 *Metadata:*\n\`\`\`\n${escapeTelegramMarkdown(metaStr)}\n\`\`\``;
    } catch { /* ignore */ }
  }

  return text;
}

export async function buildUserDetailText(userRow: any): Promise<string> {
  const txCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.userId, userRow.id));
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(and(eq(transactions.userId, userRow.id), eq(transactions.type, 'ngn_send')));
  const totalNgnIn = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(and(eq(transactions.userId, userRow.id), eq(transactions.type, 'ngn_receive')));

  const recentTxns = await db.select().from(transactions)
    .where(eq(transactions.userId, userRow.id))
    .orderBy(desc(transactions.createdAt))
    .limit(5);

  let text = `👤 *User Detail*\n\n`;
  text += `*Name:* ${escapeTelegramMarkdown(userRow.firstName || 'Unknown')} ${escapeTelegramMarkdown(userRow.lastName || '')}\n`;
  text += `*Username:* ${userRow.telegramUsername ? `@${escapeTelegramMarkdown(userRow.telegramUsername.replace(/^@/, ''))}` : 'N/A'}\n`;
  text += `*ID:* \`${userRow.id}\`\n`;
  text += `*Wallet:* \`${userRow.walletAddress}\`\n`;
  text += `*Tier:* ${userRow.tier || 1} | *Lang:* ${userRow.language || 'en'}\n`;
  if (userRow.autoSaveRateBps) text += `*Auto-save:* ${(userRow.autoSaveRateBps / 100).toFixed(1)}%\n`;
  if (userRow.pajContact) text += `*PAJ Contact:* ${escapeTelegramMarkdown(userRow.pajContact)}\n`;

  if (userRow.virtualAccount) {
    try {
      const va = typeof userRow.virtualAccount === 'string' ? JSON.parse(userRow.virtualAccount) : userRow.virtualAccount;
      if (va?.accountNumber) text += `\n🏦 *Virtual Account:*\n   Bank: ${escapeTelegramMarkdown(va.bankName || 'N/A')}\n   Number: \`${va.accountNumber}\`\n`;
    } catch { /* ignore */ }
  }

  text += `\n📊 *Stats:*\n`;
  text += `   Total Txns: ${txCount[0]?.count || 0}\n`;
  text += `   NGN In: ₦${Number(totalNgnIn[0]?.sum || 0).toLocaleString()}\n`;
  text += `   NGN Out: ₦${Number(totalNgnOut[0]?.sum || 0).toLocaleString()}\n`;

  if (recentTxns.length > 0) {
    text += `\n📋 *Recent Transactions:*\n`;
    text += recentTxns.map((t: any) =>
      `   • ${formatTxnType(t.type)} ${formatTxnStatus(t.status)} | ₦${Number(t.ngnAmount || 0).toLocaleString()} | \`${t.id}\``
    ).join('\n');
  }

  text += `\n\n🕐 *Joined:* ${new Date(userRow.createdAt).toLocaleString('en-NG')}`;
  return text;
}