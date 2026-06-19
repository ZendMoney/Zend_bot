import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { db, users, transactions, savedBankAccounts, ambassadorApplications, feedback } from '@zend/db';
import { eq, sql, and } from 'drizzle-orm';
import {
  ConversationState,
  SOLANA_TOKENS,
  NIGERIAN_BANKS,
  PAJ_MIN_DEPOSIT_NGN,
  PAJ_MAX_DEPOSIT_NGN,
} from '@zend/shared';
import {
  parseCommand,
  chatWithAI,
  chatWithKimi,
  isCasualGreeting,
  parseMenuInputWithAI,
  askTransactionQuestion,
  indexTransaction,
  parseBulkSendWithAI,
} from '../../services/nlp.js';
import { getPAJClient, walletService, airbillsClient } from '../../deps.js';
import { getStablecoinBalances } from '../../services/stablecoin.js';
import { getDataPlans, type DataPlan } from '../../services/bills/index.js';
import { getDataPlansForNetwork } from '../../services/airbills/plans.js';
import { mainMenu, cancelKeyboard, REPLY_KEYBOARD_BUTTONS } from '../../keyboards/index.js';
import { md, escapeTelegramMarkdown } from '../../lib/telegram.js';
import { formatNgn, formatBalance } from '../../lib/format.js';
import { showLoading, finishLoading } from '../../lib/loading.js';
import { getBotFeatures } from '../../services/bot-features.js';
import { showBridgeMenu } from '../bridge.js';
import { isGroupChat } from '../../lib/group.js';
import { sanitizeAccountNumber } from '../../lib/account.js';
import { hashPin, verifyPin } from '../../lib/pin.js';
import { getSession, setSession } from '../../session/store.js';
import { checkSendBalance } from '../../utils/send-balance.js';
import { formatNearIntentsError } from '../../utils/api-errors.js';
import {
  formatSendFeeLabel,
  MIN_SOL_FOR_GAS,
  type SendFeeInfo,
} from '../../utils/fees.js';
import { calculateSendFee } from '../../services/gas.js';
import {
  getPAJRates,
  verifyBankAccount,
} from '../../services/paj.js';
import { generateTxId } from '../../lib/ids.js';
import { CHAIN_DISPLAY_NAMES, resolveTokenDecimals } from '@zend/near-intents-client';
import {
  createDepositQuote,
  formatExactAmountDepositWarning,
  createWithdrawQuote,
  formatChainName,
  validateChainAddress,
} from '../../services/near-intents-flow.js';
import { getSolPriceInUsdt } from '../../utils/sol-price.js';
import { AUDD_ENABLED } from '../../utils/flags.js';
import { startOnboarding } from '../start.js';
import { executeSend } from '../send.js';
import { handleSwapAmount } from '../swap.js';
import { executeSwap } from '../../services/swap.js';
import { showVirtualAccount } from '../onramp.js';
import { parseBulkRecipient, executeBulkSend } from '../bulk-send.js';
import { doExportKey } from '../wallet-export.js';
import { executeNearIntentWithdraw } from '../withdraw-execute.js';
import { saveScheduledTransfer } from '../schedule/save.js';
import { adminMainKeyboard, adminSearchKeyboard } from '../admin/keyboards.js';
import { buildTxnDetailText, buildUserDetailText } from '../admin/detail.js';
import type { HandlerContext } from '../types.js';

