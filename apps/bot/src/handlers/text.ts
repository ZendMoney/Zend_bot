import { ConversationState, parseAmountInput, normalizeBank } from '@zend/shared';
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

  // Natural language parsing (when not in a conversation flow)
  const lowerText = text.toLowerCase();

  // Balance queries
  if (lowerText.match(/balance|how much|wetin be my balance/)) {
    const { balanceHandler } = await import('./balance.js');
    await balanceHandler(ctx);
    return;
  }

  // Send money
  if (lowerText.match(/send|transfer|give/)) {
    const parsed = parseAmountInput(text);
    if (parsed) {
      await ctx.reply(
        `📤 I understood: Send ${parsed.currency === 'NGN' ? '₦' : ''}${parsed.value.toLocaleString()} ${parsed.currency || ''}\n\n` +
        `Who should receive it?`,
      );
      session.state = ConversationState.AWAITING_SEND_RECIPIENT;
      session.pendingIntent = {
        intent: 'NGN_SEND',
        confidence: 0.9,
        entities: [
          { type: 'amount', value: parsed.value },
          { type: 'currency', value: parsed.currency || 'NGN' },
        ],
        rawText: text,
      };
    } else {
      await ctx.reply('📤 How much do you want to send?');
      session.state = ConversationState.AWAITING_SEND_AMOUNT;
    }
    return;
  }

  // Buy / Add money
  if (lowerText.match(/buy|add|fund|deposit|wan add/)) {
    const { buyHandler } = await import('./buy.js');
    await buyHandler(ctx);
    return;
  }

  // Sell / Withdraw
  if (lowerText.match(/sell|withdraw|cash out/)) {
    const { sellHandler } = await import('./sell.js');
    await sellHandler(ctx);
    return;
  }

  // Fallback
  await ctx.reply(
    `🤔 I didn't understand that.\n\n` +
    `Try:\n` +
    `• "Send 50k to Tunde GTB"\n` +
    `• "What's my balance?"\n` +
    `• /help for all commands`,
  );
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
