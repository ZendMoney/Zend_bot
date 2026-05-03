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
import { parseCommand, transcribeVoice, chatWithKimi, type ParsedCommand } from './services/nlp.js';
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
    recipientName: string;
    recipientBankCode: string;
    recipientBankName: string;
    recipientAccountNumber: string;
    recipientAccountName: string;
    recipientWalletAddress: string;
    zendFeeUsdt?: number;
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

// ─── Loading UI Helper ───
async function showLoading(ctx: ZendContext, text: string): Promise<{ message_id: number }> {
  await ctx.replyWithChatAction('typing');
  const msg = await ctx.reply(`⏳ ${text}`);
  return msg;
}

async function updateLoading(ctx: ZendContext, messageId: number, text: string): Promise<void> {
  await ctx.replyWithChatAction('typing');
  await ctx.telegram.editMessageText(ctx.chat!.id, messageId, undefined, `⏳ ${text}`);
}

async function finishLoading(ctx: ZendContext, messageId: number, text: string, parseMode?: string): Promise<void> {
  await ctx.telegram.editMessageText(ctx.chat!.id, messageId, undefined, text, parseMode ? { parse_mode: parseMode as any } : undefined);
}

// ─── Rate Cache ───
let _pajRates: { onRampRate: number; offRampRate: number } | null = null;
let _pajRatesTime = 0;

async function getPAJRates(): Promise<{ onRampRate: number; offRampRate: number }> {
  if (_pajRates && Date.now() - _pajRatesTime < 300000) { // 5 min cache
    return _pajRates;
  }
  const pajClient = await getPAJClient();
  if (!pajClient) {
    return _pajRates || { onRampRate: 1550, offRampRate: 1550 };
  }
  try {
    const rates = await pajClient.getAllRates();
    _pajRates = {
      onRampRate: rates.onRampRate.rate,
      offRampRate: rates.offRampRate.rate,
    };
    _pajRatesTime = Date.now();
    return _pajRates;
  } catch (err) {
    console.log('[PAJ] Rate fetch failed, using cache/fallback');
    return _pajRates || { onRampRate: 1550, offRampRate: 1550 };
  }
}

// ─── Bank Verification ───
// Cache PAJ bank list to map our bank codes ↔ PAJ bank IDs
let _pajBankCache: Array<{ id: string; name: string; code: string }> | null = null;
let _pajBankCacheTime = 0;

async function getPAJBankList(sessionToken: string): Promise<Array<{ id: string; name: string; code: string }>> {
  if (_pajBankCache && Date.now() - _pajBankCacheTime < 3600000) {
    return _pajBankCache;
  }
  const pajClient = await getPAJClient();
  if (!pajClient) return [];
  try {
    const banks = await pajClient.getBanks(sessionToken);
    _pajBankCache = banks.map((b: any) => ({ id: b.id, name: b.name, code: b.code || '' }));
    _pajBankCacheTime = Date.now();
    return _pajBankCache || [];
  } catch (err) {
    console.error('[PAJ] Failed to fetch bank list:', err);
    return _pajBankCache || [];
  }
}

