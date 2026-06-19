import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { transcribeVoice, parseVoiceCommand, type ParsedCommand } from '../services/nlp.js';
import { ConversationState, NIGERIAN_BANKS, PAJ_MIN_DEPOSIT_NGN, PAJ_MAX_DEPOSIT_NGN } from '@zend/shared';
import { getPAJClient } from '../deps.js';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';

import { getSession, setSession } from '../session/store.js';
import { showLoading, updateLoading, finishLoading } from '../lib/loading.js';
import { handleBalance } from './balance.js';
import { prepareSendConfirmation } from './send.js';
import { showReceive } from './receive.js';
import { showHistory } from './history.js';
import { showSettings } from './settings.js';
import { showSwapMenu } from './swap.js';
import { showBridgeMenu } from './bridge.js';
import { formatVoiceError } from '../utils/api-errors.js';
import type { HandlerContext } from './types.js';
import type { ZendContext } from '../session/types.js';

async function executeVoiceCommand(ctx: ZendContext, userId: string, cmd: ParsedCommand): Promise<void> {
  switch (cmd.intent) {
    case 'balance':
      await ctx.reply('Checking your balance...', mainMenu);
      await handleBalance(ctx, userId);
      return;

    case 'add_naira': {
      const pajClient = await getPAJClient();
      if (!pajClient) {
        await ctx.reply('❌ PAJ service is not configured. Please contact support.', mainMenu);
        return;
      }
      if (cmd.amount && cmd.amount > PAJ_MAX_DEPOSIT_NGN) {
        await ctx.reply(`❌ Amount too large.\nMaximum deposit is ${formatNgn(PAJ_MAX_DEPOSIT_NGN)}.`, mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT, onrampAmount: cmd.amount || undefined });
      await ctx.reply(
        `💵 *Add Naira*\n\n` +
        (cmd.amount && cmd.amount >= PAJ_MIN_DEPOSIT_NGN
          ? `Amount: ${formatNgn(cmd.amount)}\n\nConfirm or enter a different amount (Minimum ₦1,000):`
          : `How much NGN do you want to add to your wallet?\n\nMinimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n\nEnter the amount (numbers only):`),
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      return;
    }

    case 'send':
    case 'cash_out': {
      if (!cmd.amount) {
        setSession(userId, { state: ConversationState.AWAITING_SEND_AMOUNT, pendingTransaction: {} });
        await ctx.reply('How much do you want to send? (in Naira)', { parse_mode: 'Markdown', ...cancelKeyboard });
        return;
      }
      if (cmd.walletAddress) {
        await ctx.reply(
          `📤 Crypto wallet sends are not yet available.\nPlease use bank transfer instead.`,
          mainMenu
        );
        return;
      }
      if (!cmd.accountNumber) {
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
      if (!cmd.bankCode) {
        const bankButtons = NIGERIAN_BANKS.map(b => Markup.button.callback(b.name, `nlp_bank:${b.code}`));
        const rows: any[] = [];
        for (let i = 0; i < bankButtons.length; i += 2) {
          rows.push(bankButtons.slice(i, i + 2));
        }
        setSession(userId, {
          state: ConversationState.AWAITING_BANK_DETAILS,
          pendingTransaction: {
            amountNgn: cmd.amount,
            recipientAccountNumber: cmd.accountNumber,
            recipientName: cmd.recipientName,
          },
        });
        await ctx.reply(
          `🏦 Which bank?\n\nAccount: \`${cmd.accountNumber}\`\nAmount: ${formatNgn(cmd.amount)}\n\nSelect a bank:`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
        );
        return;
      }
      const bank = NIGERIAN_BANKS.find(b => b.code === cmd.bankCode);
      if (!bank) {
        await ctx.reply('❌ Unknown bank. Please try again.', mainMenu);
        return;
      }
      await prepareSendConfirmation(
        ctx, userId, cmd.amount, cmd.accountNumber, bank.code, bank.name, cmd.recipientName || undefined
      );
      return;
    }

    case 'receive':
      await showReceive(ctx, userId);
      return;

    case 'history':
      await showHistory(ctx, userId);
      return;

    case 'settings':
      await showSettings(ctx, userId);
      return;

    case 'swap':
      await showSwapMenu(ctx, userId);
      return;

    case 'bridge':
      await showBridgeMenu(ctx, userId);
      return;

    default:
      await ctx.reply(
        'I\'m not sure what you mean. Try:\n• "Check balance"\n• "Send 5000 to GTB 0123456789"\n• Or use the menu below.',
        mainMenu
      );
  }
}

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

    await updateLoading(ctx, loadingVoice.message_id, 'Understanding your request...');

    const t1 = Date.now();
    const cmd = await parseVoiceCommand(text);
    console.log(`[Voice] Parsed in ${Date.now() - t1}ms: intent=${cmd.intent} amount=${cmd.amount ?? '-'} account=${cmd.accountNumber ?? '-'}`);

    await finishLoading(ctx, loadingVoice.message_id, `📝 *You said:* "${cmd.raw}"`, 'Markdown');
    await executeVoiceCommand(ctx, userId, cmd);

  } catch (err: any) {
    console.error('[Voice] Error:', err.message || err);
    const hint = formatVoiceError(err);
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
