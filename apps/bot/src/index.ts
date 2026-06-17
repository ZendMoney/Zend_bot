import './env.js';

import { Telegraf, Markup, Context } from 'telegraf';
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { message } from 'telegraf/filters';
import { db, checkConnection } from '@zend/db';
import { users, transactions, savedBankAccounts, scheduledTransfers } from '@zend/db';
import { eq, sql, and } from 'drizzle-orm';
import {
  parseCommand, transcribeVoice, chatWithAI, chatWithKimi, isCasualGreeting,
  analyzeVoiceWithAI, analyzeVoiceWithKimi, parseMenuInputWithAI,
  parseReceiptWithQVAC, askTransactionQuestion, indexTransaction,
  parseBulkSendWithAI, type ParsedCommand,
} from './services/nlp.js';
import { initQVAC, getQVACStatus } from './services/qvac/index.js';
import {
  ConversationState,
  SOLANA_TOKENS,
  NIGERIAN_BANKS,
  PAJ_MIN_DEPOSIT_NGN,
  PAJ_MAX_DEPOSIT_NGN,
} from '@zend/shared';

import { PIN_TTL_MS } from './middleware/auto-delete.js';
import { getSession, setSession, initSessionStore } from './session/store.js';
import type { ZendContext, ZendSession } from './session/types.js';
import { checkSendBalance } from './utils/send-balance.js';
import { runStartupHealthChecks } from './launch/health.js';

import {
  buyAirtime, buyData, buyElectricity, buyCable,
  NETWORKS, DISCOS, CABLE_PROVIDERS, getDataPlans, validateMeter, validateSmartCard,
  isDemoMode, type DataPlan,
} from './services/bills/index.js';
import {
  purchaseAirtime as airbillsBuyAirtime,
  purchaseData as airbillsBuyData,
  purchaseElectricity as airbillsBuyElectricity,
  purchaseCable as airbillsBuyCable,
} from './services/airbills/index.js';
import {
  formatSendFeeLabel,
  MIN_SOL_FOR_GAS,
  ATA_RENT_SOL,
  ZEND_FEE_NORMAL_BPS,
  ZEND_FEE_FUNDED_BPS,
  type SendFeeInfo,
} from './utils/fees.js';
import { getSolPriceInUsdt } from './utils/sol-price.js';
import { AUDD_ENABLED, isAuddSwapPair } from './utils/flags.js';
import {
  SOLANA_RPC,
  Currency,
  Chain,
  walletService,
  airbillsClient,
  getPAJClient,
  DEV_WALLET_SECRET,
  getPublicBaseUrl,
  getPajWebhookUrl,
  deps,
} from './deps.js';
import { bot } from './bot.js';
import {
  mainMenu,
  cancelKeyboard,
  billsMenu,
  billsBackKeyboard,
  REPLY_KEYBOARD_BUTTONS,
} from './keyboards/index.js';
import { md, escapeTelegramMarkdown } from './lib/telegram.js';
import { isGroupChat, getBotUsername, promptPrivateChat } from './lib/group.js';
import { formatBalance, formatNgn } from './lib/format.js';
import { getAuddPriceInUsdt } from './services/pricing.js';
import { getBotFeatures } from './services/bot-features.js';
import { run } from './launch/main.js';
import {
  calculateSendFee,
  fundSolIfNeeded,
  gasFundingErrorToUserMessage,
} from './services/gas.js';
import {
  getPAJRates,
  verifyBankAccount,
  isPajSessionError,
  clearPajSession,
} from './services/paj.js';
import { executeSendCore } from './services/send.js';
import { executeSwap } from './services/swap.js';
import { registerPreTextHandlers, registerPostTextHandlers, registerTextRouter } from './handlers/register.js';
import { doExportKey } from './handlers/wallet-export.js';
import { executeNearIntentWithdraw } from './handlers/withdraw-execute.js';
import { sanitizeAccountNumber } from './lib/account.js';
import {
  getNearIntentsClient,
  NEAR_INTENTS_ASSETS,
  CHAIN_DISPLAY_NAMES,
  TOKEN_DECIMALS as NEAR_INTENTS_DECIMALS,
} from '@zend/near-intents-client';
import {
  DEPOSIT_CHAINS,
  WITHDRAW_CHAINS,
  SOLANA_DEST_ASSETS,
  SOLANA_ORIGIN_ASSETS,
  createWithdrawQuote,
  fundNearIntentDeposit,
  getDestinationAssetId,
  validateChainAddress,
  formatChainName,
} from './services/near-intents-flow.js';
import { handleBalance } from './handlers/balance.js';
import { startOnboarding } from './handlers/start.js';
import { executeSend, prepareSendConfirmation } from './handlers/send.js';
import { handleSwapAmount, showSwapMenu } from './handlers/swap.js';
import { showReceive } from './handlers/receive.js';
import { showHistory } from './handlers/history.js';
import { showSettings } from './handlers/settings.js';
import { showLoading, updateLoading, finishLoading } from './lib/loading.js';

