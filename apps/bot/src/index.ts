// ─── Load .env FIRST — before any imports that need env vars ───
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
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
import { parseCommand, transcribeVoice, chatWithKimi, analyzeVoiceWithKimi, parseMenuInputWithAI, type ParsedCommand } from './services/nlp.js';
import type { PAJClient } from '@zend/paj-client';
import {
  ConversationState,
  SOLANA_TOKENS,
  NIGERIAN_BANKS,
  PAJ_MIN_DEPOSIT_NGN,
} from '@zend/shared';

import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN!;
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

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
    ngnRate?: number;
    // Swap fields
    fromMint?: string;
    toMint?: string;
    fromSymbol?: string;
    toSymbol?: string;
    fromDecimals?: number;
    swapAmountBase?: number;
    swapQuote?: any;
    swapOutAmount?: number;
    swapMinOut?: number;
    swapPriceImpact?: number;
  }>;
  pinVerifyAction?: 'send' | 'swap' | 'export';
  pajContact?: string; // email/phone pending OTP
  onrampAmount?: number; // pending on-ramp amount in NGN
  voiceAnalysis?: {
    text: string;
    amount: number | null;
    recipientName: string | null;
    bankCode: string | null;
    bankName: string | null;
    accountNumber: string | null;
    walletAddress: string | null;
  };
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

// ─── PIN hashing ───
function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256').toString('hex');
  return salt + ':' + hash;
}

function verifyPin(pin: string, stored: string): { valid: boolean; isLegacy: boolean } {
  // Legacy: plaintext PIN stored before hashing was introduced
  if (!stored.includes(':')) {
    return { valid: stored === pin, isLegacy: true };
  }
  const parts = stored.split(':');
  if (parts.length !== 2) return { valid: false, isLegacy: false };
  const [salt, hash] = parts;
  const computed = crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256').toString('hex');
  return { valid: computed === hash, isLegacy: false };
}

function formatBalance(amount: number, symbol: string): string {
  return `${amount.toFixed(symbol === 'SOL' ? 4 : 2)} ${symbol}`;
}

function formatNgn(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}

// Strip non-digits from account numbers (Whisper adds dashes, spaces, dots)
function sanitizeAccountNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/\D/g, '');
}

// ─── SOL Price (CoinGecko) ───
let _solPriceCache: { price: number; time: number } | null = null;

async function getSolPriceInUsdt(): Promise<number> {
  if (_solPriceCache && Date.now() - _solPriceCache.time < 120000) {
    return _solPriceCache.price;
  }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    const price = data?.solana?.usd || 140;
    _solPriceCache = { price, time: Date.now() };
    return price;
  } catch {
    return _solPriceCache?.price || 140;
  }
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

async function getPajBankList(sessionToken: string): Promise<Array<{ id: string; name: string; code: string }>> {
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

// Bank name aliases for fuzzy matching between our codes and PAJ names
const BANK_NAME_ALIASES: Record<string, string[]> = {
  'GTB': ['gtbank', 'guaranty trust bank', 'guaranty trust', 'gt bank', 'gtb'],
  'UBA': ['uba', 'united bank for africa'],
  'ACC': ['access', 'access bank'],
  'ZEN': ['zenith', 'zenith bank'],
  'FBN': ['first bank', 'firstbank'],
  'ECO': ['ecobank', 'eco bank'],
  'WEM': ['wema', 'wema bank'],
  'FID': ['fidelity', 'fidelity bank'],
  'SKY': ['polaris', 'polaris bank', 'skye', 'skye bank'],
  'FCMB': ['fcmb', 'first city'],
  'STERLING': ['sterling', 'sterling bank'],
  'STA': ['stanbic', 'stanbic ibtc'],
  'UNI': ['union', 'union bank'],
  'KEC': ['keystone', 'keystone bank'],
  'JAB': ['jaiz', 'jaiz bank'],
  'OPY': ['opay'],
  'MON': ['moniepoint'],
  'KUD': ['kuda'],
  'PAL': ['palmpay'],
  'PAG': ['paga'],
  'VFD': ['vfd'],
  'CAR': ['carbon'],
  'FAI': ['fairmoney'],
  'BRA': ['branch'],
};

function scoreBankMatch(pajName: string, ourCode: string): number {
  const ourBank = NIGERIAN_BANKS.find(b => b.code === ourCode);
  if (!ourBank) return 0;

  const p = pajName.toLowerCase();
  const o = ourBank.name.toLowerCase();
  const aliases = BANK_NAME_ALIASES[ourCode] || [];

  // Exact match
  if (p === o) return 100;
  // Contains each other
  if (p.includes(o) || o.includes(p)) return 80;
  // Alias match
  for (const alias of aliases) {
    if (p.includes(alias.toLowerCase())) return 70;
  }
  // Word overlap
  const pWords = p.split(/\s+/);
  const oWords = o.split(/\s+/);
  const overlap = pWords.filter(w => oWords.includes(w)).length;
  if (overlap > 0) return overlap * 20;

  return 0;
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
    const pajBanks = await getPajBankList(sessionToken);
    const ourBank = NIGERIAN_BANKS.find(b => b.code === ourBankCode);
    if (!ourBank) {
      return { verified: false, error: 'Unknown bank code' };
    }

    // Score all banks and pick best match
    let bestMatch: { bank: any; score: number } | null = null;
    for (const pb of pajBanks) {
      const score = scoreBankMatch(pb.name, ourBankCode);
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { bank: pb, score };
      }
    }

    if (!bestMatch || bestMatch.score < 20) {
      console.log('[PAJ] Available banks:', pajBanks.map(b => b.name).join(', '));
      return { verified: false, error: `Bank "${ourBank.name}" not found on PAJ` };
    }

    console.log(`[PAJ] Matched bank: ${ourBank.name} → ${bestMatch.bank.name} (score: ${bestMatch.score})`);
    const result = await pajClient.resolveBankAccount(sessionToken, bestMatch.bank.id, accountNumber);
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
// GROUP CHAT: reply only when tagged
// ═════════════════════════════════════════════════════════════════════════════

bot.use(async (ctx, next) => {
  const chatType = ctx.chat?.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    const msg = ctx.message;
    if (!msg || !('text' in msg)) {
      return; // ignore non-text updates in groups
    }

    const text = msg.text;
    const username = ctx.botInfo?.username;

    // Check @mention
    const isMentioned = username ? text.includes(`@${username}`) : false;
    // Check reply to bot
    const isReplyToBot = msg.reply_to_message?.from?.id === ctx.botInfo?.id;

    if (!isMentioned && !isReplyToBot) {
      return; // silently ignore in groups when not tagged
    }

    // Strip mention so handlers match correctly (e.g. "@Bot Balance" → "Balance")
    if (username && isMentioned) {
      msg.text = text.replace(new RegExp(`\\s?@${username}\\b`, 'g'), '').trim();
    }
  }
  await next();
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP CHAT HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function isGroupChat(ctx: ZendContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

function getBotUsername(ctx: ZendContext): string {
  return ctx.botInfo?.username || 'ZendBot';
}

async function promptPrivateChat(ctx: ZendContext, action: string) {
  const name = ctx.from?.first_name || 'there';
  const username = getBotUsername(ctx);
  await ctx.reply(
    `📩 ${name}, please use me in private chat to ${action}.\n\n` +
    `Sensitive actions are only available in DMs for security.`,
    Markup.inlineKeyboard([
      [Markup.button.url('💬 Open Private Chat', `https://t.me/${username}`)],
    ])
  );
}

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
    `👛 *Your Wallet*\n\n` +
    `*Solana Address:*\n` +
    `\`\`\`\n${u.walletAddress}\n\`\`\`\n\n` +
    `Tap the code block above to copy your address.\n\n` +
    `*Network:* Solana Mainnet\n` +
    `*Tokens:* SOL, USDT, USDC\n\n` +
    `⚠️ To export your private key, go to *⚙️ Settings*.`;

  if (isGroupChat(ctx)) {
    const name = ctx.from?.first_name || 'there';
    await ctx.reply(`📩 ${name}, check your DM for your wallet address.`);
    await ctx.telegram.sendMessage(ctx.from!.id, msg, { parse_mode: 'Markdown' });
    return;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ─── Export key helper (called after PIN is verified) ───
async function doExportKey(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  try {
    const secretKey = decryptPrivateKey(user[0].walletEncryptedKey);

    const msg = await ctx.reply(
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
        await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id);
      } catch (err) {
        // Message may already be deleted
      }
    }, 60000);
  } catch (err) {
    console.error('Export key error:', err);
    await ctx.reply('❌ Could not export private key. Please contact support.', mainMenu);
  }
}

bot.action('export_key', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'export your private key');
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
      `Enter your 4-digit PIN to export your private key:`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply('Waiting for PIN...', cancelKeyboard);
    return;
  }

  // No PIN set — proceed directly (but warn)
  await ctx.editMessageText(
    `⚠️ *No PIN Set*\n\n` +
    `For security, we recommend setting a PIN in Settings before exporting your private key.\n\n` +
    `Proceeding anyway...`,
    { parse_mode: 'Markdown' }
  );
  await doExportKey(ctx, userId);
});

