// ─── Load .env FIRST — before any imports that need env vars ───
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { Telegraf, Markup, Context } from 'telegraf';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { message } from 'telegraf/filters';
import { db, checkConnection } from '@zend/db';
import { users, transactions } from '@zend/db';
import { eq } from 'drizzle-orm';
import { WalletService } from '@zend/solana';
import type { PAJClient } from '@zend/paj-client';
import {
  ConversationState,
  SOLANA_TOKENS,
  NIGERIAN_BANKS,
  PAJ_MIN_DEPOSIT_NGN,
} from '@zend/shared';

import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN!;
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Lazy-load PAJ client to ensure .env is loaded first
let _pajClient: PAJClient | null = null;
async function getPAJClient(): Promise<PAJClient | null> {
  if (_pajClient) return _pajClient;
  const { createPAJClient } = await import('@zend/paj-client');
  _pajClient = createPAJClient();
  return _pajClient;
}

// Re-export enums from paj_ramp via paj-client for static use
const _pajEnums = await import('@zend/paj-client');
const Currency = _pajEnums.Currency;
const Chain = _pajEnums.Chain;

// ─── Types ───
interface ZendSession {
  state: ConversationState;
  pendingTransaction?: Partial<{
    amountNgn: number;
    amountUsdt: number;
    recipientBankCode: string;
    recipientBankName: string;
    recipientAccountNumber: string;
    recipientAccountName: string;
    recipientWalletAddress: string;
    hasGas?: boolean;
  }>;
  pajContact?: string; // email/phone pending OTP
  onrampAmount?: number; // pending on-ramp amount in NGN
}

interface ZendContext extends Context {
  session: ZendSession;
}

// ─── Session Store (in-memory, replace with Redis in production) ───
const sessions = new Map<string, ZendSession>();

function getSession(userId: string): ZendSession {
  if (!sessions.has(userId)) {
    sessions.set(userId, { state: ConversationState.IDLE });
  }
  return sessions.get(userId)!;
}

function setSession(userId: string, session: ZendSession): void {
  sessions.set(userId, session);
}

// ─── Services ───
const walletService = new WalletService(SOLANA_RPC);

// ─── Helpers ───
function generateTxId(): string {
  return 'ZND-' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

function generateReferralCode(): string {
  return 'ZND' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function encryptPrivateKey(secretKey: Uint8Array): string {
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'zend-dev-key', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPrivateKey(encryptedKey: string): Uint8Array {
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'zend-dev-key', 'salt', 32);
  const parts = encryptedKey.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return new Uint8Array(decrypted);
}

function formatBalance(amount: number, symbol: string): string {
  return `${amount.toFixed(symbol === 'SOL' ? 4 : 2)} ${symbol}`;
}

function formatNgn(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}

// ─── Keyboards ───
const mainMenu = Markup.keyboard([
  ['💰 Balance', '📤 Send'],
  ['💵 Add Naira', '💴 Cash Out'],
  ['🔄 Swap', '📥 Receive'],
  ['📋 History', '⚙️ Settings'],
]).resize();

const cancelKeyboard = Markup.keyboard([['❌ Cancel']]).resize();

// ─── Bot ───
const bot = new Telegraf<ZendContext>(BOT_TOKEN);

// Session middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (userId) {
    (ctx as any).session = getSession(userId);
  }
  await next();
});

// ═════════════════════════════════════════════════════════════════════════════
// /START — Onboarding
// ═════════════════════════════════════════════════════════════════════════════

