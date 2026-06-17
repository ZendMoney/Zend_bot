import { db, users, transactions } from '@zend/db';
import { eq } from 'drizzle-orm';
import {
  ConversationState,
  SOLANA_TOKENS,
  PAJ_MIN_DEPOSIT_NGN,
  PAJ_MAX_DEPOSIT_NGN,
} from '@zend/shared';
import { Currency, Chain, getPAJClient, getPajWebhookUrl } from '../deps.js';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';
import { md } from '../lib/telegram.js';
import { showLoading, finishLoading } from '../lib/loading.js';
import { generateTxId } from '../lib/ids.js';
import { setSession } from '../session/store.js';
import { getPAJRates, isPajSessionError, clearPajSession } from '../services/paj.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showVirtualAccount(
  ctx: ZendContext,
  userId: string,
  sessionToken: string,
  amount?: number,
  rate?: number,
  fee?: number,
  targetToken: 'USDT' | 'AUDD' = 'USDT'
): Promise<void> {
  const pajClient = await getPAJClient();
  if (!pajClient) {
    await ctx.reply('❌ PAJ service unavailable.', mainMenu);
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user.length || !user[0].walletAddress) {
    await ctx.reply('❌ User profile incomplete. Please run /start.', mainMenu);
    return;
  }
  const walletAddress = user[0].walletAddress;

  const fiatAmount = amount && amount >= PAJ_MIN_DEPOSIT_NGN && amount <= PAJ_MAX_DEPOSIT_NGN ? amount : PAJ_MIN_DEPOSIT_NGN;

  let _rate = rate || 1550;
  let _fee = fee || 0;
  if (!rate) {
    try {
      const rates = await getPAJRates();
      _rate = rates.onRampRate;
    } catch (err) {
      console.log('Using fallback rate for VA display');
    }
  }
  const usdtAmount = fiatAmount / _rate;
  const receiveLabel = targetToken === 'AUDD' ? 'AUDD' : 'Dollars';

  let virtualAccount: any = user[0]?.virtualAccount;
  const webhookUrl = getPajWebhookUrl();

  const loadingVA = await showLoading(ctx, 'Creating your virtual bank account...');
  let order: any;
  try {
    order = await pajClient.createOnramp({
      fiatAmount,
      currency: Currency.NGN,
      recipient: walletAddress,
      mint: targetToken === 'AUDD' ? SOLANA_TOKENS.AUDD.mint : SOLANA_TOKENS.USDT.mint,
      chain: Chain.SOLANA,
      webhookURL: webhookUrl,
    }, sessionToken);

    virtualAccount = {
      bankCode: 'WEM',
      bankName: order.bank,
      accountNumber: order.accountNumber,
      accountName: order.accountName,
      orderId: order.id,
      amount: fiatAmount,
      createdAt: new Date().toISOString(),
    };

    await db.update(users)
      .set({ virtualAccount })
      .where(eq(users.id, userId));

    console.log('[PAJ] Virtual account created:', order.accountNumber, 'for ₦', fiatAmount, 'bank:', order.bank, 'name:', order.accountName, 'orderId:', order.id, 'fullOrder:', JSON.stringify(order));
  } catch (err: any) {
    console.error('[PAJ] createOnramp failed:', err);
    console.error('[PAJ] createOnramp error details:', err.response?.data || err.body || 'No extra details');
    if (isPajSessionError(err)) {
      await clearPajSession(userId);
      await finishLoading(ctx, loadingVA.message_id, '⚠️ Your PAJ session expired. Please re-link in Settings.');
      await ctx.reply(
        `⚠️ *PAJ Session Expired*\n\n` +
        `Go to *⚙️ Settings → 🔗 Link PAJ* to reconnect.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }
    await finishLoading(ctx, loadingVA.message_id, `❌ Could not create virtual account.\nError: ${err.message || 'Unknown error'}`);
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  const txId = generateTxId();
  await db.insert(transactions).values({
    id: txId,
    userId,
    type: 'ngn_receive',
    status: 'pending',
    ngnAmount: String(fiatAmount),
    ngnRate: String(order?.rate || _rate),
    fromAmount: String(order?.amount || usdtAmount),
    pajReference: order.id,
    pajPoolAddress: walletAddress,
    recipientWalletAddress: walletAddress,
    metadata: { virtualAccount, source: 'fresh', targetToken },
  });

  const displayRate = order?.rate || _rate;
  const displayFee = order?.fee || _fee;
  const displayReceive = order?.amount || usdtAmount;

  const isExactAmount = amount && amount >= PAJ_MIN_DEPOSIT_NGN;
  const menuTitle = targetToken === 'AUDD' ? '🇦🇺 Add AUDD' : '💵 Add Naira';
  await finishLoading(ctx, loadingVA.message_id,
    `${menuTitle}\n\n` +
    `*Deposit Details:*\n` +
    (isExactAmount ? `Amount: ${formatNgn(fiatAmount)}\n` : `Minimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n`) +
    `Rate: ₦${displayRate.toLocaleString()}/USD\n` +
    `Fee: ${formatNgn(displayFee)}\n` +
    `You receive: ~${Number(displayReceive).toFixed(2)} ${receiveLabel}\n\n` +
    `*Send bank transfer to:*\n` +
    `🏦 *${md(virtualAccount.bankName)}*\n` +
    `🔢 \`${virtualAccount.accountNumber}\`\n` +
    `👤 *${md(virtualAccount.accountName)}*\n\n` +
    `⏱️ Arrives in: 2-5 minutes\n\n` +
    `⚠️ *Important:* Send from a bank account in your name.`,
    'Markdown'
  );
  await ctx.reply(virtualAccount.accountNumber);
}

export async function startAddNaira(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT, onrampTargetToken: 'USDT' });

  await ctx.reply(
    `💵 *Add Naira*\n\n` +
    `How much NGN do you want to deposit?\n\n` +
    `You'll receive US Dollars (USDT) in your wallet.\n\n` +
    `Minimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n\n` +
    `Enter the amount (numbers only):`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

export async function startAddAudd(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT, onrampTargetToken: 'AUDD' });

  await ctx.reply(
    `🇦🇺 *Add AUDD*\n\n` +
    `How much NGN do you want to deposit?\n\n` +
    `You'll receive Australian Digital Dollars (AUDD) in your wallet.\n\n` +
    `Minimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n\n` +
    `Enter the amount (numbers only):`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

export function registerOnrampHandlers({ bot: b }: HandlerContext): void {
  b.hears('💵 Add Naira', async (ctx) => {
    await startAddNaira(ctx, ctx.from.id.toString());
  });

  b.action('add_naira_start', async (ctx) => {
    await ctx.answerCbQuery();
    await startAddNaira(ctx, ctx.from!.id.toString());
  });

  b.command('addaudd', async (ctx) => {
    await startAddAudd(ctx, ctx.from.id.toString());
  });

  b.action('add_aud_start', async (ctx) => {
    await ctx.answerCbQuery();
    await startAddAudd(ctx, ctx.from!.id.toString());
  });
}