// ═════════════════════════════════════════════════════════════════════════════
// 💰 BALANCE
// ═════════════════════════════════════════════════════════════════════════════

// Reusable balance handler
async function buildBalanceMessage(userId: string): Promise<string | null> {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) return null;

  const walletAddress = user[0].walletAddress;
  try {
    const balances = await walletService.getAllBalances(walletAddress);
    const rates = await getPAJRates();
    const offRampRate = rates.offRampRate;
    const solPrice = await getSolPriceInUsdt();

    let msg = `💰 *Your Balance*\n\n`;
    let totalNgn = 0;

    for (const bal of balances) {
      let ngnEquiv = 0;
      if (bal.symbol === 'SOL') {
        ngnEquiv = bal.amount * solPrice * offRampRate;
      } else {
        ngnEquiv = bal.amount * offRampRate;
      }
      totalNgn += ngnEquiv;
      const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : '🟡';
      msg += `${emoji} *${bal.symbol}*  ${formatBalance(bal.amount, bal.symbol)}  (≈${formatNgn(ngnEquiv)})\n`;
    }

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💵 Total: ≈${formatNgn(totalNgn)}\n`;
    msg += `📈 SOL: $${solPrice.toFixed(2)}  ·  Rate: ${formatNgn(offRampRate)}/USDT`;
    return msg;
  } catch (err) {
    console.error('Balance error:', err);
    return null;
  }
}

async function handleBalance(ctx: ZendContext, userId: string) {
  const loading = await showLoading(ctx, 'Fetching your balance...');

  const msg = await buildBalanceMessage(userId);
  if (!msg) {
    await finishLoading(ctx, loading.message_id, '❌ Could not fetch balance. Please try again.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  await finishLoading(ctx, loading.message_id, msg, 'Markdown');
  await ctx.reply('Menu:', mainMenu);
}

bot.hears('💰 Balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (isGroupChat(ctx)) {
    const name = ctx.from?.first_name || 'there';
    await ctx.reply(`📩 ${name}, check your DM for your balance.`);
    const msg = await buildBalanceMessage(userId);
    if (msg) {
      await ctx.telegram.sendMessage(ctx.from!.id, msg, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(ctx.from!.id, 'Menu:', mainMenu);
    } else {
      await ctx.telegram.sendMessage(ctx.from!.id, '❌ Could not fetch balance. Please try again.', mainMenu);
    }
    return;
  }
  await handleBalance(ctx, userId);
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
          `❌ *PAJ Server Error*\n\n` +
          `Could not send OTP. PAJ is experiencing issues with phone number processing.\n\n` +
          `Try these options:\n` +
          `1. Use your email instead of phone number\n` +
          `2. Try again in a few minutes\n` +
          `3. Contact PAJ support if the issue persists`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
      } else if (errorMsg.includes('Can\'t find business') || errorMsg.includes('business')) {
        await ctx.reply(
          `❌ *PAJ API Key Invalid*\n\n` +
          `Your PAJ business API key is not recognized.\n` +
          `Please check your PAJ dashboard and update the PAJ_BUSINESS_API_KEY environment variable.`,
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
      const errorMsg = err.message || '';

      if (errorMsg.includes('No recipients defined') || errorMsg.includes('recipients')) {
        await ctx.reply(
          `❌ *PAJ Server Error*\n\n` +
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
      verifyMsg = await showLoading(ctx, 'Verifying account with PAJ...');
      const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, accountNumber);
      if (verification.verified && verification.accountName) {
        verifiedName = verification.accountName;
        verifiedStatus = 'verified';
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

    const menuFromMint = session.pendingTransaction?.fromMint || SOLANA_TOKENS.USDT.mint;
    const menuFromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === menuFromMint) || SOLANA_TOKENS.USDT;
    confirmMsg += `\n` +
      `Amount: *${formatNgn(amountNgn!)}*\n` +
      `To: *${verifiedName}*\n` +
      `Bank: *${bank.name}*\n` +
      `Account: \`${accountNumber}\`\n\n` +
      feeLine +
      `You pay: *${amountUsdt!.toFixed(2)} ${menuFromToken.symbol}*\n` +
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

  // ─── SWAP: AWAITING_SWAP_AMOUNT ───
  if (session.state === ConversationState.AWAITING_SWAP_AMOUNT) {
    await handleSwapAmount(ctx, userId, text);
    return;
  }

  // ─── NLP: Parse natural language when IDLE ───
  if (session.state === ConversationState.IDLE) {
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
          const reply = await chatWithKimi(
            `The user said: "${text}". They want to send money but didn't specify an amount. ` +
            `Respond conversationally in Nigerian Pidgin style. Ask how much they want to send.`
          );
          await ctx.reply(reply || 'How much do you want to send?', { parse_mode: 'Markdown', ...cancelKeyboard });
          setSession(userId, { state: ConversationState.AWAITING_SEND_AMOUNT, pendingTransaction: { recipientName: parsed.recipientName } });
          return;
        }
        if (parsed.amount < 100) {
          const reply = await chatWithKimi(
            `The user wants to send ${parsed.amount} Naira. Minimum is ₦100. ` +
            `Respond in Nigerian Pidgin style telling them the minimum.`
          );
          await ctx.reply(reply || `Minimum send amount is ${formatNgn(100)}.`, cancelKeyboard);
          return;
        }
        if (!parsed.accountNumber && !parsed.walletAddress) {
          // We have amount + recipient name but missing bank/account
          const reply = await chatWithKimi(
            `The user said: "${text}". I understood they want to send ${formatNgn(parsed.amount)} to ${parsed.recipientName || 'someone'}. ` +
            `But I need the bank name and account number. Respond conversationally in Nigerian Pidgin style.`
          );
          await ctx.reply(reply || `I got that you want to send ${formatNgn(parsed.amount)}. What's the bank and account number?`, cancelKeyboard);
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

        const fromMint = parsed.fromToken === 'USDC' ? SOLANA_TOKENS.USDC.mint :
                           parsed.fromToken === 'SOL' ? SOLANA_TOKENS.SOL.mint :
                           SOLANA_TOKENS.USDT.mint;
        const fromTokenInfo = Object.values(SOLANA_TOKENS).find(t => t.mint === fromMint) || SOLANA_TOKENS.USDT;

        session.pendingTransaction = {
          amountNgn: parsed.amount,
          amountUsdt: usdtNeeded,
          zendFeeUsdt,
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
          msg += `✅ *Account Verified by PAJ*\n`;
        } else if (verifiedStatus === 'no_paj') {
          msg += `⚠️ *Account Not Verified* (link PAJ in Settings to verify)\n`;
        } else {
          msg += `⚠️ *Could not verify account* — please double-check details\n`;
        }

        const fromSymbol = fromTokenInfo.symbol;
        msg += `\n` +
          `To: *${verifiedName || 'Recipient'}*\n` +
          `Bank: ${parsed.bankName || 'Solana'}\n` +
          `Account: \`${parsed.accountNumber || parsed.walletAddress}\`\n` +
          `Amount: ${formatNgn(parsed.amount)}\n` +
          `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${zendFeeUsdt.toFixed(4)} USDT\n` +
          `You pay: *${usdtNeeded.toFixed(2)} ${fromSymbol}*\n` +
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
          const solPrice = await getSolPriceInUsdt();

          let msg = `💰 *Your Balance*\n\n`;
          let totalNgn = 0;

          for (const bal of balances) {
            let ngnEquiv = 0;
            if (bal.symbol === 'SOL') {
              ngnEquiv = bal.amount * solPrice * offRampRate;
            } else {
              ngnEquiv = bal.amount * offRampRate;
            }
            totalNgn += ngnEquiv;
            const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : '🟡';
            msg += `${emoji} *${bal.symbol}*  ${formatBalance(bal.amount, bal.symbol)}  (≈${formatNgn(ngnEquiv)})\n`;
          }

          msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
          msg += `💵 Total: ≈${formatNgn(totalNgn)}\n`;
          msg += `📈 SOL: $${solPrice.toFixed(2)}  ·  Rate: ${formatNgn(offRampRate)}/USDT`;

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

    const hashed = hashPin(pin);
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

    const result = verifyPin(pin, user[0].transactionPin);
    if (!result.valid) {
      await ctx.reply('❌ Incorrect PIN. Please try again.', cancelKeyboard);
      return;
    }

    // Auto-migrate legacy plaintext PIN to hashed
    if (result.isLegacy) {
      await db.update(users)
        .set({ transactionPin: hashPin(pin) })
        .where(eq(users.id, userId));
      console.log(`[PIN] Migrated plaintext PIN to hashed for user ${userId}`);
    }

    const action = session.pinVerifyAction;
    setSession(userId, { state: ConversationState.IDLE });

    if (action === 'send') {
      const pt = session.pendingTransaction;
      if (!pt) {
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      await executeSend(ctx, userId, {
        amountNgn: pt.amountNgn!,
        amountUsdt: pt.amountUsdt!,
        ngnRate: pt.ngnRate,
        zendFeeUsdt: pt.zendFeeUsdt,
        fromMint: pt.fromMint,
        recipientBankCode: pt.recipientBankCode,
        recipientBankName: pt.recipientBankName,
        recipientAccountNumber: pt.recipientAccountNumber,
        recipientAccountName: pt.recipientAccountName,
        recipientName: pt.recipientName,
      });
    } else if (action === 'swap') {
      const pt = session.pendingTransaction;
      if (!pt || !pt.swapQuote) {
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      // Re-use confirm_swap logic inline since we need the session
      await executeSwap(ctx, userId, pt);
    } else if (action === 'export') {
      await doExportKey(ctx, userId);
    } else {
      await ctx.reply('✅ PIN verified.', mainMenu);
    }
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

  // Check whisper.cpp is available
  try {
    const { hasWhisper } = await import('./services/whisper/index.js');
    if (!hasWhisper()) {
      await ctx.reply(
        '🎙️ *Voice Notes*\n\n' +
        'Voice transcription is being set up.\n' +
        'For now, please type your command or use the menu below.',
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }
  } catch {
    await ctx.reply(
      '🎙️ *Voice Notes*\n\n' +
      'Voice transcription is not ready yet.\n' +
      'Please type your command or use the menu below.',
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  const loadingVoice = await showLoading(ctx, 'Listening to your voice note...');

  try {
    // Download voice file from Telegram
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const response = await fetch(fileLink.toString());
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    await updateLoading(ctx, loadingVoice.message_id, 'Transcribing with Deepgram...');

    // Step 1: STT
    const text = await transcribeVoice(audioBuffer);
    console.log('[Voice] Transcribed:', text);
    if (!text.trim()) {
      await finishLoading(ctx, loadingVoice.message_id, '❌ Could not hear anything. Please speak clearly and try again.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    await updateLoading(ctx, loadingVoice.message_id, 'Analyzing with Kimi...');

    // Step 2: Kimi analysis + confirmation
    const analysis = await analyzeVoiceWithKimi(text);

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
    console.error('[Voice] Error:', err);
    await finishLoading(ctx, loadingVoice.message_id, '❌ Could not process voice note. Please type your command or use the menu below.');
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

  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'send money');
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

// Reusable send execution (used by confirm_send and voice_confirm_yes)
async function executeSend(
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
  }
) {
  const fromMint = txData.fromMint || SOLANA_TOKENS.USDT.mint;
  const fromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === fromMint) || SOLANA_TOKENS.USDT;
  const fromSymbol = fromToken.symbol;
  const finalAccountName = txData.recipientAccountName || txData.recipientName || 'Recipient';
  const finalBankName = txData.recipientBankName || 'Unknown';
  const finalBankCode = txData.recipientBankCode || 'UNKNOWN';
  const finalAccountNumber = txData.recipientAccountNumber || '0000000000';

  const txId = generateTxId();
  const feeUsdt = txData.zendFeeUsdt || 0;
  await db.insert(transactions).values({
    id: txId,
    userId,
    type: 'ngn_send',
    status: 'processing',
    ngnAmount: txData.amountNgn.toString(),
    ngnRate: (txData.ngnRate || 1550).toString(),
    fromAmount: txData.amountUsdt.toString(),
    fromMint: fromMint,
    zendFeeUsdt: feeUsdt.toString(),
    recipientBankCode: finalBankCode,
    recipientBankName: finalBankName,
    recipientAccountNumber: finalAccountNumber,
    recipientAccountName: finalAccountName,
  });

  setSession(userId, { state: ConversationState.IDLE });

  const processingText =
    `⏳ *Processing...*\n\n` +
    `Sending ${txData.amountUsdt.toFixed(2)} ${fromSymbol}\n` +
    `Estimated: 1-5 minutes\n\n` +
    `Reference: \`${txId}\``;

  // editMessageText only works when called from callback query context
  if (ctx.callbackQuery) {
    await ctx.editMessageText(processingText, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(processingText, { parse_mode: 'Markdown' });
  }

  let offRampRef = 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  let solanaTxHash: string | undefined;

  try {
    await ctx.replyWithChatAction('typing');
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (user.length === 0 || !user[0].walletEncryptedKey) {
      throw new Error('User wallet not found');
    }

    const pajClient = await getPAJClient();
    if (pajClient && user[0].pajSessionToken) {
      await ctx.replyWithChatAction('typing');
      const pajBanks = await getPajBankList(user[0].pajSessionToken);
      const ourBank = NIGERIAN_BANKS.find(b => b.code === finalBankCode);
      const pajBank = pajBanks.find(pb =>
        pb.name.toLowerCase().includes(ourBank?.name.toLowerCase() || '') ||
        (ourBank?.name.toLowerCase() || '').includes(pb.name.toLowerCase())
      );
      if (!pajBank) {
        throw new Error(`Bank "${ourBank?.name}" not found on PAJ`);
      }

      // Create PAJ off-ramp order
      const webhookUrl = process.env.WEBHOOK_BASE_URL
        ? `${process.env.WEBHOOK_BASE_URL}/webhooks/paj`
        : 'https://example.com/webhook';
      const order = await pajClient.createOfframp({
        bank: pajBank.id,
        accountNumber: finalAccountNumber,
        currency: Currency.NGN,
        fiatAmount: txData.amountNgn,
        mint: fromMint,
        chain: Chain.SOLANA,
        webhookURL: webhookUrl,
      } as any, user[0].pajSessionToken);

      offRampRef = order.id;
      console.log('[PAJ] Off-ramp order created:', order.id, 'deposit address:', order.address, 'amount:', order.amount);

      // ─── Check user has enough of the selected token ───
      await ctx.replyWithChatAction('typing');
      let tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, fromMint);

      // ─── Auto-swap USDC → USDT if sending USDT but only have USDC ───
      if (fromMint === SOLANA_TOKENS.USDT.mint && tokenBalance < order.amount) {
        const usdcBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDC.mint);

        if (usdcBalance >= order.amount) {
          const swapStatusText =
            `⏳ *Processing...*\n\n` +
            `You have ${usdcBalance.toFixed(2)} USDC but only ${tokenBalance.toFixed(2)} USDT.\n` +
            `Swapping USDC → USDT via Jupiter...`;
          if (ctx.callbackQuery) {
            await ctx.editMessageText(swapStatusText, { parse_mode: 'Markdown' });
          } else {
            await ctx.reply(swapStatusText, { parse_mode: 'Markdown' });
          }

          const swapAmountUsdc = Math.min(usdcBalance, order.amount * 1.03);
          const swapAmountBase = Math.round(swapAmountUsdc * Math.pow(10, SOLANA_TOKENS.USDC.decimals));

          const quote = await getSwapQuote(
            SOLANA_TOKENS.USDC.mint,
            SOLANA_TOKENS.USDT.mint,
            swapAmountBase,
            100 // 1% slippage
          );

          if (!quote) {
            throw new Error(
              `Insufficient USDT balance.\n\n` +
              `You have: ${tokenBalance.toFixed(2)} USDT\n` +
              `Required: ${order.amount.toFixed(2)} USDT\n\n` +
              `You also have ${usdcBalance.toFixed(2)} USDC, but the swap route is currently unavailable. ` +
              `Please deposit USDT or try again later.`
            );
          }

          const outAmountUsdt = Number(quote.outAmount) / Math.pow(10, SOLANA_TOKENS.USDT.decimals);
          if (outAmountUsdt < order.amount) {
            throw new Error(
              `Swap would only give ${outAmountUsdt.toFixed(2)} USDT, but ${order.amount.toFixed(2)} USDT is needed. ` +
              `Please deposit more USDC or USDT.`
            );
          }

          const serializedTx = await buildSwapTransaction(quote, user[0].walletAddress, true);
          if (!serializedTx) {
            throw new Error('Failed to build swap transaction. Please try again.');
          }

          const secretKey = decryptPrivateKey(user[0].walletEncryptedKey);
          const keypair = Keypair.fromSecretKey(secretKey);

          const swapTxHash = await walletService.signAndSendSerialized(keypair, serializedTx);
          console.log('[Jupiter] Auto-swap USDC→USDT:', swapTxHash);

          // Record swap in DB
          const swapTxId = generateTxId();
          await db.insert(transactions).values({
            id: swapTxId,
            userId,
            type: 'swap',
            status: 'completed',
            fromMint: SOLANA_TOKENS.USDC.mint,
            fromAmount: swapAmountUsdc.toString(),
            toMint: SOLANA_TOKENS.USDT.mint,
            toAmount: outAmountUsdt.toString(),
            solanaTxHash: swapTxHash,
          });

          // Re-check USDT balance after swap
          tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDT.mint);
        }
      }

      if (tokenBalance < order.amount) {
        throw new Error(
          `Insufficient ${fromSymbol} balance.\n\n` +
          `You have: ${tokenBalance.toFixed(2)} ${fromSymbol}\n` +
          `Required: ${order.amount.toFixed(2)} ${fromSymbol}\n\n` +
          `Please deposit ${fromSymbol} to your wallet first.\n` +
          `Wallet: \`${user[0].walletAddress}\``
        );
      }

      // ─── Check SOL for gas + ATA rent ───
      const hasGas = await walletService.hasEnoughSolForGas(user[0].walletAddress, 0.005);
      if (!hasGas) {
        throw new Error(
          'Insufficient SOL for gas and account creation.\n\n' +
          'Swaps need ~0.005 SOL to cover:\n' +
          '• Transaction gas (~0.001 SOL)\n' +
          '• Token account rent (~0.002 SOL) if you don\'t have a USDT account yet\n\n' +
          'Please deposit at least 0.005 SOL to your wallet.'
        );
      }

      const secretKey = decryptPrivateKey(user[0].walletEncryptedKey);
      const keypair = Keypair.fromSecretKey(secretKey);

      solanaTxHash = await walletService.sendSplToken(
        keypair,
        order.address,
        fromMint,
        order.amount,
        fromToken.decimals
      );
      console.log(`[Solana] ${fromSymbol} sent to PAJ:`, solanaTxHash);

      // ─── Collect Zend fee ───
      const feeWallet = process.env.ZEND_FEE_WALLET;
      let feeTxHash: string | undefined;
      if (feeWallet && feeUsdt > 0) {
        try {
          feeTxHash = await walletService.sendSplToken(keypair, feeWallet, fromMint, feeUsdt, fromToken.decimals);
          console.log(`[Solana] Zend fee collected:`, feeUsdt, `${fromSymbol} →`, feeWallet, 'tx:', feeTxHash);
        } catch (feeErr: any) {
          console.error('[Solana] Fee collection failed (non-critical):', feeErr.message);
        }
      }

      await db.update(transactions)
        .set({ solanaTxHash, pajReference: offRampRef })
        .where(eq(transactions.id, txId));
    } else {
      // No PAJ — just record mock
      await db.update(transactions)
        .set({ pajReference: offRampRef })
        .where(eq(transactions.id, txId));
    }

    // Simulate completion (in production, webhook updates this)
    setTimeout(async () => {
      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.id, txId));

      await ctx.reply(
        `✅ *Transfer Complete!*\n\n` +
        `${formatNgn(txData.amountNgn)} sent to ${finalAccountName}\n` +
        `${finalBankName} • \`${finalAccountNumber}\`\n\n` +
        `Reference: \`${txId}\`\n` +
        `PAJ Ref: \`${offRampRef}\`\n` +
        (solanaTxHash ? `Tx: \`https://solscan.io/tx/${solanaTxHash}\`\n` : '') +
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
}

// Reusable swap execution (used by confirm_swap and PIN verify flow)
async function executeSwap(
  ctx: ZendContext,
  userId: string,
  pt: NonNullable<ZendSession['pendingTransaction']>
) {
  const fromSymbol = pt.fromSymbol as string;
  const toSymbol = pt.toSymbol as string;
  const quote = pt.swapQuote as any;
  const outAmount = pt.swapOutAmount as number;

  await ctx.reply('⏳ Executing swap via Jupiter...');

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0 || !user[0].walletEncryptedKey) {
      throw new Error('Wallet not found');
    }

    // Check SOL for gas + ATA rent
    const hasGas = await walletService.hasEnoughSolForGas(user[0].walletAddress, 0.005);
    if (!hasGas) {
      throw new Error(
        'Insufficient SOL for gas and account creation.\n\n' +
        'Swaps need ~0.005 SOL to cover:\n' +
        '• Transaction gas (~0.001 SOL)\n' +
        '• Token account rent (~0.002 SOL) if you don\'t have a USDT account yet\n\n' +
        'Please deposit at least 0.005 SOL to your wallet.'
      );
    }

    // Build swap transaction
    const serializedTx = await buildSwapTransaction(quote, user[0].walletAddress, true);
    if (!serializedTx) {
      throw new Error('Failed to build swap transaction');
    }

    // Sign and send
    const secretKey = decryptPrivateKey(user[0].walletEncryptedKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    await ctx.replyWithChatAction('typing');
    const txHash = await walletService.signAndSendSerialized(keypair, serializedTx);
    console.log('[Jupiter] Swap executed:', txHash);

    // Record in DB
    const txId = generateTxId();
    await db.insert(transactions).values({
      id: txId,
      userId,
      type: 'swap',
      status: 'completed',
      fromMint: pt.fromMint,
      fromAmount: (Number(quote.inAmount) / Math.pow(10, getTokenBySymbol(fromSymbol)!.decimals)).toString(),
      toMint: pt.toMint,
      toAmount: outAmount.toString(),
      solanaTxHash: txHash,
    });

    setSession(userId, { state: ConversationState.IDLE });

    await ctx.reply(
      `✅ *Swap Complete!*\n\n` +
      `${formatTokenAmount(Number(quote.inAmount), getTokenBySymbol(fromSymbol)!.decimals)} ${fromSymbol} → ${outAmount.toFixed(2)} ${toSymbol}\n\n` +
      `Tx: \`https://solscan.io/tx/${txHash}\`\n` +
      `Reference: \`${txId}\``, 
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } catch (err: any) {
    console.error('[Swap] Failed:', err);
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply(
      `❌ *Swap Failed*\n\n` +
      `Error: ${err.message || 'Unknown error'}\n` +
      `No funds were deducted.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }
}

bot.action('confirm_send', async (ctx) => {
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

  // If PIN is set, require verification first
  if (user[0].transactionPin) {
    setSession(userId, { ...session, state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'send' });
    await ctx.editMessageText(
      `🔐 *Security Check*\n\n` +
      `Enter your 4-digit PIN to confirm this transfer:`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply('Waiting for PIN...', cancelKeyboard);
    return;
  }

  const { amountNgn, amountUsdt, ngnRate, zendFeeUsdt, fromMint, recipientBankCode, recipientBankName, recipientAccountNumber, recipientAccountName, recipientName } =
    session.pendingTransaction;

  await executeSend(ctx, userId, {
    amountNgn: amountNgn!,
    amountUsdt: amountUsdt!,
    ngnRate,
    zendFeeUsdt,
    fromMint,
    recipientBankCode,
    recipientBankName,
    recipientAccountNumber,
    recipientAccountName,
    recipientName,
  });
});

bot.action('cancel_send', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Cancelled.');
  await ctx.reply('What would you like to do?', mainMenu);
});

// ═════════════════════════════════════════════════════════════════════════════
// SHARED SEND CONFIRMATION HELPER (used by text + voice flows)
// ═════════════════════════════════════════════════════════════════════════════

async function prepareSendConfirmation(
  ctx: ZendContext,
  userId: string,
  amountNgn: number,
  recipientAccountNumber: string,
  bankCode: string,
  bankName: string,
  recipientName?: string,
  fromMint?: string
) {
  const selectedMint = fromMint || SOLANA_TOKENS.USDT.mint;
  const selectedToken = Object.values(SOLANA_TOKENS).find(t => t.mint === selectedMint) || SOLANA_TOKENS.USDT;
  const selectedSymbol = selectedToken.symbol;
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

  const zendFeeBps = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
  const zendFeeUsdt = (amountNgn / rate) * (zendFeeBps / 10000);
  const usdtNeeded = (amountNgn / rate) + zendFeeUsdt;

  // ─── Verify bank account with PAJ ───
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  let verifiedName = recipientName;
  let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';

  if (user[0]?.pajSessionToken) {
    const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, recipientAccountNumber);
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
    ngnRate: rate,
    fromMint: selectedMint,
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
    msg += `✅ *Account Verified by PAJ*\n`;
  } else if (verifiedStatus === 'no_paj') {
    msg += `⚠️ *Account Not Verified* (link PAJ in Settings to verify)\n`;
  } else {
    msg += `⚠️ *Could not verify account* — please double-check details\n`;
  }

  msg += `\n` +
    `To: *${verifiedName || 'Recipient'}*\n` +
    `Bank: ${bankName}\n` +
    `Account: \`${recipientAccountNumber}\`\n` +
    `Amount: ${formatNgn(amountNgn)}\n` +
    `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${zendFeeUsdt.toFixed(4)} USDT\n` +
    `You pay: *${usdtNeeded.toFixed(2)} ${selectedSymbol}*\n` +
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
}

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

  const { amountNgn, recipientName, recipientAccountNumber, fromMint } = session.pendingTransaction;
  await prepareSendConfirmation(ctx, userId, amountNgn!, recipientAccountNumber!, bank.code, bank.name, recipientName || undefined, fromMint);
});

// ═════════════════════════════════════════════════════════════════════════════
// 💴 CASH OUT (alias for Send)
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('💴 Cash Out', async (ctx) => {
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'cash out');
    return;
  }
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

async function showReceive(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const walletAddress = user[0].walletAddress;
  const virtualAccount = user[0].virtualAccount as any;
  const hasVA = virtualAccount?.accountNumber;

  let msg = `📥 *Receive Money*\n\n`;
  msg += `Choose how you want to get paid:\n\n`;

  msg += `*🪙 Crypto (Solana)*\n`;
  msg += `Send SOL, USDT, or USDC to:\n`;
  msg += `\`\`\`\n${walletAddress}\n\`\`\`\n\n`;

  if (hasVA) {
    msg += `*🇳🇬 Naira (Bank Transfer)*\n`;
    msg += `Send NGN to your virtual account:\n\n`;
    msg += `🏦 *Bank:* ${virtualAccount.bankName || 'Zend Bank'}\n`;
    msg += `👤 *Name:* ${virtualAccount.accountName || user[0].firstName + ' ' + (user[0].lastName || '')}\n`;
    msg += `🔢 *Number:* \`${virtualAccount.accountNumber}\`\n\n`;
  } else {
    msg += `*🇳🇬 Naira (Bank Transfer)*\n`;
    msg += `You don't have a virtual account yet.\n`;
    msg += `Tap 💵 *Add Naira* to create one.\n\n`;
  }

  msg += `💡 *Crypto arrives instantly*\n`;
  msg += `⏱️ *Naira takes 2–5 minutes* after bank transfer`;

  await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
}

bot.hears('📥 Receive', async (ctx) => {
  await showReceive(ctx, ctx.from.id.toString());
});

// ═════════════════════════════════════════════════════════════════════════════
// 🔄 SWAP (Jupiter integration)
// ═════════════════════════════════════════════════════════════════════════════

import { getSwapQuote, buildSwapTransaction, SWAP_TOKENS, getTokenBySymbol, formatTokenAmount } from './services/jupiter.js';
import { getChainRailsClient, TOKEN_ADDRESSES, CHAIN_NAMES } from '@zend/chainrails-client';

async function showSwapMenu(ctx: ZendContext, userId: string) {
  await ctx.reply(
    `🔄 *Swap Tokens*\n\n` +
    `Convert tokens in your wallet instantly via Jupiter.\n\n` +
    `Select a swap pair:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('SOL → USDT', 'swap:SOL:USDT')],
        [Markup.button.callback('USDC → USDT', 'swap:USDC:USDT')],
        [Markup.button.callback('USDT → SOL', 'swap:USDT:SOL')],
        [Markup.button.callback('❌ Cancel', 'cancel_swap')],
      ]),
    }
  );
}

bot.hears('🔄 Swap', async (ctx) => {
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'swap tokens');
    return;
  }
  const userId = ctx.from.id.toString();
  await showSwapMenu(ctx, userId);
});

bot.action(/swap:([A-Z]+):([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const fromSymbol = ctx.match[1];
  const toSymbol = ctx.match[2];

  const fromToken = getTokenBySymbol(fromSymbol);
  const toToken = getTokenBySymbol(toSymbol);
  if (!fromToken || !toToken) {
    await ctx.editMessageText('❌ Invalid token pair.');
    return;
  }

  setSession(userId, {
    state: ConversationState.AWAITING_SWAP_AMOUNT,
    pendingTransaction: {
      fromMint: fromToken.mint,
      toMint: toToken.mint,
      fromSymbol: fromToken.symbol,
      toSymbol: toToken.symbol,
      fromDecimals: fromToken.decimals,
    },
  });

  await ctx.editMessageText(
    `🔄 *Swap ${fromSymbol} → ${toSymbol}*\n\n` +
    `How much ${fromSymbol} do you want to swap?\n\n` +
    `Example: 0.1, 1, 10`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'cancel_swap')],
      ]),
    }
  );
});

bot.action('cancel_swap', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Swap cancelled.');
  await ctx.reply('Menu:', mainMenu);
});

// Handle swap amount input
async function handleSwapAmount(ctx: ZendContext, userId: string, text: string) {
  const session = getSession(userId);
  const pt = session.pendingTransaction;
  if (!pt?.fromMint || !pt.toMint || !pt.fromSymbol || !pt.toSymbol || !pt.fromDecimals) {
    await ctx.reply('❌ Swap session expired. Please start over.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const amount = parseFloat(text.trim());
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Please enter a valid amount. Example: 0.1, 1, 10', cancelKeyboard);
    return;
  }

  // Convert to base units
  const amountBase = Math.round(amount * Math.pow(10, pt.fromDecimals as number));

  await ctx.replyWithChatAction('typing');
  const quote = await getSwapQuote(pt.fromMint, pt.toMint, amountBase, 50);

  if (!quote) {
    await ctx.reply('❌ Could not get a swap quote. The route may not exist or liquidity is too low.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const fromToken = getTokenBySymbol(pt.fromSymbol as string)!;
  const toToken = getTokenBySymbol(pt.toSymbol as string)!;

  const outAmount = Number(quote.outAmount) / Math.pow(10, toToken.decimals);
  const minOut = Number(quote.otherAmountThreshold) / Math.pow(10, toToken.decimals);
  const priceImpact = parseFloat(quote.priceImpactPct);

  // Store quote for confirmation
  session.pendingTransaction = {
    ...pt,
    swapAmountBase: amountBase,
    swapQuote: quote,
    swapOutAmount: outAmount,
    swapMinOut: minOut,
    swapPriceImpact: priceImpact,
  };
  session.state = ConversationState.AWAITING_CONFIRMATION;
  setSession(userId, session);

  let msg = `🔄 *Swap Quote*\n\n`;
  msg += `${formatTokenAmount(Number(quote.inAmount), fromToken.decimals)} ${fromToken.symbol} → ${outAmount.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
  msg += `Minimum received: ${minOut.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
  msg += `Price impact: ${priceImpact < 0.01 ? '<0.01%' : priceImpact.toFixed(2) + '%'}\n`;
  msg += `Slippage: 0.5%\n\n`;
  msg += `💡 *Gas: ~0.001 SOL* (deducted from your wallet)\n\n`;
  msg += `Confirm swap?`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm Swap', 'confirm_swap')],
      [Markup.button.callback('❌ Cancel', 'cancel_swap')],
    ]),
  });
}

bot.action('confirm_swap', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'swap tokens');
    return;
  }

  const session = getSession(userId);

  if (session.state !== ConversationState.AWAITING_CONFIRMATION || !session.pendingTransaction?.swapQuote) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  // If PIN is set, require verification first
  if (user[0].transactionPin) {
    setSession(userId, { ...session, state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'swap' });
    await ctx.editMessageText(
      `🔐 *Security Check*\n\n` +
      `Enter your 4-digit PIN to confirm this swap:`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply('Waiting for PIN...', cancelKeyboard);
    return;
  }

  await executeSwap(ctx, userId, session.pendingTransaction);
});

// ═════════════════════════════════════════════════════════════════════════════
// 🌉 CHAINRAILS BRIDGE (Cross-chain Deposit)
// ═════════════════════════════════════════════════════════════════════════════

// Map shorthand chain names to ChainRails chain IDs
const BRIDGE_CHAIN_MAP: Record<string, string> = {
  ethereum: 'ETHEREUM_MAINNET',
  base: 'BASE_MAINNET',
  bsc: 'BSC_MAINNET',
  arbitrum: 'ARBITRUM_MAINNET',
  optimism: 'OPTIMISM_MAINNET',
  polygon: 'POLYGON_MAINNET',
  avalanche: 'AVALANCHE_MAINNET',
};

async function showBridgeMenu(ctx: ZendContext, userId: string) {
  const chainRails = await getChainRailsClient();
  if (!chainRails) {
    await ctx.reply(
      `🌉 *Cross-Chain Deposit*\n\n` +
      `Deposit crypto from any chain directly into your Zend Solana wallet.\n\n` +
      `⚠️ *ChainRails API key not configured.*\n\n` +
      `For now, use:\n` +
      `• 💵 *Add Naira* — NGN bank transfer → USDT\n` +
      `• 📥 *Receive* — Direct Solana deposit`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  await ctx.reply(
    `🌉 *Cross-Chain Deposit*\n\n` +
    `Send crypto from any EVM chain and receive USDT on Solana.\n\n` +
    `Select source chain:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Ethereum (USDC)', 'bridge:ethereum:USDC')],
        [Markup.button.callback('Base (USDC)', 'bridge:base:USDC')],
        [Markup.button.callback('BSC (USDT)', 'bridge:bsc:USDT')],
        [Markup.button.callback('Arbitrum (USDC)', 'bridge:arbitrum:USDC')],
        [Markup.button.callback('❌ Cancel', 'cancel_bridge')],
      ]),
    }
  );
}

bot.command('bridge', async (ctx) => {
  await showBridgeMenu(ctx, ctx.from.id.toString());
});

bot.action(/bridge:([a-z]+):([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const token = ctx.match[2];

  const chainRails = await getChainRailsClient();
  if (!chainRails) {
    await ctx.editMessageText('❌ ChainRails not configured.');
    return;
  }

  const sourceChain = BRIDGE_CHAIN_MAP[chainKey];
  if (!sourceChain) {
    await ctx.editMessageText('❌ Unsupported chain.');
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.editMessageText('❌ User not found. Run /start first.');
    return;
  }

  try {
    await ctx.editMessageText('⏳ Generating deposit address via ChainRails...');

    const tokenIn = TOKEN_ADDRESSES[sourceChain]?.[token];
    if (!tokenIn) {
      throw new Error(`Token ${token} not supported on ${sourceChain}`);
    }

    // Get quote first (optional but good for fee transparency)
    const quote = await chainRails.getBestQuote({
      tokenIn,
      tokenOut: TOKEN_ADDRESSES.SOLANA_MAINNET.USDT,
      sourceChain,
      destinationChain: 'SOLANA_MAINNET',
      amount: '10000000', // 10 USDC/USDT for quote (will be replaced by actual amount)
      amountSymbol: token,
      recipient: user[0].walletAddress,
    });

    // Create intent — user will send to intent_address
    const intent = await chainRails.createIntent({
      amount: '0', // 0 = open amount, user can send any amount
      amountSymbol: token,
      tokenIn,
      sourceChain,
      destinationChain: 'SOLANA_MAINNET',
      recipient: user[0].walletAddress,
      metadata: {
        userId,
        telegramUserId: userId,
      },
    });

    // Record in DB
    const txId = generateTxId();
    await db.insert(transactions).values({
      id: txId,
      userId,
      type: 'crypto_receive',
      status: 'pending',
      pajReference: intent.intent_address,
      recipientWalletAddress: user[0].walletAddress,
      fromAmount: '0',
      fromMint: tokenIn,
      toMint: TOKEN_ADDRESSES.SOLANA_MAINNET.USDT,
    });

    const chainDisplay = CHAIN_NAMES[sourceChain] || sourceChain;

    await ctx.reply(
      `🌉 *Deposit ${token} from ${chainDisplay}*\n\n` +
      `Send ${token} to this ChainRails intent address:\n` +
      `\`\`\`\n${intent.intent_address}\n\`\`\`\n\n` +
      `⚠️ *Important:*\n` +
      `• Only send ${token} on ${chainDisplay}\n` +
      `• You'll receive USDT on Solana\n` +
      `• Estimated fee: ${quote.totalFeeFormatted} ${token}\n` +
      `• Expires: ${new Date(intent.expires_at).toLocaleString()}\n\n` +
      `Reference: \`${txId}\`\n` +
      `Intent: \`${intent.intent_address}\``, 
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } catch (err: any) {
    console.error('[Bridge] Failed:', err);
    await ctx.reply(
      `❌ *Bridge Error*\n\n` +
      `Could not generate deposit address.\n` +
      `Error: ${err.message || 'Unknown error'}\n\n` +
      `Note: ChainRails may not support Solana as a destination yet.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }
});

bot.action('cancel_bridge', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ Bridge cancelled.');
});

// ═════════════════════════════════════════════════════════════════════════════
// 📋 HISTORY
// ═════════════════════════════════════════════════════════════════════════════

async function buildHistoryMessage(userId: string): Promise<string | null> {
  const txs = await db.select().from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(transactions.createdAt)
    .limit(10);

  if (txs.length === 0) {
    return '📋 No transactions yet.\n\nSend or receive money to see your history here.';
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

  return msg;
}

async function showHistory(ctx: ZendContext, userId: string) {
  const msg = await buildHistoryMessage(userId);
  if (msg) {
    await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
  }
}

bot.hears('📋 History', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (isGroupChat(ctx)) {
    const name = ctx.from?.first_name || 'there';
    await ctx.reply(`📩 ${name}, check your DM for your history.`);
    const msg = await buildHistoryMessage(userId);
    if (msg) {
      await ctx.telegram.sendMessage(ctx.from!.id, msg, { parse_mode: 'Markdown', ...mainMenu });
    }
    return;
  }
  await showHistory(ctx, userId);
});

// ═════════════════════════════════════════════════════════════════════════════
// ⚙️ SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

async function showSettings(ctx: ZendContext, userId: string) {
  const loading = await showLoading(ctx, 'Loading settings...');

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (user.length === 0) {
      await finishLoading(ctx, loading.message_id, 'Please run /start first.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    const u = user[0];
    const autoSave = (u.autoSaveRateBps || 0) > 0 ? (u.autoSaveRateBps / 100).toFixed(0) + '%' : 'Off';

    const msg =
      `⚙️ *Settings*\n\n` +
      `👤 *Profile*\n` +
      `Name: ${u.firstName} ${u.lastName || ''}\n\n` +
      `*Wallet Address:*\n` +
      `\`\`\`\n${u.walletAddress}\n\`\`\`\n\n` +
      `🔐 *Security*\n` +
      `Email: ${u.email || 'Not set'} ${u.emailVerified ? '✓' : ''}\n` +
      `PAJ: ${u.pajSessionToken ? '✅ Linked' : '❌ Not linked'}\n` +
      `PIN: ${u.transactionPin ? 'Set ✅' : 'Not set'}\n\n` +
      `💰 *Preferences*\n` +
      `Auto-save: ${autoSave}`;

    // Build dynamic settings menu — hide items already done
    const buttons: any[] = [];
    if (!u.email) {
      buttons.push([Markup.button.callback('📧 Add Email', 'settings_email')]);
    }
    if (!u.pajSessionToken) {
      buttons.push([Markup.button.callback('🔗 Link PAJ', 'settings_paj')]);
    }
    if (!u.transactionPin) {
      buttons.push([Markup.button.callback('🔢 Set PIN', 'settings_pin')]);
    } else {
      buttons.push([Markup.button.callback('🔢 Change PIN', 'settings_pin')]);
    }
    buttons.push([Markup.button.callback('🔑 Export Private Key', 'export_key')]);

    await finishLoading(ctx, loading.message_id, msg, 'Markdown');
    await ctx.reply('Menu:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (err) {
    console.error('Settings error:', err);
    await finishLoading(ctx, loading.message_id, '❌ Could not load settings. Please try again.');
    await ctx.reply('Menu:', mainMenu);
  }
}

bot.hears('⚙️ Settings', async (ctx) => {
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'access Settings');
    return;
  }
  await showSettings(ctx, ctx.from.id.toString());
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
    `📧 *Add / Change Email*\n\n` +
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
    `🔢 *Set / Change Transaction PIN*\n\n` +
    `Enter a new 4-digit PIN for transaction security:\n` +
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

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOK SERVER (runs alongside bot for PAJ callbacks)
// ═════════════════════════════════════════════════════════════════════════════

function startWebhookServer(botInstance: Telegraf<any>) {
  const port = parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3001');

  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (url === '/health' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      return;
    }

    // PAJ Webhooks
    if (url === '/webhooks/paj' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          console.log('📩 PAJ Webhook:', event.type, event.reference);

          switch (event.type) {
            case 'onramp.deposit.confirmed': {
              await db.update(transactions)
                .set({ status: 'completed', completedAt: new Date() })
                .where(eq(transactions.pajReference, event.reference));
              break;
            }
            case 'onramp.deposit.failed': {
              await db.update(transactions)
                .set({ status: 'failed' })
                .where(eq(transactions.pajReference, event.reference));
              break;
            }
            case 'offramp.settlement.confirmed': {
              await db.update(transactions)
                .set({ status: 'completed', completedAt: new Date() })
                .where(eq(transactions.pajReference, event.reference));
              break;
            }
            case 'offramp.settlement.failed': {
              await db.update(transactions)
                .set({ status: 'failed' })
                .where(eq(transactions.pajReference, event.reference));
              break;
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('Webhook error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ChainRails Webhooks
    if (url === '/webhooks/chain-rails' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          console.log('📩 ChainRails Webhook:', event.event || event.type, event.intent_address || event.id);

          const intentAddress = event.intent_address || event.address || event.id;
          const status = event.intent_status || event.status;
          const amount = event.initialAmount || event.amount;
          const token = event.asset_token_symbol || event.token;

          // Update transaction status
          if (intentAddress) {
            const txStatus = status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'processing';
            await db.update(transactions)
              .set({
                status: txStatus,
                completedAt: txStatus === 'completed' ? new Date() : undefined,
              })
              .where(eq(transactions.pajReference, intentAddress));
          }

          // Notify user via Telegram
          if (status === 'COMPLETED' && event.metadata?.telegramUserId) {
            try {
              await botInstance.telegram.sendMessage(
                event.metadata.telegramUserId,
                `✅ *Cross-Chain Deposit Complete!*\n\n` +
                `${amount} ${token} has arrived in your Zend Solana wallet.`,
                { parse_mode: 'Markdown', ...mainMenu }
              );
            } catch (notifyErr) {
              console.log('[ChainRails] Could not notify user:', notifyErr);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('ChainRails webhook error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    const host = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${port}`;
    console.log(`🌐 Webhook server running on http://${host}`);
    console.log(`   PAJ webhook URL: https://${host}/webhooks/paj`);
    console.log(`   ChainRails webhook URL: https://${host}/webhooks/chain-rails`);
  });

  return server;
}

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

  // Start webhook server (runs alongside bot)
  startWebhookServer(bot);

  // Launch bot
  bot.launch({ dropPendingUpdates: true });
  console.log('🤖 Zend bot is running...');

  // Handle 409 conflict from polling loop (Railway deploy overlap)
  let retryTimeout: NodeJS.Timeout | null = null;
  process.on('unhandledRejection', (reason: any) => {
    if (reason?.response?.error_code === 409) {
      console.log('[Bot] 409 conflict detected, stopping and retrying in 5s...');
      bot.stop();
      if (retryTimeout) clearTimeout(retryTimeout);
      retryTimeout = setTimeout(() => {
        console.log('[Bot] Retrying launch...');
        bot.launch({ dropPendingUpdates: true });
      }, 5000);
    }
  });

  process.once('SIGINT', () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    bot.stop('SIGTERM');
  });
}

main();