// ═════════════════════════════════════════════════════════════════════════════
// /WALLET — View Address
// ═════════════════════════════════════════════════════════════════════════════

bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const u = user[0];
  const msg =
    `👛 *Your Account*\n\n` +
    `*Your Address:*\n\n` +
    `${u.walletAddress}\n\n` +
    `*Currencies:* SOL, USDT, USDC${AUDD_ENABLED ? ', AUDD' : ''}\n\n` +
    `⚠️ To view your secret code, go to *⚙️ Settings*.`;

  const copyBtn = Markup.inlineKeyboard([
    [{ text: '📋 Copy Address', copy_text: { text: u.walletAddress } } as any]
  ]);

  if (isGroupChat(ctx)) {
    const name = ctx.from?.first_name || 'there';
    await ctx.reply(`📩 ${name}, check your DM for your address.`);
    await ctx.telegram.sendMessage(ctx.from!.id, msg, { parse_mode: 'Markdown', ...copyBtn });
    return;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown', ...copyBtn });
});

bot.action('export_key', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'view your secret code');
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const u = user[0];

  // If PIN is set, require it first
  if (u.transactionPin) {
    setSession(userId, { state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'export' });
    await ctx.editMessageText(
      `🔐 *Security Check*\n\n` +
      `Enter your 4-digit PIN to view your secret code:`,
      { parse_mode: 'Markdown' }
    );
    const waitMsg = await ctx.reply('Waiting for PIN...', cancelKeyboard);
    getSession(userId).lastBotMessageId = waitMsg.message_id;
    return;
  }

  // No PIN set — proceed directly (but warn)
  await ctx.editMessageText(
    `⚠️ *No PIN Set*\n\n` +
    `For security, we recommend setting a PIN in Settings before viewing your secret code.\n\n` +
    `Proceeding anyway...`,
    { parse_mode: 'Markdown' }
  );
  await doExportKey(ctx, userId);
});

// ═════════════════════════════════════════════════════════════════════════════
registerPreTextHandlers({ bot, deps });
registerTextRouter({ bot, deps });

// ═════════════════════════════════════════════════════════════════════════════
// 🎙️ VOICE MESSAGES — Transcribe & Parse
// ═════════════════════════════════════════════════════════════════════════════