/** Text message state router — handles all ConversationState branches. */
export function registerTextRouter({ bot: b }: HandlerContext): void {
  b.on(message('text'), async (ctx, next) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;
  const session = getSession(userId);

  // ─── Pass reply-keyboard buttons to bot.hears() handlers ───
  if (REPLY_KEYBOARD_BUTTONS.has(text)) {
    return next();
  }

  // ─── Onboarding gate ───
  const isOnboardingState = session.state.startsWith('onboarding_');
  if (!isOnboardingState) {
    const userRow = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (userRow.length > 0 && !userRow[0].onboardingComplete) {
      await ctx.reply(
        `🔐 *Account Setup Required*\n\n` +
        `Please complete identity verification and PIN setup before using ZendPay.`,
        { parse_mode: 'Markdown' }
      );
      await startOnboarding(ctx, userId);
      return;
    }
  }

  // ─── Ignore stateful flows in groups ───
  if (isGroupChat(ctx) && session.state !== ConversationState.IDLE) {
    return; // silently ignore — user should continue in DM
  }

  // Cancel
  if (text === '❌ Cancel') {
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply('Cancelled.', mainMenu);
    return;
  }

  // ─── ADMIN: SEARCH TRANSACTION ───
  if (session.state === ConversationState.AWAITING_ADMIN_TXN_SEARCH) {
    setSession(userId, { state: ConversationState.IDLE });
    const txnId = text.trim().toUpperCase();
    const txnRows = await db.select().from(transactions).where(eq(transactions.id, txnId)).limit(1);
    if (txnRows.length === 0) {
      await ctx.reply('❌ Transaction not found. Try again or tap 🔍 Search to go back.', adminSearchKeyboard);
      return;
    }
    const detailText = await buildTxnDetailText(txnRows[0]);
    const buttons = [
      [Markup.button.callback('👤 View User', `admin_user:${txnRows[0].userId}`)],
      [Markup.button.callback('🔍 New Search', 'admin_page:search')],
    ];
    await ctx.reply(detailText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    return;
  }

  // ─── ADMIN: SEARCH USER ───
  if (session.state === ConversationState.AWAITING_ADMIN_USER_SEARCH) {
    setSession(userId, { state: ConversationState.IDLE });
    const query = text.trim();
    let targetId = query;
    if (query.startsWith('@')) targetId = query.slice(1);

    // Try exact ID match first
    let userRows = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    // Fallback to username match (case-insensitive via sql)
    if (userRows.length === 0) {
      userRows = await db.select().from(users).where(sql`LOWER(${users.telegramUsername}) = LOWER(${targetId})`).limit(1);
    }
    if (userRows.length === 0) {
      await ctx.reply('❌ User not found. Try again or tap 🔍 Search to go back.', adminSearchKeyboard);
      return;
    }
    const detailText = await buildUserDetailText(userRows[0]);
    const buttons = [
      [Markup.button.url('💬 Open Chat', `tg://user?id=${userRows[0].id}`)],
      [Markup.button.callback('🔍 New Search', 'admin_page:search')],
    ];
    await ctx.reply(detailText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    return;
  }

  // ─── ADMIN: SET AMBASSADOR REFERRAL CODE ───
  if (session.state === ConversationState.AWAITING_ADMIN_SET_AMBASSADOR_CODE) {
    setSession(userId, { state: ConversationState.IDLE });
    const ambId = parseInt((session as any).pendingTransaction?.recipientName || '0', 10);
    if (!ambId) {
      await ctx.reply('❌ Something went wrong. Please try again.', adminMainKeyboard);
      return;
    }

    const code = text.trim().toLowerCase().replace(/\s+/g, '');
    if (!code || code.length < 3 || code.length > 50) {
      await ctx.reply('❌ Code must be 3–50 characters. Try again.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `admin_ambassador_detail:${ambId}`)]]));
      return;
    }

    // Check uniqueness
    const existing = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.customReferralCode, code)).limit(1);
    if (existing.length > 0 && existing[0].id !== ambId) {
      await ctx.reply('❌ That code is already taken. Try another.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `admin_ambassador_detail:${ambId}`)]]));
      return;
    }

    await db.update(ambassadorApplications).set({ customReferralCode: code }).where(eq(ambassadorApplications.id, ambId));
    await ctx.reply(
      `✅ Referral code updated!\n\n` +
      `Ambassador link:\n` +
      `\`t.me/zend_money_bot?start=${code}\``,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]) }
    );
    return;
  }

  // ─── BULK SEND: AWAITING_BULK_SEND_INPUT ───
  if (session.state === ConversationState.AWAITING_BULK_SEND_INPUT) {
    const rawText = text.trim();
    if (!rawText) {
      await ctx.reply('❌ No recipients found. Please paste at least one recipient.', cancelKeyboard);
      return;
    }

    // Try AI parsing first
    const aiRecipients = await parseBulkSendWithAI(rawText);

    let recipients: Array<{ amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string }> = [];
    let usedAI = false;

    if (aiRecipients && aiRecipients.length > 0) {
      usedAI = true;
      for (const r of aiRecipients) {
        const bank = NIGERIAN_BANKS.find(b => b.code === r.bank_code);
        if (bank) {
          recipients.push({
            amountNgn: r.amount_ngn,
            bankCode: r.bank_code,
            bankName: bank.name,
            accountNumber: r.account_number,
            accountName: r.account_name,
          });
        }
      }
    }

    // Fallback to strict parser if AI returned nothing
    if (recipients.length === 0) {
      const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parsed = parseBulkRecipient(line);
        if (parsed) recipients.push(parsed);
      }
    }

    if (recipients.length === 0) {
      await ctx.reply(
        `❌ Could not parse any valid recipients.\n\n` +
        `Try describing each recipient naturally, e.g.:\n` +
        `\`Send 50k to John Doe at GTBank 0123456789\`\n` +
        `\`₦30,000 to Jane Smith UBA 9876543210\`\n\n` +
        `Or use the strict format:\n` +
        `\`AMOUNT BANK_CODE ACCOUNT_NUMBER ACCOUNT_NAME\``,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      return;
    }

    // Store recipients in session
    setSession(userId, { state: ConversationState.IDLE, pendingTransaction: { bulkRecipients: recipients } as any });

    // Calculate totals
    const totalNgn = recipients.reduce((sum, r) => sum + r.amountNgn, 0);
    const pajClient = await getPAJClient();
    let rate = 1550;
    try {
      if (pajClient) {
        const rates = await getPAJRates();
        rate = rates.offRampRate;
      }
    } catch { /* fallback */ }

    // Calculate per-recipient fees based on user's SOL balance
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const walletAddress = user[0]?.walletAddress;

    let totalUsdt = 0;
    let totalFeeUsdt = 0;
    let anyFunded = false;
    for (const r of recipients) {
      const transferUsdt = r.amountNgn / rate;
      const feeInfo = walletAddress
        ? await calculateSendFee(transferUsdt, walletAddress, userId)
        : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
      totalUsdt += transferUsdt;
      totalFeeUsdt += feeInfo.zendFeeUsdt;
      if (feeInfo.willFundSol) anyFunded = true;
    }
    const grandTotalUsdt = totalUsdt + totalFeeUsdt;

    // Check total balance
    let balanceOk = true;
    let balanceMsg = '';
    if (walletAddress) {
      const tokenBalance = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
      const solBalance = await walletService.getSolBalance(walletAddress);

      if (tokenBalance < grandTotalUsdt) {
        balanceOk = false;
        balanceMsg = `❌ Insufficient USDT. Need ${grandTotalUsdt.toFixed(2)} USDT, have ${tokenBalance.toFixed(2)} USDT.`;
      } else if (solBalance < MIN_SOL_FOR_GAS) {
        balanceOk = false;
        balanceMsg = `❌ Insufficient SOL for gas. Need ~${MIN_SOL_FOR_GAS} SOL.`;
      }
    }

    const feeRateText = anyFunded
      ? `max(${(ZEND_FEE_FUNDED_BPS / 100).toFixed(1)}%, gas cost + small fee)`
      : `1% capped at $2`;

    let summary =
      `📦 *Bulk Send Summary*\n\n` +
      `Recipients: ${recipients.length}\n` +
      `Total NGN: ₦${totalNgn.toLocaleString()}\n` +
      `Rate: ₦${rate.toLocaleString()} / USDT\n` +
      `Transfer: ${totalUsdt.toFixed(2)} USDT\n` +
      `ZendPay Fee: ${totalFeeUsdt.toFixed(2)} USDT (${feeRateText})\n` +
      `Grand Total: ${grandTotalUsdt.toFixed(2)} USDT\n\n` +
      `*Recipients:*\n`;

    summary += recipients.map((r, i) =>
      `${i + 1}. ${escapeTelegramMarkdown(r.accountName)} — ₦${r.amountNgn.toLocaleString()} → ${escapeTelegramMarkdown(r.bankName)} (\`${r.accountNumber}\`)`
    ).join('\n');

    if (!balanceOk) {
      summary += `\n\n${balanceMsg}`;
      await ctx.reply(summary, { parse_mode: 'Markdown', ...cancelKeyboard });
      return;
    }

    // Require PIN if set
    if (user[0]?.transactionPin) {
      setSession(userId, {
        state: ConversationState.AWAITING_PIN_VERIFY,
        pinVerifyAction: 'bulk_send',
        pendingTransaction: { bulkRecipients: recipients } as any,
      });
      await ctx.reply(
        `${summary}\n\n🔐 Enter your 4-digit PIN to confirm this bulk send:`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      return;
    }

    // No PIN — confirm directly
    const confirmButtons = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm Bulk Send', 'bulk_send_confirm')],
      [Markup.button.callback('❌ Cancel', 'bulk_send_cancel')],
    ]);
    await ctx.reply(summary, { parse_mode: 'Markdown', ...confirmButtons });
    return;
  }

  // ─── ADD NAIRA: AWAITING_ONRAMP_AMOUNT ───
  if (session.state === ConversationState.AWAITING_ONRAMP_AMOUNT) {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);

    if (!amount || amount < PAJ_MIN_DEPOSIT_NGN) {
      await ctx.reply(
        `❌ Please enter a valid amount.\n` +
        `Minimum deposit is ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}.`,
        cancelKeyboard
      );
      return;
    }
    if (amount > PAJ_MAX_DEPOSIT_NGN) {
      await ctx.reply(
        `❌ Amount too large.\n` +
        `Maximum deposit is ${formatNgn(PAJ_MAX_DEPOSIT_NGN)}.`,
        cancelKeyboard
      );
      return;
    }

    const pajClient = await getPAJClient();
    if (!pajClient) {
      await ctx.reply('❌ Service temporarily unavailable. Please try again later.', mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }

    // Get on-ramp rate from PAJ
    let rate = 1550;
    let fee = 0;
    try {
      const rates = await getPAJRates();
      rate = rates.onRampRate;
    } catch (err) {
      console.log('Using fallback rate for on-ramp');
    }

    const usdtAmount = amount / rate;
    const feeNgn = fee;
    const totalNgn = amount + feeNgn;

    // Store amount and check PAJ auth
    session.onrampAmount = amount;
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const hasPajSession = user[0]?.pajSessionToken && user[0]?.pajSessionExpiresAt && new Date(user[0].pajSessionExpiresAt) > new Date();

    if (hasPajSession && user[0]) {
      // Already authenticated — create order and show VA
      const targetToken = session.onrampTargetToken || 'USDT';
      setSession(userId, { state: ConversationState.IDLE, onrampAmount: amount, onrampTargetToken: targetToken });
      await showVirtualAccount(ctx, userId, user[0].pajSessionToken!, amount, rate, feeNgn, targetToken);
      return;
    }

    // Need PAJ auth — proceed to email/phone
    session.state = ConversationState.AWAITING_EMAIL;
    setSession(userId, session);

    await ctx.reply(
      `💵 *Deposit Preview*\n\n` +
      `Amount: ${formatNgn(amount)}\n` +
      `Rate: ₦${rate.toLocaleString()}/USD\n` +
      `Fee: ${formatNgn(feeNgn)}\n` +
      `You receive: ~${usdtAmount.toFixed(2)} Dollars\n\n` +
      `🔐 *Identity Verification*\n\n` +
      `Enter your email or phone number (with country code):\n` +
      `Example: user@email.com or +2348012345678`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
    return;
  }

  // ─── BRIDGE: AWAITING_BRIDGE_AMOUNT ───
  if (session.state === ConversationState.AWAITING_BRIDGE_AMOUNT) {
    const bd = session.bridgeData;
    if (!bd || !bd.destinationAsset || !bd.destinationSymbol) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired. Please start over.', mainMenu);
      return;
    }

    const amount = parseFloat(text.trim().replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Please enter a valid amount. Example: 10, 50, 100', cancelKeyboard);
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0) {
      await ctx.reply('❌ User not found. Run /start first.', mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }

    try {
      await ctx.reply('⏳ Generating deposit address via NEAR Intents...');

      const quote = await createDepositQuote({
        sourceChain: bd.sourceChain,
        sourceToken: bd.token,
        sourceAssetId: bd.assetId,
        destinationAsset: bd.destinationAsset,
        destinationSymbol: bd.destinationSymbol,
        amount,
        recipientWallet: user[0].walletAddress,
      });

      const depositAddress = quote.quote.depositAddress;
      const amountOutFormatted = quote.quote.amountOutFormatted;
      const exactAmount = quote.quote.amountInFormatted || amount.toString();
      const chainDisplay = CHAIN_DISPLAY_NAMES[bd.sourceChain] || bd.sourceChain;
      const feeLine = quote.quote.withdrawFee
        ? `• Est. network fee: ~${quote.quote.withdrawFee}\n`
        : '';

      // Record in DB
      const txId = generateTxId();
      await db.insert(transactions).values({
        id: txId,
        userId,
        type: 'crypto_receive',
        status: 'pending',
        nearIntentDepositAddress: depositAddress,
        recipientWalletAddress: user[0].walletAddress,
        fromAmount: amount.toString(),
        fromMint: bd.assetId,
        toMint: bd.destinationAsset,
        metadata: {
          nearIntents: true,
          direction: 'deposit',
          sourceChain: bd.sourceChain,
          sourceToken: bd.token,
          destinationSymbol: bd.destinationSymbol,
        },
      });

      await indexTransaction(userId, txId, `Deposit from ${chainDisplay} via NEAR Intents`, {
        amount,
        chain: chainDisplay,
        depositAddress,
      });

      await ctx.reply(
        `🌉 *Deposit ${bd.token} from ${chainDisplay}*\n\n` +
        `${formatExactAmountDepositWarning(exactAmount, bd.token, chainDisplay)}\n\n` +
        `📬 *Deposit address:*\n${depositAddress}\n\n` +
        `📋 *After you send:*\n` +
        `• You'll receive ~${amountOutFormatted} ${bd.destinationSymbol} in ZendPay\n` +
        feeLine +
        `• Quote expires: ${new Date(quote.quote.deadline).toLocaleString('en-NG')}\n` +
        `• Reference: \`${txId}\``,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      await ctx.reply('📋 Tap to copy the address:', Markup.inlineKeyboard([
        [{ text: '📋 Copy Address', copy_text: { text: depositAddress } } as any]
      ]));
    } catch (err: any) {
      console.error('[Bridge] Failed:', err);
      setSession(userId, { state: ConversationState.IDLE });
      let decimals: number | undefined;
      try {
        decimals = await resolveTokenDecimals(bd.sourceChain, bd.token, bd.assetId);
      } catch { /* use generic min-amount message */ }
      await ctx.reply(
        `❌ *Deposit Error*\n\n` +
        `${formatNearIntentsError(err, { symbol: bd.token, decimals })}\n\n` +
        `Tap *📤 Send → Other Apps* to try again, or use *📥 Receive* for a direct deposit.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }

    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  // ─── WITHDRAW: AWAITING_WITHDRAW_RECIPIENT ───
  if (session.state === ConversationState.AWAITING_WITHDRAW_RECIPIENT) {
    const wd = session.withdrawData;
    if (!wd) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired.', mainMenu);
      return;
    }

    const recipientAddress = text.trim();
    if (!validateChainAddress(wd.destChain, recipientAddress)) {
      await ctx.reply(
        `❌ Invalid address for ${formatChainName(wd.destChain)}.\nPlease check and try again.`,
        cancelKeyboard
      );
      return;
    }

    setSession(userId, {
      ...session,
      state: ConversationState.AWAITING_WITHDRAW_AMOUNT,
      withdrawData: { ...wd, recipientAddress },
    });

    await ctx.reply(
      `📤 *Withdraw Preview*\n\n` +
      `From: ZendPay *USDT* (USDC auto-converts)\n` +
      `To: *${formatChainName(wd.destChain)}* (${wd.destToken})\n` +
      `Recipient: \`${recipientAddress}\`\n\n` +
      `How much USDT do you want to send?\n` +
      `Example: 10, 25, 50`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
    return;
  }

  // ─── WITHDRAW: AWAITING_WITHDRAW_AMOUNT ───
  if (session.state === ConversationState.AWAITING_WITHDRAW_AMOUNT) {
    const wd = session.withdrawData;
    if (!wd?.recipientAddress) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired.', mainMenu);
      return;
    }

    const amount = parseFloat(text.trim().replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Please enter a valid amount.', cancelKeyboard);
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0) {
      await ctx.reply('Please run /start first.', mainMenu);
      return;
    }

    const stable = await getStablecoinBalances(user[0].walletAddress);
    if (stable.total < amount) {
      await ctx.reply(
        `❌ Insufficient balance.\n` +
        `You have ${stable.usdt.toFixed(2)} USDT + ${stable.usdc.toFixed(2)} USDC ` +
        `(${stable.total.toFixed(2)} total), need ${amount} USDT.`,
        cancelKeyboard
      );
      return;
    }

    try {
      await ctx.reply('⏳ Getting quote from NEAR Intents...');

      const quote = await createWithdrawQuote({
        sourceSymbol: 'USDT',
        amount,
        destChain: wd.destChain,
        destToken: wd.destToken,
        destAssetId: wd.destAssetId,
        recipientAddress: wd.recipientAddress,
        refundWallet: user[0].walletAddress,
      });

      const depositAddress = quote.quote.depositAddress;
      const amountOutFormatted = quote.quote.amountOutFormatted;
      const txId = generateTxId();

      await db.insert(transactions).values({
        id: txId,
        userId,
        type: 'crypto_send',
        status: 'pending',
        nearIntentDepositAddress: depositAddress,
        fromAmount: amount.toString(),
        fromMint: SOLANA_ORIGIN_ASSETS.USDT,
        toMint: wd.destAssetId,
        recipientWalletAddress: wd.recipientAddress,
        metadata: { direction: 'withdraw', destChain: wd.destChain, destToken: wd.destToken },
      });

      setSession(userId, {
        state: ConversationState.IDLE,
        withdrawData: {
          ...wd,
          amount,
          depositAddress,
          txId,
          amountOutFormatted,
        },
      });

      await ctx.reply(
        `📤 *Confirm Withdrawal*\n\n` +
        `Send: *${amount} USDT*\n` +
        `To: *${formatChainName(wd.destChain)}*\n` +
        `Recipient: \`${wd.recipientAddress}\`\n` +
        `They receive: ~${amountOutFormatted} ${wd.destToken}\n` +
        (quote.quote.withdrawFee ? `Est. fee: ~${quote.quote.withdrawFee}\n` : '') +
        `\nReference: \`${txId}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm', 'confirm_withdraw')],
            [Markup.button.callback('❌ Cancel', 'cancel_withdraw')],
          ]),
        }
      );
    } catch (err: any) {
      console.error('[Withdraw] Quote failed:', err);
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply(
        `❌ *Withdrawal Error*\n\n${formatNearIntentsError(err)}`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }
    return;
  }

  // ─── ONBOARDING: AWAITING_EMAIL ───
  if (session.state === ConversationState.ONBOARDING_AWAITING_EMAIL) {
    const contact = text.trim();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
    const isPhone = /^\+\d{10,15}$/.test(contact);

    if (!isEmail && !isPhone) {
      await ctx.reply(
        '❌ Please enter a valid email or phone number with country code.\n' +
        'Examples: user@email.com or +2348012345678',
        cancelKeyboard
      );
      return;
    }

    const pajClient = await getPAJClient();
    if (!pajClient) {
      await ctx.reply('❌ PAJ service unavailable.', cancelKeyboard);
      return;
    }

    try {
      const pajContact = isPhone && contact.startsWith('+') ? contact.slice(1) : contact;
      const initiated = await pajClient.initiateSession(pajContact);
      console.log('[PAJ] OTP sent to:', initiated.email || initiated.phone);

      session.pajContact = contact;
      session.state = ConversationState.ONBOARDING_AWAITING_OTP;
      setSession(userId, session);

      await ctx.reply(
        `📧 *OTP Sent!*\n\n` +
        `Check your ${isEmail ? 'email' : 'SMS'} for a verification code from PAJ.\n\n` +
        `Enter the OTP:`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
    } catch (err: any) {
      console.error('[PAJ] Initiate failed:', err);
      await ctx.reply(
        `❌ Could not send OTP.\n` +
        `Error: ${err.message || 'Unknown error'}\n\n` +
        `Please try again.`,
        cancelKeyboard
      );
    }
    return;
  }

  // ─── ONBOARDING: AWAITING_OTP ───
  if (session.state === ConversationState.ONBOARDING_AWAITING_OTP) {
    const otp = text.trim();
    const contact = session.pajContact;

    const pajClient = await getPAJClient();
    if (!contact || !pajClient) {
      await ctx.reply('❌ Session expired. Please start over.', cancelKeyboard);
      setSession(userId, { state: ConversationState.ONBOARDING_AWAITING_EMAIL });
      return;
    }

    if (!/^\d{4,8}$/.test(otp)) {
      await ctx.reply('❌ Please enter a valid OTP (4-8 digits).', cancelKeyboard);
      return;
    }

    try {
      const pajContact = contact.startsWith('+') ? contact.slice(1) : contact;
      const verified = await pajClient.verifySession(pajContact, otp, {
        uuid: `zend-${userId}`,
        device: 'Telegram',
        os: 'Telegram Bot',
        browser: 'Telegram',
      });

      console.log('[PAJ] Session verified for:', verified.recipient);

      await db.update(users)
        .set({
          pajSessionToken: verified.token,
          pajSessionExpiresAt: new Date(verified.expiresAt),
          pajContact: contact,
        })
        .where(eq(users.id, userId));

      // Move to PIN setup
      session.state = ConversationState.ONBOARDING_AWAITING_PIN;
      setSession(userId, session);

      await ctx.reply(
        `✅ *Identity Verified!*\n\n` +
        `Step 3 of 3: Set a 4-digit transaction PIN\n` +
        `This PIN will be required for all transfers.`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
    } catch (err: any) {
      console.error('[PAJ] Verify failed:', err);
      const errorMsg = err.message || '';
      if (errorMsg.includes('Invalid') || errorMsg.includes('invalid')) {
        await ctx.reply(
          `❌ *Invalid OTP*\n\n` +
          `The code you entered is incorrect or has expired.\n` +
          `Please check your ${contact.includes('@') ? 'email' : 'SMS'} and try again.`,
          cancelKeyboard
        );
      } else {
        await ctx.reply(
          `❌ Verification failed.\n` +
          `Error: ${errorMsg || 'Unknown error'}\n\n` +
          `Please try again.`,
          cancelKeyboard
        );
      }
    }
    return;
  }

  // ─── ONBOARDING: AWAITING_PIN ───
  if (session.state === ConversationState.ONBOARDING_AWAITING_PIN) {
    const pin = text.trim();
    if (!/^\d{4}$/.test(pin)) {
      await ctx.reply('❌ Please enter a valid 4-digit PIN.', cancelKeyboard);
      return;
    }

    const hashed = await hashPin(pin);
    await db.update(users)
      .set({ transactionPin: hashed, onboardingComplete: true })
      .where(eq(users.id, userId));

    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply(
      `✅ *Setup Complete!*\n\n` +
      `Your account is secured and ready to use.\n\n` +
      `💰 Check your balance | 📤 Send money | 💵 Add Naira`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  // ─── PAJ AUTH: AWAITING_EMAIL ───
  if (session.state === ConversationState.AWAITING_EMAIL) {
    const contact = text.trim();

    // Validate email or phone
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
    const isPhone = /^\+\d{10,15}$/.test(contact);

    if (!isEmail && !isPhone) {
      await ctx.reply(
        '❌ Please enter a valid email or phone number with country code.\n' +
        'Examples: user@email.com or +2348012345678',
        cancelKeyboard
      );
      return;
    }

    const pajClient = await getPAJClient();
    if (!pajClient) {
      await ctx.reply('❌ PAJ service unavailable.', mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }

    try {
      // PAJ expects phone without + prefix, email as-is
      const pajContact = isPhone && contact.startsWith('+') ? contact.slice(1) : contact;

      // Step 1: Initiate PAJ session (sends OTP)
      const initiated = await pajClient.initiateSession(pajContact);
      console.log('[PAJ] OTP sent to:', initiated.email || initiated.phone);

      // Save pending contact (store original with + for verify)
      session.pajContact = contact;
      session.state = ConversationState.AWAITING_OTP;
      setSession(userId, session);

      await ctx.reply(
        `📧 *OTP Sent!*\n\n` +
        `Check your ${isEmail ? 'email' : 'SMS'} for a verification code from PAJ.\n\n` +
        `Enter the OTP:`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
    } catch (err: any) {
      console.error('[PAJ] Initiate failed:', err);
      const errorMsg = err.message || '';

      // User-friendly error messages
      if (errorMsg.includes('No recipients defined') || errorMsg.includes('recipients')) {
        await ctx.reply(
          `❌ *Service Error*\n\n` +
          `Could not send verification code. We're experiencing issues with phone number processing.\n\n` +
          `Try these options:\n` +
          `1. Use your email instead of phone number\n` +
          `2. Try again in a few minutes\n` +
          `3. Contact support if the issue persists`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
      } else if (errorMsg.includes('Can\'t find business') || errorMsg.includes('business')) {
        await ctx.reply(
          `❌ *Service Error*\n\n` +
          `Our payment partner is temporarily unavailable.\n` +
          `Please try again in a few minutes or contact support.`,
          mainMenu
        );
      } else {
        await ctx.reply(
          `❌ Could not send OTP.\n` +
          `Error: ${errorMsg || 'Unknown error'}\n\n` +
          `Please try again or contact support.`,
          mainMenu
        );
      }
      setSession(userId, { state: ConversationState.IDLE });
    }
    return;
  }

  // ─── PAJ AUTH: AWAITING_OTP ───
  if (session.state === ConversationState.AWAITING_OTP) {
    const otp = text.trim();
    const contact = session.pajContact;

    const pajClient = await getPAJClient();
    if (!contact || !pajClient) {
      await ctx.reply('❌ Session expired. Please start over.', mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }

    if (!/^\d{4,8}$/.test(otp)) {
      await ctx.reply('❌ Please enter a valid OTP (4-8 digits).', cancelKeyboard);
      return;
    }

    try {
      // PAJ verify also expects phone without + prefix
      const pajContact = contact.startsWith('+') ? contact.slice(1) : contact;

      // Step 2: Verify OTP
      const verified = await pajClient.verifySession(pajContact, otp, {
        uuid: `zend-${userId}`,
        device: 'Telegram',
        os: 'Telegram Bot',
        browser: 'Telegram',
      });

      console.log('[PAJ] Session verified for:', verified.recipient);

      // Save session to DB
      await db.update(users)
        .set({
          pajSessionToken: verified.token,
          pajSessionExpiresAt: new Date(verified.expiresAt),
          pajContact: contact,
        })
        .where(eq(users.id, userId));

      setSession(userId, { state: ConversationState.IDLE });

      await ctx.reply(
        `✅ *PAJ Verified!*\n\n` +
        `Your account is now linked.`,
        { parse_mode: 'Markdown' }
      );

      // Now show virtual account (with pending amount if any)
      const onrampAmount = session.onrampAmount;
      const targetToken = session.onrampTargetToken || 'USDT';
      if (onrampAmount) {
        // Get rate for the pending amount
        let rate = 1550;
        let fee = 0;
        try {
          const rateData = await pajClient.getRateByAmount(onrampAmount);
          rate = rateData.rate.rate;
          fee = (rateData as any).fee || 0;
        } catch (err) {
          console.log('Using fallback rate for on-ramp after verify');
        }
        await showVirtualAccount(ctx, userId, verified.token, onrampAmount, rate, fee, targetToken);
      } else {
        await showVirtualAccount(ctx, userId, verified.token, undefined, undefined, undefined, targetToken);
      }
    } catch (err: any) {
      console.error('[PAJ] Verify failed:', err);
      const errorMsg = err.message || '';

      if (errorMsg.includes('No recipients defined') || errorMsg.includes('recipients')) {
        await ctx.reply(
          `❌ *Service Error*\n\n` +
          `The verification server is experiencing issues.\n\n` +
          `Please try again in a few minutes or use email instead of phone number.`,
          mainMenu
        );
        setSession(userId, { state: ConversationState.IDLE });
      } else if (errorMsg.includes('Invalid') || errorMsg.includes('invalid')) {
        await ctx.reply(
          `❌ *Invalid OTP*\n\n` +
          `The code you entered is incorrect or has expired.\n` +
          `Please check your ${contact.includes('@') ? 'email' : 'SMS'} and try again.`,
          cancelKeyboard
        );
      } else {
        await ctx.reply(
          `❌ Verification failed.\n` +
          `Error: ${errorMsg || 'Unknown error'}\n\n` +
          `Please try again.`,
          cancelKeyboard
        );
      }
    }
    return;
  }

  // ─── SEND: AWAITING_SEND_AMOUNT ───
  if (session.state === ConversationState.AWAITING_SEND_AMOUNT) {
    let amount: number | undefined;

    // Try AI first for natural language amounts ("2k", "two thousand", "₦2000")
    const aiParse = await parseMenuInputWithAI(text);
    if (aiParse && aiParse.success && aiParse.amount && aiParse.amount >= 100) {
      amount = aiParse.amount;
      console.log('[AI] Parsed amount:', amount, 'from:', text);
    } else {
      // Fallback: strip non-digits
      amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
      if (text.toLowerCase().includes('k')) {
        const kMatch = text.match(/(\d+\.?\d*)k/i);
        if (kMatch) amount = Math.round(parseFloat(kMatch[1]) * 1000);
      }
    }

    if (!amount || amount < 100) {
      const aiMsg = aiParse?.message;
      await ctx.reply(
        aiMsg || 'Hmm, I didn\'t catch that amount. Try something like "2000", "2k", or "₦5000". Minimum is ₦100.',
        cancelKeyboard
      );
      return;
    }

    // Get real PAJ off-ramp rate
    let rate = 1550;
    try {
      const rates = await getPAJRates();
      rate = rates.offRampRate;
    } catch (err) {
      console.log('Using fallback rate');
    }

    const transferUsdt = amount / rate;
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const feeInfo = user[0]?.walletAddress
      ? await calculateSendFee(transferUsdt, user[0].walletAddress, userId)
      : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
    const usdtNeeded = transferUsdt + feeInfo.zendFeeUsdt;

    session.pendingTransaction = {
      ...session.pendingTransaction,
      amountNgn: amount,
      amountUsdt: usdtNeeded,
      zendFeeUsdt: feeInfo.zendFeeUsdt,
      feeSol: feeInfo.feeSol,
    };
    session.state = ConversationState.AWAITING_SEND_RECIPIENT;
    setSession(userId, session);

    let msg = `📤 Send ${formatNgn(amount)}\n` +
      `Rate: ${formatNgn(rate)} per Dollar\n` +
      `${formatSendFeeLabel(feeInfo)}\n` +
      `You pay: *${usdtNeeded.toFixed(2)} USDT*\n\n` +
      `Who should receive it?\n\n` +
      `Just tell me naturally — e.g. "Mark OPay 7082406410" or "send to Amaka at GTB 0123456789"`;

    await ctx.reply(msg, { parse_mode: 'Markdown', ...cancelKeyboard });
    return;
  }


  // ─── SEND: AWAITING_SEND_RECIPIENT ───
  if (session.state === ConversationState.AWAITING_SEND_RECIPIENT) {
    // ─── Try AI parser first ───
    const aiParse = await parseMenuInputWithAI(text);

    let accountNumber: string | undefined;
    let bankCode: string | undefined;
    let accountName: string | undefined;
    let fromToken: string | undefined;

    if (aiParse && aiParse.success) {
      accountNumber = aiParse.accountNumber;
      bankCode = aiParse.bankCode;
      accountName = aiParse.recipientName;
      fromToken = aiParse.fromToken;
      console.log('[AI] Parsed recipient:', { bankCode, accountNumber, accountName, fromToken });
    } else if (aiParse && aiParse.message) {
      await ctx.reply(aiParse.message, cancelKeyboard);
      return;
    }

    // ─── Fallback: local smart parser ───
    if (!bankCode || !accountNumber) {
      const parts = text.trim().split(/\s+/);
      for (let i = 0; i < parts.length; i++) {
        if (/^\d{10}$/.test(parts[i])) {
          accountNumber = parts[i];
          if (i > 0) {
            const candidate = parts[i - 1].toUpperCase();
            const bank = NIGERIAN_BANKS.find(b => b.code === candidate);
            if (bank) { bankCode = candidate; accountName = parts.slice(0, i - 1).join(' '); break; }
          }
          if (i < parts.length - 1 && !bankCode) {
            const candidate = parts[i + 1].toUpperCase();
            const bank = NIGERIAN_BANKS.find(b => b.code === candidate);
            if (bank) { bankCode = candidate; accountName = parts.slice(0, i).join(' '); break; }
          }
        }
      }
      if (!bankCode) {
        const aliases: Record<string, string[]> = {
          'GTB': ['gtb', 'gtbank'], 'FBN': ['first bank', 'fbn', 'firstbank'],
          'UBA': ['uba'], 'ZEN': ['zenith', 'zenith bank'],
          'ACC': ['access', 'access bank'], 'ECO': ['ecobank', 'eco bank'],
          'WEM': ['wema', 'wema bank'], 'FID': ['fidelity', 'fidelity bank'],
          'SKY': ['polaris', 'polaris bank', 'skye'], 'FCMB': ['fcmb', 'first city'],
          'STERLING': ['sterling', 'sterling bank'], 'STA': ['stanbic', 'stanbic ibtc'],
          'UNI': ['union', 'union bank'], 'KEC': ['keystone', 'keystone bank'],
          'JAB': ['jaiz', 'jaiz bank'], 'OPY': ['opay', 'o pay'],
          'MON': ['moniepoint', 'monie point'], 'KUD': ['kuda', 'kuda bank'],
          'PAL': ['palmpay', 'palm pay'], 'PAG': ['paga', 'paga bank'],
          'VFD': ['vfd'], 'CAR': ['carbon', 'carbon bank'],
          'FAI': ['fairmoney', 'fair money'], 'BRA': ['branch', 'branch bank'],
        };
        for (let i = 0; i < parts.length; i++) {
          const pl = parts[i].toLowerCase();
          for (const [code, als] of Object.entries(aliases)) {
            if (als.includes(pl) || pl === code.toLowerCase()) {
              bankCode = code;
              for (let j = 0; j < parts.length; j++) {
                if (j !== i && /^\d{10}$/.test(parts[j])) { accountNumber = parts[j]; break; }
              }
              accountName = parts.filter((_, idx) => idx !== i && parts[idx] !== accountNumber).join(' ');
              break;
            }
          }
          if (bankCode) break;
        }
      }
    }

    if (!bankCode || !accountNumber) {
      await ctx.reply(
        "I couldn't quite figure out the recipient details from that.\n\n" +
        "Try something like:\n" +
        '• "Mark OPay 7082406410"\n' +
        '• "Amaka GTB 0123456789"\n' +
        '• "send to Tunde at First Bank 0011223344"',
        cancelKeyboard
      );
      return;
    }

    const bank = NIGERIAN_BANKS.find(b => b.code === bankCode)!;

    if (!fromToken) {
      const lt = text.toLowerCase();
      if (/\busdc\b/.test(lt)) fromToken = 'USDC';
      else if (/\bsol\b/.test(lt)) fromToken = 'SOL';
    }
    const fromMint = fromToken === 'USDC' ? SOLANA_TOKENS.USDC.mint :
                     fromToken === 'SOL' ? SOLANA_TOKENS.SOL.mint :
                     SOLANA_TOKENS.USDT.mint;

    // ─── Verify bank account with PAJ ───
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    let verifiedName = accountName;
    let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';
    let verifyMsg: { message_id: number } | undefined;

    if (user[0]?.pajSessionToken) {
      verifyMsg = await showLoading(ctx, 'Verifying account...');
      const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, accountNumber, userId);
      if (verification.verified && verification.accountName) {
        verifiedName = verification.accountName;
        verifiedStatus = 'verified';
      } else if (verification.sessionExpired) {
        await ctx.reply(
          `⚠️ *PAJ Session Expired*\n\n` +
          `Your bank verification link has expired.\n` +
          `Please go to *⚙️ Settings → 🔗 Link PAJ* to reconnect.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        session.state = ConversationState.IDLE;
        session.pendingTransaction = undefined;
        setSession(userId, session);
        return;
      } else {
        console.log('[Verify] Failed:', verification.error);
      }
    } else {
      verifiedStatus = 'no_paj';
    }

    session.pendingTransaction!.fromMint = fromMint;
    session.pendingTransaction!.recipientBankCode = bankCode;
    session.pendingTransaction!.recipientBankName = bank.name;
    session.pendingTransaction!.recipientAccountNumber = accountNumber;
    session.pendingTransaction!.recipientAccountName = verifiedName;
    session.state = ConversationState.AWAITING_CONFIRMATION;
    setSession(userId, session);

    const { amountNgn, amountUsdt } = session.pendingTransaction!;

    let confirmMsg = `📤 *Confirm Transfer*\n\n`;

    if (verifiedStatus === 'verified') {
      confirmMsg += `✅ *Account Verified*\n`;
    } else if (verifiedStatus === 'no_paj') {
      confirmMsg += `⚠️ *Account Not Verified* (verify identity in Settings)\n`;
    } else {
      confirmMsg += `⚠️ *Could not verify account* — please double-check details\n`;
    }

    const feeLine = session.pendingTransaction?.zendFeeUsdt
      ? `ZendPay fee: ~${session.pendingTransaction.zendFeeUsdt.toFixed(2)} USDT\n`
      : '';

    const menuFromMint = session.pendingTransaction?.fromMint || SOLANA_TOKENS.USDT.mint;
    const menuFromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === menuFromMint) || SOLANA_TOKENS.USDT;
    confirmMsg += `\n` +
      `Amount: *${formatNgn(amountNgn!)}*\n` +
      `To: *${md(verifiedName)}*\n` +
      `Bank: *${md(bank.name)}*\n` +
      `Account: \`${accountNumber}\`\n\n` +
      feeLine +
      `You pay: *${amountUsdt!.toFixed(2)} ${menuFromToken.symbol}*\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    await ctx.reply(confirmMsg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm & Send', 'confirm_send')],
        [Markup.button.callback('❌ Cancel', 'cancel_send')],
      ]),
    });
    return;
  }

  // ─── SWAP: AWAITING_SWAP_AMOUNT ───
  if (session.state === ConversationState.AWAITING_SWAP_AMOUNT) {
    await handleSwapAmount(ctx, userId, text);
    return;
  }

  // ─── BILL PAYMENTS ───
  if (session.state === ConversationState.BILL_ENTER_PHONE) {
    const phone = text.trim().replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 15) {
      await ctx.reply('❌ Please enter a valid phone number (10-15 digits).', cancelKeyboard);
      return;
    }
    session.billData = { ...session.billData, phone };

    if (session.billData?.type === 'airtime') {
      session.state = ConversationState.BILL_ENTER_AMOUNT;
      setSession(userId, session);
      await ctx.reply('💵 Enter amount in Naira (e.g., 500, 1000, 2000):', cancelKeyboard);
      return;
    }

    if (session.billData?.type === 'data') {
      const loading = await showLoading(ctx, 'Fetching data plans...');
      try {
        let rows: ReturnType<typeof Markup.button.callback>[][] = [];
        if (airbillsClient) {
          const plans = await getDataPlansForNetwork(airbillsClient, session.billData.network!);
          if (plans.length === 0) {
            await finishLoading(ctx, loading.message_id, '❌ No data plans found for this network.');
            setSession(userId, { state: ConversationState.IDLE });
            await ctx.reply('Menu:', mainMenu);
            return;
          }
          rows = plans.map((p) =>
            [Markup.button.callback(`${p.name} — ₦${p.amount.toLocaleString()}`, `bill_plan_${p.id}_${p.amount}`)]
          );
        } else {
          const plans = await getDataPlans(session.billData.network!);
          if (plans.length === 0) {
            await finishLoading(ctx, loading.message_id, '❌ No data plans found.');
            setSession(userId, { state: ConversationState.IDLE });
            await ctx.reply('Menu:', mainMenu);
            return;
          }
          rows = plans.map((p: DataPlan) =>
            [Markup.button.callback(`${p.name} — ₦${p.amount.toLocaleString()} (${p.validity})`, `bill_plan_${p.planCode}_${p.amount}`)]
          );
        }
        await finishLoading(ctx, loading.message_id, `🌐 Select a data plan for ${session.billData.phone}:`);
        await ctx.reply('Choose a plan:', Markup.inlineKeyboard(rows));
        setSession(userId, session);
      } catch (err: any) {
        await finishLoading(ctx, loading.message_id, '❌ Could not fetch plans. Please try again.');
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('Menu:', mainMenu);
      }
      return;
    }

    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply('❌ Unknown bill type. Please start over.', mainMenu);
    return;
  }

  if (session.state === ConversationState.BILL_ENTER_AMOUNT) {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!amount || amount < 50) {
      await ctx.reply('❌ Minimum amount is ₦50. Enter a valid amount:', cancelKeyboard);
      return;
    }

    const bill = session.billData;
    if (!bill) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired. Please start over.', mainMenu);
      return;
    }

    bill.amount = amount;
    session.billData = bill;
    setSession(userId, session);

    // Show confirmation
    let rate = 1400;
    try {
      const rates = await getPAJRates();
      rate = rates.offRampRate || 1400;
    } catch { /* fallback */ }
    const usdtAmount = amount / rate;

    const typeMap: Record<string, string> = {
      airtime: '📱 Airtime',
      data: '🌐 Data',
      electricity: '⚡ Electricity',
      cable: '📺 Cable TV',
    };

    await ctx.reply(
      `💳 *Confirm Purchase*\n\n` +
      `Type: ${typeMap[bill.type || ''] || bill.type}\n` +
      `${bill.network ? `Network: ${bill.network.toUpperCase()}\n` : ''}` +
      `${bill.disco ? `Disco: ${bill.disco}\n` : ''}` +
      `${bill.provider ? `Provider: ${bill.provider.toUpperCase()}\n` : ''}` +
      `${bill.phone ? `Phone: ${bill.phone}\n` : ''}` +
      `${bill.meterNumber ? `Meter: ${bill.meterNumber}\n` : ''}` +
      `${(bill as any).customerName ? `Customer: ${(bill as any).customerName}\n` : ''}` +
      `${bill.smartCardNumber ? `Smart Card: ${bill.smartCardNumber}\n` : ''}` +
      `Amount: ₦${amount.toLocaleString()}\n` +
      `≈ ${usdtAmount.toFixed(4)} USDT\n\n` +
      `Tap Confirm to complete.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm', 'bill_confirm')],
          [Markup.button.callback('❌ Cancel', 'cancel_send')],
        ]),
      }
    );
    return;
  }

  if (session.state === ConversationState.BILL_ENTER_METER) {
    const meter = text.trim().replace(/\D/g, '');
    if (meter.length < 5 || meter.length > 20) {
      await ctx.reply('❌ Please enter a valid meter number.', cancelKeyboard);
      return;
    }
    session.billData = { ...session.billData, meterNumber: meter };

    if (airbillsClient && session.billData?.disco) {
      const verifyMsg = await showLoading(ctx, 'Verifying meter number...');
      try {
        const validation = await airbillsClient.validateRecipient(session.billData.disco, meter);
        if (validation.valid && validation.name) {
          session.billData = { ...session.billData, meterNumber: meter, customerName: validation.name };
          await finishLoading(
            ctx,
            verifyMsg.message_id,
            `✅ *Meter Verified*\n\nCustomer: ${md(validation.name)}\nMeter: \`${meter}\``,
            'Markdown'
          );
        } else {
          await finishLoading(ctx, verifyMsg.message_id, '⚠️ Could not verify meter name. Double-check the number, then enter amount.');
        }
      } catch (err: any) {
        console.error('[Bills] Meter validation failed:', err.message);
        await finishLoading(ctx, verifyMsg.message_id, '⚠️ Meter lookup unavailable. Enter amount to continue.');
      }
    }

    session.state = ConversationState.BILL_ENTER_AMOUNT;
    setSession(userId, session);
    await ctx.reply('💵 Enter amount in Naira (e.g., 1000, 5000):', cancelKeyboard);
    return;
  }

  if (session.state === ConversationState.BILL_ENTER_SMARTCARD) {
    const card = text.trim().replace(/\D/g, '');
    if (card.length < 5 || card.length > 20) {
      await ctx.reply('❌ Please enter a valid smart card number.', cancelKeyboard);
      return;
    }
    session.billData = { ...session.billData, smartCardNumber: card };

    if (airbillsClient && session.billData?.provider) {
      const verifyMsg = await showLoading(ctx, 'Verifying smart card...');
      try {
        const validation = await airbillsClient.validateRecipient(session.billData.provider, card);
        if (validation.valid && validation.name) {
          session.billData = { ...session.billData, smartCardNumber: card, customerName: validation.name };
          await finishLoading(
            ctx,
            verifyMsg.message_id,
            `✅ *Smart Card Verified*\n\nCustomer: ${md(validation.name)}\nCard: \`${card}\``,
            'Markdown'
          );
        } else {
          await finishLoading(ctx, verifyMsg.message_id, '⚠️ Could not verify subscriber name. Double-check the card number.');
        }
      } catch (err: any) {
        console.error('[Bills] Smart card validation failed:', err.message);
        await finishLoading(ctx, verifyMsg.message_id, '⚠️ Lookup unavailable. Enter amount to continue.');
      }
    }

    session.state = ConversationState.BILL_ENTER_AMOUNT;
    setSession(userId, session);
    await ctx.reply('💵 Enter subscription amount in Naira:', cancelKeyboard);
    return;
  }

  // ─── NLP: Parse natural language when IDLE ───
  if (session.state === ConversationState.IDLE) {
    // ─── Instant greetings (no slow LLM) ───
    if (isCasualGreeting(text)) {
      const name = ctx.from?.first_name || 'there';
      await ctx.reply(
        `Hey ${name}! 👋 No wahala — I'm here.\n\n` +
        `Try *💰 Balance*, *📤 Send*, or say:\n` +
        `"Send 500 to 08123456789 Opay"`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }

    // ─── Semantic Transaction Search (QVAC Embeddings) ───
    const historyQueryPatterns = /\b(how much did i send|how much did i|did i send|transactions? with|payments? to|money i sent|what did i pay|show me my|search my)\b/i;
    if (historyQueryPatterns.test(text)) {
      const loading = await showLoading(ctx, 'Searching your history with QVAC...');
      try {
        const answer = await askTransactionQuestion(userId, text);
        if (answer) {
          await finishLoading(ctx, loading.message_id, `🔍 *Smart Search*\n\n${answer}`, 'Markdown');
        } else {
          await finishLoading(ctx, loading.message_id, '🔍 No matching transactions found. Try a different question or check your 📋 History.');
        }
      } catch (err: any) {
        console.error('[Search] Error:', err);
        await finishLoading(ctx, loading.message_id, '❌ Search failed. Please try 📋 History instead.');
      }
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    const parsed = await parseCommand(text);
    console.log('[NLP] Parsed:', parsed);

    switch (parsed.intent) {
      case 'send': {
        // Sanitize account numbers from NLP
        if (parsed.accountNumber) {
          parsed.accountNumber = sanitizeAccountNumber(parsed.accountNumber) || parsed.accountNumber;
        }

        // Use Kimi for conversational responses when details are missing
        if (!parsed.amount) {
          const features = await getBotFeatures();
          const reply = await chatWithKimi(
            `The user said: "${text}". They want to send money but didn't specify an amount. ` +
            `Respond conversationally in Nigerian Pidgin style. Ask how much they want to send.`,
            features
          );
          await ctx.reply(escapeTelegramMarkdown(reply?.reply || 'How much do you want to send?'), { parse_mode: 'Markdown', ...cancelKeyboard });
          setSession(userId, { state: ConversationState.AWAITING_SEND_AMOUNT, pendingTransaction: { recipientName: parsed.recipientName } });
          return;
        }
        if (parsed.amount < 100) {
          const features = await getBotFeatures();
          const reply = await chatWithKimi(
            `The user wants to send ${parsed.amount} Naira. Minimum is ₦100. ` +
            `Respond in Nigerian Pidgin style telling them the minimum.`,
            features
          );
          await ctx.reply(reply?.reply || `Minimum send amount is ${formatNgn(100)}.`, cancelKeyboard);
          return;
        }
        if (!parsed.accountNumber && !parsed.walletAddress) {
          // We have amount + recipient name but missing bank/account
          const features = await getBotFeatures();
          const reply = await chatWithKimi(
            `The user said: "${text}". I understood they want to send ${formatNgn(parsed.amount)} to ${parsed.recipientName || 'someone'}. ` +
            `But I need the bank name and account number. Respond conversationally in Nigerian Pidgin style.`,
            features
          );
          await ctx.reply(reply?.reply || `I got that you want to send ${formatNgn(parsed.amount)}. What's the bank and account number?`, cancelKeyboard);
          setSession(userId, {
            state: ConversationState.AWAITING_SEND_RECIPIENT,
            pendingTransaction: { amountNgn: parsed.amount, recipientName: parsed.recipientName },
          });
          return;
        }

        // Pre-fill transaction and go to confirmation
        const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (user.length === 0) {
          await ctx.reply('Please run /start first.', mainMenu);
          return;
        }

        // If bank not found for account number transfer, ask user to specify
        if (parsed.accountNumber && !parsed.bankCode) {
          const bankButtons = NIGERIAN_BANKS.map(b => Markup.button.callback(b.name, `nlp_bank:${b.code}`));
          const rows: any[] = [];
          for (let i = 0; i < bankButtons.length; i += 2) {
            rows.push(bankButtons.slice(i, i + 2));
          }

          // Store pending NLP data in session
          session.pendingTransaction = {
            amountNgn: parsed.amount,
            recipientName: parsed.recipientName,
            recipientAccountNumber: parsed.accountNumber,
          };
          session.state = ConversationState.AWAITING_BANK_DETAILS;
          setSession(userId, session);

          await ctx.reply(
            `🏦 Which bank is this account with?\n\n` +
            `Account: \`${parsed.accountNumber}\`\n` +
            `Amount: ${formatNgn(parsed.amount)}\n\n` +
            `Select the bank:`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
          );
          return;
        }

        let rate = 1550;
        try {
          const rates = await getPAJRates();
          rate = rates.offRampRate;
        } catch (err) {
          console.log('Using fallback rate for NLP send');
        }

        const fromMint = parsed.fromToken === 'USDC' ? SOLANA_TOKENS.USDC.mint :
                           parsed.fromToken === 'SOL' ? SOLANA_TOKENS.SOL.mint :
                           SOLANA_TOKENS.USDT.mint;
        const fromTokenInfo = Object.values(SOLANA_TOKENS).find(t => t.mint === fromMint) || SOLANA_TOKENS.USDT;

        const transferUsdt = parsed.amount / rate;
        const feeInfo = user[0]?.walletAddress
          ? await calculateSendFee(transferUsdt, user[0].walletAddress, userId)
          : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
        const usdtNeeded = transferUsdt + feeInfo.zendFeeUsdt;

        // ─── Check wallet balance before showing confirmation ───
        if (user[0]?.walletAddress) {
          const tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, fromMint);
          const solBalance = await walletService.getSolBalance(user[0].walletAddress);
          if (tokenBalance < transferUsdt) {
            const shortfall = transferUsdt - tokenBalance;
            await ctx.reply(
              `❌ *Insufficient Balance*\n\n` +
              `You want to send ${formatNgn(parsed.amount)}\n` +
              `You need: *${transferUsdt.toFixed(2)} ${fromTokenInfo.symbol}*\n` +
              `You have: *${tokenBalance.toFixed(2)} ${fromTokenInfo.symbol}*\n` +
              `Short by: *${shortfall.toFixed(2)} ${fromTokenInfo.symbol}*\n\n` +
              `Add more Dollars to your wallet or send a smaller amount.`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
            return;
          }
          if (!feeInfo.willFundSol && solBalance < MIN_SOL_FOR_GAS) {
            await ctx.reply(
              `❌ *Insufficient SOL for gas*\n\n` +
              `Gas: ~${MIN_SOL_FOR_GAS} SOL\n` +
              `You have: ${solBalance.toFixed(6)} SOL\n\n` +
              `Top up your SOL balance first.`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
            return;
          }
        }

        // ─── Verify bank account with PAJ ───
        let verifiedName = parsed.recipientName;
        let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';

        if (parsed.bankCode && parsed.accountNumber && user[0]?.pajSessionToken) {
          const verification = await verifyBankAccount(user[0].pajSessionToken, parsed.bankCode, parsed.accountNumber, userId);
          if (verification.verified && verification.accountName) {
            verifiedName = verification.accountName;
            verifiedStatus = 'verified';
          } else {
            console.log('[Verify] NLP failed:', verification.error);
          }
        } else if (!user[0]?.pajSessionToken) {
          verifiedStatus = 'no_paj';
        }

        session.pendingTransaction = {
          amountNgn: parsed.amount,
          amountUsdt: usdtNeeded,
          zendFeeUsdt: feeInfo.zendFeeUsdt,
          feeSol: feeInfo.feeSol,
          fromMint,
          recipientName: verifiedName,
          recipientAccountName: verifiedName,
          recipientBankName: parsed.bankName,
          recipientBankCode: parsed.bankCode,
          recipientAccountNumber: parsed.accountNumber,
          recipientWalletAddress: parsed.walletAddress,
        };
        session.state = ConversationState.AWAITING_CONFIRMATION;
        setSession(userId, session);

        let msg = `📤 *Confirm Transfer*\n\n`;

        if (verifiedStatus === 'verified') {
          msg += `✅ *Account Verified*\n`;
        } else if (verifiedStatus === 'no_paj') {
          msg += `⚠️ *Account Not Verified* (verify identity in Settings)\n`;
        } else {
          msg += `⚠️ *Could not verify account* — please double-check details\n`;
        }

        const fromSymbol = fromTokenInfo.symbol;
        msg += `\n` +
          `To: *${md(verifiedName || 'Recipient')}*\n` +
          `Bank: ${md(parsed.bankName) || 'Solana'}\n` +
          `Account: \`${parsed.accountNumber || parsed.walletAddress}\`\n` +
          `Amount: ${formatNgn(parsed.amount)}\n` +
          `${formatSendFeeLabel(feeInfo)}\n` +
          `You pay: *${usdtNeeded.toFixed(2)} ${fromSymbol}*\n` +
          `Rate: ${formatNgn(rate)} per Dollar\n\n` +
          `Confirm?`;

        const addressToCopy = parsed.accountNumber || parsed.walletAddress;
        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [{ text: '📋 Copy Account/Address', copy_text: { text: addressToCopy } } as any],
            [Markup.button.callback('✅ Confirm', 'confirm_send')],
            [Markup.button.callback('❌ Cancel', 'cancel_send')],
          ]),
        });
        return;
      }

      case 'add_naira': {
        // Simulate clicking Add Naira
        if (parsed.amount && parsed.amount > PAJ_MAX_DEPOSIT_NGN) {
          await ctx.reply(
            `❌ Amount too large.\nMaximum deposit is ${formatNgn(PAJ_MAX_DEPOSIT_NGN)}.`,
            mainMenu
          );
          return;
        }
        await ctx.reply(`💵 *Add Naira*\n\n` +
          (parsed.amount
            ? `Amount: ${formatNgn(parsed.amount)}\n\nHow much do you want to add? (Minimum ₦1,000)`
            : `How much NGN do you want to add? (Minimum ₦1,000)`),
          { parse_mode: 'Markdown', ...cancelKeyboard }
        );
        setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT, onrampAmount: parsed.amount });
        return;
      }

      case 'balance': {
        // Direct balance logic (avoid hacky handleUpdate)
        const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (user.length === 0) {
          await ctx.reply('Please run /start first.', mainMenu);
          return;
        }
        const walletAddress = user[0].walletAddress;
        try {
          const balances = await walletService.getAllBalances(walletAddress);
          const pajClient = await getPAJClient();
          const rates = pajClient ? await pajClient.getAllRates() : null;
          const offRampRate = rates?.offRampRate?.rate || 1550;
          const solPrice = await getSolPriceInUsdt();

          let msg = `💰 *Your Balance*\n\n`;
          let totalNgn = 0;

          for (const bal of balances) {
            if (!AUDD_ENABLED && bal.symbol === 'AUDD') continue;
            let ngnEquiv = 0;
            if (bal.symbol === 'SOL') {
              ngnEquiv = bal.amount * solPrice * offRampRate;
            } else {
              ngnEquiv = bal.amount * offRampRate;
            }
            totalNgn += ngnEquiv;
            const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : bal.symbol === 'AUDD' ? '🇦🇺' : bal.symbol === 'NEAR' ? '⚡' : '🟡';
            msg += `${emoji} *${bal.symbol}*  ${formatBalance(bal.amount, bal.symbol)}  (≈${formatNgn(ngnEquiv)})\n`;
          }

          msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
          msg += `💵 Total: ≈${formatNgn(totalNgn)}\n`;
          msg += `📈 Rate: ${formatNgn(offRampRate)} per Dollar`;

          await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
        } catch (err) {
          console.error('Balance error:', err);
          await ctx.reply('❌ Could not fetch balance. Please try again.', mainMenu);
        }
        return;
      }

      case 'bridge': {
        await showBridgeMenu(ctx, userId);
        return;
      }

      default: {
        const features = await getBotFeatures();
        const loading = await showLoading(ctx, 'Thinking...');
        const aiReply = (await chatWithAI(text, features)) ?? (await chatWithKimi(text, features));
        if (aiReply?.reply) {
          await finishLoading(ctx, loading.message_id, aiReply.reply);
          await ctx.reply('Menu:', mainMenu);
        } else {
          await finishLoading(
            ctx,
            loading.message_id,
            `I didn't catch that. Try the menu below or say something like:\n"Send 500 to 08123456789 Opay"`
          );
          await ctx.reply('Menu:', mainMenu);
        }
      }
    }
  }

  // ─── PIN: AWAITING_PIN ───
  if (session.state === ConversationState.AWAITING_PIN) {
    const pin = text.trim();
    if (!/^\d{4}$/.test(pin)) {
      await ctx.reply('❌ Please enter a valid 4-digit PIN.', cancelKeyboard);
      return;
    }

    const hashed = await hashPin(pin);
    await db.update(users)
      .set({ transactionPin: hashed })
      .where(eq(users.id, userId));

    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply('✅ PIN set successfully.', mainMenu);
    return;
  }

  // ─── PIN VERIFY: AWAITING_PIN_VERIFY ───
  if (session.state === ConversationState.AWAITING_PIN_VERIFY) {
    const pin = text.trim();
    if (!/^\d{4}$/.test(pin)) {
      await ctx.reply('❌ Please enter a valid 4-digit PIN.', cancelKeyboard);
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0 || !user[0].transactionPin) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ PIN not set. Please set a PIN in Settings.', mainMenu);
      return;
    }

    const result = await verifyPin(pin, user[0].transactionPin);
    if (!result.valid) {
      await ctx.reply('❌ Incorrect PIN. Please try again.', cancelKeyboard);
      return;
    }

    // Auto-migrate legacy plaintext PIN to hashed
    if (result.isLegacy) {
      await db.update(users)
        .set({ transactionPin: await hashPin(pin) })
        .where(eq(users.id, userId));
      console.log(`[PIN] Migrated plaintext PIN to hashed for user ${userId}`);
    }

    const action = session.pinVerifyAction;
    const savedPendingTx = session.pendingTransaction;
    const savedWithdrawData = session.withdrawData;

    if (action === 'swap') {
      const pt = savedPendingTx;
      if (!pt || !pt.swapQuote) {
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE, pendingTransaction: pt });
      await executeSwap(ctx, userId, pt);
    } else if (action === 'export') {
      setSession(userId, { state: ConversationState.IDLE });
      await doExportKey(ctx, userId);
    } else if (action === 'withdraw') {
      setSession(userId, { state: ConversationState.IDLE, withdrawData: savedWithdrawData });
      await executeNearIntentWithdraw(ctx, userId);
    } else if (action === 'send') {
      const pt = savedPendingTx;
      if (!pt?.amountNgn || !pt.amountUsdt) {
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE, pendingTransaction: pt });
      await executeSend(ctx, userId, {
        amountNgn: pt.amountNgn,
        amountUsdt: pt.amountUsdt,
        ngnRate: pt.ngnRate,
        zendFeeUsdt: pt.zendFeeUsdt,
        feeSol: pt.feeSol,
        fromMint: pt.fromMint,
        recipientBankCode: pt.recipientBankCode,
        recipientBankName: pt.recipientBankName,
        recipientAccountNumber: pt.recipientAccountNumber,
        recipientAccountName: pt.recipientAccountName,
        recipientName: pt.recipientName,
      });
    } else if (action === 'bulk_send') {
      const recipients = (savedPendingTx as any)?.bulkRecipients as Array<{
        amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string;
      }> | undefined;
      if (!recipients?.length) {
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE });
      await executeBulkSend(ctx, userId, recipients);
    } else if (action === 'schedule') {
      const sd = session.scheduleData;
      const startAt = sd?.startAt;
      if (!sd?.amountNgn || !startAt) {
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE });
      await saveScheduledTransfer(userId, sd, startAt);
      await ctx.reply(
        `✅ *Scheduled Transfer Created!*\n\n` +
        `To: ${md(sd.recipientName || 'Recipient')}\n` +
        `Bank: ${md(sd.bankName || '')}\n` +
        `Account: \`${sd.accountNumber}\`\n` +
        `Amount: ${formatNgn(sd.amountNgn)}\n` +
        `Frequency: ${sd.frequency}\n` +
        `Starts: ${startAt.toLocaleDateString('en-NG')}\n\n` +
        `Use *📅 Schedule* to view or cancel.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } else {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('✅ PIN verified.', mainMenu);
    }
    return;
  }

  // ─── SCHEDULE: AWAITING_SCHEDULE_RECIPIENT ───
  if (session.state === ConversationState.AWAITING_SCHEDULE_RECIPIENT) {
    // Parse "BANK_NAME ACCOUNT_NUMBER", "Name Bank Account", or "GTB • 0123456789"
    const cleanText = text.replace(/[•,]/g, ' ').trim();
    let accountNumber = '';
    let bankQuery = '';
    let recipientName: string | undefined;

    const acctMatch = cleanText.match(/(\d{10})\s*$/);
    if (acctMatch) {
      accountNumber = acctMatch[1];
      const beforeAcct = cleanText.slice(0, acctMatch.index).trim();
      const aiParsed = await parseMenuInputWithAI(beforeAcct || cleanText);
      if (aiParsed?.success && aiParsed.bankCode && aiParsed.accountNumber) {
        accountNumber = aiParsed.accountNumber;
        bankQuery = aiParsed.bankCode.toLowerCase();
        recipientName = aiParsed.recipientName || undefined;
      } else {
        const parts = beforeAcct.split(/\s+/).filter(Boolean);
        if (parts.length >= 1) {
          bankQuery = parts[parts.length - 1].toLowerCase();
          if (parts.length > 1) recipientName = parts.slice(0, -1).join(' ');
        }
      }
    }

    if (!accountNumber) {
      await ctx.reply('❌ Please enter bank name and account number.\nExample: GTB 0123456789 or Tunde GTB 0123456789', cancelKeyboard);
      return;
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      await ctx.reply('❌ Account number must be 10 digits.', cancelKeyboard);
      return;
    }

    // Find bank
    const bank = NIGERIAN_BANKS.find(b =>
      b.code.toLowerCase() === bankQuery ||
      b.name.toLowerCase().includes(bankQuery) ||
      bankQuery.includes(b.name.toLowerCase().split(' ')[0]) ||
      bankQuery.includes(b.code.toLowerCase())
    );
    if (!bank) {
      const bankButtons = NIGERIAN_BANKS.map(b => Markup.button.callback(b.name, `schedule_bank:${b.code}`));
      const rows: any[] = [];
      for (let i = 0; i < bankButtons.length; i += 2) {
        rows.push(bankButtons.slice(i, i + 2));
      }
      setSession(userId, {
        state: ConversationState.AWAITING_BANK_DETAILS,
        scheduleData: { pendingAccountNumber: accountNumber },
      });
      await ctx.reply(
        `🏦 Which bank is account \`${accountNumber}\` with?`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
      );
      return;
    }

    // Try to verify account name via PAJ if linked
    let accountName = recipientName || 'Unknown';
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user[0]?.pajSessionToken) {
      try {
        const verification = await verifyBankAccount(user[0].pajSessionToken, bank.code, accountNumber, userId);
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

    await ctx.reply(
      `✅ *Recipient Saved*\n\n` +
      `Name: ${md(accountName)}\n` +
      `Bank: ${md(bank.name)}\n` +
      `Account: \`${accountNumber}\`\n\n` +
      `How much NGN do you want to send each time?\n` +
      `Example: 50000`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ─── SCHEDULE: AWAITING_SCHEDULE_AMOUNT ───
  if (session.state === ConversationState.AWAITING_SCHEDULE_AMOUNT) {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!amount || amount < 100) {
      await ctx.reply('❌ Please enter a valid amount (minimum ₦100).', cancelKeyboard);
      return;
    }

    session.scheduleData!.amountNgn = amount;
    session.state = ConversationState.AWAITING_SCHEDULE_FREQUENCY;
    setSession(userId, session);

    await ctx.reply(
      `📅 *Schedule Transfer*\n\n` +
      `Amount: ${formatNgn(amount)}\n\n` +
      `How often should this run?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔁 Once', 'schedule_freq:once')],
          [Markup.button.callback('📆 Daily', 'schedule_freq:daily')],
          [Markup.button.callback('📅 Weekly', 'schedule_freq:weekly')],
          [Markup.button.callback('🗓️ Monthly', 'schedule_freq:monthly')],
          [Markup.button.callback('❌ Cancel', 'cancel_schedule')],
        ]),
      }
    );
    return;
  }

  // ─── SCHEDULE: AWAITING_SCHEDULE_FREQUENCY ───
  if (session.state === ConversationState.AWAITING_SCHEDULE_FREQUENCY) {
    const freqMap: Record<string, 'once' | 'daily' | 'weekly' | 'monthly'> = {
      once: 'once', 'one time': 'once', 'one-time': 'once',
      daily: 'daily', day: 'daily',
      weekly: 'weekly', week: 'weekly',
      monthly: 'monthly', month: 'monthly',
    };
    const freq = freqMap[text.trim().toLowerCase()];
    if (!freq || !session.scheduleData) {
      await ctx.reply(
        '❌ Please pick a frequency from the buttons above, or type: *once*, *daily*, *weekly*, or *monthly*.',
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      return;
    }

    session.scheduleData.frequency = freq;
    session.state = ConversationState.AWAITING_SCHEDULE_START;
    setSession(userId, session);

    await ctx.reply(
      `📅 *Schedule Transfer*\n\n` +
      `Frequency: *${freq}*\n\n` +
      `When should the first transfer happen?\n` +
      `Enter a date (YYYY-MM-DD) or type *now* to start immediately.`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
    return;
  }

  // ─── SCHEDULE: AWAITING_SCHEDULE_START ───
  if (session.state === ConversationState.AWAITING_SCHEDULE_START) {
    let startAt: Date;
    const lower = text.trim().toLowerCase();

    if (lower === 'now' || lower === 'today') {
      startAt = new Date();
    } else {
      // Try parsing YYYY-MM-DD
      const parsed = new Date(text.trim());
      if (isNaN(parsed.getTime())) {
        await ctx.reply(
          `❌ Invalid date. Please enter a date in YYYY-MM-DD format, or type *now* to start immediately.`,
          cancelKeyboard
        );
        return;
      }
      startAt = parsed;
    }

    const sd = session.scheduleData!;
    sd.startAt = startAt;

    // Check if PIN is required
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length > 0 && user[0].transactionPin) {
      setSession(userId, {
        state: ConversationState.AWAITING_PIN_VERIFY,
        pinVerifyAction: 'schedule',
        scheduleData: sd,
      });
      const pinMsg = await ctx.reply(
        `🔐 *Security Check*\n\n` +
        `Enter your 4-digit PIN to confirm this scheduled transfer:`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      getSession(userId).lastBotMessageId = pinMsg.message_id;
      return;
    }

    // No PIN — save directly
    await saveScheduledTransfer(userId, sd, startAt);
    setSession(userId, { state: ConversationState.IDLE });

    await ctx.reply(
      `✅ *Scheduled Transfer Created!*\n\n` +
      `To: ${md(sd.recipientName)}\n` +
      `Bank: ${md(sd.bankName)}\n` +
      `Account: \`${sd.accountNumber}\`\n` +
      `Amount: ${formatNgn(sd.amountNgn!)}\n` +
      `Frequency: ${sd.frequency}\n` +
      `Starts: ${startAt.toLocaleDateString('en-NG')}\n\n` +
      `Use *📅 Schedule* to view or cancel.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  // ─── FEEDBACK: AWAITING_FEEDBACK_TEXT ───
  if (session.state === ConversationState.AWAITING_FEEDBACK_TEXT) {
    const feedbackText = text.trim();
    if (feedbackText.length < 3) {
      await ctx.reply('❌ Please write a bit more so we can understand your feedback.', cancelKeyboard);
      return;
    }
    if (feedbackText.length > 2000) {
      await ctx.reply('❌ Feedback is too long. Please keep it under 2000 characters.', cancelKeyboard);
      return;
    }
    try {
      await db.insert(feedback).values({
        userId,
        message: feedbackText,
        category: 'general',
        status: 'open',
      });
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply(
        `📝 *Feedback Received*\n\n` +
        `Thank you\! We read every message and will follow up if needed.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } catch (err) {
      console.error('[Feedback] Save error:', err);
      await ctx.reply('❌ Could not save feedback. Please try again later.', mainMenu);
    }
    return;
  }
  });
}
