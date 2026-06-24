import { Markup } from 'telegraf';
import { db, users, savedBankAccounts } from '@zend/db';
import { eq, and } from 'drizzle-orm';
import { ConversationState, SOLANA_TOKENS, NIGERIAN_BANKS } from '@zend/shared';
import { getPAJClient, walletService } from '../deps.js';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';
import { md } from '../lib/telegram.js';
import { isGroupChat, promptPrivateChat } from '../lib/group.js';
import { getSession, setSession } from '../session/store.js';
import { checkSendBalance } from '../utils/send-balance.js';
import {
  formatSendFeeLabel,
  MIN_SOL_FOR_GAS,
  type SendFeeInfo,
} from '../utils/fees.js';
import { AUDD_ENABLED } from '../utils/flags.js';
import { calculateSendFee } from '../services/gas.js';
import { getStablecoinBalances } from '../services/stablecoin.js';
import { getPAJRates, verifyBankAccount } from '../services/paj.js';
import { executeSendCore } from '../services/send.js';
import { checkMilestones } from '../services/milestones.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function executeSend(
  ctx: ZendContext,
  userId: string,
  txData: {
    amountNgn: number;
    amountUsdt: number;
    ngnRate?: number;
    zendFeeUsdt?: number;
    fromMint?: string;
    recipientBankCode?: string;
    recipientBankName?: string;
    recipientAccountNumber?: string;
    recipientAccountName?: string;
    recipientName?: string;
    feeSol?: number;
  }
) {
  const fromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === (txData.fromMint || SOLANA_TOKENS.USDT.mint)) || SOLANA_TOKENS.USDT;
  let displayFeeUsdt = txData.zendFeeUsdt || 0;

  const processingText =
    `⏳ *Processing...*\n\n` +
    `Sending ${txData.amountUsdt.toFixed(2)} ${fromToken.symbol}\n` +
    `Fee: ~${displayFeeUsdt.toFixed(2)} USDT\n` +
    `Estimated: 1-5 minutes`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(processingText, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(processingText, { parse_mode: 'Markdown' });
  }

  setSession(userId, { state: ConversationState.IDLE });
  const result = await executeSendCore(userId, txData);

  displayFeeUsdt = result.finalFeeUsdt ?? txData.zendFeeUsdt ?? 0;

  if (result.success) {
    const { txId, solanaTxHash, offRampRef } = result;
    const finalName = txData.recipientAccountName || txData.recipientName || 'Recipient';
    const finalBank = txData.recipientBankName || 'Unknown';
    const finalAccount = txData.recipientAccountNumber || '0000000000';

    setTimeout(async () => {
      await ctx.reply(
        `✅ *Transfer Complete!*\n\n` +
        `${formatNgn(txData.amountNgn)} sent to ${finalName}\n` +
        `${finalBank} • \`${finalAccount}\`\n\n` +
        `Fee: ~${displayFeeUsdt.toFixed(2)} USDT\n` +
        `Reference: \`${txId}\`\n` +
        (solanaTxHash ? `View: [Transaction Details](https://solscan.io/tx/${solanaTxHash})\n` : '') +
        `Time: ~2 minutes`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      if (txData.recipientBankCode && txData.recipientAccountNumber) {
        try {
          const existing = await db.select().from(savedBankAccounts)
            .where(and(
              eq(savedBankAccounts.userId, userId),
              eq(savedBankAccounts.bankCode, txData.recipientBankCode),
              eq(savedBankAccounts.accountNumber, txData.recipientAccountNumber)
            ))
            .limit(1);
          if (existing.length === 0) {
            await db.insert(savedBankAccounts).values({
              userId,
              bankCode: txData.recipientBankCode,
              bankName: txData.recipientBankName || finalBank,
              accountNumber: txData.recipientAccountNumber,
              accountName: finalName,
              verified: true,
            });
          }
        } catch (err) {
          console.log('[Schedule] Auto-save failed (non-critical):', err);
        }
      }
      await checkMilestones(userId, (text) => ctx.reply(text, { parse_mode: 'Markdown', ...mainMenu }));
    }, 3000);
  } else {
    await ctx.reply(
      `❌ *Transfer Failed*\n\n` +
      `Error: ${result.error}\n` +
      `No funds were deducted.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }
}

export async function prepareSendConfirmation(
  ctx: ZendContext,
  userId: string,
  amountNgn: number,
  recipientAccountNumber: string,
  bankCode: string,
  bankName: string,
  recipientName?: string,
  fromMint?: string
) {
  const selectedMint =
    fromMint === SOLANA_TOKENS.AUDD.mint ? SOLANA_TOKENS.AUDD.mint : SOLANA_TOKENS.USDT.mint;
  const selectedToken = Object.values(SOLANA_TOKENS).find(t => t.mint === selectedMint) || SOLANA_TOKENS.USDT;
  const selectedSymbol = selectedToken.symbol;
  const autoSwapNote =
    selectedMint === SOLANA_TOKENS.USDT.mint
      ? '\n_Paid in USDT — we auto-convert USDC if needed._\n'
      : '';
  const pajClient = await getPAJClient();
  let rate = 1550;
  try {
    if (pajClient) {
      const rates = await getPAJRates();
      rate = rates.offRampRate;
    }
  } catch (err) {
    console.log('Using fallback rate for send confirmation');
  }

  const transferUsdt = amountNgn / rate;

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  let feeInfo: SendFeeInfo = {
    zendFeeUsdt: 0, feeSol: 0, feeBps: 100, willFundSol: false,
    transferUsdt, totalUsdt: transferUsdt,
  };
  if (user[0]?.walletAddress) {
    feeInfo = await calculateSendFee(transferUsdt, user[0].walletAddress, userId);
  }
  const { zendFeeUsdt, feeSol, feeBps, willFundSol } = feeInfo;
  const usdtNeeded = transferUsdt + zendFeeUsdt;

  if (user[0]?.walletAddress) {
    const isAudd = selectedMint === SOLANA_TOKENS.AUDD.mint;
    const tokenBalance = isAudd
      ? await walletService.getTokenBalance(user[0].walletAddress, selectedMint)
      : (await getStablecoinBalances(user[0].walletAddress)).total;
    const solBalance = await walletService.getSolBalance(user[0].walletAddress);
    const balanceCheck = checkSendBalance({
      tokenBalance,
      solBalance,
      transferUsdt,
      zendFeeUsdt,
      willFundSol,
      isAudd,
    });

    if (!balanceCheck.ok) {
      if (balanceCheck.error === 'no_audd') {
        await ctx.reply(
          `❌ *No AUDD Balance*\n\n` +
          `You don't have any AUDD to send.\n\n` +
          `Add AUDD to your wallet first.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        return;
      }
      if (balanceCheck.error === 'insufficient_token') {
        await ctx.reply(
          `❌ *Insufficient Balance*\n\n` +
          `You want to send ${formatNgn(amountNgn)}\n` +
          `You need: *${balanceCheck.usdtNeeded.toFixed(2)} ${selectedSymbol}* (incl. ${zendFeeUsdt.toFixed(2)} fee)\n` +
          `You have: *${tokenBalance.toFixed(2)} ${isAudd ? selectedSymbol : 'USDT/USDC'}*\n` +
          `Short by: *${balanceCheck.shortfall!.toFixed(2)} ${isAudd ? selectedSymbol : 'USDT'}*\n\n` +
          `Add more Dollars to your wallet or send a smaller amount.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        return;
      }
      if (balanceCheck.error === 'insufficient_sol') {
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
  }

  let verifiedName = recipientName;
  let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';

  if (user[0]?.pajSessionToken) {
    const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, recipientAccountNumber, userId);
    if (verification.verified && verification.accountName) {
      verifiedName = verification.accountName;
      verifiedStatus = 'verified';
    } else {
      console.log('[Verify] prepareSend failed:', verification.error);
    }
  } else {
    verifiedStatus = 'no_paj';
  }

  const session = getSession(userId);
  session.pendingTransaction = {
    amountNgn,
    amountUsdt: usdtNeeded,
    zendFeeUsdt,
    feeSol,
    ngnRate: rate,
    fromMint: selectedMint, // bank sends settle via USDT (USDC auto-swapped)
    recipientName: verifiedName,
    recipientAccountName: verifiedName,
    recipientBankName: bankName,
    recipientBankCode: bankCode,
    recipientAccountNumber,
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

  msg += `\n` +
    `To: *${md(verifiedName || 'Recipient')}*\n` +
    `Bank: ${md(bankName)}\n` +
    `Account: \`${recipientAccountNumber}\`\n` +
    `Amount: ${formatNgn(amountNgn)}\n` +
    `${formatSendFeeLabel({ zendFeeUsdt, feeBps, willFundSol, gasCostUsdt: feeInfo.gasCostUsdt, extraFeeUsdt: feeInfo.extraFeeUsdt, feeSol, feeMode: feeInfo.feeMode, percentageFeeUsdt: feeInfo.percentageFeeUsdt })}\n` +
    `You pay: *${usdtNeeded.toFixed(2)} ${selectedSymbol}*${autoSwapNote}` +
    `Rate: ${formatNgn(rate)} per Dollar\n\n` +
    `Confirm?`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', 'confirm_send')],
      [Markup.button.callback('❌ Cancel', 'cancel_send')],
    ]),
  });
}