bot.on(message('voice'), async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const loadingVoice = await showLoading(ctx, 'Listening to your voice note...');

  try {
    // Download voice file from Telegram
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const response = await fetch(fileLink.toString());
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`[Voice] Downloaded ${audioBuffer.length} bytes`);

    await updateLoading(ctx, loadingVoice.message_id, 'Transcribing with QVAC Whisper...');

    // Step 1: STT
    const t0 = Date.now();
    const text = await transcribeVoice(audioBuffer);
    console.log(`[Voice] Transcribed in ${Date.now() - t0}ms: "${text}"`);
    if (!text.trim()) {
      await finishLoading(ctx, loadingVoice.message_id, '❌ Could not hear anything. Please speak clearly and try again.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    await updateLoading(ctx, loadingVoice.message_id, 'Analyzing with QVAC AI...');

    // Step 2: QVAC LLM analysis + confirmation
    const analysis = await analyzeVoiceWithAI(text);

    if (!analysis) {
      await finishLoading(ctx, loadingVoice.message_id, `📝 *You said:* "${text}"\n\nI understood you, but I need a bit more info. Can you type it out?`, 'Markdown');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    await finishLoading(ctx, loadingVoice.message_id, `📝 *You said:* "${text}"`, 'Markdown');

    // Execute based on intent
    switch (analysis.intent) {
      case 'balance': {
        await ctx.reply(analysis.message || 'Checking your balance...', mainMenu);
        await handleBalance(ctx, userId);
        return;
      }
      case 'add_naira': {
        await ctx.reply(analysis.message || 'Starting Add Naira...', mainMenu);
        const pajClient = await getPAJClient();
        if (!pajClient) {
          await ctx.reply('❌ PAJ service is not configured. Please contact support.', mainMenu);
          return;
        }
        if (analysis.amount && analysis.amount > PAJ_MAX_DEPOSIT_NGN) {
          await ctx.reply(
            `❌ Amount too large.\nMaximum deposit is ${formatNgn(PAJ_MAX_DEPOSIT_NGN)}.`,
            mainMenu
          );
          return;
        }
        setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT, onrampAmount: analysis.amount || undefined });
        await ctx.reply(
          `💵 *Add Naira*\n\n` +
          (analysis.amount && analysis.amount >= PAJ_MIN_DEPOSIT_NGN
            ? `Amount: ${formatNgn(analysis.amount)}\n\nConfirm or enter a different amount (Minimum ₦1,000):`
            : `How much NGN do you want to add to your wallet?\n\nMinimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n\nEnter the amount (numbers only):`),
          { parse_mode: 'Markdown', ...cancelKeyboard }
        );
        return;
      }
      case 'send':
      case 'cash_out': {
        // Sanitize Whisper artifacts from account numbers
        const cleanAccountNumber = sanitizeAccountNumber(analysis.accountNumber);
        if (cleanAccountNumber) {
          (analysis as any).accountNumber = cleanAccountNumber;
        }

        if (!analysis.amount) {
          setSession(userId, { state: ConversationState.AWAITING_SEND_AMOUNT, pendingTransaction: {} });
          await ctx.reply(
            (analysis.message || 'Got it, you want to send money.') + '\n\nHow much do you want to send? (in Naira)',
            { parse_mode: 'Markdown', ...cancelKeyboard }
          );
          return;
        }
        // Wallet send (crypto address)
        if (analysis.walletAddress) {
          await ctx.reply(
            `📤 *Send to Wallet*\n\n` +
            `Amount: ${formatNgn(analysis.amount)}\n` +
            `Address: \`${analysis.walletAddress}\`\n\n` +
            `Crypto wallet sends are not yet available. Please use bank transfer instead.`,
            { parse_mode: 'Markdown', ...mainMenu }
          );
          return;
        }
        // Bank send — need account number + bank
        if (!analysis.accountNumber) {
          setSession(userId, {
            state: ConversationState.AWAITING_SEND_RECIPIENT,
            pendingTransaction: { amountNgn: analysis.amount || undefined, recipientName: analysis.recipientName || undefined },
          });
          await ctx.reply(
            (analysis.message || `Send ${formatNgn(analysis.amount || 0)}`) + '\n\nPlease provide recipient details:\n"Name BankCode AccountNumber"\nExample: "Tunde GTB 0123456789"',
            { parse_mode: 'Markdown', ...cancelKeyboard }
          );
          return;
        }
        if (!analysis.bankCode) {
          const bankButtons = NIGERIAN_BANKS.map(b => Markup.button.callback(b.name, `nlp_bank:${b.code}`));
          const rows: any[] = [];
          for (let i = 0; i < bankButtons.length; i += 2) {
            rows.push(bankButtons.slice(i, i + 2));
          }
          setSession(userId, {
            state: ConversationState.AWAITING_BANK_DETAILS,
            pendingTransaction: {
              amountNgn: analysis.amount || undefined,
              recipientAccountNumber: analysis.accountNumber,
              recipientName: analysis.recipientName || undefined,
            },
          });
          await ctx.reply(
            `🏦 Which bank?\n\n` +
            `Account number: \`${analysis.accountNumber}\`\n` +
            `Amount: ${formatNgn(analysis.amount || 0)}\n\n` +
            `Select a bank:`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
          );
          return;
        }
        // Full details — verify + show confirmation
        const bank = NIGERIAN_BANKS.find(b => b.code === analysis.bankCode);
        if (!bank) {
          await ctx.reply('❌ Unknown bank code. Please try again.', mainMenu);
          return;
        }
        await prepareSendConfirmation(
          ctx, userId, analysis.amount,
          analysis.accountNumber, bank.code, bank.name,
          analysis.recipientName || undefined,
          undefined // voice flow defaults to USDT for now
        );
        return;
      }
      case 'receive': {
        await ctx.reply(analysis.message || 'Here is how to receive money:', mainMenu);
        await showReceive(ctx, userId);
        return;
      }
      case 'history': {
        await ctx.reply(analysis.message || 'Loading your history...', mainMenu);
        await showHistory(ctx, userId);
        return;
      }
      case 'settings': {
        await ctx.reply(analysis.message || 'Opening settings...', mainMenu);
        await showSettings(ctx, userId);
        return;
      }
      case 'swap': {
        await ctx.reply(analysis.message || 'Opening swap...', mainMenu);
        await showSwapMenu(ctx, userId);
        return;
      }
      default: {
        // chat / unknown — just reply conversationally
        await ctx.reply(analysis.message || 'I\'m not sure what you mean. Try using the menu.', mainMenu);
      }
    }

  } catch (err: any) {
    console.error('[Voice] Error:', err.message || err);
    try {
      await finishLoading(ctx, loadingVoice.message_id, '❌ Could not process voice note. Please type your command or use the menu below.');
    } catch {
      await ctx.reply('❌ Could not process voice note. Please type your command or use the menu below.', mainMenu);
    }
    await ctx.reply('Menu:', mainMenu);
  }
});

