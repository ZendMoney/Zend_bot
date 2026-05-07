// ─── Load .env FIRST — before any imports that need env vars ───
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { Telegraf, Markup, Context } from 'telegraf';
import { Keypair, PublicKey } from '@solana/web3.js';
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
  pinVerifyAction?: 'send' | 'swap' | 'export' | 'schedule';
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
  scheduleData?: {
    recipientBankAccountId?: number;
    recipientName?: string;
    bankName?: string;
    accountNumber?: string;
    amountNgn?: number;
    frequency?: 'once' | 'daily' | 'weekly' | 'monthly';
    startAt?: Date;
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

const MIN_SOL_FOR_GAS = 0.0005; // ~0.00008 base fee + buffer for bundled tx
const GAS_SPONSORSHIP_FEE_BPS = 50; // 0.5% extra for gasless users

/** Fund SOL from dev wallet if user has insufficient balance. Returns true if funded. */
async function fundSolIfNeeded(walletAddress: string): Promise<boolean> {
  const hasGas = await walletService.hasEnoughSolForGas(walletAddress, MIN_SOL_FOR_GAS);
  if (hasGas) return false;

  const devSecret = process.env.ZEND_DEV_WALLET_SECRET;
  if (!devSecret) {
    console.warn('[Gas] No ZEND_DEV_WALLET_SECRET set — cannot fund SOL');
    return false;
  }

  try {
    const devKeypair = Keypair.fromSecretKey(bs58.decode(devSecret));
    await walletService.sendSol(devKeypair, walletAddress, MIN_SOL_FOR_GAS);
    console.log('[Gas] Funded', MIN_SOL_FOR_GAS, 'SOL from dev wallet to', walletAddress);
    return true;
  } catch (err: any) {
    console.error('[Gas] Failed to fund SOL:', err.message);
    return false;
  }
}

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
  ['🌉 Bridge', '📅 Schedule'],
  ['📋 History', '⚙️ Settings'],
  ['🌐 Community'],
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

// ─── Strip reply keyboards in groups (keep inline keyboards) ───
bot.use(async (ctx, next) => {
  if (isGroupChat(ctx)) {
    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = async (text: any, extra?: any) => {
      if (extra && extra.reply_markup && 'keyboard' in extra.reply_markup) {
        const { reply_markup, ...cleaned } = extra;
        return originalReply(text, cleaned);
      }
      return originalReply(text, extra);
    };
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
  const menuButtons = ['💰 Balance', '💵 Add Naira', '📤 Send', '💴 Cash Out', '📥 Receive', '🔄 Swap', '📅 Schedule', '📋 History', '⚙️ Settings', '🌐 Community'];
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
          await ctx.reply(reply?.reply || 'How much do you want to send?', { parse_mode: 'Markdown', ...cancelKeyboard });
          setSession(userId, { state: ConversationState.AWAITING_SEND_AMOUNT, pendingTransaction: { recipientName: parsed.recipientName } });
          return;
        }
        if (parsed.amount < 100) {
          const reply = await chatWithKimi(
            `The user wants to send ${parsed.amount} Naira. Minimum is ₦100. ` +
            `Respond in Nigerian Pidgin style telling them the minimum.`
          );
          await ctx.reply(reply?.reply || `Minimum send amount is ${formatNgn(100)}.`, cancelKeyboard);
          return;
        }
        if (!parsed.accountNumber && !parsed.walletAddress) {
          // We have amount + recipient name but missing bank/account
          const reply = await chatWithKimi(
            `The user said: "${text}". I understood they want to send ${formatNgn(parsed.amount)} to ${parsed.recipientName || 'someone'}. ` +
            `But I need the bank name and account number. Respond conversationally in Nigerian Pidgin style.`
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

      case 'bridge': {
        await showBridgeMenu(ctx, userId);
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
    } else if (action === 'schedule') {
      const sd = session.scheduleData;
      if (!sd || !sd.startAt) {
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      await saveScheduledTransfer(userId, sd, sd.startAt);
      await ctx.reply(
        `✅ *Scheduled Transfer Created!*\n\n` +
        `To: ${sd.recipientName}\n` +
        `Bank: ${sd.bankName}\n` +
        `Account: \`${sd.accountNumber}\`\n` +
        `Amount: ${formatNgn(sd.amountNgn!)}\n` +
        `Frequency: ${sd.frequency}\n` +
        `Starts: ${sd.startAt.toLocaleDateString('en-NG')}\n\n` +
        `Use *📅 Schedule* to view or cancel.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } else {
      await ctx.reply('✅ PIN verified.', mainMenu);
    }
    return;
  }

  // ─── SCHEDULE: AWAITING_SCHEDULE_RECIPIENT ───
  if (session.state === ConversationState.AWAITING_SCHEDULE_RECIPIENT) {
    // User should have clicked an inline button — text input here is unexpected
    await ctx.reply('❌ Please select a recipient from the buttons above.', cancelKeyboard);
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
    // User should have clicked a frequency button
    await ctx.reply('❌ Please select a frequency from the buttons above.', cancelKeyboard);
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
      setSession(userId, { ...session, state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'schedule' });
      await ctx.reply(
        `🔐 *Security Check*\n\n` +
        `Enter your 4-digit PIN to confirm this scheduled transfer:`,
        cancelKeyboard
      );
      return;
    }

    // No PIN — save directly
    await saveScheduledTransfer(userId, sd, startAt);
    setSession(userId, { state: ConversationState.IDLE });

    await ctx.reply(
      `✅ *Scheduled Transfer Created!*\n\n` +
      `To: ${sd.recipientName}\n` +
      `Bank: ${sd.bankName}\n` +
      `Account: \`${sd.accountNumber}\`\n` +
      `Amount: ${formatNgn(sd.amountNgn!)}\n` +
      `Frequency: ${sd.frequency}\n` +
      `Starts: ${startAt.toLocaleDateString('en-NG')}\n\n` +
      `Use *📅 Schedule* to view or cancel.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }
});

// Helper to save scheduled transfer
async function saveScheduledTransfer(userId: string, sd: NonNullable<ZendSession['scheduleData']>, startAt: Date) {
  let nextRunAt = new Date(startAt);
  const freq = sd.frequency!;
  if (freq === 'daily') nextRunAt.setDate(nextRunAt.getDate() + 1);
  else if (freq === 'weekly') nextRunAt.setDate(nextRunAt.getDate() + 7);
  else if (freq === 'monthly') nextRunAt.setMonth(nextRunAt.getMonth() + 1);

  await db.insert(scheduledTransfers).values({
    userId,
    recipientBankAccountId: sd.recipientBankAccountId!,
    amountNgn: sd.amountNgn!.toString(),
    frequency: freq,
    startAt,
    nextRunAt,
    isActive: true,
  });
}

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

// Core send logic — no Telegram UI (used by executeSend and scheduled executor)
async function executeSendCore(
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
): Promise<{ success: boolean; txId: string; solanaTxHash?: string; offRampRef?: string; error?: string }> {
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

  let offRampRef = 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  let solanaTxHash: string | undefined;

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0 || !user[0].walletEncryptedKey) {
      throw new Error('User wallet not found');
    }

    const pajClient = await getPAJClient();
    if (pajClient && user[0].pajSessionToken) {
      const pajBanks = await getPajBankList(user[0].pajSessionToken);
      const ourBank = NIGERIAN_BANKS.find(b => b.code === finalBankCode);
      const pajBank = pajBanks.find(pb =>
        pb.name.toLowerCase().includes(ourBank?.name.toLowerCase() || '') ||
        (ourBank?.name.toLowerCase() || '').includes(pb.name.toLowerCase())
      );
      if (!pajBank) {
        throw new Error(`Bank "${ourBank?.name}" not found on PAJ`);
      }

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

      let tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, fromMint);

      // Auto-swap USDC → USDT if needed
      if (fromMint === SOLANA_TOKENS.USDT.mint && tokenBalance < order.amount) {
        const usdcBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDC.mint);
        if (usdcBalance >= order.amount) {
          const swapAmountUsdc = Math.min(usdcBalance, order.amount * 1.03);
          const swapAmountBase = Math.round(swapAmountUsdc * Math.pow(10, SOLANA_TOKENS.USDC.decimals));
          const quote = await getSwapQuote(SOLANA_TOKENS.USDC.mint, SOLANA_TOKENS.USDT.mint, swapAmountBase, 100);
          if (!quote) {
            throw new Error('Swap route unavailable. Please deposit USDT.');
          }
          const outAmountUsdt = Number(quote.outAmount) / Math.pow(10, SOLANA_TOKENS.USDT.decimals);
          if (outAmountUsdt < order.amount) {
            throw new Error(`Swap would only give ${outAmountUsdt.toFixed(2)} USDT. Deposit more.`);
          }
          const serializedTx = await buildSwapTransaction(quote, user[0].walletAddress, true);
          if (!serializedTx) throw new Error('Failed to build swap transaction.');
          const secretKey = decryptPrivateKey(user[0].walletEncryptedKey);
          const keypair = Keypair.fromSecretKey(secretKey);
          const swapTxHash = await walletService.signAndSendSerialized(keypair, serializedTx);
          console.log('[Jupiter] Auto-swap USDC→USDT:', swapTxHash);
          const swapTxId = generateTxId();
          await db.insert(transactions).values({
            id: swapTxId, userId, type: 'swap', status: 'completed',
            fromMint: SOLANA_TOKENS.USDC.mint, fromAmount: swapAmountUsdc.toString(),
            toMint: SOLANA_TOKENS.USDT.mint, toAmount: outAmountUsdt.toString(),
            solanaTxHash: swapTxHash,
          });
          tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDT.mint);
        }
      }

      if (tokenBalance < order.amount) {
        throw new Error(`Insufficient ${fromSymbol} balance. You have: ${tokenBalance.toFixed(2)}, need: ${order.amount.toFixed(2)}`);
      }

      // Gas sponsorship: fund SOL if user has none
      const gasSponsored = await fundSolIfNeeded(user[0].walletAddress);
      if (!gasSponsored) {
        const hasGas = await walletService.hasEnoughSolForGas(user[0].walletAddress, MIN_SOL_FOR_GAS);
        if (!hasGas) {
          throw new Error(`Insufficient SOL for gas. Please deposit at least ${MIN_SOL_FOR_GAS} SOL.`);
        }
      }

      // Calculate total fee (Zend fee + gas sponsorship if applicable)
      const feeWallet = process.env.ZEND_FEE_WALLET;
      let totalFeeUsdt = feeUsdt;
      if (gasSponsored) {
        const sponsorshipFee = txData.amountUsdt * (GAS_SPONSORSHIP_FEE_BPS / 10000); // 0.5% of amount
        totalFeeUsdt += sponsorshipFee;
        console.log('[Gas] Sponsorship fee added:', sponsorshipFee.toFixed(6), 'USDT. Total fee:', totalFeeUsdt.toFixed(6));
      }

      // Build fee transfer instructions to bundle with main send
      const feeInstructions: any[] = [];
      if (feeWallet && totalFeeUsdt > 0) {
        const mintPubkey = new PublicKey(fromMint);
        const feeWalletPubkey = new PublicKey(feeWallet);
        const senderTokenAccount = await getAssociatedTokenAddress(mintPubkey, new PublicKey(user[0].walletAddress));
        const feeTokenAccount = await getAssociatedTokenAddress(mintPubkey, feeWalletPubkey);
        const rawFeeAmount = BigInt(Math.round(totalFeeUsdt * Math.pow(10, fromToken.decimals)));

        feeInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            new PublicKey(user[0].walletAddress),
            feeTokenAccount,
            feeWalletPubkey,
            mintPubkey
          ),
          createTransferInstruction(
            senderTokenAccount,
            feeTokenAccount,
            new PublicKey(user[0].walletAddress),
            rawFeeAmount
          )
        );
      }

      const secretKey = decryptPrivateKey(user[0].walletEncryptedKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      solanaTxHash = await walletService.sendSplToken(
        keypair, order.address, fromMint, order.amount, fromToken.decimals,
        feeInstructions.length > 0 ? feeInstructions : undefined
      );
      console.log(`[Solana] ${fromSymbol} sent to PAJ (+ fee bundled):`, solanaTxHash);

      await db.update(transactions)
        .set({ solanaTxHash, pajReference: offRampRef })
        .where(eq(transactions.id, txId));
    } else {
      await db.update(transactions)
        .set({ pajReference: offRampRef })
        .where(eq(transactions.id, txId));
    }

    setTimeout(async () => {
      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.id, txId));
    }, 3000);

    return { success: true, txId, solanaTxHash, offRampRef };
  } catch (err: any) {
    console.error('Off-ramp failed:', err);
    await db.update(transactions)
      .set({ status: 'failed' })
      .where(eq(transactions.id, txId));
    return { success: false, txId, error: err.message || 'Unknown error' };
  }
}

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
  const fromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === (txData.fromMint || SOLANA_TOKENS.USDT.mint)) || SOLANA_TOKENS.USDT;
  const processingText =
    `⏳ *Processing...*\n\n` +
    `Sending ${txData.amountUsdt.toFixed(2)} ${fromToken.symbol}\n` +
    `Estimated: 1-5 minutes`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(processingText, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(processingText, { parse_mode: 'Markdown' });
  }

  setSession(userId, { state: ConversationState.IDLE });
  const result = await executeSendCore(userId, txData);

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
        `Reference: \`${txId}\`\n` +
        `PAJ Ref: \`${offRampRef}\`\n` +
        (solanaTxHash ? `Tx: \`https://solscan.io/tx/${solanaTxHash}\`\n` : '') +
        `Time: ~2 minutes`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      // Check milestones after successful transfer
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

    // Gas sponsorship for swaps
    const gasSponsored = await fundSolIfNeeded(user[0].walletAddress);
    if (!gasSponsored) {
      const hasGas = await walletService.hasEnoughSolForGas(user[0].walletAddress, MIN_SOL_FOR_GAS);
      if (!hasGas) {
        throw new Error(
          `Insufficient SOL for gas. Swaps need ~${MIN_SOL_FOR_GAS} SOL.\n\n` +
          `Please deposit SOL or we can fund it (+0.5% fee).`
        );
      }
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

    // Collect gas sponsorship fee for swaps (0.5% of output value)
    if (gasSponsored) {
      const feeWallet = process.env.ZEND_FEE_WALLET;
      if (feeWallet) {
        try {
          const sponsorshipFee = outAmount * (GAS_SPONSORSHIP_FEE_BPS / 10000);
          const feeTokenMint = pt.toMint as string;
          const feeTokenDecimals = getTokenBySymbol(toSymbol)?.decimals || 6;
          await walletService.sendSplToken(keypair, feeWallet, feeTokenMint, sponsorshipFee, feeTokenDecimals);
          console.log('[Gas] Swap sponsorship fee collected:', sponsorshipFee.toFixed(6), toSymbol);
        } catch (feeErr: any) {
          console.error('[Gas] Swap fee collection failed (non-critical):', feeErr.message);
        }
      }
    }

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

  msg += `\n*🌉 Cross-Chain (Any Chain)*\n`;
  msg += `Send from Ethereum, Base, BSC, Arbitrum → get USDT on Solana.\n`;
  msg += `Tap *🌉 Bridge* to start.\n\n`;

  msg += `💡 *Crypto arrives instantly*\n`;
  msg += `⏱️ *Naira takes 2–5 minutes* after bank transfer`;

  await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
}

bot.hears('📥 Receive', async (ctx) => {
  await showReceive(ctx, ctx.from.id.toString());
});

bot.hears('🌉 Bridge', async (ctx) => {
  await showBridgeMenu(ctx, ctx.from.id.toString());
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

// ═════════════════════════════════════════════════════════════════════════════
// 📅 SCHEDULED TRANSFERS
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('📅 Schedule', async (ctx) => {
  const userId = ctx.from.id.toString();
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

  if (accounts.length === 0) {
    await ctx.reply(
      `📅 *Scheduled Transfers*\n\n` +
      `You don't have any saved bank accounts yet.\n\n` +
      `Send money to a bank account first and I'll save it for scheduling.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  // Show saved accounts + option to view existing schedules
  const rows: any[] = accounts.map(acc =>
    [Markup.button.callback(`${acc.bankName} • ${acc.accountNumber}`, `schedule_recipient:${acc.id}`)]
  );
  rows.push([Markup.button.callback('📋 View My Schedules', 'schedule_view')]);

  await ctx.reply(
    `📅 *Schedule Transfer*\n\n` +
    `Select a saved recipient:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
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
    `Recipient: ${acc.accountName}\n` +
    `Bank: ${acc.bankName}\n` +
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
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  const schedules = await db.select().from(scheduledTransfers)
    .where(eq(scheduledTransfers.userId, userId))
    .orderBy(scheduledTransfers.nextRunAt);

  if (schedules.length === 0) {
    await ctx.editMessageText('📅 You have no scheduled transfers.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  let msg = `📅 *Your Scheduled Transfers*\n\n`;
  const rows: any[] = [];

  for (const s of schedules) {
    const status = s.isActive ? '🟢 Active' : '🔴 Paused';
    const next = s.nextRunAt ? s.nextRunAt.toLocaleDateString('en-NG') : '—';
    msg += `${status} • ${formatNgn(Number(s.amountNgn))} • ${s.frequency}\n`;
    msg += `   Next: ${next}  •  Runs: ${s.runCount}\n\n`;
    if (s.isActive) {
      rows.push([Markup.button.callback(`❌ Cancel #${s.id}`, `schedule_cancel:${s.id}`)]);
    }
  }

  await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  if (rows.length > 0) {
    await ctx.reply('Tap to cancel:', Markup.inlineKeyboard(rows));
  }
  await ctx.reply('Menu:', mainMenu);
});

bot.action(/schedule_cancel:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const scheduleId = parseInt(ctx.match[1], 10);

  await db.update(scheduledTransfers)
    .set({ isActive: false })
    .where(and(eq(scheduledTransfers.id, scheduleId), eq(scheduledTransfers.userId, userId)));

  await ctx.editMessageText(`✅ Scheduled transfer #${scheduleId} has been cancelled.`);
  await ctx.reply('Menu:', mainMenu);
});

// ═════════════════════════════════════════════════════════════════════════════
// 🌉 CHAINRAILS BRIDGE (Cross-chain Deposit)
// ═════════════════════════════════════════════════════════════════════════════

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
  const chainRails = getChainRailsClient();
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

  const chainRails = getChainRailsClient();
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

    // Get quote first for fee transparency (use 1 unit for estimate)
    let quote: any = null;
    try {
      quote = await chainRails.getBestQuote({
        tokenIn,
        tokenOut: TOKEN_ADDRESSES.SOLANA_MAINNET.USDT,
        sourceChain,
        destinationChain: 'SOLANA_MAINNET',
        amount: '1000000',
        amountSymbol: token,
        recipient: user[0].walletAddress,
      });
    } catch (quoteErr: any) {
      console.log('[Bridge] Quote failed (non-critical):', quoteErr.message);
    }

    // Create intent — user will send to intent_address
    const intentAmount = '1000000'; // 1 unit in token base decimals (consistent with quote)
    console.log('[Bridge] Creating intent:', { sourceChain, token, amount: intentAmount, recipient: user[0].walletAddress });
    const intent = await chainRails.createIntent({
      amount: intentAmount,
      amountSymbol: token,
      tokenIn,
      sourceChain,
      destinationChain: 'SOLANA_MAINNET',
      recipient: user[0].walletAddress,
      metadata: {
        userId,
        telegramUserId: userId,
        sourceChain,
        token,
      },
    });

    // Record in DB
    const txId = generateTxId();
    await db.insert(transactions).values({
      id: txId,
      userId,
      type: 'crypto_receive',
      status: 'pending',
      chainrailsIntentAddress: intent.intent_address,
      recipientWalletAddress: user[0].walletAddress,
      fromAmount: '0',
      fromMint: tokenIn,
      toMint: TOKEN_ADDRESSES.SOLANA_MAINNET.USDT,
    });

    const chainDisplay = CHAIN_NAMES[sourceChain] || sourceChain;
    const feeLine = quote ? `• Estimated fee: ${quote.totalFeeFormatted} ${token}\n` : '';

    await ctx.reply(
      `🌉 *Deposit ${token} from ${chainDisplay}*\n\n` +
      `Send ${token} to this ChainRails intent address:\n` +
      `\`\`\`\n${intent.intent_address}\n\`\`\`\n\n` +
      `⚠️ *Important:*\n` +
      `• Only send ${token} on ${chainDisplay}\n` +
      `• You'll receive USDT on Solana\n` +
      feeLine +
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
      `Please try again later or contact support.`,
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
    .orderBy(sql`${transactions.createdAt} desc`)
    .limit(10);

  if (txs.length === 0) {
    return '📋 *No transactions yet*\n\nSend or receive money to see your history here.';
  }

  // Get user stats
  const allTxs = await db.select().from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));
  const totalSent = allTxs.filter(t => t.type === 'ngn_send').reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
  const totalCount = allTxs.length;

  let msg = `📋 *Transaction History*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 Total Sent: ${formatNgn(totalSent)}  •  📊 ${totalCount} txs\n\n`;

  for (const tx of txs) {
    const statusEmoji = tx.status === 'completed' ? '✅' : tx.status === 'processing' ? '⏳' : tx.status === 'pending' ? '🕐' : '❌';
    const typeEmoji = tx.type === 'ngn_send' ? '📤' : tx.type === 'ngn_receive' ? '📥' : tx.type === 'swap' ? '🔄' : tx.type === 'scheduled' ? '📅' : '💱';
    const typeLabel = tx.type === 'ngn_send' ? 'Send' : tx.type === 'ngn_receive' ? 'Deposit' : tx.type === 'swap' ? 'Swap' : tx.type === 'scheduled' ? 'Scheduled' : tx.type;

    const amountLine = tx.ngnAmount
      ? `${formatNgn(Number(tx.ngnAmount))}`
      : tx.fromAmount && tx.fromMint
        ? `${Number(tx.fromAmount).toFixed(2)} ${tx.fromMint === SOLANA_TOKENS.USDT.mint ? 'USDT' : tx.fromMint === SOLANA_TOKENS.USDC.mint ? 'USDC' : 'SOL'}`
        : '';

    const date = tx.createdAt.toLocaleDateString('en-NG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    msg += `${typeEmoji} *${typeLabel}*  ${statusEmoji}\n`;
    msg += `💵 ${amountLine}\n`;

    if (tx.recipientBankName || tx.recipientAccountName) {
      msg += `👤 ${tx.recipientAccountName || 'Recipient'} · ${tx.recipientBankName || ''}\n`;
      if (tx.recipientAccountNumber) {
        msg += `🔢 \`${tx.recipientAccountNumber}\`\n`;
      }
    }
    if (tx.solanaTxHash) {
      msg += `🔗 [View on Solscan](https://solscan.io/tx/${tx.solanaTxHash})\n`;
    }
    msg += `🆔 \`${tx.id}\` · ${date}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
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
// 🌐 COMMUNITY
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('🌐 Community', async (ctx) => {
  await ctx.reply(
    `🌐 *Zend Community*\n\n` +
    `Join our community for support, feedback, and updates:\n\n` +
    `👉 [Zend Community](https://t.me/zend_community)`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, ...mainMenu }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 🧹 CLEAR CHAT
// ═════════════════════════════════════════════════════════════════════════════

bot.command('clear', async (ctx) => {
  const chatId = ctx.chat.id;
  const currentMsgId = ctx.message?.message_id;

  if (!currentMsgId) {
    await ctx.reply('❌ Could not clear chat.', mainMenu);
    return;
  }

  const statusMsg = await ctx.reply('🧹 Clearing recent bot messages...');

  let deleted = 0;
  // Try deleting the last 15 messages before the current one
  for (let offset = 1; offset <= 15; offset++) {
    try {
      const msgId = currentMsgId - offset;
      if (msgId <= 0) break;
      await ctx.telegram.deleteMessage(chatId, msgId);
      deleted++;
    } catch (e) {
      // Message not from bot, too old, or already deleted — continue
    }
  }

  // Delete the status message too
  try {
    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id);
  } catch (e) { /* ignore */ }

  // Delete the /clear command itself
  try {
    await ctx.telegram.deleteMessage(chatId, currentMsgId);
  } catch (e) { /* ignore */ }

  const confirmMsg = await ctx.reply(`✅ Cleared ${deleted} messages.`, mainMenu);
  // Auto-delete confirmation after 3 seconds
  setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(chatId, confirmMsg.message_id);
    } catch (e) { /* ignore */ }
  }, 3000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 📊 STATS
// ═════════════════════════════════════════════════════════════════════════════

bot.command('stats', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    // Personal stats
    const userTxs = await db.select().from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));
    const sendTxs = userTxs.filter(t => t.type === 'ngn_send');
    const swapTxs = userTxs.filter(t => t.type === 'swap');
    const schedTxs = userTxs.filter(t => t.type === 'scheduled');
    const totalNgn = sendTxs.reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
    const totalSwaps = swapTxs.length + schedTxs.length;

    // Platform stats
    const allTxs = await db.select().from(transactions).where(eq(transactions.status, 'completed'));
    const platformSends = allTxs.filter(t => t.type === 'ngn_send');
    const platformNgn = platformSends.reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
    const userCount = (await db.select().from(users)).length;

    await ctx.reply(
      `📊 *Your Stats*\n\n` +
      `💰 Total Sent: ${formatNgn(totalNgn)}\n` +
      `📤 Transfers: ${sendTxs.length}\n` +
      `🔄 Swaps: ${totalSwaps}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *Platform Stats*\n\n` +
      `👥 Users: ${userCount}\n` +
      `💰 Total Volume: ${formatNgn(platformNgn)}\n` +
      `📤 Total Transfers: ${platformSends.length}`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } catch (err) {
    console.error('Stats error:', err);
    await ctx.reply('❌ Could not fetch stats. Please try again.', mainMenu);
  }
});

// ─── Auto-delete helper for sensitive messages ───
async function autoDeleteReply(ctx: ZendContext, text: string, extra?: any, delayMs = 120000) {
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

// ─── Milestone tracking ───
const MILESTONE_AMOUNTS = [10000, 50000, 100000, 500000, 1000000, 5000000, 10000000];
const MILESTONE_COUNTS = [1, 5, 10, 25, 50, 100];

async function checkMilestones(userId: string, notifyFn: (text: string) => Promise<any>) {
  try {
    const completed = await db.select().from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));

    const sendTxs = completed.filter(t => t.type === 'ngn_send');
    const totalNgn = sendTxs.reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
    const count = sendTxs.length;

    // Check amount milestones
    for (const milestone of MILESTONE_AMOUNTS) {
      if (totalNgn >= milestone && totalNgn < milestone + 1000) {
        await notifyFn(
          `🎉 *Milestone Reached!*\n\n` +
          `You've sent a total of *${formatNgn(milestone)}* across ${count} transactions!\n\n` +
          `Keep it going 🚀`
        );
        break; // Only announce one milestone at a time
      }
    }

    // Check count milestones
    for (const milestone of MILESTONE_COUNTS) {
      if (count === milestone) {
        await notifyFn(
          `🎉 *Milestone Reached!*\n\n` +
          `You've completed *${milestone}* successful transfers!\n\n` +
          `Total sent: ${formatNgn(totalNgn)}\n` +
          `Keep it going 🚀`
        );
        break;
      }
    }
  } catch (err) {
    console.error('[Milestone] Error checking milestones:', err);
  }
}

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
      // Verify webhook secret if configured
      const webhookSecret = process.env.CHAINRAILS_WEBHOOK_SECRET;
      const receivedSecret = req.headers['x-webhook-secret'];
      if (webhookSecret && receivedSecret !== webhookSecret) {
        console.warn('[ChainRails Webhook] Invalid secret');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

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

          if (!intentAddress) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing intent_address' }));
            return;
          }

          // Find transaction by ChainRails intent address
          const txRows = await db.select().from(transactions)
            .where(eq(transactions.chainrailsIntentAddress, intentAddress))
            .limit(1);

          if (txRows.length === 0) {
            console.warn('[ChainRails Webhook] No transaction found for intent:', intentAddress);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'No matching transaction' }));
            return;
          }

          const tx = txRows[0];

          // Idempotency: don't re-process completed transactions
          if (tx.status === 'completed') {
            console.log('[ChainRails Webhook] Transaction already completed, skipping:', intentAddress);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Already completed' }));
            return;
          }

          const txStatus = status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'processing';

          // Update transaction
          await db.update(transactions)
            .set({
              status: txStatus,
              toAmount: amount ? amount.toString() : tx.toAmount,
              completedAt: txStatus === 'completed' ? new Date() : undefined,
            })
            .where(eq(transactions.id, tx.id));

          // Notify user via Telegram
          if (txStatus === 'completed') {
            const userId = tx.userId;
            try {
              await botInstance.telegram.sendMessage(
                userId,
                `✅ *Cross-Chain Deposit Complete!*\n\n` +
                `${amount || ''} ${token || 'USDT'} has arrived in your Zend Solana wallet.\n\n` +
                `Reference: \`${tx.id}\``,
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

    // Telegram Bot Webhooks
    if (url === '/webhook/telegram' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const update = JSON.parse(body);
          await botInstance.handleUpdate(update);
          res.writeHead(200);
          res.end('OK');
        } catch (err: any) {
          console.error('[Webhook] Telegram update error:', err);
          res.writeHead(500);
          res.end('Error');
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
    console.log(`   Telegram webhook URL: https://${host}/webhook/telegram`);
  });

  return server;
}

// ═════════════════════════════════════════════════════════════════════════════
// LAUNCH
// ═════════════════════════════════════════════════════════════════════════════

// ─── Scheduled Transfer Executor ───
async function runScheduledTransfers() {
  try {
    const now = new Date();
    const due = await db.select().from(scheduledTransfers)
      .where(and(eq(scheduledTransfers.isActive, true), sql`${scheduledTransfers.nextRunAt} <= ${now.toISOString()}`));

    for (const s of due) {
      try {
        // Get recipient details
        const accounts = await db.select().from(savedBankAccounts)
          .where(eq(savedBankAccounts.id, s.recipientBankAccountId))
          .limit(1);

        if (accounts.length === 0) {
          console.log(`[Schedule] Skipping #${s.id}: recipient account not found`);
          continue;
        }

        const acc = accounts[0];

        // Get rate for USDT calculation
        let rate = 1550;
        try {
          const rates = await getPAJRates();
          rate = rates.offRampRate;
        } catch (e) { /* use fallback */ }

        const amountUsdt = Number(s.amountNgn) / rate;

        // Auto-execute the transfer
        const result = await executeSendCore(s.userId, {
          amountNgn: Number(s.amountNgn),
          amountUsdt,
          ngnRate: rate,
          recipientBankCode: acc.bankCode,
          recipientBankName: acc.bankName,
          recipientAccountNumber: acc.accountNumber,
          recipientAccountName: acc.accountName,
        });

        // Notify user
        try {
          if (result.success) {
            await bot.telegram.sendMessage(
              s.userId,
              `✅ *Scheduled Transfer Executed*\n\n` +
              `Amount: ${formatNgn(Number(s.amountNgn))}\n` +
              `To: ${acc.accountName}\n` +
              `Bank: ${acc.bankName} • \`${acc.accountNumber}\`\n\n` +
              `Reference: \`${result.txId}\`\n` +
              (result.solanaTxHash ? `Tx: \`https://solscan.io/tx/${result.solanaTxHash}\`\n` : '') +
              `Time: ~2 minutes`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
            // Check milestones after successful scheduled transfer
            await checkMilestones(s.userId, (text) => bot.telegram.sendMessage(s.userId, text, { parse_mode: 'Markdown', ...mainMenu }));
          } else {
            await bot.telegram.sendMessage(
              s.userId,
              `❌ *Scheduled Transfer Failed*\n\n` +
              `Amount: ${formatNgn(Number(s.amountNgn))}\n` +
              `To: ${acc.accountName}\n` +
              `Bank: ${acc.bankName} • \`${acc.accountNumber}\`\n\n` +
              `Error: ${result.error || 'Unknown error'}\n` +
              `No funds were deducted.`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
          }
        } catch (notifyErr) {
          console.log('[Schedule] Could not notify user:', notifyErr);
        }

        // Update schedule
        const newRunCount = s.runCount + 1;
        let updates: any = { runCount: newRunCount };

        if (s.frequency === 'once') {
          updates.isActive = false;
        } else {
          let next = new Date();
          if (s.frequency === 'daily') next.setDate(next.getDate() + 1);
          else if (s.frequency === 'weekly') next.setDate(next.getDate() + 7);
          else if (s.frequency === 'monthly') next.setMonth(next.getMonth() + 1);
          updates.nextRunAt = next;
        }

        if (s.maxRuns && newRunCount >= s.maxRuns) {
          updates.isActive = false;
        }
        if (s.endAt && now >= s.endAt) {
          updates.isActive = false;
        }

        await db.update(scheduledTransfers)
          .set(updates)
          .where(eq(scheduledTransfers.id, s.id));

        console.log(`[Schedule] Executed #${s.id} for user ${s.userId}`);
      } catch (err) {
        console.error(`[Schedule] Error processing #${s.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[Schedule] Executor error:', err);
  }
}

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

  // Launch bot — prefer webhooks on Railway, fallback to polling locally
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  let isWebhookMode = false;

  if (webhookBaseUrl) {
    const telegramWebhookUrl = `${webhookBaseUrl.replace(/\/$/, '')}/webhook/telegram`;
    try {
      await bot.telegram.setWebhook(telegramWebhookUrl, { drop_pending_updates: true });
      console.log('🤖 Zend bot running in webhook mode');
      console.log(`   Webhook URL: ${telegramWebhookUrl}`);
      isWebhookMode = true;
    } catch (webhookErr: any) {
      console.error('[Bot] Failed to set webhook:', webhookErr.message);
      console.log('🤖 Falling back to polling mode...');
      bot.launch({ dropPendingUpdates: true });
    }
  } else {
    bot.launch({ dropPendingUpdates: true });
    console.log('🤖 Zend bot running in polling mode...');
  }

  // Start scheduled transfer executor (every 60 seconds)
  setInterval(runScheduledTransfers, 60000);
  console.log('📅 Scheduled transfer executor started (every 60s)');

  // Handle 409 conflict from polling loop (Railway deploy overlap)
  // Only relevant in polling mode; webhooks don't have 409s
  let retryTimeout: NodeJS.Timeout | null = null;
  let retryCount = 0;
  const MAX_409_RETRIES = 10;

  process.on('unhandledRejection', async (reason: any) => {
    // Only handle 409s in polling mode
    if (!isWebhookMode && reason?.response?.error_code === 409) {
      retryCount++;
      const delay = Math.min(5000 * Math.pow(2, retryCount - 1), 60000);
      console.log(`[Bot] 409 conflict (retry ${retryCount}/${MAX_409_RETRIES}), retrying in ${delay}ms...`);

      try { await bot.stop(); } catch { /* may already be stopped */ }
      if (retryTimeout) clearTimeout(retryTimeout);

      if (retryCount > MAX_409_RETRIES) {
        console.error('[Bot] Max 409 retries exceeded. Exiting.');
        process.exit(1);
      }

      retryTimeout = setTimeout(async () => {
        console.log('[Bot] Retrying polling launch...');
        try {
          await bot.launch({ dropPendingUpdates: true });
          retryCount = 0;
          console.log('🤖 Bot polling restarted successfully');
        } catch (err: any) {
          console.error('[Bot] Polling relaunch failed:', err.message);
        }
      }, delay);
      return;
    }

    // Log non-409 unhandled rejections but don't swallow them
    console.error('[UnhandledRejection]', reason);
    // In webhook mode, the server keeps running even if a handler throws
    // In polling mode, let Railway restart if things are truly broken
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
