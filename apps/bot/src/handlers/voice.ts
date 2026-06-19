import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { transcribeVoice, analyzeVoiceWithAI, parseCommand } from '../services/nlp.js';
import { ConversationState, NIGERIAN_BANKS, PAJ_MIN_DEPOSIT_NGN, PAJ_MAX_DEPOSIT_NGN } from '@zend/shared';
import { getPAJClient } from '../deps.js';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';
import { sanitizeAccountNumber } from '../lib/account.js';
import { getSession, setSession } from '../session/store.js';
import { showLoading, updateLoading, finishLoading } from '../lib/loading.js';
import { handleBalance } from './balance.js';
import { prepareSendConfirmation } from './send.js';
import { showReceive } from './receive.js';
import { showHistory } from './history.js';
import { showSettings } from './settings.js';
import { showSwapMenu } from './swap.js';
import type { HandlerContext } from './types.js';

export function registerVoiceHandlers({ bot: b }: HandlerContext): void {
  b.on(message('voice'), async (ctx) => {
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
      const cmd = parseCommand(text);
      if (cmd.intent === 'send' || cmd.intent === 'cash_out') {
        await finishLoading(ctx, loadingVoice.message_id, `📝 *You said:* "${text}"`, 'Markdown');
        if (cmd.amount && cmd.accountNumber && cmd.bankCode) {
          const bank = NIGERIAN_BANKS.find(b => b.code === cmd.bankCode);
          if (bank) {
            await prepareSendConfirmation(
              ctx, userId, cmd.amount, cmd.accountNumber, bank.code, bank.name,
              cmd.recipientName || undefined,
            );
            return;
          }
        }
        if (cmd.amount) {
          setSession(userId, {
            state: ConversationState.AWAITING_SEND_RECIPIENT,
            pendingTransaction: { amountNgn: cmd.amount, recipientName: cmd.recipientName },
          });
          await ctx.reply(
            `Send ${formatNgn(cmd.amount)} — please provide recipient details:\n"Name BankCode AccountNumber"\nExample: "Tunde GTB 0123456789"`,
            { parse_mode: 'Markdown', ...cancelKeyboard }
          );
          return;
        }
      }
      if (cmd.intent === 'balance') {
        await finishLoading(ctx, loadingVoice.message_id, `📝 *You said:* "${text}"`, 'Markdown');
        await handleBalance(ctx, userId);
        return;
      }
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
    const hint = err.message?.includes('QVAC') || err.message?.includes('Whisper')
      ? 'Voice AI is temporarily unavailable. Type your command instead, e.g. "Send 5000 to GTB 0123456789".'
      : 'Could not process voice note. Please type your command or use the menu below.';
    try {
      await finishLoading(ctx, loadingVoice.message_id, `❌ ${hint}`);
    } catch {
      await ctx.reply(`❌ ${hint}`, mainMenu);
    }
    await ctx.reply('Menu:', mainMenu);
  }
});

// Voice confirmation handlers (legacy — new voice flow uses confirm_send/cancel_send directly)
  b.action('voice_confirm_yes', async (ctx) => {
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

  b.action('voice_confirm_no', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  session.voiceAnalysis = undefined;
  setSession(userId, session);
  await ctx.editMessageText('❌ Cancelled. No action taken.');
  await ctx.reply('Menu:', mainMenu);
});
}