// Voice confirmation handlers (legacy — new voice flow uses confirm_send/cancel_send directly)
bot.action('voice_confirm_yes', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  const va = session.voiceAnalysis;

  if (!va || !va.amount) {
    await ctx.editMessageText('❌ Session expired. Please try again.');
    return;
  }

  // Clear voice analysis
  session.voiceAnalysis = undefined;
  setSession(userId, session);

  // If we have enough info, prepare confirmation UI (same as direct voice flow)
  if (va.accountNumber && va.bankCode) {
    const bank = NIGERIAN_BANKS.find(b => b.code === va.bankCode);
    if (bank) {
      await ctx.editMessageText('✅ Got it! Preparing confirmation...');
      await prepareSendConfirmation(
        ctx, userId, va.amount,
        va.accountNumber, bank.code, bank.name,
        va.recipientName || undefined,
        undefined // voice flow defaults to USDT for now
      );
      return;
    }
  }

  // Missing bank — show bank selection
  if (va.accountNumber && va.amount) {
    const bankButtons = NIGERIAN_BANKS.map(b => Markup.button.callback(b.name, `nlp_bank:${b.code}`));
    const rows: any[] = [];
    for (let i = 0; i < bankButtons.length; i += 2) {
      rows.push(bankButtons.slice(i, i + 2));
    }
    setSession(userId, {
      state: ConversationState.AWAITING_BANK_DETAILS,
      pendingTransaction: {
        amountNgn: va.amount,
        recipientAccountNumber: va.accountNumber,
        recipientName: va.recipientName || undefined,
      },
    });
    await ctx.editMessageText('🏦 Which bank?');
    await ctx.reply(
      `Select the recipient's bank:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
    return;
  }

  // Not enough info
  await ctx.editMessageText('❌ Not enough details. Please use the menu to send.');
  await ctx.reply('Menu:', mainMenu);
});

bot.action('voice_confirm_no', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  session.voiceAnalysis = undefined;
  setSession(userId, session);
  await ctx.editMessageText('❌ Cancelled. No action taken.');
  await ctx.reply('Menu:', mainMenu);
});

// ═════════════════════════════════════════════════════════════════════════════
// 📸 PHOTO / RECEIPT OCR — QVAC-powered screenshot parsing
// ═════════════════════════════════════════════════════════════════════════════

bot.on(message('photo'), async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const loading = await showLoading(ctx, 'Reading your screenshot with QVAC OCR...');
  const startTime = Date.now();

  try {
    // Get the largest photo
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    console.log(`[Photo] Downloading image ${photo.file_id} (${photo.width}x${photo.height})`);
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(fileLink.toString());
    const imageBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`[Photo] Downloaded ${imageBuffer.length} bytes in ${Date.now() - startTime}ms`);

    const receipt = await parseReceiptWithQVAC(imageBuffer);
    console.log(`[Photo] Parsed receipt in ${Date.now() - startTime}ms:`, receipt);

    if (!receipt || !receipt.rawText) {
      await finishLoading(ctx, loading.message_id, '❌ Could not read text from this image. Try a clearer screenshot.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    // Guard: if amount equals account number, LLM/parser confused them
    if (receipt.amount && receipt.accountNumber && receipt.amount.toString() === receipt.accountNumber) {
      receipt.amount = undefined;
    }

    // If we got structured data, offer to send
    if (receipt.amount && receipt.accountNumber && receipt.bankName) {
      await finishLoading(ctx, loading.message_id, `📝 I found payment details!\n\nAmount: ₦${receipt.amount.toLocaleString()}\nBank: ${receipt.bankName}\nAccount: ${receipt.accountNumber}\nName: ${receipt.recipientName || 'Unknown'}`, 'Markdown');

      // Find bank code
      const bank = NIGERIAN_BANKS.find(b =>
        b.name.toLowerCase().includes((receipt.bankName || '').toLowerCase()) ||
        (receipt.bankName || '').toLowerCase().includes(b.name.toLowerCase())
      );

      if (bank) {
        setSession(userId, {
          state: ConversationState.AWAITING_CONFIRMATION,
          pendingTransaction: {
            amountNgn: receipt.amount,
            recipientAccountNumber: receipt.accountNumber,
            recipientBankCode: bank.code,
            recipientBankName: bank.name,
            recipientName: receipt.recipientName || 'Recipient',
          },
        });

        await ctx.reply(
          `Send ₦${receipt.amount.toLocaleString()} to ${receipt.recipientName || 'Recipient'} at ${bank.name}?`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm', 'confirm_send')],
            [Markup.button.callback('❌ Cancel', 'cancel_send')],
          ])
        );
        return;
      }
    }

    // Partial parse — show what we found
    const found: string[] = [];
    if (receipt.amount) found.push(`Amount: ₦${receipt.amount.toLocaleString()}`);
    if (receipt.bankName) found.push(`Bank: ${receipt.bankName}`);
    if (receipt.accountNumber) found.push(`Account: ${receipt.accountNumber}`);
    if (receipt.recipientName) found.push(`Name: ${receipt.recipientName}`);

    if (found.length > 0) {
      await finishLoading(ctx, loading.message_id, `📝 I found some details:\n\n${found.join('\n')}\n\nBut I'm missing some info to send money.`, 'Markdown');
    } else {
      await finishLoading(ctx, loading.message_id, `📝 I can see text in the image, but couldn't find payment details.\n\nTry sending a clearer screenshot of the bank app or payment request.`);
    }

    await ctx.reply('Menu:', mainMenu);
  } catch (err: any) {
    console.error('[OCR] Error:', err.message || err);
    try {
      await finishLoading(ctx, loading.message_id, '❌ Could not process image. Please try again or type the details manually.');
    } catch {
      await ctx.reply('❌ Could not process image. Please try again or type the details manually.', mainMenu);
    }
    await ctx.reply('Menu:', mainMenu);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SHOW VIRTUAL ACCOUNT (PAJ On-Ramp)
// ═════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════
// 🌉 BRIDGE ENTRY (from Receive menu)
// ═════════════════════════════════════════════════════════════════════════════

bot.action('bridge_start', async (ctx) => {
  await ctx.answerCbQuery();
  await showBridgeMenu(ctx, ctx.from!.id.toString());
});

// ═════════════════════════════════════════════════════════════════════════════
// 📅 SCHEDULED TRANSFERS
// ═════════════════════════════════════════════════════════════════════════════

async function showScheduleMenu(ctx: ZendContext, userId: string) {
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

bot.hears('📅 Schedule', async (ctx) => {
  await showScheduleMenu(ctx, ctx.from.id.toString());
});

bot.action('schedule_start', async (ctx) => {
  await ctx.answerCbQuery();
  await showScheduleMenu(ctx, ctx.from!.id.toString());
});

bot.action('schedule_add_recipient', async (ctx) => {
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

bot.action(/schedule_bank:([A-Z]+)/, async (ctx) => {
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

bot.action(/schedule_recipient:(\d+)/, async (ctx) => {
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

bot.action(/schedule_freq:(\w+)/, async (ctx) => {
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

bot.action('cancel_schedule', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Schedule creation cancelled.');
  await ctx.reply('Menu:', mainMenu);
});

bot.action('schedule_view', async (ctx) => {
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

bot.action(/schedule_cancel:(\d+)/, async (ctx) => {
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

// ═════════════════════════════════════════════════════════════════════════════
// 🌉 NEAR INTENTS DEPOSIT (Cross-chain Deposit)
// ═════════════════════════════════════════════════════════════════════════════

async function showBridgeMenu(ctx: ZendContext, userId: string) {
  const nearIntents = getNearIntentsClient();
  if (!nearIntents) {
    await ctx.reply(
      `🌉 *Deposit from Other Apps*\n\n` +
      `Receive Dollars from Binance, MetaMask, or any app.\n\n` +
      `⚠️ *Service not configured.*\n\n` +
      `For now, use:\n` +
      `• 💵 *Add Naira* — NGN bank transfer → Dollars\n` +
      `• 📥 *Receive* — Direct crypto deposit`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  const rows: any[] = [];
  for (let i = 0; i < DEPOSIT_CHAINS.length; i += 2) {
    const row = [
      Markup.button.callback(CHAIN_DISPLAY_NAMES[DEPOSIT_CHAINS[i]], `bridge_chain:${DEPOSIT_CHAINS[i]}`),
    ];
    if (DEPOSIT_CHAINS[i + 1]) {
      row.push(Markup.button.callback(CHAIN_DISPLAY_NAMES[DEPOSIT_CHAINS[i + 1]], `bridge_chain:${DEPOSIT_CHAINS[i + 1]}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('❌ Cancel', 'cancel_bridge')]);

  await ctx.reply(
    `🌉 *Deposit from Other Apps*\n\n` +
    `Send crypto from any wallet → receive Dollars in Zend via NEAR Intents.\n\n` +
    `Select the chain you're sending from:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    }
  );
}

bot.command('bridge', async (ctx) => {
  await showBridgeMenu(ctx, ctx.from.id.toString());
});

// Step 2: After chain selected, show token options
bot.action(/bridge_chain:([a-z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainKey = ctx.match[1];
  const assets = NEAR_INTENTS_ASSETS[chainKey];
  if (!assets) {
    await ctx.editMessageText('❌ Unsupported chain.');
    return;
  }

  const chainDisplay = CHAIN_DISPLAY_NAMES[chainKey] || chainKey;
  const buttons: any[] = [];
  for (const symbol of Object.keys(assets)) {
    buttons.push(Markup.button.callback(symbol, `bridge:${chainKey}:${symbol}`));
  }

  await ctx.editMessageText(
    `🌉 *Deposit from Other Apps*\n\n` +
    `From: *${chainDisplay}*\n\n` +
    `What are you sending?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        buttons,
        [Markup.button.callback('← Back', 'bridge_back')],
        [Markup.button.callback('❌ Cancel', 'cancel_bridge')],
      ]),
    }
  );
});

bot.action('bridge_back', async (ctx) => {
  await ctx.answerCbQuery();
  await showBridgeMenu(ctx, ctx.from!.id.toString());
});

bot.action(/bridge:([a-z]+):([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const token = ctx.match[2];

  const assetId = NEAR_INTENTS_ASSETS[chainKey]?.[token];
  if (!assetId) {
    await ctx.editMessageText(`❌ ${token} is not supported from ${CHAIN_DISPLAY_NAMES[chainKey] || chainKey} yet.`);
    return;
  }

  const chainDisplay = CHAIN_DISPLAY_NAMES[chainKey] || chainKey;

  // Store partial bridge data and ask for destination token
  setSession(userId, {
    state: ConversationState.IDLE,
    bridgeData: { chainKey, sourceChain: chainKey, token, assetId },
  });

  await ctx.editMessageText(
    `🌉 *Deposit from Other Apps*\n\n` +
    `From: *${chainDisplay}*\n` +
    `Currency: *${token}*\n\n` +
    `Receive in Zend as:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('USDT', `bridge_dest:${chainKey}:${token}:USDT`)],
        [Markup.button.callback('USDC', `bridge_dest:${chainKey}:${token}:USDC`)],
        [Markup.button.callback('← Back', `bridge_chain:${chainKey}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_bridge')],
      ]),
    }
  );
});

bot.action(/bridge_dest:([a-z]+):([A-Z]+):(USDT|USDC)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const token = ctx.match[2];
  const destSymbol = ctx.match[3];

  const assetId = NEAR_INTENTS_ASSETS[chainKey]?.[token];
  if (!assetId) {
    await ctx.editMessageText(`❌ ${token} is not supported from ${CHAIN_DISPLAY_NAMES[chainKey] || chainKey} yet.`);
    return;
  }

  const destinationAsset = SOLANA_DEST_ASSETS[destSymbol];
  if (!destinationAsset) {
    await ctx.editMessageText(`❌ ${destSymbol} is not supported as a receive token.`);
    return;
  }

  setSession(userId, {
    state: ConversationState.AWAITING_BRIDGE_AMOUNT,
    bridgeData: { chainKey, sourceChain: chainKey, token, assetId, destinationAsset, destinationSymbol: destSymbol },
  });

  await ctx.editMessageText(
    `🌉 *Deposit from Other Apps*\n\n` +
    `From: *${CHAIN_DISPLAY_NAMES[chainKey] || chainKey}*\n` +
    `Currency: *${token}*\n` +
    `Receive as: *${destSymbol}*\n\n` +
    `How much ${token} do you want to deposit?\n\n` +
    `Examples:\n` +
    `• 10\n` +
    `• 50\n` +
    `• 100`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_bridge')]]) }
  );
});

bot.action('cancel_bridge', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Cancelled.');
});

// ═════════════════════════════════════════════════════════════════════════════
// 📤 NEAR INTENTS WITHDRAWAL (Zend → external chain)
// ═════════════════════════════════════════════════════════════════════════════

async function showWithdrawMenu(ctx: ZendContext, userId: string) {
  const nearIntents = getNearIntentsClient();
  if (!nearIntents) {
    await ctx.reply(
      `📤 *Send to Other Apps*\n\n` +
      `⚠️ Cross-chain withdrawals are not configured.\n` +
      `Contact support or try again later.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  const rows: any[] = [];
  for (let i = 0; i < WITHDRAW_CHAINS.length; i += 2) {
    const row = [
      Markup.button.callback(CHAIN_DISPLAY_NAMES[WITHDRAW_CHAINS[i]], `withdraw_chain:${WITHDRAW_CHAINS[i]}`),
    ];
    if (WITHDRAW_CHAINS[i + 1]) {
      row.push(Markup.button.callback(CHAIN_DISPLAY_NAMES[WITHDRAW_CHAINS[i + 1]], `withdraw_chain:${WITHDRAW_CHAINS[i + 1]}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('❌ Cancel', 'cancel_withdraw')]);

  await ctx.reply(
    `📤 *Send to Other Apps*\n\n` +
    `Send Dollars from Zend to Binance, MetaMask, Trust Wallet, etc.\n\n` +
    `Select destination chain:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
}

bot.action('withdraw_start', async (ctx) => {
  await ctx.answerCbQuery();
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'send crypto to other apps');
    return;
  }
  await showWithdrawMenu(ctx, ctx.from!.id.toString());
});

bot.action(/withdraw_chain:([a-z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainKey = ctx.match[1];
  const assets = NEAR_INTENTS_ASSETS[chainKey];
  if (!assets) {
    await ctx.editMessageText('❌ Unsupported chain.');
    return;
  }

  const buttons: any[] = Object.keys(assets).map(symbol =>
    Markup.button.callback(symbol, `withdraw_dest:${chainKey}:${symbol}`)
  );

  await ctx.editMessageText(
    `📤 *Send to ${formatChainName(chainKey)}*\n\n` +
    `What token should the recipient receive?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        buttons,
        [Markup.button.callback('← Back', 'withdraw_back')],
        [Markup.button.callback('❌ Cancel', 'cancel_withdraw')],
      ]),
    }
  );
});

bot.action('withdraw_back', async (ctx) => {
  await ctx.answerCbQuery();
  await showWithdrawMenu(ctx, ctx.from!.id.toString());
});

bot.action(/withdraw_dest:([a-z]+):([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const destToken = ctx.match[2];
  const destAssetId = getDestinationAssetId(chainKey, destToken);
  if (!destAssetId) {
    await ctx.editMessageText(`❌ ${destToken} is not supported on ${formatChainName(chainKey)}.`);
    return;
  }

  setSession(userId, {
    state: ConversationState.IDLE,
    withdrawData: { destChain: chainKey, destToken, destAssetId, sourceSymbol: 'USDT' },
  });

  await ctx.editMessageText(
    `📤 *Send to ${formatChainName(chainKey)}*\n\n` +
    `Recipient receives: *${destToken}*\n\n` +
    `Pay from your Zend balance:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('USDT', `withdraw_source:USDT`)],
        [Markup.button.callback('USDC', `withdraw_source:USDC`)],
        [Markup.button.callback('← Back', `withdraw_chain:${chainKey}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_withdraw')],
      ]),
    }
  );
});

bot.action(/withdraw_source:(USDT|USDC)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const sourceSymbol = ctx.match[1] as 'USDT' | 'USDC';
  const session = getSession(userId);
  if (!session.withdrawData) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    return;
  }

  setSession(userId, {
    ...session,
    state: ConversationState.AWAITING_WITHDRAW_RECIPIENT,
    withdrawData: { ...session.withdrawData, sourceSymbol },
  });

  await ctx.editMessageText(
    `📤 *Send ${sourceSymbol} → ${session.withdrawData.destToken}*\n` +
    `To: *${formatChainName(session.withdrawData.destChain)}*\n\n` +
    `Enter the recipient's wallet address on ${formatChainName(session.withdrawData.destChain)}:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_withdraw')]]) }
  );
});

bot.action('cancel_withdraw', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Cancelled.');
});

bot.action('confirm_withdraw', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'send crypto to other apps');
    return;
  }

  const session = getSession(userId);
  if (!session.withdrawData?.amount || !session.withdrawData.depositAddress) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  if (user[0].transactionPin) {
    setSession(userId, { ...session, state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'withdraw' });
    await ctx.editMessageText(
      `🔐 *Security Check*\n\nEnter your 4-digit PIN to confirm this withdrawal:`,
      { parse_mode: 'Markdown' }
    );
    const waitMsg = await ctx.reply('Waiting for PIN...', cancelKeyboard);
    getSession(userId).lastBotMessageId = waitMsg.message_id;
    return;
  }

  await executeNearIntentWithdraw(ctx, userId);
});



// ═════════════════════════════════════════════════════════════════════════════
// ─── Auto-delete helper for sensitive messages ───
async function autoDeleteReply(ctx: ZendContext, text: string, extra?: any, delayMs = PIN_TTL_MS) {
  const msg = await ctx.reply(text, extra);
  setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id);
    } catch (e) {
      // Message may already be deleted or too old
    }
  }, delayMs);
  return msg;
}

// ERROR HANDLER
// ═════════════════════════════════════════════════════════════════════════════


registerPostTextHandlers({ bot, deps });

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Something went wrong. Please try again or contact support.', mainMenu);
});

// ═════════════════════════════════════════════════════════════════════════════
// LAUNCH (see launch/main.ts)
// ═════════════════════════════════════════════════════════════════════════════

run().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

// Railway deploy trigger Wed May 20 10:32:40 WAT 2026
