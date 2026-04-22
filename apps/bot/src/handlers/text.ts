import { ConversationState, parseAmountInput, normalizeBank } from '@zend/shared';
import { parseUserInput } from '@zend/nlu';
import type { ZendContext } from '../middleware/session.js';

export async function textHandler(ctx: ZendContext) {
  const text = ctx.message?.text;
  if (!text) return;

  const user = (ctx as any).user;
  const session = ctx.session;

  // Handle conversation states
  switch (session.state) {
    case ConversationState.AWAITING_SEND_AMOUNT:
      await handleSendAmount(ctx, text);
      return;
    
    case ConversationState.AWAITING_SEND_RECIPIENT:
      await handleSendRecipient(ctx, text);
      return;
    
    case ConversationState.AWAITING_EMAIL:
      await handleEmailInput(ctx, text);
      return;
    
    case ConversationState.AWAITING_OTP:
      await handleOtpInput(ctx, text);
      return;
  }

  // Natural language parsing with Kimi AI
  const parsed = await parseUserInput(text);

  switch (parsed.intent) {
    case 'BALANCE':
      await balanceHandler(ctx);
      return;

    case 'NGN_SEND':
      session.pendingIntent = parsed;
      session.state = ConversationState.AWAITING_SEND_RECIPIENT;

      const amount = parsed.entities.find(e => e.type === 'amount')?.value;
      const currency = parsed.entities.find(e => e.type === 'currency')?.value || 'NGN';

      if (amount) {
        await ctx.reply(
          `📤 Send ${currency === 'NGN' ? '₦' : ''}${Number(amount).toLocaleString()} ${currency}\n\n` +
          `Who should receive it?\n` +
          `Type: "Name Bank AccountNumber"\n` +
          `Example: "Tunde GTBank 0123456789"`,
        );
      } else {
        await ctx.reply('📤 How much do you want to send?');
        session.state = ConversationState.AWAITING_SEND_AMOUNT;
      }
      return;

    case 'NGN_RECEIVE':
      await buyHandler(ctx);
      return;

    case 'CRYPTO_SEND':
      await sellHandler(ctx);
      return;

    case 'SWAP': {
      const fromAsset = parsed.entities.find(e => e.type === 'from_asset')?.value;
      const toAsset = parsed.entities.find(e => e.type === 'to_asset')?.value;
      const swapAmount = parsed.entities.find(e => e.type === 'amount')?.value;

      await ctx.reply(
        `🔄 Swap ${fromAsset || 'SOL'} → ${toAsset || 'USDT'}\n\n` +
        `${swapAmount ? `Amount: ${swapAmount}` : 'How much do you want to swap?'}`,
      );
      return;
    }

    case 'HISTORY':
      await historyHandler(ctx);
      return;

    case 'VAULT_SAVE':
    case 'VAULT_LOCK':
    case 'VAULT_WITHDRAW':
      await vaultHandler(ctx);
      return;

    case 'SCHEDULE':
      await ctx.reply('📅 Scheduled transfers coming soon!');
      return;

    case 'SETTINGS':
      await settingsHandler(ctx);
      return;

    case 'HELP':
      await helpHandler(ctx);
      return;

    case 'GREETING':
      await ctx.reply(
        `👋 Hello! I'm Zend — your crypto wallet in Telegram.\n\n` +
        `What would you like to do?\n` +
        `• Send money: "Send 50k to Tunde"\n` +
        `• Check balance: "What's my balance?"\n` +
        `• Add money: /buy\n` +
        `• /help for all commands`,
      );
      return;

    case 'CRYPTO_RECEIVE':
      await receiveHandler(ctx);
      return;

    default:
      await ctx.reply(
        `🤔 I understood: "${parsed.intent}" (confidence: ${Math.round(parsed.confidence * 100)}%)\n\n` +
        `But I'm not sure what to do. Try:\n` +
        `• "Send 50k to Tunde GTB"\n` +
        `• "What's my balance?"\n` +
        `• /help for all commands`,
      );
  }
}

async function handleSendAmount(ctx: ZendContext, text: string) {
  const parsed = parseAmountInput(text);
  if (!parsed) {
    await ctx.reply('❌ Please enter a valid amount. Examples: 50000, 10k, 100 USDT');
    return;
  }

  ctx.session.pendingIntent = {
    intent: 'NGN_SEND',
    confidence: 1,
    entities: [
      { type: 'amount', value: parsed.value },
      { type: 'currency', value: parsed.currency || 'NGN' },
    ],
    rawText: text,
  };

  ctx.session.state = ConversationState.AWAITING_SEND_RECIPIENT;

  await ctx.reply(
    `📤 Send ${parsed.currency === 'NGN' ? '₦' : ''}${parsed.value.toLocaleString()}\n\n` +
    `Who should receive it?\n` +
    `Type: "Name Bank AccountNumber"\n` +
    `Example: "Tunde GTBank 0123456789"`,
  );
}

async function handleSendRecipient(ctx: ZendContext, text: string) {
  // Try to parse bank details from text
  const bankMatch = normalizeBank(text);
  const accountMatch = text.match(/(\d{10})/);
  
  if (!bankMatch || !accountMatch) {
    await ctx.reply(
      `❌ Could not parse bank details.\n\n` +
      `Please use format: "Name Bank AccountNumber"\n` +
      `Example: "Tunde GTBank 0123456789"`,
    );
    return;
  }

  const accountNumber = accountMatch[1];
  const bank = bankMatch;

  // Extract name (everything before the bank name)
  const nameMatch = text.match(new RegExp(`(.+?)\\s+${bank.name}`, 'i'));
  const recipientName = nameMatch ? nameMatch[1].trim() : 'Unknown';

  await ctx.reply(
    `📤 Confirm Transfer\n\n` +
    `Amount: ₦${ctx.session.pendingIntent?.entities.find(e => e.type === 'amount')?.value.toLocaleString()}\n` +
    `To: ${recipientName.toUpperCase()}\n` +
    `Bank: ${bank.name}\n` +
    `Account: \`${accountNumber}\`\n\n` +
    `[✅ Confirm & Send]  [❌ Cancel]`,
    { parse_mode: 'Markdown' }
  );

  ctx.session.state = ConversationState.AWAITING_CONFIRMATION;
}

async function handleEmailInput(ctx: ZendContext, text: string) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(text)) {
    await ctx.reply('❌ Invalid email. Please try again:');
    return;
  }

  // TODO: Send OTP
  await ctx.reply(`📧 Verification code sent to ${text}. Enter the 6-digit code:`);
  ctx.session.state = ConversationState.AWAITING_OTP;
}

async function handleOtpInput(ctx: ZendContext, text: string) {
  if (!/^\d{6}$/.test(text)) {
    await ctx.reply('❌ Invalid code. Please enter the 6-digit code:');
    return;
  }

  // TODO: Verify OTP
  await ctx.reply('✅ Email verified!');
  ctx.session.state = ConversationState.IDLE;
}