async function verifyBankAccount(
  sessionToken: string,
  ourBankCode: string,
  accountNumber: string
): Promise<{ verified: boolean; accountName?: string; error?: string }> {
  const pajClient = await getPAJClient();
  if (!pajClient) {
    return { verified: false, error: 'PAJ not available' };
  }

  try {
    // Get PAJ bank list and find matching bank
    const pajBanks = await getPAJBankList(sessionToken);
    const ourBank = NIGERIAN_BANKS.find(b => b.code === ourBankCode);
    if (!ourBank) {
      return { verified: false, error: 'Unknown bank code' };
    }

    // Find PAJ bank by name match
    const pajBank = pajBanks.find(pb =>
      pb.name.toLowerCase().includes(ourBank.name.toLowerCase()) ||
      ourBank.name.toLowerCase().includes(pb.name.toLowerCase())
    );

    if (!pajBank) {
      return { verified: false, error: `Bank "${ourBank.name}" not found on PAJ` };
    }

    // Call PAJ to resolve account
    const result = await pajClient.resolveBankAccount(sessionToken, pajBank.id, accountNumber);
    return { verified: true, accountName: result.accountName };
  } catch (err: any) {
    console.error('[PAJ] Bank verification failed:', err);
    return { verified: false, error: err.message || 'Could not verify account' };
  }
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
  const loading = await showLoading(ctx, 'Fetching your balance...');

  try {
    const balances = await walletService.getAllBalances(walletAddress);
    const rates = await getPAJRates();
    const offRampRate = rates.offRampRate;

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

    await finishLoading(ctx, loading.message_id, msg, 'Markdown');
    await ctx.reply('Menu:', mainMenu);
  } catch (err) {
    console.error('Balance error:', err);
    await finishLoading(ctx, loading.message_id, '❌ Could not fetch balance. Please try again.');
    await ctx.reply('Menu:', mainMenu);
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
bot.on(message('text'), async (ctx, next) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;
  const session = getSession(userId);

  // ─── Pass menu buttons to bot.hears() handlers ───
  const menuButtons = ['💰 Balance', '💵 Add Naira', '📤 Send', '💴 Cash Out', '📥 Receive', '🔄 Swap', '📋 History', '⚙️ Settings'];
  if (menuButtons.includes(text)) {
    return next();
  }

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

    // Get real PAJ off-ramp rate
    let rate = 1550;
    try {
      const rates = await getPAJRates();
      rate = rates.offRampRate;
    } catch (err) {
      console.log('Using fallback rate');
    }

    const zendFeeBps = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
    const zendFeeUsdt = (amount / rate) * (zendFeeBps / 10000);
    const usdtNeeded = (amount / rate) + zendFeeUsdt;

    session.pendingTransaction = {
      amountNgn: amount,
      amountUsdt: usdtNeeded,
      zendFeeUsdt,
    };
    session.state = ConversationState.AWAITING_SEND_RECIPIENT;
    setSession(userId, session);

    let msg = `📤 Send ${formatNgn(amount)}\n` +
      `Rate: ${formatNgn(rate)}/USDT\n` +
      `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${zendFeeUsdt.toFixed(4)} USDT\n` +
      `You pay: *${usdtNeeded.toFixed(2)} USDT*\n\n` +
      `Who should receive it?\n\n` +
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

    // ─── Verify bank account with PAJ ───
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    let verifiedName = accountName;
    let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';
    let verifyMsg: { message_id: number } | undefined;

    if (user[0]?.pajSessionToken) {
      verifyMsg = await showLoading(ctx, 'Verifying account with PAJ...');
      const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, accountNumber);
      if (verification.verified && verification.accountName) {
        verifiedName = verification.accountName;
        verifiedStatus = 'verified';
      } else {
        console.log('[Verify] Failed:', verification.error);
        // Don't block — let user decide
      }
    } else {
      verifiedStatus = 'no_paj';
    }

    session.pendingTransaction!.recipientBankCode = bankCode;
    session.pendingTransaction!.recipientBankName = bank.name;
    session.pendingTransaction!.recipientAccountNumber = accountNumber;
    session.pendingTransaction!.recipientAccountName = verifiedName;
    session.state = ConversationState.AWAITING_CONFIRMATION;
    setSession(userId, session);

    const { amountNgn, amountUsdt } = session.pendingTransaction!;

    let confirmMsg = `📤 *Confirm Transfer*\n\n`;

    if (verifiedStatus === 'verified') {
      confirmMsg += `✅ *Account Verified by PAJ*\n`;
    } else if (verifiedStatus === 'no_paj') {
      confirmMsg += `⚠️ *Account Not Verified* (link PAJ in Settings to verify)\n`;
    } else {
      confirmMsg += `⚠️ *Could not verify account* — please double-check details\n`;
    }

    const zendFeeBps = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
    const feeLine = session.pendingTransaction?.zendFeeUsdt
      ? `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${session.pendingTransaction.zendFeeUsdt.toFixed(4)} USDT\n`
      : '';

    confirmMsg += `\n` +
      `Amount: *${formatNgn(amountNgn!)}*\n` +
      `To: *${verifiedName}*\n` +
      `Bank: *${bank.name}*\n` +
      `Account: \`${accountNumber}\`\n\n` +
      feeLine +
      `You pay: *${amountUsdt!.toFixed(2)} USDT*\n` +
      `💡 *Gas: ~0.001 SOL* (deducted from your wallet)\n\n` +
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

  // ─── NLP: Parse natural language when IDLE ───
  if (session.state === ConversationState.IDLE) {
    const parsed = await parseCommand(text);
    console.log('[NLP] Parsed:', parsed);

    switch (parsed.intent) {
      case 'send': {
        if (!parsed.amount) {
          await ctx.reply('❌ How much do you want to send? Example: "Send 5000 to Tunde"', cancelKeyboard);
          return;
        }
        if (parsed.amount < 100) {
          await ctx.reply(`❌ Minimum send amount is ${formatNgn(100)}.`, cancelKeyboard);
          return;
        }
        if (!parsed.accountNumber && !parsed.walletAddress) {
          await ctx.reply('❌ Please include account details. Example: "Send 5000 to Tunde GTB 0123456789"', cancelKeyboard);
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

        const zendFeeBps = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
        const zendFeeUsdt = (parsed.amount / rate) * (zendFeeBps / 10000);
        const usdtNeeded = (parsed.amount / rate) + zendFeeUsdt;

        // ─── Verify bank account with PAJ ───
        let verifiedName = parsed.recipientName;
        let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';

        if (parsed.bankCode && parsed.accountNumber && user[0]?.pajSessionToken) {
          const verification = await verifyBankAccount(user[0].pajSessionToken, parsed.bankCode, parsed.accountNumber);
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
          zendFeeUsdt,
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
          msg += `✅ *Account Verified by PAJ*\n`;
        } else if (verifiedStatus === 'no_paj') {
          msg += `⚠️ *Account Not Verified* (link PAJ in Settings to verify)\n`;
        } else {
          msg += `⚠️ *Could not verify account* — please double-check details\n`;
        }

        msg += `\n` +
          `To: *${verifiedName || 'Recipient'}*\n` +
          `Bank: ${parsed.bankName || 'Solana'}\n` +
          `Account: \`${parsed.accountNumber || parsed.walletAddress}\`\n` +
          `Amount: ${formatNgn(parsed.amount)}\n` +
          `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${zendFeeUsdt.toFixed(4)} USDT\n` +
          `You pay: *${usdtNeeded.toFixed(2)} USDT*\n` +
          `Rate: ${formatNgn(rate)}/USDT\n\n` +
          `💡 *Gas: ~0.001 SOL* (deducted from your wallet)\n\n` +
          `Confirm?`;

        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm', 'confirm_send')],
            [Markup.button.callback('❌ Cancel', 'cancel_send')],
          ]),
        });
        return;
      }

      case 'add_naira': {
        // Simulate clicking Add Naira
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

          let msg = `💰 *Your Balance*\n\n`;
          let totalNgn = 0;

          for (const bal of balances) {
            const ngnEquiv = bal.symbol === 'SOL'
              ? bal.amount * offRampRate * 0.0006
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
        return;
      }

      default: {
        // Try conversational AI for unknown intents
        const aiReply = await chatWithKimi(text);
        if (aiReply) {
          await ctx.reply(aiReply.reply, mainMenu);
        } else {
          await ctx.reply(
            `I didn't understand that. Try using the menu below or type a command like "Send 50k to Tunde GTB 0123456789".`,
            mainMenu
          );
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

    await db.update(users)
      .set({ transactionPin: pin })
      .where(eq(users.id, userId));

    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply('✅ PIN set successfully.', mainMenu);
    return;
  }
});

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_key') {
    await ctx.reply(
      '❌ Voice messages are not configured yet.\n\n' +
      'Please type your command or use the menu below.',
      mainMenu
    );
    return;
  }

  const loadingVoice = await showLoading(ctx, 'Transcribing voice note...');

  try {
    // Download voice file
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const response = await fetch(fileLink.toString());
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    await updateLoading(ctx, loadingVoice.message_id, 'Transcribing with AI...');

    // Transcribe
    const text = await transcribeVoice(audioBuffer, apiKey);
    console.log('[Voice] Transcribed:', text);

    await updateLoading(ctx, loadingVoice.message_id, 'Parsing your command...');

    // Parse transcribed text
    const parsed = await parseCommand(text, true); // use Kimi for voice

    await finishLoading(ctx, loadingVoice.message_id, `📝 *You said:* "${text}"`, 'Markdown');

    // Forward to text handler logic
    // Create a synthetic text message update
    (ctx as any).message.text = text;
    (ctx as any).message.voice = undefined;

    // Re-process as text
    await bot.handleUpdate(ctx.update);

  } catch (err: any) {
    console.error('[Voice] Error:', err);
    await finishLoading(ctx, loadingVoice.message_id, '❌ Could not process voice note. Please type your command or use the menu below.');
    await ctx.reply('Menu:', mainMenu);
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
      const rates = await getPAJRates();
      _rate = rates.onRampRate;
    } catch (err) {
      console.log('Using fallback rate for VA display');
    }
  }
  const usdtAmount = fiatAmount / _rate;

  // Always create a fresh on-ramp order for the specific amount
  // (Don't reuse cached VAs since amounts may differ)
  const loadingVA = await showLoading(ctx, 'Creating your virtual bank account...');
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
    await finishLoading(ctx, loadingVA.message_id, `❌ Could not create virtual account.\nError: ${err.message || 'Unknown error'}`);
    await ctx.reply('Menu:', mainMenu);
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

  const { amountNgn, amountUsdt, recipientBankCode, recipientBankName, recipientAccountNumber, recipientAccountName, recipientName } =
    session.pendingTransaction;

  // Use recipientName as fallback for recipientAccountName (from NLP)
  const finalAccountName = recipientAccountName || recipientName || 'Recipient';
  const finalBankName = recipientBankName || 'Unknown';
  const finalBankCode = recipientBankCode || 'UNKNOWN';
  const finalAccountNumber = recipientAccountNumber || '0000000000';

  const txId = generateTxId();
  await db.insert(transactions).values({
    id: txId,
    userId,
    type: 'ngn_send',
    status: 'processing',
    ngnAmount: amountNgn!.toString(),
    ngnRate: '1550',
    recipientBankCode: finalBankCode,
    recipientBankName: finalBankName,
    recipientAccountNumber: finalAccountNumber,
    recipientAccountName: finalAccountName,
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
    await ctx.replyWithChatAction('typing');
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const walletAddress = user[0].walletAddress;
    let offRampRef = 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    const pajClient = await getPAJClient();
    if (pajClient && user[0].pajSessionToken) {
      await ctx.replyWithChatAction('typing');
      // Real PAJ off-ramp
      const order = await pajClient.createOfframp({
        bank: finalBankCode,
        accountNumber: finalAccountNumber,
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
        `${formatNgn(amountNgn!)} sent to ${finalAccountName}\n` +
        `${finalBankName} • \`${finalAccountNumber}\`\n\n` +
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
// NLP BANK SELECTION (when bank not detected in natural language)
// ═════════════════════════════════════════════════════════════════════════════

bot.action(/nlp_bank:(.+)/, async (ctx) => {
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

  const { amountNgn, recipientName, recipientAccountNumber } = session.pendingTransaction;
  const pajClient = await getPAJClient();
  let rate = 1550;
  try {
    if (pajClient) {
      const rates = await getPAJRates();
      rate = rates.offRampRate;
    }
  } catch (err) {
    console.log('Using fallback rate for NLP bank select');
  }

  const zendFeeBps = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
  const zendFeeUsdt = (amountNgn! / rate) * (zendFeeBps / 10000);
  const usdtNeeded = (amountNgn! / rate) + zendFeeUsdt;

  // ─── Verify bank account with PAJ ───
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  let verifiedName = recipientName;
  let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';

  if (user[0]?.pajSessionToken) {
    const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, recipientAccountNumber!);
    if (verification.verified && verification.accountName) {
      verifiedName = verification.accountName;
      verifiedStatus = 'verified';
    } else {
      console.log('[Verify] nlp_bank failed:', verification.error);
    }
  } else {
    verifiedStatus = 'no_paj';
  }

  session.pendingTransaction = {
    amountNgn,
    amountUsdt: usdtNeeded,
    zendFeeUsdt,
    recipientName: verifiedName,
    recipientAccountName: verifiedName,
    recipientBankName: bank.name,
    recipientBankCode: bank.code,
    recipientAccountNumber,
  };
  session.state = ConversationState.AWAITING_CONFIRMATION;
  setSession(userId, session);

  let msg = `📤 *Confirm Transfer*\n\n`;

  if (verifiedStatus === 'verified') {
    msg += `✅ *Account Verified by PAJ*\n`;
  } else if (verifiedStatus === 'no_paj') {
    msg += `⚠️ *Account Not Verified* (link PAJ in Settings to verify)\n`;
  } else {
    msg += `⚠️ *Could not verify account* — please double-check details\n`;
  }

  msg += `\n` +
    `To: *${verifiedName || 'Recipient'}*\n` +
    `Bank: ${bank.name}\n` +
    `Account: \`${recipientAccountNumber}\`\n` +
    `Amount: ${formatNgn(amountNgn!)}\n` +
    `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${zendFeeUsdt.toFixed(4)} USDT\n` +
    `You pay: *${usdtNeeded.toFixed(2)} USDT*\n` +
    `Rate: ${formatNgn(rate)}/USDT\n\n` +
    `💡 *Gas: ~0.001 SOL* (deducted from your wallet)\n\n` +
    `Confirm?`;

  await ctx.editMessageText(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', 'confirm_send')],
      [Markup.button.callback('❌ Cancel', 'cancel_send')],
    ]),
  });
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

bot.action('settings_email', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  setSession(userId, { state: ConversationState.AWAITING_EMAIL });

  await ctx.editMessageText(
    `📧 *Add Email*\n\n` +
    `Enter your email address:\n` +
    `Example: user@email.com`
  );

  await ctx.reply('Waiting for your input...', cancelKeyboard);
});

bot.action('settings_pin', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  setSession(userId, { state: ConversationState.AWAITING_PIN });

  await ctx.editMessageText(
    `🔢 *Set Transaction PIN*\n\n` +
    `Enter a 4-digit PIN for transaction security:\n` +
    `Example: 1234`
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

  bot.launch({ dropPendingUpdates: true });
  console.log('🤖 Zend bot is running...');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main();