async function startBankSend(ctx: ZendContext, userId: string) {
  if (AUDD_ENABLED) {
    await ctx.reply(
      `📤 *Send to Nigerian Bank*\n\n` +
      `Send from which balance?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('USDT', 'send_token:USDT')],
          [Markup.button.callback('AUDD', 'send_token:AUDD')],
          [Markup.button.callback('❌ Cancel', 'cancel_send')],
        ]),
      }
    );
    return;
  }

  setSession(userId, {
    state: ConversationState.AWAITING_SEND_AMOUNT,
    pendingTransaction: { fromMint: SOLANA_TOKENS.USDT.mint },
  });
  await ctx.reply(
    `📤 *Send to Nigerian Bank*\n\n` +
    `Paid from your Dollar balance (USDT or USDC — we auto-convert if needed).\n\n` +
    `How much do you want to send? (in Naira)\n\n` +
    `Examples: 50000, 100000, 5000`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

export function registerSendHandlers({ bot: b }: HandlerContext): void {
  b.hears('📤 Send', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (user.length === 0) {
      await ctx.reply('Please run /start first.', mainMenu);
      return;
    }

    if (isGroupChat(ctx)) {
      await promptPrivateChat(ctx, 'send money');
      return;
    }

    await ctx.reply(
      `📤 *Send Money*\n\n` +
      `Where are you sending?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏦 Nigerian Bank', 'send_bank_start')],
          [Markup.button.callback('📤 Other Apps (Binance, MetaMask…)', 'withdraw_start')],
          [Markup.button.callback('❌ Cancel', 'cancel_send')],
        ]),
      }
    );
  });

  b.action('send_bank_start', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    if (isGroupChat(ctx)) {
      await promptPrivateChat(ctx, 'send money');
      return;
    }
    await startBankSend(ctx, userId);
  });

  b.action(/send_token:([A-Z]+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    const tokenSymbol = ctx.match[1];

    if (!AUDD_ENABLED && tokenSymbol === 'AUDD') {
      await ctx.editMessageText('❌ AUDD sends are not available right now.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    const token = Object.values(SOLANA_TOKENS).find(t => t.symbol === tokenSymbol);

    if (!token) {
      await ctx.editMessageText('❌ Invalid token selected.');
      return;
    }

    setSession(userId, {
      state: ConversationState.AWAITING_SEND_AMOUNT,
      pendingTransaction: { fromMint: token.mint },
    });

    await ctx.editMessageText(
      `📤 *Send Money (${tokenSymbol})*\n\n` +
      `How much do you want to send? (in Naira)\n\n` +
      `Examples:\n• 50000\n• 100000\n• 5000`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply('Waiting for amount...', cancelKeyboard);
  });

  b.action('confirm_send', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();

    if (isGroupChat(ctx)) {
      await promptPrivateChat(ctx, 'send money');
      return;
    }

    const session = getSession(userId);

    if (session.state !== ConversationState.AWAITING_CONFIRMATION || !session.pendingTransaction) {
      await ctx.editMessageText('❌ Session expired. Please start over.');
      await ctx.reply('Use the menu to start again.', mainMenu);
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0) {
      await ctx.reply('Please run /start first.', mainMenu);
      return;
    }

    if (user[0].transactionPin) {
      setSession(userId, { ...session, state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'send' });
      await ctx.editMessageText(
        `🔐 *Security Check*\n\n` +
        `Enter your 4-digit PIN to confirm this transfer:`,
        { parse_mode: 'Markdown' }
      );
      const waitMsg = await ctx.reply('Waiting for PIN...', cancelKeyboard);
      getSession(userId).lastBotMessageId = waitMsg.message_id;
      return;
    }

    const { amountNgn, amountUsdt, ngnRate, zendFeeUsdt, fromMint, recipientBankCode, recipientBankName, recipientAccountNumber, recipientAccountName, recipientName } =
      session.pendingTransaction;

    await executeSend(ctx, userId, {
      amountNgn: amountNgn!,
      amountUsdt: amountUsdt!,
      ngnRate,
      zendFeeUsdt,
      feeSol: session.pendingTransaction?.feeSol,
      fromMint,
      recipientBankCode,
      recipientBankName,
      recipientAccountNumber,
      recipientAccountName,
      recipientName,
    });
  });

  b.action('cancel_send', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.editMessageText('❌ Cancelled.');
    await ctx.reply('What would you like to do?', mainMenu);
  });

  b.action(/nlp_bank:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    const session = getSession(userId);
    const bankCode = ctx.match[1];

    if (session.state !== ConversationState.AWAITING_BANK_DETAILS || !session.pendingTransaction) {
      await ctx.editMessageText('❌ Session expired. Please start over.');
      return;
    }

    const bank = NIGERIAN_BANKS.find(b => b.code === bankCode);
    if (!bank) {
      await ctx.editMessageText('❌ Invalid bank selected.');
      return;
    }

    const { amountNgn, recipientName, recipientAccountNumber, fromMint } = session.pendingTransaction;
    await prepareSendConfirmation(ctx, userId, amountNgn!, recipientAccountNumber!, bank.code, bank.name, recipientName || undefined, fromMint);
  });

  b.hears('💴 Cash Out', async (ctx) => {
    if (isGroupChat(ctx)) {
      await promptPrivateChat(ctx, 'cash out');
      return;
    }
    const userId = ctx.from.id.toString();
    setSession(userId, {
      state: ConversationState.AWAITING_SEND_AMOUNT,
      pendingTransaction: {},
    });
    await ctx.reply(
      `💴 *Cash Out to Bank*\n\n` +
      `How much do you want to withdraw? (in Naira)\n\n` +
      `Examples: 50000, 100000, 5000`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
  });
}