bot.command('start', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  const firstName = ctx.from.first_name;
  const lastName = ctx.from.last_name || '';

  const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (existing.length > 0) {
    await ctx.reply(`👋 Welcome back, ${firstName}!\n\nYour Zend wallet is ready.`, mainMenu);
    return;
  }

  // Generate wallet
  const wallet = walletService.generateWallet();
  const encryptedKey = encryptPrivateKey(wallet.secretKey);
  const referralCode = generateReferralCode();

  await db.insert(users).values({
    id: userId,
    telegramUsername: username,
    firstName,
    lastName,
    walletAddress: wallet.publicKey,
    walletEncryptedKey: encryptedKey,
    referralCode,
  });

  await ctx.reply(
    `🟣 *Welcome to Zend*\n\n` +
    `Your Solana wallet + Naira bank account — inside Telegram.\n\n` +
    `✅ Wallet created automatically\n` +
    `✅ No seed phrase to remember\n` +
    `✅ Send naira to any Nigerian bank\n` +
    `✅ Receive naira via bank transfer`,
    { parse_mode: 'Markdown' }
  );

  await ctx.reply(
    `✅ *Wallet Created!*\n\n` +
    `Your Solana address:\n` +
    `\`${wallet.publicKey}\`\n\n` +
    `⚠️ *Important:* You need SOL for gas fees.\n` +
    `Send a small amount of SOL to this address to start transacting.\n\n` +
    `💡 Tap *💵 Add Naira* to get your virtual bank account.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// /WALLET — View Address & Export Private Key
// ═════════════════════════════════════════════════════════════════════════════

bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const u = user[0];

  await ctx.reply(
    `👛 *Your Wallet*\n\n` +
    `*Solana Address:*\n` +
    `\`${u.walletAddress}\`\n\n` +
    `Tap to copy the address above.\n\n` +
    `*Network:* Solana Devnet\n` +
    `*Tokens:* SOL, USDT, USDC\n\n` +
    `⚠️ To export your private key, tap the button below.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Export Private Key', 'export_key')],
      ]),
    }
  );
});

bot.action('export_key', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  try {
    const secretKey = decryptPrivateKey(user[0].walletEncryptedKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    await ctx.editMessageText(
      `🔑 *Private Key Export*\n\n` +
      `⚠️ *SECURITY WARNING*\n` +
      `Never share this with anyone. Zend will NEVER ask for it.\n\n` +
      `*Private Key (Base58):*\n` +
      `\`${bs58.encode(secretKey)}\`\n\n` +
      `*Private Key (Hex):*\n` +
      `\`${Buffer.from(secretKey).toString('hex')}\`\n\n` +
      `Copy this and store it in a password manager or write it down.\n` +
      `This message will self-destruct in 1 minute.`,
      { parse_mode: 'Markdown' }
    );

    // Auto-delete after 60 seconds for security
    setTimeout(async () => {
      try {
        await ctx.deleteMessage();
      } catch (err) {
        // Message may already be deleted
      }
    }, 60000);
  } catch (err) {
    console.error('Export key error:', err);
    await ctx.reply('❌ Could not export private key. Please contact support.', mainMenu);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 💰 BALANCE
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('💰 Balance', async (ctx) => {
  const userId = ctx.from.id.toString();
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

    let msg = `💰 *Your Balance*\n\n`;
    let totalNgn = 0;

    for (const bal of balances) {
      const ngnEquiv = bal.symbol === 'SOL'
        ? bal.amount * offRampRate * 0.0006 // rough SOL→USD→NGN
        : bal.amount * offRampRate;
      totalNgn += ngnEquiv;
      const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : '🟡';
      msg += `${emoji} *${bal.symbol}*  ${formatBalance(bal.amount, bal.symbol)}  (≈${formatNgn(ngnEquiv)})\n`;
    }

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💵 Total: ≈${formatNgn(totalNgn)}`;

    await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
  } catch (err) {
    console.error('Balance error:', err);
    await ctx.reply('❌ Could not fetch balance. Please try again.', mainMenu);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 💵 ADD NAIRA (On-Ramp) — With PAJ OTP Flow
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('💵 Add Naira', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  // Check if PAJ is configured
  const pajClient = await getPAJClient();
  if (!pajClient) {
    await ctx.reply('❌ PAJ service is not configured. Please contact support.', mainMenu);
    return;
  }

  // Step 1: Ask how much NGN they want to add
  setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT });

  await ctx.reply(
    `💵 *Add Naira*\n\n` +
    `How much NGN do you want to add to your wallet?\n\n` +
    `Minimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n\n` +
    `Enter the amount (numbers only):`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
});

// Handle PAJ email/phone input
bot.on(message('text'), async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;
  const session = getSession(userId);

  // Cancel
  if (text === '❌ Cancel') {
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply('Cancelled.', mainMenu);
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

    const pajClient = await getPAJClient();
    if (!pajClient) {
      await ctx.reply('❌ PAJ service unavailable.', mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }

    // Get rate for this amount
    let rate = 1550;
    let fee = 0;
    try {
      const rateData = await pajClient.getRateByAmount(amount);
      rate = rateData.rate.rate;
      fee = rateData.fee || 0;
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
      setSession(userId, { state: ConversationState.IDLE, onrampAmount: amount });
      await showVirtualAccount(ctx, userId, user[0].pajSessionToken!, amount, rate, feeNgn);
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
      `You receive: ~${usdtAmount.toFixed(2)} USDT\n\n` +
      `🔐 *PAJ Authentication Required*\n\n` +
      `Enter your email or phone number (with country code):\n` +
      `Example: user@email.com or +2348012345678`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
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
      // Step 1: Initiate PAJ session (sends OTP)
      const initiated = await pajClient.initiateSession(contact);
      console.log('[PAJ] OTP sent to:', initiated.email || initiated.phone);

      // Save pending contact
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
      await ctx.reply(
        `❌ Could not send OTP.\n` +
        `Error: ${err.message || 'Unknown error'}\n\n` +
        `Please try again or contact support.`,
        mainMenu
      );
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
      // Step 2: Verify OTP
      const verified = await pajClient.verifySession(contact, otp, {
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
      if (onrampAmount) {
        // Get rate for the pending amount
        let rate = 1550;
        let fee = 0;
        try {
          const rateData = await pajClient.getRateByAmount(onrampAmount);
          rate = rateData.rate.rate;
          fee = rateData.fee || 0;
        } catch (err) {
          console.log('Using fallback rate for on-ramp after verify');
        }
        await showVirtualAccount(ctx, userId, verified.token, onrampAmount, rate, fee);
      } else {
        await showVirtualAccount(ctx, userId, verified.token);
      }
    } catch (err: any) {
      console.error('[PAJ] Verify failed:', err);
      await ctx.reply(
        `❌ Invalid OTP or verification failed.\n` +
        `Error: ${err.message || 'Unknown error'}\n\n` +
        `Please try again.`,
        cancelKeyboard
      );
    }
    return;
  }

  // ─── SEND: AWAITING_SEND_AMOUNT ───
  if (session.state === ConversationState.AWAITING_SEND_AMOUNT) {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!amount || amount < 100) {
      await ctx.reply('❌ Please enter a valid amount (minimum ₦100).', cancelKeyboard);
      return;
    }

    // Get real PAJ rate
    let rate = 1550;
    let fee = 0;
    try {
      const pajClient = await getPAJClient();
      if (pajClient) {
        const rateData = await pajClient.getRateByAmount(amount);
        rate = rateData.rate.rate;
        // fee is included in the rate calculation
      }
    } catch (err) {
      console.log('Using fallback rate');
    }

    const usdtNeeded = amount / rate;

    // Check user has enough SOL for gas
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const walletAddress = user[0]?.walletAddress;
    const hasGas = walletAddress ? await walletService.hasEnoughSolForGas(walletAddress, 0.001) : false;

    session.pendingTransaction = {
      amountNgn: amount,
      amountUsdt: usdtNeeded,
      hasGas,
    };
    session.state = ConversationState.AWAITING_SEND_RECIPIENT;
    setSession(userId, session);

    let msg = `📤 Send ${formatNgn(amount)}\n` +
      `You pay: *${usdtNeeded.toFixed(2)} USDT*\n` +
      `Rate: ${formatNgn(rate)}/USDT\n\n`;

    if (!hasGas) {
      msg += `⚠️ *Low SOL for gas.* You'll need ~0.001 SOL.\n\n`;
    }

    msg += `Who should receive it?\n\n` +
      `Type: "Name BankCode AccountNumber"\n` +
      `Example: "Tunde GTB 0123456789"`;

    await ctx.reply(msg, { parse_mode: 'Markdown', ...cancelKeyboard });
    return;
  }

  // ─── SEND: AWAITING_SEND_RECIPIENT ───
  if (session.state === ConversationState.AWAITING_SEND_RECIPIENT) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
      await ctx.reply(
        '❌ Please use format: "Name BankCode AccountNumber"\n' +
        'Example: "Tunde GTB 0123456789"',
        cancelKeyboard
      );
      return;
    }

    const accountNumber = parts[parts.length - 1];
    const bankCode = parts[parts.length - 2].toUpperCase();
    const accountName = parts.slice(0, -2).join(' ');

    const bank = NIGERIAN_BANKS.find(b => b.code === bankCode);
    if (!bank) {
      const bankList = NIGERIAN_BANKS.map(b => `${b.code} = ${b.name}`).join('\n');
      await ctx.reply(`❌ Unknown bank code: ${bankCode}\n\nSupported banks:\n${bankList}`, cancelKeyboard);
      return;
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      await ctx.reply('❌ Account number must be exactly 10 digits.', cancelKeyboard);
      return;
    }

    session.pendingTransaction!.recipientBankCode = bankCode;
    session.pendingTransaction!.recipientBankName = bank.name;
    session.pendingTransaction!.recipientAccountNumber = accountNumber;
    session.pendingTransaction!.recipientAccountName = accountName;
    session.state = ConversationState.AWAITING_CONFIRMATION;
    setSession(userId, session);

    const { amountNgn, amountUsdt, hasGas } = session.pendingTransaction!;

    let confirmMsg = `📤 *Confirm Transfer*\n\n` +
      `Amount: *${formatNgn(amountNgn!)}*\n` +
      `To: *${accountName}*\n` +
      `Bank: *${bank.name}*\n` +
      `Account: \`${accountNumber}\`\n\n` +
      `You pay: *${amountUsdt!.toFixed(2)} USDT*\n`;

    if (!hasGas) {
      confirmMsg += `⚠️ *Gas: ~0.001 SOL* (you pay)\n`;
    } else {
      confirmMsg += `⛽ *Gas: ~0.001 SOL* (you have enough)\n`;
    }

    confirmMsg += `\n━━━━━━━━━━━━━━━━━━━━`;

    await ctx.reply(confirmMsg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm & Send', 'confirm_send')],
        [Markup.button.callback('❌ Cancel', 'cancel_send')],
      ]),
    });
    return;
  }

  // ─── Default ───
  if (session.state === ConversationState.IDLE) {
    await ctx.reply(
      `I didn't understand that. Try using the menu below or type a command like "Send 50k to Tunde GTB 0123456789".`,
      mainMenu
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SHOW VIRTUAL ACCOUNT (PAJ On-Ramp)
// ═════════════════════════════════════════════════════════════════════════════

async function showVirtualAccount(
  ctx: ZendContext,
  userId: string,
  sessionToken: string,
  amount?: number,
  rate?: number,
  fee?: number
): Promise<void> {
  const pajClient = await getPAJClient();
  if (!pajClient) {
    await ctx.reply('❌ PAJ service unavailable.', mainMenu);
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const walletAddress = user[0].walletAddress;

  // Use provided amount or default to minimum
  const fiatAmount = amount && amount >= PAJ_MIN_DEPOSIT_NGN ? amount : PAJ_MIN_DEPOSIT_NGN;

  // Get rate if not provided
  let _rate = rate || 1550;
  let _fee = fee || 0;
  if (!rate) {
    try {
      const rateData = await pajClient.getRateByAmount(fiatAmount);
      _rate = rateData.rate.rate;
      _fee = rateData.fee || 0;
    } catch (err) {
      console.log('Using fallback rate for VA display');
    }
  }
  const usdtAmount = fiatAmount / _rate;

  // Always create a fresh on-ramp order for the specific amount
  // (Don't reuse cached VAs since amounts may differ)
  let virtualAccount: any;
  try {
    const order = await pajClient.createOnramp({
      fiatAmount,
      currency: Currency.NGN,
      recipient: walletAddress,
      mint: SOLANA_TOKENS.USDT.mint,
      chain: Chain.SOLANA,
    }, sessionToken);

    virtualAccount = {
      bankCode: 'WEM', // PAJ uses Wema Bank
      bankName: order.bank,
      accountNumber: order.accountNumber,
      accountName: order.accountName,
      orderId: order.id,
      amount: fiatAmount,
      createdAt: new Date().toISOString(),
    };

    // Cache in DB (overwrite previous)
    await db.update(users)
      .set({ virtualAccount })
      .where(eq(users.id, userId));

    console.log('[PAJ] Virtual account created:', order.accountNumber, 'for ₦', fiatAmount);
  } catch (err: any) {
    console.error('[PAJ] createOnramp failed:', err);
    await ctx.reply(
      `❌ Could not create virtual account.\n` +
      `Error: ${err.message || 'Unknown error'}`,
      mainMenu
    );
    return;
  }

  await ctx.reply(
    `💵 *Add Naira to Your Wallet*\n\n` +
    `*Deposit Details:*\n` +
    `Amount: ${formatNgn(fiatAmount)}\n` +
    `Rate: ₦${_rate.toLocaleString()}/USD\n` +
    `Fee: ${formatNgn(_fee)}\n` +
    `You receive: ~${usdtAmount.toFixed(2)} USDT\n\n` +
    `*Send bank transfer to:*\n` +
    `🏦 *${virtualAccount.bankName}*\n` +
    `🔢 \`${virtualAccount.accountNumber}\`\n` +
    `👤 *${virtualAccount.accountName}*\n\n` +
    `⏱️ Arrives in: 2-5 minutes\n\n` +
    `📋 Tap to copy account number\n\n` +
    `⚠️ *Important:* Send from a bank account in your name.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 📤 SEND — Off-Ramp
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('📤 Send', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  setSession(userId, {
    state: ConversationState.AWAITING_SEND_AMOUNT,
    pendingTransaction: {},
  });

  await ctx.reply(
    `📤 *Send Money*\n\n` +
    `How much do you want to send? (in Naira)\n\n` +
    `Examples:\n• 50000\n• 100000\n• 5000`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// CONFIRM SEND
// ═════════════════════════════════════════════════════════════════════════════

bot.action('confirm_send', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);

  if (session.state !== ConversationState.AWAITING_CONFIRMATION || !session.pendingTransaction) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    await ctx.reply('Use the menu to start again.', mainMenu);
    return;
  }

  const { amountNgn, amountUsdt, recipientBankCode, recipientBankName, recipientAccountNumber, recipientAccountName } =
    session.pendingTransaction;

  const txId = generateTxId();
  await db.insert(transactions).values({
    id: txId,
    userId,
    type: 'ngn_send',
    status: 'processing',
    ngnAmount: amountNgn!.toString(),
    ngnRate: '1550',
    recipientBankCode: recipientBankCode!,
    recipientBankName: recipientBankName!,
    recipientAccountNumber: recipientAccountNumber!,
    recipientAccountName: recipientAccountName!,
  });

  setSession(userId, { state: ConversationState.IDLE });

  await ctx.editMessageText(
    `⏳ *Processing...*\n\n` +
    `Sending ${amountUsdt!.toFixed(2)} USDT\n` +
    `Estimated: 1-5 minutes\n\n` +
    `Reference: ${txId}`,
    { parse_mode: 'Markdown' }
  );

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const walletAddress = user[0].walletAddress;
    let offRampRef = 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    const pajClient = await getPAJClient();
    if (pajClient && user[0].pajSessionToken) {
      // Real PAJ off-ramp
      const order = await pajClient.createOfframp({
        bank: recipientBankCode!,
        accountNumber: recipientAccountNumber!,
        currency: Currency.NGN,
        fiatAmount: amountNgn!,
        mint: SOLANA_TOKENS.USDT.mint,
        chain: Chain.SOLANA,
      }, user[0].pajSessionToken);

      offRampRef = order.id;
      console.log('[PAJ] Off-ramp order created:', order.id);
    }

    await db.update(transactions)
      .set({ pajReference: offRampRef })
      .where(eq(transactions.id, txId));

    // Simulate completion
    setTimeout(async () => {
      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.id, txId));

      await ctx.reply(
        `✅ *Transfer Complete!*\n\n` +
        `${formatNgn(amountNgn!)} sent to ${recipientAccountName}\n` +
        `${recipientBankName} • \`${recipientAccountNumber}\`\n\n` +
        `Reference: ${txId}\n` +
        `PAJ Ref: ${offRampRef}\n` +
        `Time: ~2 minutes`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }, 3000);
  } catch (err: any) {
    console.error('Off-ramp failed:', err);
    await db.update(transactions)
      .set({ status: 'failed' })
      .where(eq(transactions.id, txId));

    await ctx.reply(
      `❌ *Transfer Failed*\n\n` +
      `Error: ${err.message || 'Unknown error'}\n` +
      `No funds were deducted.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }
});

bot.action('cancel_send', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Cancelled.');
  await ctx.reply('What would you like to do?', mainMenu);
});

// ═════════════════════════════════════════════════════════════════════════════
// 💴 CASH OUT (alias for Send)
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('💴 Cash Out', async (ctx) => {
  await ctx.reply('💴 Cash Out uses the same flow as Send. Redirecting...');
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

// ═════════════════════════════════════════════════════════════════════════════
// 📥 RECEIVE
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('📥 Receive', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const walletAddress = user[0].walletAddress;

  await ctx.reply(
    `📥 *Receive Money*\n\n` +
    `Share your details to get paid:\n\n` +
    `┌─ *Crypto (Solana)* ─────────────┐\n` +
    `│ \`${walletAddress}\`\n` +
    `│ [📋 Copy]\n` +
    `└────────────────────────────────┘\n\n` +
    `┌─ *Naira (Bank Transfer)* ──────┐\n` +
    `│ Tap 💵 *Add Naira* to get your\n` +
    `│ virtual bank account.\n` +
    `└────────────────────────────────┘\n\n` +
    `💡 Crypto arrives instantly. Naira arrives in 2-5 minutes.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 🔄 SWAP (placeholder)
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('🔄 Swap', async (ctx) => {
  await ctx.reply(
    `🔄 *Swap Tokens*\n\n` +
    `Coming soon! You'll be able to swap SOL, USDC, and other tokens to USDT instantly.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 📋 HISTORY
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('📋 History', async (ctx) => {
  const userId = ctx.from.id.toString();
  const txs = await db.select().from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(transactions.createdAt)
    .limit(10);

  if (txs.length === 0) {
    await ctx.reply('📋 No transactions yet.\n\nSend or receive money to see your history here.', mainMenu);
    return;
  }

  let msg = `📋 *Transaction History*\n\n`;

  for (const tx of txs) {
    const icon = tx.status === 'completed' ? '✅' : tx.status === 'processing' ? '⏳' : '❌';
    const typeLabel = tx.type === 'ngn_send' ? 'Send NGN' : tx.type === 'ngn_receive' ? 'Deposit' : tx.type;
    const amount = tx.ngnAmount ? formatNgn(Number(tx.ngnAmount)) : `${tx.fromAmount} ${tx.fromMint}`;
    const date = tx.createdAt.toLocaleDateString('en-NG', { month: 'short', day: 'numeric' });

    msg += `${icon} ${typeLabel}  ${amount}  ${date}\n`;
    if (tx.recipientBankName) {
      msg += `   To: ${tx.recipientAccountName} (${tx.recipientBankName})\n`;
    }
    msg += `   Ref: ${tx.id}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
});

// ═════════════════════════════════════════════════════════════════════════════
// ⚙️ SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const u = user[0];

  await ctx.reply(
    `⚙️ *Settings*\n\n` +
    `👤 *Profile*\n` +
    `Name: ${u.firstName} ${u.lastName || ''}\n` +
    `Wallet: \`${u.walletAddress.slice(0, 6)}...${u.walletAddress.slice(-4)}\`\n\n` +
    `🔐 *Security*\n` +
    `Email: ${u.email || 'Not set'} ${u.emailVerified ? '✓' : ''}\n` +
    `PAJ: ${u.pajSessionToken ? '✅ Linked' : '❌ Not linked'}\n` +
    `PIN: ${u.transactionPin ? 'Set' : 'Not set'}\n\n` +
    `💰 *Preferences*\n` +
    `Auto-save: ${u.autoSaveRateBps > 0 ? (u.autoSaveRateBps / 100).toFixed(0) + '%' : 'Off'}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📧 Add Email', 'settings_email')],
        [Markup.button.callback('🔗 Link PAJ', 'settings_paj')],
        [Markup.button.callback('🔢 Set PIN', 'settings_pin')],
      ]),
    }
  );
});

bot.action('settings_paj', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  setSession(userId, { state: ConversationState.AWAITING_EMAIL });

  await ctx.editMessageText(
    `🔗 *Link PAJ Account*\n\n` +
    `Enter your email or phone (with country code):\n` +
    `Example: user@email.com or +2348012345678`
  );

  await ctx.reply('Waiting for your input...', cancelKeyboard);
});

// ═════════════════════════════════════════════════════════════════════════════
// ERROR HANDLER
// ═════════════════════════════════════════════════════════════════════════════

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Something went wrong. Please try again or contact support.', mainMenu);
});

// ═════════════════════════════════════════════════════════════════════════════
// LAUNCH
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  const dbOk = await checkConnection();
  if (!dbOk) {
    console.error('❌ Database connection failed.');
    process.exit(1);
  }
  console.log('✅ Database connected');

  const pajClient = await getPAJClient();
  if (pajClient) {
    try {
      const rates = await pajClient.getAllRates();
      console.log('✅ PAJ connected — On-ramp:', rates.onRampRate.rate, 'Off-ramp:', rates.offRampRate.rate);
    } catch (err) {
      console.warn('⚠️  PAJ rate check failed:', err);
    }
  } else {
    console.warn('⚠️  PAJ not configured');
  }

  bot.launch();
  console.log('🤖 Zend bot is running...');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main();
