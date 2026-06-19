import { db, users, transactions } from '@zend/db';
import { eq } from 'drizzle-orm';
import { SOLANA_RPC } from '../deps.js';
import { getNearIntentsClient } from '@zend/near-intents-client';
import { mainMenu } from '../keyboards/index.js';
import { getSession, setSession } from '../session/store.js';
import { indexTransaction } from '../services/nlp.js';
import { fundNearIntentDeposit, formatChainName } from '../services/near-intents-flow.js';
import { ensureUsdtBalance } from '../services/stablecoin.js';
import { ConversationState } from '@zend/shared';
import type { ZendContext } from '../session/types.js';

export async function executeNearIntentWithdraw(ctx: ZendContext, userId: string) {
  const session = getSession(userId);
  const wd = session.withdrawData;
  if (!wd?.amount || !wd.depositAddress || !wd.recipientAddress || !wd.txId) {
    await ctx.reply('❌ Withdrawal session expired. Please start over.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  try {
    await ctx.reply('⏳ Preparing USDT and sending via NEAR Intents...');

    await ensureUsdtBalance(
      userId,
      user[0].walletAddress,
      user[0].walletEncryptedKey,
      wd.amount,
      'cross-chain send'
    );

    const solanaTxHash = await fundNearIntentDeposit(
      user[0].walletEncryptedKey,
      'USDT',
      wd.amount,
      wd.depositAddress,
      SOLANA_RPC
    );

    const nearIntents = getNearIntentsClient();
    if (nearIntents) {
      try {
        await nearIntents.submitDepositTx(wd.depositAddress, solanaTxHash);
      } catch (submitErr) {
        console.warn('[Withdraw] submitDepositTx failed (non-fatal):', submitErr);
      }
    }

    await db.update(transactions)
      .set({
        status: 'processing',
        solanaTxHash,
        metadata: { direction: 'withdraw', destChain: wd.destChain, destToken: wd.destToken },
      })
      .where(eq(transactions.id, wd.txId));

    await indexTransaction(userId, wd.txId, `Withdraw to ${formatChainName(wd.destChain)} via NEAR Intents`, {
      amount: wd.amount,
      chain: wd.destChain,
      recipient: wd.recipientAddress,
    });

    setSession(userId, { state: ConversationState.IDLE });

    await ctx.reply(
      `✅ *Withdrawal Submitted!*\n\n` +
      `Sent: *${wd.amount} ${wd.sourceSymbol}*\n` +
      `To: *${formatChainName(wd.destChain)}* → \`${wd.recipientAddress}\`\n` +
      `Recipient receives: ~${wd.amountOutFormatted || '?'} ${wd.destToken}\n\n` +
      `Solana tx: \`https://solscan.io/tx/${solanaTxHash}\`\n` +
      `Reference: \`${wd.txId}\`\n\n` +
      `⏱️ Cross-chain delivery usually takes 2–15 minutes.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } catch (err: any) {
    console.error('[Withdraw] Failed:', err);
    await db.update(transactions)
      .set({ status: 'failed', metadata: { error: err.message } })
      .where(eq(transactions.id, wd.txId));
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply(
      `❌ *Withdrawal Failed*\n\n${err.message || 'Unknown error'}\nNo funds were deducted.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }
}