// ─── Load .env FIRST — before any imports that need env vars ───
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

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
import { users, transactions, savedBankAccounts, scheduledTransfers, bitrefillOrders, ambassadorApplications, deviceSuspensionRequests, botFeatures } from '@zend/db';
import { eq, sql, and, desc } from 'drizzle-orm';
import { WalletService } from '@zend/solana';
import { BitRefillClient } from '@zend/bitrefill-client';
import { parseCommand, transcribeVoice, chatWithKimi, analyzeVoiceWithKimi, parseMenuInputWithAI, type ParsedCommand } from './services/nlp.js';
import type { PAJClient } from '@zend/paj-client';
import {
  ConversationState,
  SOLANA_TOKENS,
  NIGERIAN_BANKS,
  PAJ_MIN_DEPOSIT_NGN,
  PAJ_MAX_DEPOSIT_NGN,
} from '@zend/shared';

import crypto from 'crypto';
import { rateLimitMiddleware } from './middleware/rateLimit.js';

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
    feeSol?: number;
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
    isLocalSwap?: boolean;
  }>;
  pinVerifyAction?: 'send' | 'swap' | 'export' | 'schedule';
  pajContact?: string; // email/phone pending OTP
  onrampAmount?: number; // pending on-ramp amount in NGN
  onrampTargetToken?: 'USDT' | 'AUDD'; // which token the on-ramp should credit
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
    pendingAccountNumber?: string; // used when adding new recipient
  };
  bridgeData?: {
    chainKey: string;
    sourceChain: string;
    token: string;
    tokenIn: string;
  };
  shopData?: {
    productId?: string;
    productName?: string;
    category?: string;
    amount?: number;
    currency?: string;
    phoneNumber?: string;
    invoiceId?: string;
    paymentUri?: string;
    paymentAddress?: string;
    cryptoAmount?: string;
    cryptoCurrency?: string;
    bitrefillPriceUsd?: number;
    totalUsdt?: number;
  };
  lastBotMessageId?: number; // message ID of last bot prompt (for cleanup)
}

interface ZendContext extends Context {
  session: ZendSession;
}

// ─── Session Store (in-memory with TTL, replace with Redis in production) ───
const sessions = new Map<string, ZendSession & { _lastAccessed: number }>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 10000;

function getSession(userId: string): ZendSession {
  const existing = sessions.get(userId);
  if (existing) {
    existing._lastAccessed = Date.now();
    return existing;
  }
  const sess = { state: ConversationState.IDLE, _lastAccessed: Date.now() };
  sessions.set(userId, sess);
  // Evict oldest if over limit
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }
  return sess;
}

function setSession(userId: string, session: ZendSession): void {
  sessions.set(userId, { ...session, _lastAccessed: Date.now() });
}

// ─── Auto-Delete Messages ───
interface TrackedMessage {
  chatId: number | string;
  messageId: number;
  deleteAt: number;
}
const messageQueue: TrackedMessage[] = [];
const MESSAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PIN_TTL_MS = 5 * 1000; // PIN messages: delete after 5 seconds
const MAX_QUEUE_SIZE = 5000;

function trackMessage(chatId: number | string, messageId: number, isPin = false) {
  if (messageQueue.length >= MAX_QUEUE_SIZE) {
    messageQueue.shift(); // drop oldest
  }
  messageQueue.push({
    chatId,
    messageId,
    deleteAt: Date.now() + (isPin ? PIN_TTL_MS : MESSAGE_TTL_MS),
  });
}

async function deleteMessageNow(chatId: number | string, messageId: number) {
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch {
    // Already deleted or permission issue
  }
}

// Cleanup loop — messages + sessions
setInterval(async () => {
  const now = Date.now();
  // Delete expired messages
  const toDelete: TrackedMessage[] = [];
  for (let i = messageQueue.length - 1; i >= 0; i--) {
    if (messageQueue[i].deleteAt <= now) {
      toDelete.push(messageQueue[i]);
      messageQueue.splice(i, 1);
    }
  }
  for (const m of toDelete) {
    try {
      await bot.telegram.deleteMessage(m.chatId, m.messageId);
    } catch {
      // Message already deleted or too old
    }
  }
  // Evict stale sessions
  for (const [uid, sess] of sessions) {
    if (now - sess._lastAccessed > SESSION_TTL_MS) {
      sessions.delete(uid);
    }
  }
}, 5000); // every 5 seconds

// ─── Services ───
const walletService = new WalletService(SOLANA_RPC);
const bitrefillClient = process.env.BITREFILL_API_KEY
  ? new BitRefillClient(process.env.BITREFILL_API_KEY)
  : null;

const bitrefillBusinessClient = (process.env.BITREFILL_BUSINESS_API_ID && process.env.BITREFILL_BUSINESS_API_SECRET)
  ? new BitRefillClient(process.env.BITREFILL_BUSINESS_API_ID, process.env.BITREFILL_BUSINESS_API_SECRET)
  : null;

const BITREFILL_MARKUP_BPS = parseInt(process.env.BITREFILL_MARKUP_BPS || '150');
const ZEND_TREASURY_WALLET = process.env.ZEND_TREASURY_WALLET || ''; // receives shop USDT payments

// Dev wallet for gas sponsorship (supports ZEND_DEV_WALLET_SECRET or PV_KEY)
const DEV_WALLET_SECRET = process.env.ZEND_DEV_WALLET_SECRET || process.env.PV_KEY || '';

const MIN_SOL_FOR_GAS = 0.0005; // base tx fee buffer
const ATA_RENT_SOL = 0.002039; // rent to create an Associated Token Account
const GAS_SPONSORSHIP_FEE_BPS = 50; // 0.5% extra for gasless users

/** Calculate exact SOL a user needs for a send (fees + optional ATA rent). */
function calcRequiredSol(feeSol: number, needsAta: boolean): number {
  return feeSol + MIN_SOL_FOR_GAS + (needsAta ? ATA_RENT_SOL : 0);
}

/** Get dev wallet SOL balance (for gas sponsorship health checks). */
async function getDevWalletBalance(): Promise<number> {
  if (!DEV_WALLET_SECRET) return 0;
  try {
    const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
    return await walletService.getSolBalance(devKeypair.publicKey.toBase58());
  } catch {
    return 0;
  }
}

/**
 * Smart gas funding — tops up the user with exactly the shortfall.
 * If recipient needs an ATA, includes ATA rent in the calculation.
 * Returns { funded: boolean; gasSponsored: boolean; shortfall?: number; error?: string }
 */
async function fundSolIfNeeded(
  walletAddress: string,
  feeSol: number,
  recipientAddress?: string,
  mintAddress?: string
): Promise<{ funded: boolean; gasSponsored: boolean; shortfall?: number; error?: string }> {
  let needsAta = false;
  if (recipientAddress && mintAddress) {
    try {
      needsAta = !(await walletService.ataExists(recipientAddress, mintAddress));
    } catch {
      needsAta = true; // assume worst case
    }
  }

  const required = calcRequiredSol(feeSol, needsAta);
  const balance = await walletService.getSolBalance(walletAddress);

  if (balance >= required) {
    return { funded: false, gasSponsored: false };
  }

  const shortfall = required - balance;

  if (!DEV_WALLET_SECRET) {
    console.warn('[Gas] No dev wallet secret set — cannot fund SOL');
    return { funded: false, gasSponsored: false, shortfall, error: 'Dev wallet not configured' };
  }

  const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
  const devBalance = await walletService.getSolBalance(devKeypair.publicKey.toBase58());
  const devNeeds = shortfall + MIN_SOL_FOR_GAS; // dev needs shortfall + its own tx fee
  if (devBalance < devNeeds) {
    console.error(`[Gas] Dev wallet has ${devBalance.toFixed(6)} SOL but needs ${devNeeds.toFixed(6)} SOL to fund user ${walletAddress}`);
    return { funded: false, gasSponsored: false, shortfall, error: `Dev wallet low on SOL (${devBalance.toFixed(6)}). Please top up the dev wallet.` };
  }

  // Retry up to 3 times with jitter
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await walletService.sendSol(devKeypair, walletAddress, shortfall);
      console.log('[Gas] Funded exact shortfall:', shortfall.toFixed(6), 'SOL (needsAta:', needsAta, ') to', walletAddress);
      return { funded: true, gasSponsored: true, shortfall };
    } catch (err: any) {
      console.error(`[Gas] Attempt ${attempt}/3 failed to fund SOL:`, err.message);
      if (attempt === 3) {
        return { funded: false, gasSponsored: false, shortfall, error: err.message };
      }
      // Jittered backoff: 500ms, 1000ms, 1500ms
      await new Promise(r => setTimeout(r, attempt * 500 + Math.random() * 200));
    }
  }

  return { funded: false, gasSponsored: false, shortfall, error: 'Funding failed after 3 retries' };
}

// ─── Helpers ───
// Escape Telegram Markdown v1 special chars in user-generated text
function md(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .replace(/_/g, '＿')
    .replace(/\*/g, '•')
    .replace(/`/g, "'");
}

function generateTxId(): string {
  return 'ZND-' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

function generateReferralCode(): string {
  return 'ZND' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

async function encryptPrivateKey(secretKey: Uint8Array): Promise<string> {
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(process.env.ENCRYPTION_KEY || 'zend-dev-key', 'salt', 32, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

async function decryptPrivateKey(encryptedKey: string): Promise<Uint8Array> {
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(process.env.ENCRYPTION_KEY || 'zend-dev-key', 'salt', 32, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
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
async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, 100000, 32, 'sha256', (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  return salt + ':' + hash.toString('hex');
}

async function verifyPin(pin: string, stored: string): Promise<{ valid: boolean; isLegacy: boolean }> {
  // Legacy: plaintext PIN stored before hashing was introduced
  if (!stored.includes(':')) {
    return { valid: stored === pin, isLegacy: true };
  }
  const parts = stored.split(':');
  if (parts.length !== 2) return { valid: false, isLegacy: false };
  const [salt, hash] = parts;
  const computed = await new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, 100000, 32, 'sha256', (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  return { valid: computed.toString('hex') === hash, isLegacy: false };
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
    const price = (data as any)?.solana?.usd || 140;
    _solPriceCache = { price, time: Date.now() };
    return price;
  } catch {
    return _solPriceCache?.price || 140;
  }
}

// ─── AUDD Price (CoinGecko) ───
let _auddPriceCache: { price: number; time: number } | null = null;

async function getAuddPriceInUsdt(): Promise<number> {
  if (_auddPriceCache && Date.now() - _auddPriceCache.time < 120000) {
    return _auddPriceCache.price;
  }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=novatti-australian-digital-dollar&vs_currencies=usd');
    const data = await res.json();
    const price = (data as any)?.['novatti-australian-digital-dollar']?.usd;
    if (typeof price === 'number' && price > 0) {
      _auddPriceCache = { price, time: Date.now() };
      return price;
    }
    throw new Error(`CoinGecko returned invalid AUDD price: ${JSON.stringify(data)}`);
  } catch (err: any) {
    if (_auddPriceCache) {
      return _auddPriceCache.price;
    }
    throw new Error(`Failed to fetch AUDD price from CoinGecko: ${err.message}`);
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

// ─── Bot Features (AI awareness) ───
let _botFeaturesCache: any[] | null = null;
let _botFeaturesCacheTime = 0;

async function getBotFeatures(): Promise<any[]> {
  if (_botFeaturesCache && Date.now() - _botFeaturesCacheTime < 300000) {
    return _botFeaturesCache;
  }
  try {
    const rows = await db.select().from(botFeatures).where(eq(botFeatures.isActive, true));
    _botFeaturesCache = rows;
    _botFeaturesCacheTime = Date.now();
    return rows;
  } catch (err) {
    console.log('[Features] DB fetch failed, using cache/empty');
    return _botFeaturesCache || [];
  }
}

async function seedBotFeatures() {
  try {
    const existing = await db.select({ count: sql`count(*)` }).from(botFeatures);
    if (Number(existing[0]?.count) > 0) return;

    const features = [
      { key: 'balance', name: 'Check Balance', description: 'Dollars (USDT/USDC) and SOL with live Naira rates', category: 'payment', sortOrder: 1 },
      { key: 'add_naira', name: 'Add Naira', description: 'Bank transfer to a virtual account, get Dollars in your wallet', category: 'payment', sortOrder: 2 },
      { key: 'send', name: 'Send to Bank', description: 'Send money to any Nigerian bank (GTB, UBA, Access, OPay, Kuda, etc.)', category: 'payment', sortOrder: 3 },
      { key: 'receive', name: 'Receive Money', description: 'Crypto address for direct deposit + virtual bank account for Naira', category: 'payment', sortOrder: 4 },
      { key: 'swap', name: 'Convert Currency', description: 'Exchange SOL ↔ USDT ↔ USDC ↔ AUDD', category: 'payment', sortOrder: 5 },
      { key: 'deposit_crypto', name: 'Deposit from Other Apps', description: 'Send Dollars or AUDD from Binance, MetaMask, Trust Wallet → receive in Zend', category: 'payment', sortOrder: 6 },
      { key: 'history', name: 'Transaction History', description: 'View all past transactions', category: 'info', sortOrder: 7 },
      { key: 'voice', name: 'Voice Commands', description: 'Send a voice note to execute commands', category: 'info', sortOrder: 8 },
      { key: 'scheduled', name: 'Scheduled Transfers', description: 'Schedule automatic recurring or one-time future payments', category: 'payment', sortOrder: 9 },
      { key: 'shop', name: 'Shop (Airtime & Gift Cards)', description: 'Buy airtime, data bundles and retail vouchers via BitRefill', category: 'payment', sortOrder: 10 },
      { key: 'settings', name: 'Settings', description: 'PIN, language, auto-save, PAJ linking, wallet export', category: 'settings', sortOrder: 11 },
      { key: 'community', name: 'Community', description: 'Join the Zend Telegram community', category: 'info', sortOrder: 12 },
    ];

    for (const f of features) {
      await db.insert(botFeatures).values(f);
    }
    console.log('[Features] Seeded', features.length, 'features');
  } catch (err) {
    console.error('[Features] Seed failed:', err);
  }
}

// ─── Bank Verification ───
// Cache PAJ bank list to map our bank codes ↔ PAJ bank IDs
let _pajBankCache: Array<{ id: string; name: string; code: string }> | null = null;
let _pajBankCacheTime = 0;

async function getPajBankList(sessionToken: string, userId?: string): Promise<Array<{ id: string; name: string; code: string }>> {
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
  } catch (err: any) {
    console.error('[PAJ] Failed to fetch bank list:', err);
    if (isPajSessionError(err) && userId) {
      await clearPajSession(userId);
    }
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

// ─── PAJ Session Helpers ───

function isPajSessionError(err: any): boolean {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.statusCode || err?.status || err?.response?.status;
  return status === 401 ||
    msg.includes('session is invalid') ||
    msg.includes('session expired') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid token');
}

async function clearPajSession(userId: string) {
  console.log('[PAJ] Clearing expired session for user:', userId);
  try {
    await db.update(users)
      .set({ pajSessionToken: null, pajSessionExpiresAt: null, pajContact: null })
      .where(eq(users.id, userId));
  } catch (e) {
    console.error('[PAJ] Failed to clear session:', e);
  }
}

async function verifyBankAccount(
  sessionToken: string,
  ourBankCode: string,
  accountNumber: string,
  userId?: string
): Promise<{ verified: boolean; accountName?: string; error?: string; sessionExpired?: boolean }> {
  const pajClient = await getPAJClient();
  if (!pajClient) {
    return { verified: false, error: 'PAJ not available' };
  }

  try {
    const pajBanks = await getPajBankList(sessionToken, userId);
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
    if (isPajSessionError(err) && userId) {
      await clearPajSession(userId);
      return { verified: false, error: 'Your PAJ session expired. Please re-link in Settings.', sessionExpired: true };
    }
    return { verified: false, error: err.message || 'Could not verify account' };
  }
}

// ─── Keyboards ───
const mainMenu = Markup.keyboard([
  ['💰 Balance', '📤 Send', '🔄 Swap'],
  ['📥 Receive', '🎁 Shop', '📋 History'],
  ['⚙️ Settings', '🌐 Community'],
]).resize();

const cancelKeyboard = Markup.keyboard([['❌ Cancel']]).resize();

// Escape Telegram legacy Markdown special chars in user-generated / AI text
function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*\[\`])/g, '\\$1');
}

// ─── Bot ───
const bot = new Telegraf<ZendContext>(BOT_TOKEN);

// Rate limiting — MUST be first
bot.use(rateLimitMiddleware);

// Session middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (userId) {
    (ctx as any).session = getSession(userId);
  }
  await next();
});

// Auto-delete all bot messages after 10 minutes (PIN after 5 sec)
bot.use(async (ctx, next) => {
  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = async function(text: any, extra?: any) {
    const msg = await originalReply(text, extra);
    if (msg && typeof msg === 'object' && 'message_id' in msg && ctx.chat) {
      const isPin = typeof text === 'string' && text.toLowerCase().includes('pin');
      trackMessage(ctx.chat.id, msg.message_id, isPin);
    }
    return msg;
  };
  const originalEdit = ctx.editMessageText.bind(ctx);
  ctx.editMessageText = async function(text: any, extra?: any) {
    const result = await originalEdit(text, extra);
    if (result && typeof result === 'object' && 'message_id' in result && ctx.chat) {
      const isPin = typeof text === 'string' && text.toLowerCase().includes('pin');
      trackMessage(ctx.chat.id, result.message_id, isPin);
    }
    return result;
  };
  await next();
});

// Track & auto-delete user messages during sensitive flows
bot.on(message('text'), async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (!userId || !ctx.chat || !ctx.message?.message_id) return next();
  const session = getSession(userId);
  const sensitiveStates = [
    ConversationState.AWAITING_PIN,
    ConversationState.AWAITING_PIN_VERIFY,
    ConversationState.AWAITING_SEND_AMOUNT,
    ConversationState.AWAITING_SWAP_AMOUNT,
    ConversationState.AWAITING_BRIDGE_AMOUNT,
    ConversationState.AWAITING_ONRAMP_AMOUNT,
    ConversationState.AWAITING_SCHEDULE_AMOUNT,
    ConversationState.AWAITING_SCHEDULE_FREQUENCY,
    ConversationState.AWAITING_SCHEDULE_START,
    ConversationState.AWAITING_EMAIL,
    ConversationState.AWAITING_SEND_RECIPIENT,
    ConversationState.AWAITING_BANK_DETAILS,
    ConversationState.AWAITING_SHOP_PHONE,
  ];
  const isSensitive = sensitiveStates.includes(session.state);
  const isPin = session.state === ConversationState.AWAITING_PIN || session.state === ConversationState.AWAITING_PIN_VERIFY;

  if (isSensitive) {
    trackMessage(ctx.chat.id, ctx.message.message_id, isPin);
  }

  await next(); // let the main handler process the message

  // Immediately delete user messages for sensitive flows (more reliable than queue)
  if (isSensitive) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
      console.log(`[AutoDelete] Deleted user message ${ctx.message.message_id} in state ${session.state}`);
    } catch (err: any) {
      console.log(`[AutoDelete] Failed to delete user message ${ctx.message.message_id}:`, err.message);
    }
    // For PIN flows, also delete the bot's previous prompt message
    if (isPin && session.lastBotMessageId) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, session.lastBotMessageId);
        console.log(`[AutoDelete] Deleted bot prompt ${session.lastBotMessageId}`);
      } catch (err: any) {
        console.log(`[AutoDelete] Failed to delete bot prompt ${session.lastBotMessageId}:`, err.message);
      }
    }
  }
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
    await ctx.reply(`👋 Welcome back, ${firstName}!\n\nYour Zend account is ready.`, mainMenu);
    return;
  }

  // Parse deep link referral param: /start <code>
  const startPayload = ctx.message?.text?.split(' ')[1]?.trim() || '';
  let ambassadorRefCode: string | undefined;
  let referredByUserId: string | undefined;

  if (startPayload) {
    // Check if it's an ambassador custom code
    const ambassadorMatch = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.customReferralCode, startPayload.toLowerCase())).limit(1);
    if (ambassadorMatch.length > 0) {
      ambassadorRefCode = startPayload.toLowerCase();
    } else {
      // Check if it's a regular user referral code
      const refUser = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, startPayload.toUpperCase())).limit(1);
      if (refUser.length > 0) {
        referredByUserId = refUser[0].id;
      }
    }
  }

  // Generate wallet
  const wallet = walletService.generateWallet();
  const encryptedKey = await encryptPrivateKey(wallet.secretKey);
  const referralCode = generateReferralCode();

  await db.insert(users).values({
    id: userId,
    telegramUsername: username,
    firstName,
    lastName,
    walletAddress: wallet.publicKey,
    walletEncryptedKey: encryptedKey,
    referralCode,
    referredBy: referredByUserId,
    ambassadorReferralCode: ambassadorRefCode,
  });

  await ctx.reply(
    `🟣 *Welcome to Zend*\n\n` +
    `Your Dollar savings + Naira bank account — inside Telegram.\n\n` +
    `✅ Account created automatically\n` +
    `✅ No password to remember\n` +
    `✅ Send naira to any Nigerian bank\n` +
    `✅ Receive naira via bank transfer`,
    { parse_mode: 'Markdown' }
  );

  await ctx.reply(
    `✅ *Account Created!*\n\n` +
    `Your Zend address:\n\n` +
    `${wallet.publicKey}\n\n` +
    `💡 Tap *💵 Add Naira* to get your virtual bank account.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
  await ctx.reply('📋 Tap to copy your address:', Markup.inlineKeyboard([
    [{ text: '📋 Copy Address', copy_text: { text: wallet.publicKey } } as any]
  ]));
});

// ═════════════════════════════════════════════════════════════════════════════
// /ADMIN — Admin Dashboard
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

async function checkAdmin(userId: string, username?: string): Promise<boolean> {
  if (ADMIN_TELEGRAM_IDS.length > 0) {
    if (ADMIN_TELEGRAM_IDS.includes(userId)) return true;
    if (username && ADMIN_TELEGRAM_IDS.includes(username.toLowerCase())) return true;
  }
  const u = await db.select({ isAdmin: users.isAdmin, telegramUsername: users.telegramUsername }).from(users).where(eq(users.id, userId)).limit(1);
  if (u.length > 0 && u[0].isAdmin) return true;
  if (u.length > 0 && u[0].telegramUsername && ADMIN_TELEGRAM_IDS.includes(u[0].telegramUsername.toLowerCase())) return true;
  return false;
}

// ─── Admin Navigation ───
const adminMainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📊 Overview', 'admin_page:overview')],
  [Markup.button.callback('👤 Users', 'admin_page:users'), Markup.button.callback('🧑‍🎓 Ambassadors', 'admin_page:ambassadors')],
  [Markup.button.callback('🚨 Suspensions', 'admin_page:suspensions'), Markup.button.callback('💰 Fees & Revenue', 'admin_page:fees')],
  [Markup.button.callback('🎯 Ref Links', 'admin_page:ambassador_refs'), Markup.button.callback('🔍 Search', 'admin_page:search')],
  [Markup.button.callback('⚙️ Features', 'admin_page:features')],
]);

bot.command('admin', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) {
    await ctx.reply('❌ You do not have permission to access the admin panel.');
    return;
  }
  await ctx.reply('🛠 *Zend Admin Panel*\n\nChoose a section:', { parse_mode: 'Markdown', ...adminMainKeyboard });
});

bot.action('admin_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }
  await ctx.editMessageText('🛠 *Zend Admin Panel*\n\nChoose a section:', { parse_mode: 'Markdown', ...adminMainKeyboard });
  await ctx.answerCbQuery();
});

// ─── Overview ───
bot.action('admin_page:overview', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const userCount = await db.select({ count: sql`count(*)` }).from(users);
  const txCount = await db.select({ count: sql`count(*)` }).from(transactions);
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'offramp'));
  const totalNgnIn = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));
  const totalZendFee = await db.select({ sum: sql`coalesce(sum(zend_fee_usdt), 0)` }).from(transactions).where(eq(transactions.status, 'completed'));
  const activeFeatures = await db.select().from(botFeatures).where(eq(botFeatures.isActive, true));

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const newToday = await db.select({ count: sql`count(*)` }).from(users).where(sql`${users.createdAt} >= ${todayStart.toISOString()}`);

  const text =
    `📊 *Overview*\n\n` +
    `👤 Total Users: ${userCount[0]?.count || 0} (+${newToday[0]?.count || 0} today)\n` +
    `📋 Total Transactions: ${txCount[0]?.count || 0}\n` +
    `💰 Total NGN In: ₦${Number(totalNgnIn[0]?.sum || 0).toLocaleString()}\n` +
    `💸 Total NGN Out: ₦${Number(totalNgnOut[0]?.sum || 0).toLocaleString()}\n` +
    `🪙 Zend Fees (USDT): $${Number(totalZendFee[0]?.sum || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\n` +
    `✅ Active Features: ${activeFeatures.length}\n`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Users (paginated) ───
const USERS_PER_PAGE = 20;

bot.action('admin_page:users', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(users);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const newToday = await db.select({ count: sql`count(*)` }).from(users).where(sql`${users.createdAt} >= ${todayStart.toISOString()}`);
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const newWeek = await db.select({ count: sql`count(*)` }).from(users).where(sql`${users.createdAt} >= ${weekStart.toISOString()}`);

  const recentUsers = await db.select({
    id: users.id,
    name: users.firstName,
    username: users.telegramUsername,
    createdAt: users.createdAt,
    wallet: users.walletAddress,
  }).from(users).orderBy(sql`${users.createdAt} desc`).limit(USERS_PER_PAGE);

  let userList = recentUsers.map(u =>
    `- ${escapeTelegramMarkdown(u.name || 'Unknown')}${u.username ? ` (@${escapeTelegramMarkdown(u.username.replace(/^@/, ''))})` : ''} | \`${u.wallet?.slice(0, 6)}...${u.wallet?.slice(-4)}\``
  ).join('\n');

  const text =
    `👤 *Users* (page 1)\n\n` +
    `Total: ${total[0]?.count || 0} | New today: ${newToday[0]?.count || 0} | This week: ${newWeek[0]?.count || 0}\n\n` +
    `${userList || 'No users yet.'}`;

  const navButtons = [];
  if (Number(total[0]?.count || 0) > USERS_PER_PAGE) {
    navButtons.push(Markup.button.callback('➡️ Next', 'admin_users_page:1'));
  }
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

bot.action(/admin_users_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * USERS_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(users);
  const pageUsers = await db.select({
    id: users.id,
    name: users.firstName,
    username: users.telegramUsername,
    wallet: users.walletAddress,
  }).from(users).orderBy(sql`${users.createdAt} desc`).limit(USERS_PER_PAGE).offset(offset);

  let userList = pageUsers.map(u =>
    `- ${escapeTelegramMarkdown(u.name || 'Unknown')}${u.username ? ` (@${escapeTelegramMarkdown(u.username.replace(/^@/, ''))})` : ''} | \`${u.wallet?.slice(0, 6)}...${u.wallet?.slice(-4)}\``
  ).join('\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `👤 *Users* (page ${page + 1})\n\n${userList || 'No more users.'}`;

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_users_page:${page - 1}`));
  if (totalCount > offset + USERS_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_users_page:${page + 1}`));

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Ambassadors (paginated) ───
const AMBS_PER_PAGE = 20;

bot.action('admin_page:ambassadors', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const apps = await db.select().from(ambassadorApplications).orderBy(sql`${ambassadorApplications.createdAt} desc`).limit(AMBS_PER_PAGE);

  let list = apps.map((a, i) =>
    `${i + 1}. *${escapeTelegramMarkdown(a.name)}* (@${escapeTelegramMarkdown(a.tgHandle.replace(/^@/, ''))})\n` +
    `   Student: ${escapeTelegramMarkdown(a.isStudent)} | Focus: ${escapeTelegramMarkdown(a.focus)}`
  ).join('\n\n');

  const text = `🧑‍🎓 *Ambassadors* (page 1) — ${total[0]?.count || 0} total\n\n${list || 'No applications yet.'}`;

  const navButtons = [];
  if (Number(total[0]?.count || 0) > AMBS_PER_PAGE) {
    navButtons.push(Markup.button.callback('➡️ Next', 'admin_ambassadors_page:1'));
  }
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

bot.action(/admin_ambassadors_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * AMBS_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const apps = await db.select().from(ambassadorApplications).orderBy(sql`${ambassadorApplications.createdAt} desc`).limit(AMBS_PER_PAGE).offset(offset);

  let list = apps.map((a, i) =>
    `${offset + i + 1}. *${escapeTelegramMarkdown(a.name)}* (@${escapeTelegramMarkdown(a.tgHandle.replace(/^@/, ''))})\n` +
    `   Student: ${escapeTelegramMarkdown(a.isStudent)} | Focus: ${escapeTelegramMarkdown(a.focus)}`
  ).join('\n\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `🧑‍🎓 *Ambassadors* (page ${page + 1}) — ${totalCount} total\n\n${list || 'No more applications.'}`;

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_ambassadors_page:${page - 1}`));
  if (totalCount > offset + AMBS_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_ambassadors_page:${page + 1}`));

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Suspensions (paginated) ───
const SUSP_PER_PAGE = 20;

bot.action('admin_page:suspensions', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(deviceSuspensionRequests);
  const reqs = await db.select().from(deviceSuspensionRequests).orderBy(sql`${deviceSuspensionRequests.createdAt} desc`).limit(SUSP_PER_PAGE);

  let list = reqs.map((r, i) =>
    `${i + 1}. *${escapeTelegramMarkdown(r.fullName)}* (@${escapeTelegramMarkdown(r.handle.replace(/^@/, ''))})\n` +
    `   📧 ${escapeTelegramMarkdown(r.email)} | 📱 ${escapeTelegramMarkdown(r.phone)}\n` +
    `   Device: ${escapeTelegramMarkdown(r.deviceLost)}${r.details ? `\n   Details: ${escapeTelegramMarkdown(r.details.slice(0, 100))}` : ''}`
  ).join('\n\n');

  const text = `🚨 *Suspensions* (page 1) — ${total[0]?.count || 0} total\n\n${list || 'No requests yet.'}`;

  const navButtons = [];
  if (Number(total[0]?.count || 0) > SUSP_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', 'admin_suspensions_page:1'));
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

bot.action(/admin_suspensions_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * SUSP_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(deviceSuspensionRequests);
  const reqs = await db.select().from(deviceSuspensionRequests).orderBy(sql`${deviceSuspensionRequests.createdAt} desc`).limit(SUSP_PER_PAGE).offset(offset);

  let list = reqs.map((r, i) =>
    `${offset + i + 1}. *${escapeTelegramMarkdown(r.fullName)}* (@${escapeTelegramMarkdown(r.handle.replace(/^@/, ''))})\n` +
    `   📧 ${escapeTelegramMarkdown(r.email)} | 📱 ${escapeTelegramMarkdown(r.phone)}\n` +
    `   Device: ${escapeTelegramMarkdown(r.deviceLost)}${r.details ? `\n   Details: ${escapeTelegramMarkdown(r.details.slice(0, 100))}` : ''}`
  ).join('\n\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `🚨 *Suspensions* (page ${page + 1}) — ${totalCount} total\n\n${list || 'No more requests.'}`;

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_suspensions_page:${page - 1}`));
  if (totalCount > offset + SUSP_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_suspensions_page:${page + 1}`));

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([navButtons, [Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Fees & Revenue ───
bot.action('admin_page:fees', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const totalZendFee = await db.select({ sum: sql`coalesce(sum(zend_fee_usdt), 0)` }).from(transactions).where(eq(transactions.status, 'completed'));
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'offramp'));
  const totalNgnIn = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));

  const offrampCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'offramp'));
  const onrampCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));
  const swapCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'swap'));
  const shopCount = await db.select({ count: sql`count(*)` }).from(bitrefillOrders);
  const shopVolume = await db.select({ sum: sql`coalesce(sum(amount_fiat), 0)` }).from(bitrefillOrders).where(eq(bitrefillOrders.status, 'completed'));

  const text =
    `💰 *Fees & Revenue*\n\n` +
    `🪙 Total Zend Fees: $${Number(totalZendFee[0]?.sum || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\n\n` +
    `📊 *Volume by Type:*\n` +
    `📤 Off-Ramp: ${offrampCount[0]?.count || 0} tx | ₦${Number(totalNgnOut[0]?.sum || 0).toLocaleString()}\n` +
    `📥 On-Ramp: ${onrampCount[0]?.count || 0} tx | ₦${Number(totalNgnIn[0]?.sum || 0).toLocaleString()}\n` +
    `🔄 Swaps: ${swapCount[0]?.count || 0} tx\n` +
    `🎁 Shop Orders: ${shopCount[0]?.count || 0} | $${Number(shopVolume[0]?.sum || 0).toLocaleString()}\n`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_back')]]) });
  await ctx.answerCbQuery();
});

// ─── Features ───
bot.action('admin_page:features', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const features = await db.select().from(botFeatures).orderBy(botFeatures.sortOrder);
  const buttons = features.map(f => [
    Markup.button.callback(`${f.isActive ? '🟢' : '🔴'} ${f.name}`, `admin_toggle_feature:${f.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  const activeCount = features.filter(f => f.isActive).length;
  const text = `⚙️ *Features* — ${activeCount} / ${features.length} active\n\nTap to toggle:`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_toggle_feature:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const featureId = parseInt(ctx.match[1], 10);
  const feature = await db.select().from(botFeatures).where(eq(botFeatures.id, featureId)).limit(1);
  if (feature.length === 0) { await ctx.answerCbQuery('Feature not found'); return; }

  const newState = !feature[0].isActive;
  await db.update(botFeatures).set({ isActive: newState }).where(eq(botFeatures.id, featureId));
  _botFeaturesCache = null;

  await ctx.answerCbQuery(`${feature[0].name} is now ${newState ? 'ON' : 'OFF'}`);

  // Refresh features page
  const features = await db.select().from(botFeatures).orderBy(botFeatures.sortOrder);
  const buttons = features.map(f => [
    Markup.button.callback(`${f.isActive ? '🟢' : '🔴'} ${f.name}`, `admin_toggle_feature:${f.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);
  const activeCount = features.filter(f => f.isActive).length;
  const text = `⚙️ *Features* — ${activeCount} / ${features.length} active\n\nTap to toggle:`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ─── Ambassador Referrals ───

bot.action('admin_page:ambassador_refs', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambassadors = await db.select().from(ambassadorApplications).orderBy(desc(ambassadorApplications.createdAt));

  // Get signup counts per ambassador code
  const signupCounts: Record<string, number> = {};
  for (const a of ambassadors) {
    if (a.customReferralCode) {
      const count = await db.select({ count: sql`count(*)` }).from(users).where(eq(users.ambassadorReferralCode, a.customReferralCode));
      signupCounts[a.customReferralCode] = Number(count[0]?.count || 0);
    }
  }

  let list = ambassadors.map((a, i) => {
    const code = a.customReferralCode ? `\`${a.customReferralCode}\`` : '_(not set)_';
    const signups = a.customReferralCode ? (signupCounts[a.customReferralCode] || 0) : 0;
    const link = a.customReferralCode ? `t.me/ZendBot?start=${a.customReferralCode}` : '';
    return `${i + 1}. *${escapeTelegramMarkdown(a.name)}* — ${code}\n   Signups: ${signups}${link ? ` | [Link](${link})` : ''}`;
  }).join('\n\n');

  const text = `🎯 *Ambassador Referral Links* — ${ambassadors.length} ambassadors\n\n${list || 'No ambassadors yet.'}\n\nTap an ambassador to manage their code:`;

  const buttons = ambassadors.map(a => [
    Markup.button.callback(`${escapeTelegramMarkdown(a.name)}`, `admin_ambassador_detail:${a.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_ambassador_detail:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  const ambRows = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.id, ambId)).limit(1);
  if (ambRows.length === 0) { await ctx.answerCbQuery('Ambassador not found'); return; }
  const amb = ambRows[0];

  const signupCount = amb.customReferralCode
    ? await db.select({ count: sql`count(*)` }).from(users).where(eq(users.ambassadorReferralCode, amb.customReferralCode))
    : [{ count: 0 }];

  const text =
    `🧑‍🎓 *Ambassador Detail*\n\n` +
    `*Name:* ${escapeTelegramMarkdown(amb.name)}\n` +
    `*Handle:* @${escapeTelegramMarkdown(amb.tgHandle.replace(/^@/, ''))}\n` +
    `*Focus:* ${escapeTelegramMarkdown(amb.focus)}\n` +
    `*Student:* ${escapeTelegramMarkdown(amb.isStudent)}\n\n` +
    `*Referral Code:* ${amb.customReferralCode ? `\`${amb.customReferralCode}\`` : '_(not set)_'}\n` +
    `*Signups:* ${Number(signupCount[0]?.count || 0)}\n` +
    `${amb.customReferralCode ? `*Link:* \`t.me/ZendBot?start=${amb.customReferralCode}\`` : ''}`;

  const buttons = [
    [Markup.button.callback('✏️ Set Code', `admin_set_ambassador_code:${amb.id}`)],
    [Markup.button.callback('👥 View Signups', `admin_ambassador_signups:${amb.id}`)],
    [Markup.button.callback('◀️ Back', 'admin_page:ambassador_refs')],
  ];

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_set_ambassador_code:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  const ambRows = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.id, ambId)).limit(1);
  if (ambRows.length === 0) { await ctx.answerCbQuery('Ambassador not found'); return; }

  setSession(userId, { state: ConversationState.AWAITING_ADMIN_SET_AMBASSADOR_CODE, pendingTransaction: { recipientName: String(ambId) } as any });

  await ctx.editMessageText(
    `✏️ *Set Referral Code*\n\n` +
    `Ambassador: *${escapeTelegramMarkdown(ambRows[0].name)}*\n\n` +
    `Enter a unique code (lowercase, no spaces, e.g., \`ajemark\`, \`ghali\`):\n\n` +
    `Current: ${ambRows[0].customReferralCode ? `\`${ambRows[0].customReferralCode}\`` : '_(none)_'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `admin_ambassador_detail:${ambId}`)]]) }
  );
  await ctx.answerCbQuery();
});

bot.action(/admin_ambassador_signups:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  const ambRows = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.id, ambId)).limit(1);
  if (ambRows.length === 0) { await ctx.answerCbQuery('Ambassador not found'); return; }
  const amb = ambRows[0];

  if (!amb.customReferralCode) {
    await ctx.editMessageText('❌ This ambassador has no referral code set.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]));
    await ctx.answerCbQuery();
    return;
  }

  const signups = await db.select({
    id: users.id,
    name: users.firstName,
    username: users.telegramUsername,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.ambassadorReferralCode, amb.customReferralCode)).orderBy(desc(users.createdAt)).limit(20);

  const total = await db.select({ count: sql`count(*)` }).from(users).where(eq(users.ambassadorReferralCode, amb.customReferralCode));

  let list = signups.map((u, i) =>
    `${i + 1}. ${escapeTelegramMarkdown(u.name || 'Unknown')}${u.username ? ` (@${escapeTelegramMarkdown(u.username.replace(/^@/, ''))})` : ''} — ${new Date(u.createdAt).toLocaleDateString('en-NG')}`
  ).join('\n');

  const text =
    `👥 *Signups via ${escapeTelegramMarkdown(amb.name)}*\n` +
    `Code: \`${amb.customReferralCode}\` | Total: ${Number(total[0]?.count || 0)}\n\n` +
    (list || 'No signups yet.');

  const buttons = signups.map(u => [Markup.button.callback(`View ${escapeTelegramMarkdown(u.name || 'User')}`, `admin_user:${u.id}`)]);
  buttons.push([Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

// ─── Admin Search ───

const adminSearchKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🔎 Search Transaction', 'admin_search:txn')],
  [Markup.button.callback('👤 Search User', 'admin_search:user')],
  [Markup.button.callback('◀️ Back', 'admin_back')],
]);

bot.action('admin_page:search', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }
  await ctx.editMessageText('🔍 *Search*\n\nWhat do you want to look up?', { parse_mode: 'Markdown', ...adminSearchKeyboard });
  await ctx.answerCbQuery();
});

bot.action('admin_search:txn', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }
  setSession(userId, { state: ConversationState.AWAITING_ADMIN_TXN_SEARCH });
  await ctx.editMessageText('🔎 *Search Transaction*\n\nEnter the transaction ID (e.g., `ZND-12345`):', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_cancel_search')]]) });
  await ctx.answerCbQuery();
});

bot.action('admin_search:user', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }
  setSession(userId, { state: ConversationState.AWAITING_ADMIN_USER_SEARCH });
  await ctx.editMessageText('👤 *Search User*\n\nEnter a Telegram user ID or @username:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_cancel_search')]]) });
  await ctx.answerCbQuery();
});

bot.action('admin_cancel_search', async (ctx) => {
  const userId = ctx.from.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('🔍 *Search*\n\nWhat do you want to look up?', { parse_mode: 'Markdown', ...adminSearchKeyboard });
  await ctx.answerCbQuery('Cancelled');
});

function formatTxnStatus(status: string): string {
  const map: Record<string, string> = {
    pending: '⏳ Pending',
    processing: '⏳ Processing',
    completed: '✅ Completed',
    failed: '❌ Failed',
    cancelled: '🚫 Cancelled',
  };
  return map[status] || status;
}

function formatTxnType(type: string): string {
  const map: Record<string, string> = {
    offramp: '📤 Off-Ramp',
    ngn_receive: '📥 On-Ramp',
    swap: '🔄 Swap',
    deposit: '⬇️ Deposit',
    withdraw: '⬆️ Withdraw',
  };
  return map[type] || type;
}

async function buildTxnDetailText(txn: any): Promise<string> {
  const userRows = await db.select({ firstName: users.firstName, telegramUsername: users.telegramUsername }).from(users).where(eq(users.id, txn.userId)).limit(1);
  const u = userRows[0];

  let text = `📋 *Transaction Detail*\n\n`;
  text += `*ID:* \`${txn.id}\`\n`;
  text += `*Type:* ${formatTxnType(txn.type)}\n`;
  text += `*Status:* ${formatTxnStatus(txn.status)}\n`;
  text += `*User:* ${escapeTelegramMarkdown(u?.firstName || 'Unknown')}${u?.telegramUsername ? ` (@${escapeTelegramMarkdown(u.telegramUsername.replace(/^@/, ''))})` : ''}\n`;
  text += `*User ID:* \`${txn.userId}\`\n`;

  if (txn.ngnAmount) {
    text += `\n💰 *Fiat:*\n`;
    text += `   NGN Amount: ₦${Number(txn.ngnAmount).toLocaleString()}\n`;
    if (txn.ngnRate) text += `   Rate: ₦${Number(txn.ngnRate).toLocaleString()}\n`;
  }

  if (txn.fromAmount || txn.toAmount) {
    text += `\n🪙 *Crypto:*\n`;
    if (txn.fromAmount && txn.fromMint) text += `   From: ${Number(txn.fromAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${txn.fromMint.slice(0, 4)}...\n`;
    if (txn.toAmount && txn.toMint) text += `   To: ${Number(txn.toAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${txn.toMint.slice(0, 4)}...\n`;
  }

  text += `\n📊 *Fees:*\n`;
  if (txn.pajFeeBps) text += `   PAJ Fee: ${(txn.pajFeeBps / 100).toFixed(2)}%\n`;
  if (txn.zendSpreadBps) text += `   Zend Spread: ${(txn.zendSpreadBps / 100).toFixed(2)}%\n`;
  if (txn.zendFeeUsdt) text += `   Zend Fee: $${Number(txn.zendFeeUsdt).toLocaleString(undefined, { maximumFractionDigits: 6 })}\n`;

  if (txn.recipientBankName || txn.recipientAccountNumber) {
    text += `\n🏦 *Recipient:*\n`;
    if (txn.recipientBankName) text += `   Bank: ${escapeTelegramMarkdown(txn.recipientBankName)}\n`;
    if (txn.recipientAccountNumber) text += `   Account: \`${txn.recipientAccountNumber}\`\n`;
    if (txn.recipientAccountName) text += `   Name: ${escapeTelegramMarkdown(txn.recipientAccountName)}\n`;
  }

  if (txn.recipientWalletAddress) {
    text += `\n📬 *Wallet Recipient:*\n   \`${txn.recipientWalletAddress}\`\n`;
  }

  if (txn.solanaTxHash) {
    text += `\n🔗 *Solana Tx:*\n   [View on Solscan](https://solscan.io/tx/${txn.solanaTxHash})\n`;
  }

  if (txn.pajReference) text += `\n📌 *PAJ Ref:* \`${txn.pajReference}\`\n`;
  if (txn.chainrailsIntentAddress) text += `📌 *ChainRails:* \`${txn.chainrailsIntentAddress}\`\n`;

  if (txn.createdAt) text += `\n🕐 *Created:* ${new Date(txn.createdAt).toLocaleString('en-NG')}\n`;
  if (txn.completedAt) text += `🕐 *Completed:* ${new Date(txn.completedAt).toLocaleString('en-NG')}\n`;

  if (txn.metadata) {
    try {
      const meta = typeof txn.metadata === 'string' ? JSON.parse(txn.metadata) : txn.metadata;
      const metaStr = JSON.stringify(meta, null, 2).slice(0, 300);
      if (metaStr.length > 10) text += `\n📝 *Metadata:*\n\`\`\`\n${escapeTelegramMarkdown(metaStr)}\n\`\`\``;
    } catch { /* ignore */ }
  }

  return text;
}

async function buildUserDetailText(userRow: any): Promise<string> {
  const txCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.userId, userRow.id));
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(and(eq(transactions.userId, userRow.id), eq(transactions.type, 'offramp')));
  const totalNgnIn = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(and(eq(transactions.userId, userRow.id), eq(transactions.type, 'ngn_receive')));

  const recentTxns = await db.select().from(transactions)
    .where(eq(transactions.userId, userRow.id))
    .orderBy(desc(transactions.createdAt))
    .limit(5);

  let text = `👤 *User Detail*\n\n`;
  text += `*Name:* ${escapeTelegramMarkdown(userRow.firstName || 'Unknown')} ${escapeTelegramMarkdown(userRow.lastName || '')}\n`;
  text += `*Username:* ${userRow.telegramUsername ? `@${escapeTelegramMarkdown(userRow.telegramUsername.replace(/^@/, ''))}` : 'N/A'}\n`;
  text += `*ID:* \`${userRow.id}\`\n`;
  text += `*Wallet:* \`${userRow.walletAddress}\`\n`;
  text += `*Tier:* ${userRow.tier || 1} | *Lang:* ${userRow.language || 'en'}\n`;
  if (userRow.autoSaveRateBps) text += `*Auto-save:* ${(userRow.autoSaveRateBps / 100).toFixed(1)}%\n`;
  if (userRow.pajContact) text += `*PAJ Contact:* ${escapeTelegramMarkdown(userRow.pajContact)}\n`;

  if (userRow.virtualAccount) {
    try {
      const va = typeof userRow.virtualAccount === 'string' ? JSON.parse(userRow.virtualAccount) : userRow.virtualAccount;
      if (va?.accountNumber) text += `\n🏦 *Virtual Account:*\n   Bank: ${escapeTelegramMarkdown(va.bankName || 'N/A')}\n   Number: \`${va.accountNumber}\`\n`;
    } catch { /* ignore */ }
  }

  text += `\n📊 *Stats:*\n`;
  text += `   Total Txns: ${txCount[0]?.count || 0}\n`;
  text += `   NGN In: ₦${Number(totalNgnIn[0]?.sum || 0).toLocaleString()}\n`;
  text += `   NGN Out: ₦${Number(totalNgnOut[0]?.sum || 0).toLocaleString()}\n`;

  if (recentTxns.length > 0) {
    text += `\n📋 *Recent Transactions:*\n`;
    text += recentTxns.map((t: any) =>
      `   • ${formatTxnType(t.type)} ${formatTxnStatus(t.status)} | ₦${Number(t.ngnAmount || 0).toLocaleString()} | \`${t.id}\``
    ).join('\n');
  }

  text += `\n\n🕐 *Joined:* ${new Date(userRow.createdAt).toLocaleString('en-NG')}`;
  return text;
}

bot.action(/admin_txn:(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const txnId = ctx.match[1];
  const txnRows = await db.select().from(transactions).where(eq(transactions.id, txnId)).limit(1);
  if (txnRows.length === 0) {
    await ctx.editMessageText('❌ Transaction not found.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:search')]]));
    await ctx.answerCbQuery();
    return;
  }

  const text = await buildTxnDetailText(txnRows[0]);
  const buttons = [
    [Markup.button.callback('👤 View User', `admin_user:${txnRows[0].userId}`)],
    [Markup.button.callback('🔍 New Search', 'admin_page:search')],
  ];
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_user:(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const targetId = ctx.match[1];
  const userRows = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (userRows.length === 0) {
    await ctx.editMessageText('❌ User not found.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:search')]]));
    await ctx.answerCbQuery();
    return;
  }

  const text = await buildUserDetailText(userRows[0]);
  const buttons = [
    [Markup.button.url('💬 Open Chat', `tg://user?id=${targetId}`)],
    [Markup.button.callback('🔍 New Search', 'admin_page:search')],
  ];
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
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
    `👛 *Your Account*\n\n` +
    `*Your Address:*\n\n` +
    `${u.walletAddress}\n\n` +
    `*Currencies:* SOL, USDT, USDC, AUDD\n\n` +
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

// ═════════════════════════════════════════════════════════════════════════════
// 🎁 SHOP — BitRefill Integration
// ═════════════════════════════════════════════════════════════════════════════

// Cache for BitRefill products (TTL: 10 minutes)
const bitrefillProductCache = new Map<string, { products: any[]; fetchedAt: number }>();
const BITREFILL_CACHE_TTL = 10 * 60 * 1000;

async function getCachedProducts(country: string, category?: string): Promise<any[]> {
  const key = `${country}:${category || 'all'}`;
  const cached = bitrefillProductCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < BITREFILL_CACHE_TTL) {
    return cached.products;
  }
  const client = bitrefillClient || bitrefillBusinessClient;
  if (!client) return [];
  try {
    const res = await client.getProducts({ country, category, limit: 50 });
    const products = Array.isArray(res) ? res : (res.data || []);
    console.log('[BitRefill] Fetched', products.length, 'products for', country, '- names:', products.map((p: any) => p.name).join(', '));
    bitrefillProductCache.set(key, { products, fetchedAt: Date.now() });
    return products;
  } catch (err) {
    console.error('[BitRefill] Failed to fetch products:', err);
    return [];
  }
}

// ─── Shop entry ───
bot.command('shop', async (ctx) => {
  await showShop(ctx);
});

bot.hears('🎁 Shop', async (ctx) => {
  await showShop(ctx);
});

async function showShop(ctx: ZendContext) {
  if (!bitrefillClient && !bitrefillBusinessClient) {
    await ctx.reply(
      '🎁 *Shop*\n\n' +
      'Shopping is temporarily unavailable. Please try again later.',
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  await ctx.reply(
    '🛒 *Shop with Crypto*\n\n' +
    'What do you want to buy?',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📱 Airtime', 'shop_cat:refill')],
        [Markup.button.callback('📶 Data Bundles', 'shop_cat:data')],
        [Markup.button.callback('🌍 Gift Cards', 'shop_cat:gift-card')],
        [Markup.button.callback('🌐 eSIM', 'shop_cat:esim')],
        [Markup.button.callback('📋 All Products', 'shop_cat:all')],
        [Markup.button.callback('📦 My Orders', 'shop_orders')],
      ]),
    }
  );
}

// ─── Category selection ───
bot.action(/shop_cat:(.+)/, async (ctx) => {
  const category = ctx.match[1];
  const userId = ctx.from!.id.toString();

  await ctx.answerCbQuery('Loading products...');

  // BitRefill Nigeria products don't use standard categories — fetch all and filter client-side
  const products = await getCachedProducts('NG');
  let filtered = products.filter((p: any) => p.in_stock !== false);

  const DATA_KEYWORDS = ['data', 'bundle', 'internet', 'sme', 'social', 'night', 'weekly', 'monthly', 'daily', 'subscription', 'pack'];
  const CARRIER_NAMES = ['airtel', 'mtn', 'glo', '9mobile'];
  const isDataProduct = (p: any) =>
    p.type === 'bundle' ||
    p.type === 'data_bundle' ||
    DATA_KEYWORDS.some(k => p.name.toLowerCase().includes(k));
  const isCarrierProduct = (p: any) =>
    CARRIER_NAMES.some(c => p.name.toLowerCase().includes(c));

  if (category === 'all') {
    // Show everything, no extra filtering
  } else if (category === 'data') {
    filtered = filtered.filter((p: any) => isCarrierProduct(p) && isDataProduct(p));
  } else if (category === 'refill') {
    // Airtime: carrier products that are NOT data bundles
    filtered = filtered.filter((p: any) => isCarrierProduct(p) && !isDataProduct(p));
  } else if (category === 'gift-card') {
    // Retail vouchers / gift cards: not carrier products
    filtered = filtered.filter((p: any) => !isCarrierProduct(p));
  } else if (category === 'esim') {
    filtered = filtered.filter((p: any) =>
      p.name.toLowerCase().includes('esim') || p.name.toLowerCase().includes('e-sim')
    );
  }

  console.log('[BitRefill] Category:', category, '-', filtered.length, 'products:', filtered.map((p: any) => p.name).join(', '));

  if (!filtered.length) {
    await ctx.editMessageText(
      '🎁 *Shop*\n\n' +
      'No products available in this category right now.\n\n' +
      'Please try again later.',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back', 'shop_back')],
      ]) }
    );
    return;
  }

  const buttons = filtered.slice(0, 10).map((p: any) =>
    [Markup.button.callback(p.name, `shop_product:${p.id}`)]
  );
  buttons.push([Markup.button.callback('⬅️ Back', 'shop_back')]);

  await ctx.editMessageText(
    `🛒 *Shop — ${category === 'refill' ? 'Airtime' : category === 'gift-card' ? 'Gift Cards' : category === 'esim' ? 'eSIM' : category === 'all' ? 'All Products' : 'Data Bundles'}*\n\n` +
    `Choose a product:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

// ─── Product selection ───
bot.action(/shop_product:(.+)/, async (ctx) => {
  const productId = ctx.match[1];
  const userId = ctx.from!.id.toString();

  await ctx.answerCbQuery('Loading...');

  const client = bitrefillClient || bitrefillBusinessClient;
  if (!client) return;

  try {
    const product = await client.getProduct(productId);
    const session = getSession(userId);
    session.shopData = {
      productId: product.id,
      productName: product.name,
      category: product.category,
    };

    // Build amount buttons
    const buttons: any[] = [];

    if (product.packages && product.packages.length > 0) {
      // Fixed packages
      for (const pkg of product.packages.slice(0, 8)) {
        const pkgCurrency = pkg.currency || product.currency || '';
        const isNgn = product.currency === 'NGN' || pkg.currency === 'NGN' || pkg.price_currency === 'NGN';
        const priceSymbol = isNgn ? '₦' : (pkg.price_currency === 'USD' ? '$' : (pkg.price_currency || '$') + ' ');
        buttons.push([Markup.button.callback(
          `${pkg.value.toLocaleString()} ${pkgCurrency} — ~${priceSymbol}${pkg.price.toLocaleString()}`,
          `shop_pkg:${pkg.package_id}`
        )]);
      }
    } else if (product.range) {
      // Variable amount
      const presets = [500, 1000, 2000, 5000, 10000];
      const validPresets = presets.filter(a =>
        a >= product.range!.min && a <= product.range!.max
      );
      for (const amt of validPresets.slice(0, 5)) {
        buttons.push([Markup.button.callback(
          `${product.currency} ${amt.toLocaleString()}`,
          `shop_amount:${amt}`
        )]);
      }
      buttons.push([Markup.button.callback('✏️ Custom Amount', 'shop_custom_amount')]);
    }

    buttons.push([Markup.button.callback('⬅️ Back', 'shop_back')]);

    await ctx.editMessageText(
      `🛒 *${md(product.name)}*\n\n` +
      `${product.in_stock ? '✅ In Stock' : '❌ Out of Stock'}\n` +
      `Country: ${product.country || 'Nigeria'}\n` +
      `Currency: ${product.currency}\n\n` +
      `Choose an amount:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  } catch (err) {
    console.error('[Shop] Product fetch error:', err);
    await ctx.editMessageText(
      '❌ Could not load product details. Please try again.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'shop_back')]])
    );
  }
});

// ─── Package selection ───
bot.action(/shop_pkg:(.+)/, async (ctx) => {
  const packageId = ctx.match[1];
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);

  if (!session.shopData) return;

  // Find package details from cache
  const products = await getCachedProducts('NG');
  const product = products.find((p: any) => p.id === session.shopData!.productId);
  const pkg = product?.packages?.find((p: any) => p.package_id === packageId);

  session.shopData.amount = pkg?.value || 0;
  session.shopData.currency = pkg?.currency || product?.currency || 'NGN';

  await askForPhoneNumber(ctx, userId);
});

// ─── Amount selection ───
bot.action(/shop_amount:(.+)/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);

  if (!session.shopData) return;

  session.shopData.amount = amount;

  const products = await getCachedProducts('NG');
  const product = products.find((p: any) => p.id === session.shopData!.productId);
  session.shopData.currency = product?.currency || 'NGN';

  await askForPhoneNumber(ctx, userId);
});

// ─── Custom amount ───
bot.action('shop_custom_amount', async (ctx) => {
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);

  if (!session.shopData) return;

  session.state = ConversationState.AWAITING_SHOP_AMOUNT;

  await ctx.editMessageText(
    `🛒 *${session.shopData.productName}*\n\n` +
    `Enter the amount you want to buy (in ${session.shopData.currency || 'NGN'}):`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Handle custom amount text input ───
bot.use(async (ctx, next) => {
  if (!ctx.message || !('text' in ctx.message)) return next();

  const userId = ctx.from!.id.toString();
  const session = getSession(userId);

  if (session.state === ConversationState.AWAITING_SHOP_AMOUNT) {
    const text = ctx.message.text.trim().replace(/,/g, '');
    const amount = parseFloat(text);

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Please enter a valid amount.', mainMenu);
      return;
    }

    session.shopData!.amount = amount;
    session.state = ConversationState.IDLE;

    const products = await getCachedProducts('NG');
    const product = products.find((p: any) => p.id === session.shopData!.productId);
    session.shopData!.currency = product?.currency || 'NGN';

    await askForPhoneNumber(ctx, userId);
    return;
  }

  return next();
});

// ─── Ask for phone number ───
async function askForPhoneNumber(ctx: ZendContext, userId: string) {
  const session = getSession(userId);
  session.state = ConversationState.AWAITING_SHOP_PHONE;

  const isAirtime = session.shopData?.category === 'refill' ||
                    session.shopData?.productName?.toLowerCase().includes('mtn') ||
                    session.shopData?.productName?.toLowerCase().includes('airtel');

  await ctx.reply(
    `🛒 *${session.shopData!.productName}*\n\n` +
    `Amount: *${session.shopData!.currency} ${session.shopData!.amount!.toLocaleString()}*\n\n` +
    `${isAirtime ? '📱 Enter the phone number to recharge:' : '📧 Enter your email (optional) or type "skip":'}`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

// ─── Handle phone number input ───
bot.use(async (ctx, next) => {
  if (!ctx.message || !('text' in ctx.message)) return next();

  const userId = ctx.from!.id.toString();
  const session = getSession(userId);

  if (session.state === ConversationState.AWAITING_SHOP_PHONE) {
    const text = ctx.message.text.trim();

    if (text === '❌ Cancel') {
      session.state = ConversationState.IDLE;
      session.shopData = undefined;
      await ctx.reply('❌ Order cancelled.', mainMenu);
      return;
    }

    // Simple phone validation for Nigeria
    const phoneRegex = /^\+?234\d{10}$|^0\d{10}$/;
    const isAirtime = session.shopData?.category === 'refill' ||
                      session.shopData?.productName?.toLowerCase().includes('mtn') ||
                      session.shopData?.productName?.toLowerCase().includes('airtel');

    if (isAirtime && !phoneRegex.test(text)) {
      await ctx.reply(
        '❌ Please enter a valid Nigerian phone number.\n\n' +
        'Examples: `+2348012345678` or `08012345678`',
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      return;
    }

    session.shopData!.phoneNumber = text;
    session.state = ConversationState.IDLE;

    await showShopConfirm(ctx, userId);
    return;
  }

  return next();
});

// ─── Show order confirmation ───
async function showShopConfirm(ctx: ZendContext, userId: string) {
  const session = getSession(userId);
  const sd = session.shopData!;

  await ctx.reply('⏳ Calculating price...');

  try {
    const cachedProducts = await getCachedProducts('NG');
    const product = cachedProducts.find((p: any) => p.id === sd.productId);
    const pkg = product?.packages?.find((p: any) => p.value === sd.amount);

    // Calculate BitRefill price in USD
    let bitrefillPriceUsd = 0;
    if (pkg) {
      const isNgnPrice = pkg.price_currency === 'NGN' || product.currency === 'NGN';
      if (isNgnPrice) {
        // Convert NGN price to USD using live PAJ rate
        let ngnRate = 1550;
        try {
          const rates = await getPAJRates();
          ngnRate = rates.offRampRate;
        } catch { /* use fallback */ }
        bitrefillPriceUsd = pkg.price / ngnRate;
      } else {
        bitrefillPriceUsd = pkg.price;
      }
    } else if (product?.range && sd.amount) {
      // Estimate: use amount as proxy for USD (NGN is ~1600:1, but BitRefill might price differently)
      // For variable products, we'll need to create an invoice to get exact price
      let ngnRate = 1600;
      try {
        const rates = await getPAJRates();
        ngnRate = rates.offRampRate;
      } catch { /* use fallback */ }
      bitrefillPriceUsd = sd.amount / ngnRate;
    }

    // Add Zend margin
    const marginMultiplier = 1 + BITREFILL_MARKUP_BPS / 10000;
    const totalUsdt = bitrefillPriceUsd * marginMultiplier;

    sd.bitrefillPriceUsd = bitrefillPriceUsd;
    sd.totalUsdt = totalUsdt;

    const canUseBalance = !!bitrefillBusinessClient && !!ZEND_TREASURY_WALLET;

    const buttons: any[] = [];
    if (canUseBalance) {
      buttons.push([Markup.button.callback(`✅ Pay $${totalUsdt.toFixed(2)} USDT`, 'shop_pay_balance')]);
    }
    buttons.push([Markup.button.callback('💳 Pay with Crypto (External)', 'shop_pay_crypto')]);
    buttons.push([Markup.button.callback('❌ Cancel', 'shop_cancel')]);

    await ctx.reply(
      `🧾 *Order Summary*\n\n` +
      `Product: ${sd.productName}\n` +
      `Amount: ${sd.currency} ${sd.amount?.toLocaleString()}\n` +
      `${sd.phoneNumber ? `Phone: \`${sd.phoneNumber}\`\n` : ''}` +
      `\n` +
      `Base Price: ~$${bitrefillPriceUsd.toFixed(2)} USDT\n` +
      `Zend Fee (${(BITREFILL_MARKUP_BPS / 100).toFixed(2)}%): ~$${(totalUsdt - bitrefillPriceUsd).toFixed(4)} USDT\n` +
      `*Total: $${totalUsdt.toFixed(2)} USDT*\n\n` +
      `${canUseBalance
        ? 'Pay instantly from your Zend balance — no external wallet needed.'
        : 'Pay directly with your crypto wallet.'}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  } catch (err: any) {
    console.error('[Shop] Confirm error:', err);
    await ctx.reply('❌ Could not calculate price. Please try again.', mainMenu);
    session.shopData = undefined;
  }
}

// ─── Pay with Zend Balance (Phase 2) ───
bot.action('shop_pay_balance', async (ctx) => {
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  const sd = session.shopData;

  if (!sd || !bitrefillBusinessClient || !ZEND_TREASURY_WALLET) {
    await ctx.answerCbQuery('Not available');
    return;
  }

  await ctx.answerCbQuery('Processing...');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user.length) {
      await ctx.reply('❌ User not found.', mainMenu);
      session.shopData = undefined;
      return;
    }

    const walletAddress = user[0].walletAddress;

    // Check USDT balance
    const usdtBalance = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
    if (usdtBalance < (sd.totalUsdt || 0)) {
      await ctx.reply(
        `❌ *Insufficient Balance*\n\n` +
        `You need *$${(sd.totalUsdt || 0).toFixed(2)} USDT* but only have *$${usdtBalance.toFixed(2)} USDT*.\n\n` +
        `Tap 💵 *Add Naira* or 📥 *Receive* to top up.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      session.shopData = undefined;
      return;
    }

    // Check SOL for gas
    const hasGas = await walletService.hasEnoughSolForGas(walletAddress, MIN_SOL_FOR_GAS);
    if (!hasGas) {
      const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
      await walletService.sendSol(devKeypair, walletAddress, MIN_SOL_FOR_GAS);
      console.log('[Gas] Funded SOL for shop purchase');
    }

    // Deduct USDT from user wallet → treasury
    const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    await ctx.reply('⏳ Sending USDT payment...');
    const txHash = await walletService.sendUsdt(keypair, ZEND_TREASURY_WALLET, sd.totalUsdt || 0);
    console.log('[Shop] USDT payment sent:', txHash);

    // Create BitRefill invoice with auto_pay
    await ctx.reply('⏳ Fulfilling your order via BitRefill...');

    const products: any[] = [{
      product_id: sd.productId,
      quantity: 1,
    }];

    const cachedProducts = await getCachedProducts('NG');
    const product = cachedProducts.find((p: any) => p.id === sd.productId);
    const pkg = product?.packages?.find((p: any) => p.value === sd.amount);

    if (pkg) {
      products[0].package_id = pkg.package_id;
    } else {
      products[0].value = sd.amount;
    }

    if (sd.phoneNumber && sd.phoneNumber !== 'skip') {
      products[0].phone_number = sd.phoneNumber;
    }

    const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || '';
    const webhookUrl = webhookBaseUrl ? `${webhookBaseUrl.replace(/\/$/, '')}/webhooks/bitrefill` : undefined;

    const invoice = await bitrefillBusinessClient.createInvoice({
      products,
      payment_method: 'balance',
      auto_pay: true,
      webhook_url: webhookUrl,
      email: user[0]?.email || undefined,
    });

    // Save order
    await db.insert(bitrefillOrders).values({
      userId,
      bitrefillInvoiceId: invoice.id,
      productId: sd.productId!,
      productName: sd.productName!,
      category: sd.category || 'refill',
      amountFiat: String(sd.amount || 0),
      currencyFiat: sd.currency,
      amountCrypto: String(sd.totalUsdt || 0),
      cryptoCurrency: 'USDT',
      status: invoice.status === 'complete' ? 'complete' : 'pending',
      recipientPhone: sd.phoneNumber,
      recipientEmail: user[0]?.email,
      metadata: invoice,
    });

    // If invoice is already complete, deliver immediately
    if (invoice.status === 'complete' && invoice.orders?.length) {
      const orderId = invoice.orders[0].id;
      const order = await bitrefillBusinessClient.getOrder(orderId);

      await db.update(bitrefillOrders)
        .set({
          status: 'complete',
          codes: order.redemption_info ? [order.redemption_info] : [],
          completedAt: new Date(),
        })
        .where(eq(bitrefillOrders.bitrefillInvoiceId, invoice.id));

      const codeText = order.redemption_info
        ? order.redemption_info.pin
          ? `Code: \`${order.redemption_info.code}\`\nPin: \`${order.redemption_info.pin}\``
          : `Code: \`${order.redemption_info.code}\``
        : '✅ Your order has been fulfilled.';

      await ctx.reply(
        `🎉 *Order Complete!*\n\n` +
        `${sd.productName}\n` +
        `${sd.currency} ${sd.amount?.toLocaleString()}\n\n` +
        `${codeText}\n\n` +
        `Paid: $${(sd.totalUsdt || 0).toFixed(2)} USDT\n` +
        `Ref: \`${invoice.id}\``,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } else {
      await ctx.reply(
        `⏳ *Order Processing*\n\n` +
        `${sd.productName}\n` +
        `Amount: ${sd.currency} ${sd.amount?.toLocaleString()}\n\n` +
        `Paid: $${(sd.totalUsdt || 0).toFixed(2)} USDT\n` +
        `You'll receive a notification when it's ready.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }

    session.shopData = undefined;

  } catch (err: any) {
    console.error('[Shop] Balance payment failed:', err);
    await ctx.reply(
      `❌ *Payment Failed*\n\n` +
      `Error: ${err.message || 'Unknown error'}\n\n` +
      `If USDT was deducted, it will be refunded. Please try again.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    session.shopData = undefined;
  }
});

// ─── Pay with Crypto (Phase 1 fallback) ───
bot.action('shop_pay_crypto', async (ctx) => {
  const userId = ctx.from!.id.toString();
  await ctx.answerCbQuery('Creating invoice...');
  await createBitRefillInvoice(ctx, userId);
});

// ─── Cancel order ───
bot.action('shop_cancel', async (ctx) => {
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  session.shopData = undefined;
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Order cancelled.');
});

// ─── Create invoice (Phase 1 — direct crypto payment) ───
async function createBitRefillInvoice(ctx: ZendContext, userId: string) {
  const session = getSession(userId);
  const sd = session.shopData!;

  const client = bitrefillClient || bitrefillBusinessClient;
  if (!client) {
    await ctx.reply('❌ Shop is not configured. Please try again later.', mainMenu);
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const email = user[0]?.email || undefined;

  await ctx.reply('⏳ Creating your invoice...');

  try {
    const products: any[] = [{
      product_id: sd.productId,
      quantity: 1,
    }];

    const cachedProducts = await getCachedProducts('NG');
    const product = cachedProducts.find((p: any) => p.id === sd.productId);
    const pkg = product?.packages?.find((p: any) => p.value === sd.amount);

    if (pkg) {
      products[0].package_id = pkg.package_id;
    } else {
      products[0].value = sd.amount;
    }

    if (sd.phoneNumber && sd.phoneNumber !== 'skip') {
      products[0].phone_number = sd.phoneNumber;
    }

    const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || '';
    const webhookUrl = webhookBaseUrl ? `${webhookBaseUrl.replace(/\/$/, '')}/webhooks/bitrefill` : undefined;

    const invoice = await client.createInvoice({
      products,
      payment_method: 'bitcoin',
      refund_address: user[0]?.walletAddress,
      webhook_url: webhookUrl,
      email,
    });

    await db.insert(bitrefillOrders).values({
      userId,
      bitrefillInvoiceId: invoice.id,
      productId: sd.productId!,
      productName: sd.productName!,
      category: sd.category || 'refill',
      amountFiat: String(sd.amount || 0),
      currencyFiat: sd.currency,
      status: 'pending',
      recipientPhone: sd.phoneNumber,
      recipientEmail: email,
      paymentAddress: invoice.payment?.address,
      paymentUri: invoice.payment?.BIP21,
      cryptoCurrency: invoice.crypto_currency || invoice.payment?.currency,
      amountCrypto: invoice.crypto_amount || invoice.payment?.amount,
      metadata: invoice,
    });

    const paymentText = invoice.payment?.BIP21
      ? `[Pay with Bitcoin](${invoice.payment.BIP21})`
      : invoice.payment?.address
        ? `Address: \`${invoice.payment.address}\``
        : 'Payment details will be sent shortly.';

    await ctx.reply(
      `🧾 *Invoice Created*\n\n` +
      `Product: ${sd.productName}\n` +
      `Amount: ${sd.currency} ${sd.amount?.toLocaleString()}\n` +
      `${sd.phoneNumber ? `Phone: \`${sd.phoneNumber}\`\n` : ''}` +
      `\n` +
      `*Payment Required:*\n` +
      `Amount: ${invoice.crypto_amount || invoice.payment?.amount || '...'} ${invoice.crypto_currency || invoice.payment?.currency || 'BTC'}\n` +
      `${paymentText}\n\n` +
      `⏱️ Your order will be processed once payment is confirmed.\n` +
      `You'll receive a notification here when it's ready.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );

    session.shopData = undefined;

  } catch (err: any) {
    console.error('[Shop] Invoice creation failed:', err);
    await ctx.reply(
      `❌ *Order Failed*\n\n` +
      `Could not create invoice.\n` +
      `Error: ${err.message || 'Unknown error'}\n\n` +
      `Please try again later.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    session.shopData = undefined;
  }
}

// ─── My Orders ───
bot.action('shop_orders', async (ctx) => {
  const userId = ctx.from!.id.toString();

  await ctx.answerCbQuery('Loading orders...');

  const orders = await db.select().from(bitrefillOrders)
    .where(eq(bitrefillOrders.userId, userId))
    .orderBy(bitrefillOrders.createdAt)
    .limit(10);

  if (!orders.length) {
    await ctx.editMessageText(
      '📦 *My Orders*\n\n' +
      'You have no orders yet.\n\n' +
      'Tap 🎁 *Shop* to get started!',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
        [Markup.button.callback('🎁 Go to Shop', 'shop_back')],
      ]) }
    );
    return;
  }

  let msg = '📦 *My Orders*\n\n';
  const buttons: any[] = [];

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const statusEmoji = o.status === 'complete' ? '✅' : o.status === 'pending' ? '⏳' : '❌';
    msg += `${i + 1}. ${statusEmoji} *${o.productName}* — ${o.currencyFiat} ${o.amountFiat}\n`;
    if (o.status === 'complete' && o.codes) {
      buttons.push([Markup.button.callback(`📋 Copy ${o.productName} Code`, `shop_copy:${o.id}`)]);
    }
  }

  buttons.push([Markup.button.callback('⬅️ Back to Shop', 'shop_back')]);

  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// ─── Copy code from order ───
bot.action(/shop_copy:(.+)/, async (ctx) => {
  const orderId = parseInt(ctx.match[1]);
  const userId = ctx.from!.id.toString();

  const orders = await db.select().from(bitrefillOrders)
    .where(and(eq(bitrefillOrders.id, orderId), eq(bitrefillOrders.userId, userId)))
    .limit(1);

  if (!orders.length) {
    await ctx.answerCbQuery('Order not found');
    return;
  }

  const codes = orders[0].codes as any[];
  if (!codes?.length) {
    await ctx.answerCbQuery('No code available');
    return;
  }

  const codeText = codes.map((c: any) => c.pin ? `${c.code} (Pin: ${c.pin})` : c.code).join('\n');

  await ctx.reply(
    `📋 *Your Code*\n\n` +
    `${orders[0].productName}\n\n` +
    `\`${codeText}\``,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCbQuery('Code sent!');
});

// ─── Back button ───
bot.action('shop_back', async (ctx) => {
  await ctx.answerCbQuery();
  await showShop(ctx);
});

// ─── Export key helper (called after PIN is verified) ───
async function doExportKey(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  try {
    const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);

    const msg = await ctx.reply(
      `🔑 *Secret Recovery Code*\n\n` +
      `⚠️ *SECURITY WARNING*\n` +
      `Never share this with anyone. Zend will NEVER ask for it.\n\n` +
      `*Your Secret Code:*\n\n` +
      `${bs58.encode(secretKey)}\n\n` +
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
    await ctx.reply('❌ Could not export secret code. Please contact support.', mainMenu);
  }
}

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
      const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : bal.symbol === 'AUDD' ? '🇦🇺' : '🟡';
      msg += `${emoji} *${bal.symbol}*  ${formatBalance(bal.amount, bal.symbol)}  (≈${formatNgn(ngnEquiv)})\n`;
    }

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💵 Total: ≈${formatNgn(totalNgn)}\n`;
    msg += `📈 Rate: ${formatNgn(offRampRate)} per Dollar`;
    return msg;
  } catch (err: any) {
    console.error('Balance error:', err);
    const isRateLimit = err?.message?.includes('429') || err?.message?.includes('Too many requests');
    if (isRateLimit) {
      return `⏳ *Rate Limited*\n\nThe Solana network is busy right now. Please wait a few seconds and tap *Balance* again.`;
    }
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

async function startAddNaira(ctx: ZendContext, userId: string) {
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
  setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT, onrampTargetToken: 'USDT' });

  await ctx.reply(
    `💵 *Add Naira*\n\n` +
    `How much NGN do you want to add?\n\n` +
    `Minimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n\n` +
    `Enter the amount (numbers only):`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

bot.hears('💵 Add Naira', async (ctx) => {
  await startAddNaira(ctx, ctx.from.id.toString());
});

bot.action('add_naira_start', async (ctx) => {
  await ctx.answerCbQuery();
  await startAddNaira(ctx, ctx.from!.id.toString());
});

// ═════════════════════════════════════════════════════════════════════════════
// 🇦🇺 ADD AUDD (On-Ramp with hidden USDT→AUDD swap)
// ═════════════════════════════════════════════════════════════════════════════

async function startAddAudd(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const pajClient = await getPAJClient();
  if (!pajClient) {
    await ctx.reply('❌ PAJ service is not configured. Please contact support.', mainMenu);
    return;
  }

  setSession(userId, { state: ConversationState.AWAITING_ONRAMP_AMOUNT, onrampTargetToken: 'AUDD' });

  await ctx.reply(
    `🇦🇺 *Add AUDD*\n\n` +
    `How much NGN do you want to deposit?\n\n` +
    `You'll receive Australian Digital Dollars (AUDD) in your wallet.\n\n` +
    `Minimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n\n` +
    `Enter the amount (numbers only):`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

bot.command('addaudd', async (ctx) => {
  await startAddAudd(ctx, ctx.from.id.toString());
});

bot.action('add_aud_start', async (ctx) => {
  await ctx.answerCbQuery();
  await startAddAudd(ctx, ctx.from!.id.toString());
});

// Handle PAJ email/phone input
bot.on(message('text'), async (ctx, next) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;
  const session = getSession(userId);

  // ─── Pass menu buttons to bot.hears() handlers ───
  const menuButtons = ['💰 Balance', '📤 Send', '📥 Receive', '🔄 Swap', '🎁 Shop', '📋 History', '⚙️ Settings', '🌐 Community'];
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

  // ─── ADMIN: SEARCH TRANSACTION ───
  if (session.state === ConversationState.AWAITING_ADMIN_TXN_SEARCH) {
    setSession(userId, { state: ConversationState.IDLE });
    const txnId = text.trim().toUpperCase();
    const txnRows = await db.select().from(transactions).where(eq(transactions.id, txnId)).limit(1);
    if (txnRows.length === 0) {
      await ctx.reply('❌ Transaction not found. Try again or tap 🔍 Search to go back.', adminSearchKeyboard);
      return;
    }
    const detailText = await buildTxnDetailText(txnRows[0]);
    const buttons = [
      [Markup.button.callback('👤 View User', `admin_user:${txnRows[0].userId}`)],
      [Markup.button.callback('🔍 New Search', 'admin_page:search')],
    ];
    await ctx.reply(detailText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    return;
  }

  // ─── ADMIN: SEARCH USER ───
  if (session.state === ConversationState.AWAITING_ADMIN_USER_SEARCH) {
    setSession(userId, { state: ConversationState.IDLE });
    const query = text.trim();
    let targetId = query;
    if (query.startsWith('@')) targetId = query.slice(1);

    // Try exact ID match first
    let userRows = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    // Fallback to username match (case-insensitive via sql)
    if (userRows.length === 0) {
      userRows = await db.select().from(users).where(sql`LOWER(${users.telegramUsername}) = LOWER(${targetId})`).limit(1);
    }
    if (userRows.length === 0) {
      await ctx.reply('❌ User not found. Try again or tap 🔍 Search to go back.', adminSearchKeyboard);
      return;
    }
    const detailText = await buildUserDetailText(userRows[0]);
    const buttons = [
      [Markup.button.url('💬 Open Chat', `tg://user?id=${userRows[0].id}`)],
      [Markup.button.callback('🔍 New Search', 'admin_page:search')],
    ];
    await ctx.reply(detailText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    return;
  }

  // ─── ADMIN: SET AMBASSADOR REFERRAL CODE ───
  if (session.state === ConversationState.AWAITING_ADMIN_SET_AMBASSADOR_CODE) {
    setSession(userId, { state: ConversationState.IDLE });
    const ambId = parseInt((session as any).pendingTransaction?.recipientName || '0', 10);
    if (!ambId) {
      await ctx.reply('❌ Something went wrong. Please try again.', adminMainKeyboard);
      return;
    }

    const code = text.trim().toLowerCase().replace(/\s+/g, '');
    if (!code || code.length < 3 || code.length > 50) {
      await ctx.reply('❌ Code must be 3–50 characters. Try again.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `admin_ambassador_detail:${ambId}`)]]));
      return;
    }

    // Check uniqueness
    const existing = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.customReferralCode, code)).limit(1);
    if (existing.length > 0 && existing[0].id !== ambId) {
      await ctx.reply('❌ That code is already taken. Try another.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `admin_ambassador_detail:${ambId}`)]]));
      return;
    }

    await db.update(ambassadorApplications).set({ customReferralCode: code }).where(eq(ambassadorApplications.id, ambId));
    await ctx.reply(
      `✅ Referral code updated!\n\n` +
      `Ambassador link:\n` +
      `\`t.me/ZendBot?start=${code}\``,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]) }
    );
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
    if (amount > PAJ_MAX_DEPOSIT_NGN) {
      await ctx.reply(
        `❌ Amount too large.\n` +
        `Maximum deposit is ${formatNgn(PAJ_MAX_DEPOSIT_NGN)}.`,
        cancelKeyboard
      );
      return;
    }

    const pajClient = await getPAJClient();
    if (!pajClient) {
      await ctx.reply('❌ Service temporarily unavailable. Please try again later.', mainMenu);
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
      const targetToken = session.onrampTargetToken || 'USDT';
      setSession(userId, { state: ConversationState.IDLE, onrampAmount: amount, onrampTargetToken: targetToken });
      await showVirtualAccount(ctx, userId, user[0].pajSessionToken!, amount, rate, feeNgn, targetToken);
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
      `You receive: ~${usdtAmount.toFixed(2)} Dollars\n\n` +
      `🔐 *Identity Verification*\n\n` +
      `Enter your email or phone number (with country code):\n` +
      `Example: user@email.com or +2348012345678`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
    return;
  }

  // ─── BRIDGE: AWAITING_BRIDGE_AMOUNT ───
  if (session.state === ConversationState.AWAITING_BRIDGE_AMOUNT) {
    const bd = session.bridgeData;
    if (!bd) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired. Please start over.', mainMenu);
      return;
    }

    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Please enter a valid amount. Example: 10, 50, 100', cancelKeyboard);
      return;
    }

    const decimals = TOKEN_DECIMALS[bd.sourceChain]?.[bd.token] || 6;
    const baseAmount = Math.floor(amount * Math.pow(10, decimals)).toString();

    const chainRails = getChainRailsClient();
    if (!chainRails) {
      await ctx.reply('❌ ChainRails not configured.', mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0) {
      await ctx.reply('❌ User not found. Run /start first.', mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }

    try {
      await ctx.reply('⏳ Generating deposit address...');

      // Get quote for fee estimate
      let quote: any = null;
      try {
        quote = await chainRails.getBestQuote({
          tokenIn: bd.tokenIn,
          tokenOut: TOKEN_ADDRESSES.SOLANA_MAINNET.USDT,
          sourceChain: bd.sourceChain,
          destinationChain: 'SOLANA_MAINNET',
          amount: baseAmount,
          amountSymbol: bd.token,
          recipient: user[0].walletAddress,
        });
      } catch (quoteErr: any) {
        console.log('[Bridge] Quote failed (non-critical):', quoteErr.message);
      }

      // Create intent with user-specified amount
      console.log('[Bridge] Creating intent:', {
        sourceChain: bd.sourceChain,
        token: bd.token,
        amount: baseAmount,
        recipient: user[0].walletAddress,
      });

      const intent = await chainRails.createIntent({
        amount: baseAmount,
        amountSymbol: bd.token,
        tokenIn: bd.tokenIn,
        sourceChain: bd.sourceChain,
        destinationChain: 'SOLANA_MAINNET',
        recipient: user[0].walletAddress,
        metadata: {
          userId,
          telegramUserId: userId,
          sourceChain: bd.sourceChain,
          token: bd.token,
          originalAmount: amount.toString(),
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
        fromAmount: amount.toString(),
        fromMint: bd.tokenIn,
        toMint: TOKEN_ADDRESSES.SOLANA_MAINNET.USDT,
      });

      const chainDisplay = CHAIN_NAMES[bd.sourceChain] || bd.sourceChain;
      const tokenDecimals = TOKEN_DECIMALS[bd.sourceChain]?.[bd.token] || 6;
      const actualFeeRaw = intent.fees_in_asset_token || intent.app_fee_in_asset_token;
      const actualFee = actualFeeRaw ? (Number(actualFeeRaw) / Math.pow(10, tokenDecimals)).toFixed(6) : null;
      const feeLine = actualFee
        ? `• Fee: ~${actualFee} ${bd.token}\n`
        : quote?.totalFeeFormatted
          ? `• Est. fee: ~${quote.totalFeeFormatted} ${bd.token}\n`
          : '';

      await ctx.reply(
        `🌉 *Receive ${bd.token} from ${chainDisplay}*\n\n` +
        `Send *${amount} ${bd.token}* to this address:\n\n` +
        `${intent.intent_address}\n\n` +
        `⚠️ *Important:*\n` +
        `• Only send ${bd.token} on ${chainDisplay}\n` +
        `• You'll receive Dollars (USDT) in your Zend account\n` +
        feeLine +
        `• Expires: ${new Date(intent.expires_at).toLocaleString('en-NG')}\n\n` +
        `Reference: \`${txId}\``,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      await ctx.reply('📋 Tap to copy the address:', Markup.inlineKeyboard([
        [{ text: '📋 Copy Address', copy_text: { text: intent.intent_address } } as any]
      ]));
    } catch (err: any) {
      console.error('[Bridge] Failed:', err);
      await ctx.reply(
        `❌ *Receive Error*\n\n` +
        `Could not generate deposit address.\n` +
        `Error: ${err.message || 'Unknown error'}\n\n` +
        `Please try again later or contact support.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }

    setSession(userId, { state: ConversationState.IDLE });
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
          `❌ *Service Error*\n\n` +
          `Could not send verification code. We're experiencing issues with phone number processing.\n\n` +
          `Try these options:\n` +
          `1. Use your email instead of phone number\n` +
          `2. Try again in a few minutes\n` +
          `3. Contact support if the issue persists`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
      } else if (errorMsg.includes('Can\'t find business') || errorMsg.includes('business')) {
        await ctx.reply(
          `❌ *Service Error*\n\n` +
          `Our payment partner is temporarily unavailable.\n` +
          `Please try again in a few minutes or contact support.`,
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
      const targetToken = session.onrampTargetToken || 'USDT';
      if (onrampAmount) {
        // Get rate for the pending amount
        let rate = 1550;
        let fee = 0;
        try {
          const rateData = await pajClient.getRateByAmount(onrampAmount);
          rate = rateData.rate.rate;
          fee = (rateData as any).fee || 0;
        } catch (err) {
          console.log('Using fallback rate for on-ramp after verify');
        }
        await showVirtualAccount(ctx, userId, verified.token, onrampAmount, rate, fee, targetToken);
      } else {
        await showVirtualAccount(ctx, userId, verified.token, undefined, undefined, undefined, targetToken);
      }
    } catch (err: any) {
      console.error('[PAJ] Verify failed:', err);
      const errorMsg = err.message || '';

      if (errorMsg.includes('No recipients defined') || errorMsg.includes('recipients')) {
        await ctx.reply(
          `❌ *Service Error*\n\n` +
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
    const solPrice = await getSolPriceInUsdt();
    const feeSol = zendFeeUsdt / solPrice;

    session.pendingTransaction = {
      ...session.pendingTransaction,
      amountNgn: amount,
      amountUsdt: usdtNeeded,
      zendFeeUsdt,
      feeSol,
    };
    session.state = ConversationState.AWAITING_SEND_RECIPIENT;
    setSession(userId, session);

    let msg = `📤 Send ${formatNgn(amount)}\n` +
      `Rate: ${formatNgn(rate)} per Dollar\n` +
      `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${feeSol.toFixed(6)} SOL (~${zendFeeUsdt.toFixed(2)} USDT)\n` +
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
      verifyMsg = await showLoading(ctx, 'Verifying account...');
      const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, accountNumber, userId);
      if (verification.verified && verification.accountName) {
        verifiedName = verification.accountName;
        verifiedStatus = 'verified';
      } else if (verification.sessionExpired) {
        await ctx.reply(
          `⚠️ *PAJ Session Expired*\n\n` +
          `Your bank verification link has expired.\n` +
          `Please go to *⚙️ Settings → 🔗 Link PAJ* to reconnect.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        session.state = ConversationState.IDLE;
        session.pendingTransaction = undefined;
        setSession(userId, session);
        return;
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
      confirmMsg += `✅ *Account Verified*\n`;
    } else if (verifiedStatus === 'no_paj') {
      confirmMsg += `⚠️ *Account Not Verified* (verify identity in Settings)\n`;
    } else {
      confirmMsg += `⚠️ *Could not verify account* — please double-check details\n`;
    }

    const zendFeeBps = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
    const feeLine = session.pendingTransaction?.feeSol
      ? `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${session.pendingTransaction.feeSol.toFixed(6)} SOL (~${session.pendingTransaction.zendFeeUsdt?.toFixed(2)} USDT)\n`
      : '';

    const menuFromMint = session.pendingTransaction?.fromMint || SOLANA_TOKENS.USDT.mint;
    const menuFromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === menuFromMint) || SOLANA_TOKENS.USDT;
    confirmMsg += `\n` +
      `Amount: *${formatNgn(amountNgn!)}*\n` +
      `To: *${md(verifiedName)}*\n` +
      `Bank: *${md(bank.name)}*\n` +
      `Account: \`${accountNumber}\`\n\n` +
      feeLine +
      `You pay: *${amountUsdt!.toFixed(2)} ${menuFromToken.symbol}*\n` +
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
          const features = await getBotFeatures();
          const reply = await chatWithKimi(
            `The user said: "${text}". They want to send money but didn't specify an amount. ` +
            `Respond conversationally in Nigerian Pidgin style. Ask how much they want to send.`,
            features
          );
          await ctx.reply(escapeTelegramMarkdown(reply?.reply || 'How much do you want to send?'), { parse_mode: 'Markdown', ...cancelKeyboard });
          setSession(userId, { state: ConversationState.AWAITING_SEND_AMOUNT, pendingTransaction: { recipientName: parsed.recipientName } });
          return;
        }
        if (parsed.amount < 100) {
          const features = await getBotFeatures();
          const reply = await chatWithKimi(
            `The user wants to send ${parsed.amount} Naira. Minimum is ₦100. ` +
            `Respond in Nigerian Pidgin style telling them the minimum.`,
            features
          );
          await ctx.reply(reply?.reply || `Minimum send amount is ${formatNgn(100)}.`, cancelKeyboard);
          return;
        }
        if (!parsed.accountNumber && !parsed.walletAddress) {
          // We have amount + recipient name but missing bank/account
          const features = await getBotFeatures();
          const reply = await chatWithKimi(
            `The user said: "${text}". I understood they want to send ${formatNgn(parsed.amount)} to ${parsed.recipientName || 'someone'}. ` +
            `But I need the bank name and account number. Respond conversationally in Nigerian Pidgin style.`,
            features
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

        const fromMint = parsed.fromToken === 'USDC' ? SOLANA_TOKENS.USDC.mint :
                           parsed.fromToken === 'SOL' ? SOLANA_TOKENS.SOL.mint :
                           SOLANA_TOKENS.USDT.mint;
        const fromTokenInfo = Object.values(SOLANA_TOKENS).find(t => t.mint === fromMint) || SOLANA_TOKENS.USDT;

        const zendFeeBps = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
        const zendFeeUsdt = (parsed.amount / rate) * (zendFeeBps / 10000);
        const usdtNeeded = (parsed.amount / rate) + zendFeeUsdt;
        const solPrice = await getSolPriceInUsdt();
        const feeSol = zendFeeUsdt / solPrice;

        // ─── Check wallet balance before showing confirmation ───
        if (user[0]?.walletAddress) {
          const tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, fromMint);
          const solBalance = await walletService.getSolBalance(user[0].walletAddress);
          const transferUsdt = parsed.amount / rate;
          if (tokenBalance < transferUsdt) {
            const shortfall = transferUsdt - tokenBalance;
            await ctx.reply(
              `❌ *Insufficient Balance*\n\n` +
              `You want to send ${formatNgn(parsed.amount)}\n` +
              `You need: *${transferUsdt.toFixed(2)} ${fromTokenInfo.symbol}*\n` +
              `You have: *${tokenBalance.toFixed(2)} ${fromTokenInfo.symbol}*\n` +
              `Short by: *${shortfall.toFixed(2)} ${fromTokenInfo.symbol}*\n\n` +
              `Add more Dollars to your wallet or send a smaller amount.`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
            return;
          }
          if (solBalance < feeSol + MIN_SOL_FOR_GAS) {
            await ctx.reply(
              `❌ *Insufficient SOL for fee*\n\n` +
              `Fee: ${feeSol.toFixed(6)} SOL\n` +
              `Gas: ~${MIN_SOL_FOR_GAS} SOL\n` +
              `You have: ${solBalance.toFixed(6)} SOL\n\n` +
              `Top up your SOL balance first.`,
              { parse_mode: 'Markdown', ...mainMenu }
            );
            return;
          }
        }

        // ─── Verify bank account with PAJ ───
        let verifiedName = parsed.recipientName;
        let verifiedStatus: 'verified' | 'unverified' | 'no_paj' = 'unverified';

        if (parsed.bankCode && parsed.accountNumber && user[0]?.pajSessionToken) {
          const verification = await verifyBankAccount(user[0].pajSessionToken, parsed.bankCode, parsed.accountNumber, userId);
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
          feeSol,
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
          msg += `✅ *Account Verified*\n`;
        } else if (verifiedStatus === 'no_paj') {
          msg += `⚠️ *Account Not Verified* (verify identity in Settings)\n`;
        } else {
          msg += `⚠️ *Could not verify account* — please double-check details\n`;
        }

        const fromSymbol = fromTokenInfo.symbol;
        msg += `\n` +
          `To: *${md(verifiedName || 'Recipient')}*\n` +
          `Bank: ${md(parsed.bankName) || 'Solana'}\n` +
          `Account: \`${parsed.accountNumber || parsed.walletAddress}\`\n` +
          `Amount: ${formatNgn(parsed.amount)}\n` +
          `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${feeSol.toFixed(6)} SOL (~${zendFeeUsdt.toFixed(2)} USDT)\n` +
          `You pay: *${usdtNeeded.toFixed(2)} ${fromSymbol}*\n` +
          `Rate: ${formatNgn(rate)} per Dollar\n\n` +
          `Confirm?`;

        const addressToCopy = parsed.accountNumber || parsed.walletAddress;
        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [{ text: '📋 Copy Account/Address', copy_text: { text: addressToCopy } } as any],
            [Markup.button.callback('✅ Confirm', 'confirm_send')],
            [Markup.button.callback('❌ Cancel', 'cancel_send')],
          ]),
        });
        return;
      }

      case 'add_naira': {
        // Simulate clicking Add Naira
        if (parsed.amount && parsed.amount > PAJ_MAX_DEPOSIT_NGN) {
          await ctx.reply(
            `❌ Amount too large.\nMaximum deposit is ${formatNgn(PAJ_MAX_DEPOSIT_NGN)}.`,
            mainMenu
          );
          return;
        }
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
            const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : bal.symbol === 'AUDD' ? '🇦🇺' : '🟡';
            msg += `${emoji} *${bal.symbol}*  ${formatBalance(bal.amount, bal.symbol)}  (≈${formatNgn(ngnEquiv)})\n`;
          }

          msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
          msg += `💵 Total: ≈${formatNgn(totalNgn)}\n`;
          msg += `📈 Rate: ${formatNgn(offRampRate)} per Dollar`;

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
        const features = await getBotFeatures();
        const aiReply = await chatWithKimi(text, features);
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

    const hashed = await hashPin(pin);
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

    const result = await verifyPin(pin, user[0].transactionPin);
    if (!result.valid) {
      await ctx.reply('❌ Incorrect PIN. Please try again.', cancelKeyboard);
      return;
    }

    // Auto-migrate legacy plaintext PIN to hashed
    if (result.isLegacy) {
      await db.update(users)
        .set({ transactionPin: await hashPin(pin) })
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
        feeSol: pt.feeSol,
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
        `To: ${md(sd.recipientName)}\n` +
        `Bank: ${md(sd.bankName)}\n` +
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
    // Parse "BANK_NAME ACCOUNT_NUMBER" or "BANK_NAME • ACCOUNT_NUMBER"
    const cleanText = text.replace(/[•,]/g, ' ').trim();
    const parts = cleanText.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('❌ Please enter bank name and account number.\nExample: GTB 0123456789', cancelKeyboard);
      return;
    }
    const accountNumber = parts[parts.length - 1].replace(/\D/g, '');
    const bankQuery = parts.slice(0, parts.length - 1).join(' ').toLowerCase();

    if (!/^\d{10}$/.test(accountNumber)) {
      await ctx.reply('❌ Account number must be 10 digits.', cancelKeyboard);
      return;
    }

    // Find bank
    const bank = NIGERIAN_BANKS.find(b =>
      b.name.toLowerCase().includes(bankQuery) ||
      b.code.toLowerCase() === bankQuery ||
      bankQuery.includes(b.name.toLowerCase().split(' ')[0])
    );
    if (!bank) {
      const bankButtons = NIGERIAN_BANKS.map(b => Markup.button.callback(b.name, `schedule_bank:${b.code}`));
      const rows: any[] = [];
      for (let i = 0; i < bankButtons.length; i += 2) {
        rows.push(bankButtons.slice(i, i + 2));
      }
      setSession(userId, {
        state: ConversationState.AWAITING_BANK_DETAILS,
        scheduleData: { pendingAccountNumber: accountNumber },
      });
      await ctx.reply(
        `🏦 Which bank is account \`${accountNumber}\` with?`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
      );
      return;
    }

    // Try to verify account name via PAJ if linked
    let accountName = 'Unknown';
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user[0]?.pajSessionToken) {
      try {
        const verification = await verifyBankAccount(user[0].pajSessionToken, bank.code, accountNumber, userId);
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

    await ctx.reply(
      `✅ *Recipient Saved*\n\n` +
      `Name: ${md(accountName)}\n` +
      `Bank: ${md(bank.name)}\n` +
      `Account: \`${accountNumber}\`\n\n` +
      `How much NGN do you want to send each time?\n` +
      `Example: 50000`,
      { parse_mode: 'Markdown' }
    );
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
      const pinMsg = await ctx.reply(
        `🔐 *Security Check*\n\n` +
        `Enter your 4-digit PIN to confirm this scheduled transfer:`,
        cancelKeyboard
      );
      getSession(userId).lastBotMessageId = pinMsg.message_id;
      return;
    }

    // No PIN — save directly
    await saveScheduledTransfer(userId, sd, startAt);
    setSession(userId, { state: ConversationState.IDLE });

    await ctx.reply(
      `✅ *Scheduled Transfer Created!*\n\n` +
      `To: ${md(sd.recipientName)}\n` +
      `Bank: ${md(sd.bankName)}\n` +
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

  const result = await db.insert(scheduledTransfers).values({
    userId,
    recipientBankAccountId: sd.recipientBankAccountId!,
    amountNgn: sd.amountNgn!.toString(),
    frequency: freq,
    startAt,
    nextRunAt,
    isActive: true,
  }).returning();

  console.log(`[Schedule] Created schedule #${result[0]?.id} for user ${userId}:`, {
    recipientBankAccountId: sd.recipientBankAccountId,
    amountNgn: sd.amountNgn,
    frequency: freq,
    startAt,
    nextRunAt,
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
  fee?: number,
  targetToken: 'USDT' | 'AUDD' = 'USDT'
): Promise<void> {
  const pajClient = await getPAJClient();
  if (!pajClient) {
    await ctx.reply('❌ PAJ service unavailable.', mainMenu);
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const walletAddress = user[0].walletAddress;

  // Use provided amount or default to minimum
  const fiatAmount = amount && amount >= PAJ_MIN_DEPOSIT_NGN && amount <= PAJ_MAX_DEPOSIT_NGN ? amount : PAJ_MIN_DEPOSIT_NGN;

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
  const receiveLabel = targetToken === 'AUDD' ? 'AUDD' : 'Dollars';

  // Check if we have a cached virtual account to reuse (max 24h old)
  let virtualAccount: any = user[0]?.virtualAccount;
  const VA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const webhookUrl = process.env.WEBHOOK_BASE_URL
    ? `${process.env.WEBHOOK_BASE_URL.replace(/\/$/, '')}/webhooks/paj`
    : 'https://example.com/webhook';

  // Always generate a fresh virtual account — PAJ accounts are one-time use
  const loadingVA = await showLoading(ctx, 'Creating your virtual bank account...');
  let order: any;
  try {
    order = await pajClient.createOnramp({
      fiatAmount,
      currency: Currency.NGN,
      recipient: walletAddress,
      mint: SOLANA_TOKENS.USDT.mint,
      chain: Chain.SOLANA,
      webhookURL: webhookUrl,
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

    console.log('[PAJ] Virtual account created:', order.accountNumber, 'for ₦', fiatAmount, 'bank:', order.bank, 'name:', order.accountName, 'orderId:', order.id, 'fullOrder:', JSON.stringify(order));
  } catch (err: any) {
    console.error('[PAJ] createOnramp failed:', err);
    if (isPajSessionError(err)) {
      await clearPajSession(userId);
      await finishLoading(ctx, loadingVA.message_id, '⚠️ Your PAJ session expired. Please re-link in Settings.');
      await ctx.reply(
        `⚠️ *PAJ Session Expired*\n\n` +
        `Go to *⚙️ Settings → 🔗 Link PAJ* to reconnect.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }
    await finishLoading(ctx, loadingVA.message_id, `❌ Could not create virtual account.\nError: ${err.message || 'Unknown error'}`);
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  const txId = generateTxId();
  await db.insert(transactions).values({
    id: txId,
    userId,
    type: 'ngn_receive',
    status: 'pending',
    ngnAmount: String(fiatAmount),
    ngnRate: String(order?.rate || _rate),
    fromAmount: String(order?.amount || usdtAmount),
    pajReference: order.id,
    pajPoolAddress: walletAddress,
    recipientWalletAddress: walletAddress,
    metadata: { virtualAccount, source: 'fresh', targetToken },
  });

  const displayRate = order?.rate || _rate;
  const displayFee = order?.fee || _fee;
  const displayReceive = order?.amount || usdtAmount;

  const isExactAmount = amount && amount >= PAJ_MIN_DEPOSIT_NGN;
  const menuTitle = targetToken === 'AUDD' ? '🇦🇺 Add AUDD' : '💵 Add Naira';
  await ctx.reply(
    `${menuTitle}\n\n` +
    `*Deposit Details:*\n` +
    (isExactAmount ? `Amount: ${formatNgn(fiatAmount)}\n` : `Minimum: ${formatNgn(PAJ_MIN_DEPOSIT_NGN)}\n`) +
    `Rate: ₦${displayRate.toLocaleString()}/USD\n` +
    `Fee: ${formatNgn(displayFee)}\n` +
    `You receive: ~${Number(displayReceive).toFixed(2)} ${receiveLabel}\n\n` +
    `*Send bank transfer to:*\n` +
    `🏦 *${md(virtualAccount.bankName)}*\n` +
    `🔢 \`${virtualAccount.accountNumber}\`\n` +
    `👤 *${md(virtualAccount.accountName)}*\n\n` +
    `⏱️ Arrives in: 2-5 minutes\n\n` +
    `⚠️ *Important:* Send from a bank account in your name.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
  // Send account number as plain text for easy copying
  await ctx.reply(virtualAccount.accountNumber);
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

  // Ask which token to send from
  await ctx.reply(
    `📤 *Send Money*\n\n` +
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
});

bot.action(/send_token:([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const tokenSymbol = ctx.match[1];
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
    feeSol?: number;
    fromMint?: string;
    recipientBankCode?: string;
    recipientBankName?: string;
    recipientAccountNumber?: string;
    recipientAccountName?: string;
    recipientName?: string;
  }
): Promise<{ success: boolean; txId: string; solanaTxHash?: string; offRampRef?: string; error?: string }> {
  const userFromMint = txData.fromMint || SOLANA_TOKENS.USDT.mint;
  const userFromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === userFromMint) || SOLANA_TOKENS.USDT;
  const userFromSymbol = userFromToken.symbol;
  const pajMint = SOLANA_TOKENS.USDT.mint; // PAJ only accepts USDT
  const pajToken = SOLANA_TOKENS.USDT;
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
    fromMint: userFromMint,
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
      throw new Error('Account not found. Please run /start first.');
    }

    const pajClient = await getPAJClient();
    if (pajClient && user[0].pajSessionToken) {
      const pajBanks = await getPajBankList(user[0].pajSessionToken);
      const ourBank = NIGERIAN_BANKS.find(b => b.code === finalBankCode);

      // Use the same robust scoring as verifyBankAccount
      let bestMatch: { bank: any; score: number } | null = null;
      for (const pb of pajBanks) {
        const score = scoreBankMatch(pb.name, finalBankCode);
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { bank: pb, score };
        }
      }

      if (!bestMatch || bestMatch.score < 20) {
        console.log('[PAJ] Available banks for send:', pajBanks.map(b => b.name).join(', '));
        throw new Error(`Bank "${ourBank?.name}" not found on PAJ`);
      }

      const pajBank = bestMatch.bank;
      console.log(`[PAJ] Send bank matched: ${ourBank?.name} → ${pajBank.name} (score: ${bestMatch.score})`);

      const webhookUrl = process.env.WEBHOOK_BASE_URL
        ? `${process.env.WEBHOOK_BASE_URL.replace(/\/$/, '')}/webhooks/paj`
        : 'https://example.com/webhook';
      const order = await pajClient.createOfframp({
        bank: pajBank.id,
        accountNumber: finalAccountNumber,
        currency: Currency.NGN,
        fiatAmount: txData.amountNgn,
        mint: pajMint,
        chain: Chain.SOLANA,
        webhookURL: webhookUrl,
      } as any, user[0].pajSessionToken);

      offRampRef = order.id;
      console.log('[PAJ] Off-ramp order created:', order.id, 'deposit address:', order.address, 'amount:', order.amount);

      let tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, pajMint);

      // Auto-swap AUDD → USDT via local pool (hidden from user)
      if (userFromMint === SOLANA_TOKENS.AUDD.mint) {
        const auddBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.AUDD.mint);
        if (auddBalance <= 0) {
          throw new Error('No AUDD balance. Please deposit AUDD first.');
        }
        const usdtNeeded = order.amount;
        const auddRate = await getAuddPriceInUsdt();
        const auddNeeded = usdtNeeded / auddRate;
        if (auddBalance < auddNeeded) {
          throw new Error(`Not enough AUDD. You have ${auddBalance.toFixed(2)} AUDD but need ${auddNeeded.toFixed(2)} AUDD (rate: 1 AUDD = ${auddRate.toFixed(4)} USDT).`);
        }
        if (!DEV_WALLET_SECRET) {
          throw new Error('AUDD swap not available: dev wallet not configured.');
        }
        const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
        const devUsdtBalance = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.USDT.mint);
        if (devUsdtBalance < usdtNeeded) {
          throw new Error('AUDD swap not available: liquidity pool is low. Please try again later or contact support.');
        }
        const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
        const keypair = Keypair.fromSecretKey(secretKey);
        const swapTxHash = await walletService.executeLocalSwap(
          keypair,
          devKeypair,
          SOLANA_TOKENS.AUDD.mint,
          SOLANA_TOKENS.USDT.mint,
          auddNeeded,
          usdtNeeded,
          SOLANA_TOKENS.AUDD.decimals,
          SOLANA_TOKENS.USDT.decimals,
          user[0].walletAddress // dev sends USDT back to user wallet
        );
        console.log('[LocalSwap] AUDD→USDT:', swapTxHash);
        const swapTxId = generateTxId();
        await db.insert(transactions).values({
          id: swapTxId, userId, type: 'swap', status: 'completed',
          fromMint: SOLANA_TOKENS.AUDD.mint, fromAmount: auddNeeded.toString(),
          toMint: SOLANA_TOKENS.USDT.mint, toAmount: usdtNeeded.toString(),
          solanaTxHash: swapTxHash,
        });
        tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDT.mint);
      }

      // Auto-swap USDC → USDT if needed
      if (tokenBalance < order.amount) {
        const usdcBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDC.mint);
        if (usdcBalance >= order.amount) {
          const swapAmountUsdc = Math.min(usdcBalance, order.amount * 1.03);
          const swapAmountBase = Math.round(swapAmountUsdc * Math.pow(10, SOLANA_TOKENS.USDC.decimals));
          const quote = await getSwapQuote(SOLANA_TOKENS.USDC.mint, SOLANA_TOKENS.USDT.mint, swapAmountBase, 100);
          if (!quote) {
            throw new Error('Exchange not available right now. Please deposit Dollars (USDT).');
          }
          const outAmountUsdt = Number(quote.outAmount) / Math.pow(10, SOLANA_TOKENS.USDT.decimals);
          if (outAmountUsdt < order.amount) {
            throw new Error(`Conversion would only give ${outAmountUsdt.toFixed(2)} Dollars. Deposit more USDT.`);
          }
          const serializedTx = await buildSwapTransaction(quote, user[0].walletAddress, true);
          if (!serializedTx) throw new Error('Failed to build swap transaction.');
          const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
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

      // Pre-calculate potential sponsorship fee so fundSolIfNeeded reserves enough SOL
      const solPrice = await getSolPriceInUsdt();
      const potentialSponsorshipFeeSol = (txData.amountUsdt * (GAS_SPONSORSHIP_FEE_BPS / 10000)) / solPrice;
      const maxFeeSol = (txData.feeSol || 0) + potentialSponsorshipFeeSol;

      // Gas sponsorship: top up exact shortfall (including ATA rent if needed)
      const { funded, gasSponsored, shortfall, error: fundError } = await fundSolIfNeeded(
        user[0].walletAddress,
        maxFeeSol,
        order.address,
        pajMint
      );
      if (shortfall && !funded) {
        throw new Error(
          `Your wallet needs ~${shortfall.toFixed(6)} more SOL for network fees. ` +
          (fundError ? `Auto-funding failed: ${fundError}. ` : '') +
          `Please deposit a small amount of SOL to your Zend wallet, or contact support.`
        );
      }

      // Calculate total fee in SOL (Zend fee + gas sponsorship fee if dev funded)
      const feeWallet = process.env.ZEND_FEE_WALLET;
      let totalFeeSol = txData.feeSol || 0;
      if (gasSponsored) {
        totalFeeSol += potentialSponsorshipFeeSol;
        console.log('[Gas] Sponsorship fee added:', potentialSponsorshipFeeSol.toFixed(6), 'SOL. Total fee:', totalFeeSol.toFixed(6), 'SOL');
      }

      // Check token balance covers transfer
      if (tokenBalance < order.amount) {
        throw new Error(`Insufficient ${userFromSymbol} balance. You have: ${tokenBalance.toFixed(2)}, need: ${order.amount.toFixed(2)} for the transfer.`);
      }

      // Build SOL fee transfer instruction to bundle with main send
      const feeInstructions: any[] = [];
      if (feeWallet && totalFeeSol > 0) {
        const feeWalletPubkey = new PublicKey(feeWallet);
        const rawFeeLamports = BigInt(Math.round(totalFeeSol * LAMPORTS_PER_SOL));

        feeInstructions.push(
          SystemProgram.transfer({
            fromPubkey: new PublicKey(user[0].walletAddress),
            toPubkey: feeWalletPubkey,
            lamports: rawFeeLamports,
          })
        );
      }

      const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      solanaTxHash = await walletService.sendSplToken(
        keypair, order.address, pajMint, order.amount, pajToken.decimals,
        feeInstructions.length > 0 ? feeInstructions : undefined,
        order.amount
      );
      console.log(`[Solana] ${userFromSymbol} sent to PAJ via USDT (+ fee bundled):`, solanaTxHash);

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
    if (isPajSessionError(err)) {
      await clearPajSession(userId);
      return { success: false, txId, error: 'Your PAJ session expired. Please re-link in Settings.' };
    }
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
    feeSol?: number;
  }
) {
  const fromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === (txData.fromMint || SOLANA_TOKENS.USDT.mint)) || SOLANA_TOKENS.USDT;
  const processingText =
    `⏳ *Processing...*\n\n` +
    `Sending ${txData.amountUsdt.toFixed(2)} ${fromToken.symbol}\n` +
    `Fee: ${(txData.feeSol || 0).toFixed(6)} SOL\n` +
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
        (solanaTxHash ? `View: [Transaction Details](https://solscan.io/tx/${solanaTxHash})\n` : '') +
        `Time: ~2 minutes`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      // Auto-save recipient for scheduling
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

  await ctx.reply('⏳ Converting...');

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0 || !user[0].walletEncryptedKey) {
      throw new Error('Account not found. Please run /start first.');
    }

    // Gas sponsorship for swaps
    const { funded, gasSponsored, shortfall, error: fundError } = await fundSolIfNeeded(user[0].walletAddress, 0);
    if (shortfall && !funded) {
      throw new Error(
        `Your wallet needs ~${shortfall.toFixed(6)} more SOL for swap fees. ` +
        (fundError ? `Auto-funding failed: ${fundError}. ` : '') +
        `Please deposit a small amount of SOL to your Zend wallet, or contact support.`
      );
    }

    let txHash: string;
    const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    // ─── Local swap (AUDD pairs via dev wallet) ───
    if ((pt as any).isLocalSwap) {
      if (!DEV_WALLET_SECRET) throw new Error('Dev wallet not configured for local swap.');
      const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
      const fromDecimals = getTokenBySymbol(fromSymbol)!.decimals;
      const toDecimals = getTokenBySymbol(toSymbol)!.decimals;
      const fromAmount = Number(quote.inAmount) / Math.pow(10, fromDecimals);

      await ctx.replyWithChatAction('typing');
      txHash = await walletService.executeLocalSwap(
        keypair,
        devKeypair,
        pt.fromMint!,
        pt.toMint!,
        fromAmount,
        outAmount,
        fromDecimals,
        toDecimals,
        user[0].walletAddress
      );
      console.log('[LocalSwap] Executed:', txHash);

      // Collect gas sponsorship fee for local swaps (0.5% of output value, paid in SOL)
      if (gasSponsored) {
        const feeWallet = process.env.ZEND_FEE_WALLET;
        if (feeWallet) {
          try {
            const solPrice = await getSolPriceInUsdt();
            const sponsorshipFeeSol = (outAmount * (GAS_SPONSORSHIP_FEE_BPS / 10000)) / solPrice;
            await walletService.sendSol(keypair, feeWallet, sponsorshipFeeSol);
            console.log('[Gas] Local swap sponsorship fee collected:', sponsorshipFeeSol.toFixed(6), 'SOL');
          } catch (feeErr: any) {
            console.error('[Gas] Local swap fee collection failed (non-critical):', feeErr.message);
          }
        }
      }
    } else {
      // ─── Jupiter swap (non-AUDD pairs) ───
      const serializedTx = await buildSwapTransaction(quote, user[0].walletAddress, true);
      if (!serializedTx) {
        throw new Error('Failed to build swap transaction');
      }

      await ctx.replyWithChatAction('typing');
      txHash = await walletService.signAndSendSerialized(keypair, serializedTx);
      console.log('[Jupiter] Swap executed:', txHash);

      // Collect gas sponsorship fee for swaps (0.5% of output value, paid in SOL)
      if (gasSponsored) {
        const feeWallet = process.env.ZEND_FEE_WALLET;
        if (feeWallet) {
          try {
            const solPrice = await getSolPriceInUsdt();
            const sponsorshipFeeSol = (outAmount * (GAS_SPONSORSHIP_FEE_BPS / 10000)) / solPrice;
            await walletService.sendSol(keypair, feeWallet, sponsorshipFeeSol);
            console.log('[Gas] Swap sponsorship fee collected:', sponsorshipFeeSol.toFixed(6), 'SOL');
          } catch (feeErr: any) {
            console.error('[Gas] Swap fee collection failed (non-critical):', feeErr.message);
          }
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
      `✅ *Conversion Complete!*\n\n` +
      `${formatTokenAmount(Number(quote.inAmount), getTokenBySymbol(fromSymbol)!.decimals)} ${fromSymbol} → ${outAmount.toFixed(2)} ${toSymbol}\n\n` +
      `View: [Transaction Details](https://solscan.io/tx/${txHash})\n` +
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
  const solPrice = await getSolPriceInUsdt();
  const feeSol = zendFeeUsdt / solPrice;

  // ─── Check wallet balance before showing confirmation ───
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user[0]?.walletAddress) {
    const tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, selectedMint);
    const solBalance = await walletService.getSolBalance(user[0].walletAddress);
    const transferUsdt = amountNgn / rate;
    if (selectedMint === SOLANA_TOKENS.AUDD.mint) {
      // For AUDD, just check they have some — actual swap check happens in executeSendCore
      if (tokenBalance <= 0) {
        await ctx.reply(
          `❌ *No AUDD Balance*\n\n` +
          `You don't have any AUDD to send.\n\n` +
          `Add AUDD to your wallet first.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        return;
      }
    } else if (tokenBalance < transferUsdt) {
      const shortfall = transferUsdt - tokenBalance;
      await ctx.reply(
        `❌ *Insufficient Balance*\n\n` +
        `You want to send ${formatNgn(amountNgn)}\n` +
        `You need: *${transferUsdt.toFixed(2)} ${selectedSymbol}*\n` +
        `You have: *${tokenBalance.toFixed(2)} ${selectedSymbol}*\n` +
        `Short by: *${shortfall.toFixed(2)} ${selectedSymbol}*\n\n` +
        `Add more Dollars to your wallet or send a smaller amount.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }
    if (solBalance < feeSol + MIN_SOL_FOR_GAS) {
      await ctx.reply(
        `❌ *Insufficient SOL for fee*\n\n` +
        `Fee: ${feeSol.toFixed(6)} SOL\n` +
        `Gas: ~${MIN_SOL_FOR_GAS} SOL\n` +
        `You have: ${solBalance.toFixed(6)} SOL\n\n` +
        `Top up your SOL balance first.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }
  }

  // ─── Verify bank account with PAJ ───
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
    `Zend fee (${(zendFeeBps / 100).toFixed(2)}%): ${feeSol.toFixed(6)} SOL (~${zendFeeUsdt.toFixed(2)} USDT)\n` +
    `You pay: *${usdtNeeded.toFixed(2)} ${selectedSymbol}*\n` +
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

  msg += `*🪙 Crypto*\n`;
  msg += `Send Dollars (USDT/USDC), AUDD or SOL to:\n`;
  msg += `${walletAddress}\n\n`;

  if (hasVA) {
    msg += `*🇳🇬 Naira (Bank Transfer)*\n`;
    msg += `Send NGN to your virtual account:\n\n`;
    msg += `🏦 *Bank:* ${virtualAccount.bankName || 'Zend Bank'}\n`;
    msg += `👤 *Name:* ${virtualAccount.accountName || user[0].firstName + ' ' + (user[0].lastName || '')}\n`;
    msg += `🔢 *Number:* \`${virtualAccount.accountNumber}\`\n\n`;
  } else {
    msg += `*🇳🇬 Naira (Bank Transfer)*\n`;
    msg += `You don't have a virtual account yet.\n`;
    msg += `Tap *💵 Add Naira* below to create one.\n\n`;
  }

  msg += `\n*🌉 From Other Apps*\n`;
  msg += `Send Dollars from Binance, MetaMask, Trust Wallet, etc. → receive in your Zend account.\n\n`;

  msg += `💡 *Crypto arrives instantly*\n`;
  msg += `⏱️ *Naira takes 2–5 minutes* after bank transfer`;

  const kbRows: any[] = [];
  kbRows.push([{ text: '📋 Copy Crypto Address', copy_text: { text: walletAddress } } as any]);
  if (hasVA) {
    kbRows.push([{ text: '📋 Copy Account Number', copy_text: { text: virtualAccount.accountNumber } } as any]);
  } else {
    kbRows.push([Markup.button.callback('💵 Add Naira', 'add_naira_start')]);
  }
  kbRows.push([Markup.button.callback('🇦🇺 Add AUDD', 'add_aud_start')]);
  kbRows.push([Markup.button.callback('🌉 Receive from Other Apps', 'bridge_start')]);

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(kbRows),
  });
}

bot.hears('📥 Receive', async (ctx) => {
  await showReceive(ctx, ctx.from.id.toString());
});

bot.action('bridge_start', async (ctx) => {
  await ctx.answerCbQuery();
  await showBridgeMenu(ctx, ctx.from!.id.toString());
});

// ═════════════════════════════════════════════════════════════════════════════
// 🔄 SWAP (Jupiter integration)
// ═════════════════════════════════════════════════════════════════════════════

import { getSwapQuote, buildSwapTransaction, SWAP_TOKENS, getTokenBySymbol, formatTokenAmount } from './services/jupiter.js';
import { getChainRailsClient, TOKEN_ADDRESSES, CHAIN_NAMES } from '@zend/chainrails-client';

async function showSwapMenu(ctx: ZendContext, userId: string) {
  await ctx.reply(
    `🔄 *Convert Currency*\n\n` +
    `Exchange money in your account instantly.\n\n` +
    `Select a pair:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('SOL → USDT', 'swap:SOL:USDT')],
        [Markup.button.callback('USDC → USDT', 'swap:USDC:USDT')],
        [Markup.button.callback('USDT → SOL', 'swap:USDT:SOL')],
        [Markup.button.callback('SOL → AUDD', 'swap:SOL:AUDD')],
        [Markup.button.callback('AUDD → SOL', 'swap:AUDD:SOL')],
        [Markup.button.callback('USDT → AUDD', 'swap:USDT:AUDD')],
        [Markup.button.callback('AUDD → USDT', 'swap:AUDD:USDT')],
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
    await ctx.editMessageText('❌ Invalid pair selected.');
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
    `🔄 *Convert ${fromSymbol} → ${toSymbol}*\n\n` +
    `How much ${fromSymbol} do you want to convert?\n\n` +
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
// 🌉 CHAINRAILS BRIDGE (Cross-chain Deposit)
// ═════════════════════════════════════════════════════════════════════════════

// Handle swap amount input
async function handleSwapAmount(ctx: ZendContext, userId: string, text: string) {
  const session = getSession(userId);
  const pt = session.pendingTransaction;
  if (!pt?.fromMint || !pt.toMint || !pt.fromSymbol || !pt.toSymbol || !pt.fromDecimals) {
    await ctx.reply('❌ Session expired. Please start over.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const amount = parseFloat(text.trim());
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Please enter a valid amount. Example: 0.1, 1, 10', cancelKeyboard);
    return;
  }

  const fromToken = getTokenBySymbol(pt.fromSymbol as string)!;
  const toToken = getTokenBySymbol(pt.toSymbol as string)!;
  const amountBase = Math.round(amount * Math.pow(10, pt.fromDecimals as number));

  // ─── Local swap via dev wallet (AUDD pairs) ───
  const isAuddPair = pt.fromMint === SOLANA_TOKENS.AUDD.mint || pt.toMint === SOLANA_TOKENS.AUDD.mint;
  if (isAuddPair) {
    await ctx.replyWithChatAction('typing');
    try {
      const solPrice = await getSolPriceInUsdt();
      const auddPrice = await getAuddPriceInUsdt();

      let outAmount = 0;
      if (pt.fromMint === SOLANA_TOKENS.SOL.mint && pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        outAmount = amount * solPrice / auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.AUDD.mint && pt.toMint === SOLANA_TOKENS.SOL.mint) {
        outAmount = amount * auddPrice / solPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.USDT.mint && pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        outAmount = amount / auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.AUDD.mint && pt.toMint === SOLANA_TOKENS.USDT.mint) {
        outAmount = amount * auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.USDC.mint && pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        outAmount = amount / auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.AUDD.mint && pt.toMint === SOLANA_TOKENS.USDC.mint) {
        outAmount = amount * auddPrice;
      }

      if (!DEV_WALLET_SECRET) {
        await ctx.reply('❌ AUDD swap not available: dev wallet not configured.', mainMenu);
        setSession(userId, { state: ConversationState.IDLE });
        return;
      }
      const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));

      // Check dev wallet has enough output token
      if (pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        const devBal = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.AUDD.mint);
        if (devBal < outAmount) {
          await ctx.reply(`❌ AUDD liquidity is low. Only ${devBal.toFixed(2)} AUDD available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      } else if (pt.toMint === SOLANA_TOKENS.USDT.mint) {
        const devBal = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.USDT.mint);
        if (devBal < outAmount) {
          await ctx.reply(`❌ USDT liquidity is low. Only ${devBal.toFixed(2)} USDT available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      } else if (pt.toMint === SOLANA_TOKENS.USDC.mint) {
        const devBal = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.USDC.mint);
        if (devBal < outAmount) {
          await ctx.reply(`❌ USDC liquidity is low. Only ${devBal.toFixed(2)} USDC available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      } else if (pt.toMint === SOLANA_TOKENS.SOL.mint) {
        const devBal = await walletService.getSolBalance(devKeypair.publicKey.toBase58());
        if (devBal < outAmount) {
          await ctx.reply(`❌ SOL liquidity is low. Only ${devBal.toFixed(4)} SOL available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      }

      const outAmountBase = Math.round(outAmount * Math.pow(10, toToken.decimals));
      session.pendingTransaction = {
        ...pt,
        swapAmountBase: amountBase,
        swapQuote: { outAmount: String(outAmountBase), inAmount: String(amountBase), otherAmountThreshold: String(outAmountBase), priceImpactPct: '0' },
        swapOutAmount: outAmount,
        swapMinOut: outAmount,
        swapPriceImpact: 0,
        isLocalSwap: true,
      };
      session.state = ConversationState.AWAITING_CONFIRMATION;
      setSession(userId, session);

      let msg = `🔄 *Exchange Rate (Local Swap)*\n\n`;
      msg += `${amount.toFixed(fromToken.decimals === 9 ? 4 : 2)} ${fromToken.symbol} → ${outAmount.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
      msg += `Rate: 1 ${fromToken.symbol} ≈ ${(outAmount / amount).toFixed(6)} ${toToken.symbol}\n`;
      msg += `Price impact: 0%\n\n`;
      msg += `Confirm?`;

      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm Swap', 'confirm_swap')],
          [Markup.button.callback('❌ Cancel', 'cancel_swap')],
        ]),
      });
      return;
    } catch (err: any) {
      await ctx.reply(`❌ Could not calculate local swap rate: ${err.message}`, mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }
  }

  // ─── Jupiter swap (non-AUDD pairs) ───
  await ctx.replyWithChatAction('typing');
  const quote = await getSwapQuote(pt.fromMint, pt.toMint, amountBase, 50);

  if (!quote) {
    await ctx.reply('❌ Could not get an exchange rate. Not enough available right now. Please try again later.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

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

  let msg = `🔄 *Exchange Rate*\n\n`;
  msg += `${formatTokenAmount(Number(quote.inAmount), fromToken.decimals)} ${fromToken.symbol} → ${outAmount.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
  msg += `Minimum you'll get: ${minOut.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
  msg += `Price impact: ${priceImpact < 0.01 ? '<0.01%' : priceImpact.toFixed(2) + '%'}\n`;
  msg += `Price protection: 0.5%\n\n`;
  msg += `Confirm?`;

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
    const waitMsg = await ctx.reply('Waiting for PIN...', cancelKeyboard);
    getSession(userId).lastBotMessageId = waitMsg.message_id;
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
      `🌉 *Receive from Other Apps*\n\n` +
      `Receive Dollars from Binance, MetaMask, or any app.\n\n` +
      `⚠️ *Service not configured.*\n\n` +
      `For now, use:\n` +
      `• 💵 *Add Naira* — NGN bank transfer → Dollars\n` +
      `• 📥 *Receive* — Direct crypto deposit`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  await ctx.reply(
    `🌉 *Receive from Other Apps*\n\n` +
    `Send Dollars from Binance, MetaMask, Trust Wallet, or any app.\n\n` +
    `Where are you sending from?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔗 Ethereum', 'bridge_chain:ethereum'), Markup.button.callback('🔵 Base', 'bridge_chain:base')],
        [Markup.button.callback('🟡 BSC', 'bridge_chain:bsc'), Markup.button.callback('🔷 Arbitrum', 'bridge_chain:arbitrum')],
        [Markup.button.callback('🔴 Optimism', 'bridge_chain:optimism'), Markup.button.callback('🟣 Polygon', 'bridge_chain:polygon')],
        [Markup.button.callback('❌ Cancel', 'cancel_bridge')],
      ]),
    }
  );
}

bot.command('bridge', async (ctx) => {
  await showBridgeMenu(ctx, ctx.from.id.toString());
});

// Step 2: After chain selected, show token options (USDC / USDT)
bot.action(/bridge_chain:([a-z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainKey = ctx.match[1];
  const sourceChain = BRIDGE_CHAIN_MAP[chainKey];
  if (!sourceChain) {
    await ctx.editMessageText('❌ Unsupported chain.');
    return;
  }
  const chainDisplay = CHAIN_NAMES[sourceChain] || sourceChain;

  // Check which tokens are available on this chain
  const hasUsdc = !!TOKEN_ADDRESSES[sourceChain]?.USDC;
  const hasUsdt = !!TOKEN_ADDRESSES[sourceChain]?.USDT;
  const buttons: any[] = [];
  if (hasUsdc) buttons.push(Markup.button.callback('USDC', `bridge:${chainKey}:USDC`));
  if (hasUsdt) buttons.push(Markup.button.callback('USDT', `bridge:${chainKey}:USDT`));

  await ctx.editMessageText(
    `🌉 *Receive from Other Apps*\n\n` +
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

// Token decimals per chain for base-unit conversion
const TOKEN_DECIMALS: Record<string, Record<string, number>> = {
  ETHEREUM_MAINNET: { USDC: 6, USDT: 6, DAI: 18, ETH: 18 },
  BASE_MAINNET: { USDC: 6, USDT: 6, DAI: 18, ETH: 18 },
  BSC_MAINNET: { USDC: 18, USDT: 18, DAI: 18, BNB: 18 },
  ARBITRUM_MAINNET: { USDC: 6, USDT: 6, DAI: 18, ETH: 18 },
  OPTIMISM_MAINNET: { USDC: 6, USDT: 6, DAI: 18, ETH: 18 },
  POLYGON_MAINNET: { USDC: 6, USDT: 6, DAI: 18, MATIC: 18 },
  SOLANA_MAINNET: { USDC: 6, USDT: 6, SOL: 9 },
};

bot.action(/bridge:([a-z]+):([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const token = ctx.match[2];

  const sourceChain = BRIDGE_CHAIN_MAP[chainKey];
  if (!sourceChain) {
    await ctx.editMessageText('❌ Unsupported chain.');
    return;
  }

  const tokenIn = TOKEN_ADDRESSES[sourceChain]?.[token];
  if (!tokenIn) {
    await ctx.editMessageText(`❌ ${token} is not supported from ${CHAIN_NAMES[sourceChain] || sourceChain} yet.`);
    return;
  }

  const chainDisplay = CHAIN_NAMES[sourceChain] || sourceChain;

  // Store bridge data in session and ask for amount
  setSession(userId, {
    state: ConversationState.AWAITING_BRIDGE_AMOUNT,
    bridgeData: { chainKey, sourceChain, token, tokenIn },
  });

  await ctx.editMessageText(
    `🌉 *Receive from Other Apps*\n\n` +
    `From: *${chainDisplay}*\n` +
    `Currency: *${token}*\n\n` +
    `How much ${token} do you want to receive?\n\n` +
    `Examples:\n` +
    `• 10\n` +
    `• 50\n` +
    `• 100`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_bridge')]]) }
  );
});

bot.action('cancel_bridge', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ Cancelled.');
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
    const typeLabel = tx.type === 'ngn_send' ? 'Send' : tx.type === 'ngn_receive' ? 'Deposit' : tx.type === 'swap' ? 'Convert' : tx.type === 'scheduled' ? 'Scheduled' : tx.type;

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
      `Name: ${md(u.firstName)} ${md(u.lastName || '')}\n\n` +
      `*Your Address:*\n` +
      `\`\`\`\n${u.walletAddress}\n\`\`\`\n\n` +
      `🔐 *Security*\n` +
      `Email: ${u.email || 'Not set'} ${u.emailVerified ? '✓' : ''}\n` +
      `Identity: ${u.pajSessionToken ? '✅ Verified' : '❌ Not verified'}\n` +
      `PIN: ${u.transactionPin ? 'Set ✅' : 'Not set'}\n\n` +
      `💰 *Preferences*\n` +
      `Auto-save: ${autoSave}`;

    // Build dynamic settings menu — hide items already done
    const buttons: any[] = [];
    buttons.push([{ text: '📋 Copy Address', copy_text: { text: u.walletAddress } } as any]);
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
    buttons.push([Markup.button.callback('🔑 Show Secret Code', 'export_key')]);
    buttons.push([Markup.button.callback('📅 Schedule Transfer', 'schedule_start')]);

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

  const waitMsg = await ctx.reply('Waiting for your input...', cancelKeyboard);
  getSession(userId).lastBotMessageId = waitMsg.message_id;
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
// BALANCE CHANGE DETECTOR — notifies users of direct Solana deposits
// ═════════════════════════════════════════════════════════════════════════════

const balanceSnapshots = new Map<string, { sol: number; usdt: number; usdc: number; audd: number }>();

async function checkBalanceChanges(botInstance: Telegraf<any>) {
  try {
    const allUsers = await db.select({ id: users.id, walletAddress: users.walletAddress }).from(users);
    for (const user of allUsers) {
      try {
        const balances = await walletService.getAllBalances(user.walletAddress);
        const current = {
          sol: balances.find((b: any) => b.symbol === 'SOL')?.amount || 0,
          usdt: balances.find((b: any) => b.symbol === 'USDT')?.amount || 0,
          usdc: balances.find((b: any) => b.symbol === 'USDC')?.amount || 0,
          audd: balances.find((b: any) => b.symbol === 'AUDD')?.amount || 0,
        };

        const prev = balanceSnapshots.get(user.id);
        if (prev) {
          const solDiff = current.sol - prev.sol;
          const usdtDiff = current.usdt - prev.usdt;
          const usdcDiff = current.usdc - prev.usdc;

          if (solDiff > 0.000001) {
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${solDiff.toFixed(6)} SOL* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.sol.toFixed(6)} SOL*`,
              { parse_mode: 'Markdown' }
            );
          }
          if (usdtDiff > 0.000001) {
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${usdtDiff.toFixed(2)} USDT* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.usdt.toFixed(2)} USDT*`,
              { parse_mode: 'Markdown' }
            );
          }
          if (usdcDiff > 0.000001) {
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${usdcDiff.toFixed(2)} USDC* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.usdc.toFixed(2)} USDC*`,
              { parse_mode: 'Markdown' }
            );
          }
          if (current.audd - (prev?.audd || 0) > 0.000001) {
            const auddDiff = current.audd - (prev?.audd || 0);
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${auddDiff.toFixed(2)} AUDD* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.audd.toFixed(2)} AUDD*`,
              { parse_mode: 'Markdown' }
            );
          }
        }

        balanceSnapshots.set(user.id, current);
      } catch (err) {
        console.error(`[BalancePoll] Error checking user ${user.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[BalancePoll] Error fetching users:', err);
  }
}

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

          // Guard against malformed/health-check webhooks
          if (!event.type) {
            console.log('[PAJ Webhook] No event type — likely ping/health-check. Body:', body.slice(0, 200));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'No event type' }));
            return;
          }

          switch (event.type) {
            case 'onramp.deposit.confirmed': {
              // Find or create transaction
              let txRows = await db.select().from(transactions)
                .where(eq(transactions.pajReference, event.reference))
                .limit(1);

              if (txRows.length === 0) {
                // Try to find user by virtual account orderId
                const userRows = await db.select().from(users)
                  .where(sql`virtual_account->>'orderId' = ${event.reference}`)
                  .limit(1);
                if (userRows.length > 0) {
                  const fallbackTxId = generateTxId();
                  await db.insert(transactions).values({
                    id: fallbackTxId,
                    userId: userRows[0].id,
                    type: 'ngn_receive',
                    status: 'completed',
                    pajReference: event.reference,
                    pajPoolAddress: userRows[0].walletAddress,
                    recipientWalletAddress: userRows[0].walletAddress,
                    completedAt: new Date(),
                  });
                  txRows = [{ id: fallbackTxId, userId: userRows[0].id } as any];
                } else {
                  console.warn('[PAJ Webhook] No transaction or user found for reference:', event.reference);
                }
              } else {
                await db.update(transactions)
                  .set({ status: 'completed', completedAt: new Date() })
                  .where(eq(transactions.pajReference, event.reference));
              }

              // Check if this on-ramp should be converted to AUDD (hidden swap)
              let notified = false;
              try {
                if (txRows.length > 0) {
                  const targetToken = (txRows[0].metadata as any)?.targetToken;
                  if (targetToken === 'AUDD') {
                    const userId = txRows[0].userId;
                    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
                    if (user.length > 0 && user[0].walletEncryptedKey) {
                      const usdtAmount = Number(txRows[0].fromAmount || 0);
                      if (usdtAmount > 0) {
                        const auddRate = await getAuddPriceInUsdt();
                        const auddOut = usdtAmount / auddRate;
                        if (DEV_WALLET_SECRET) {
                          const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
                          const devAuddBalance = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.AUDD.mint);
                          if (devAuddBalance >= auddOut) {
                            const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
                            const keypair = Keypair.fromSecretKey(secretKey);
                            const swapTxHash = await walletService.executeLocalSwap(
                              keypair,
                              devKeypair,
                              SOLANA_TOKENS.USDT.mint,
                              SOLANA_TOKENS.AUDD.mint,
                              usdtAmount,
                              auddOut,
                              SOLANA_TOKENS.USDT.decimals,
                              SOLANA_TOKENS.AUDD.decimals,
                              user[0].walletAddress
                            );
                            const swapTxId = generateTxId();
                            await db.insert(transactions).values({
                              id: swapTxId, userId, type: 'swap', status: 'completed',
                              fromMint: SOLANA_TOKENS.USDT.mint, fromAmount: usdtAmount.toString(),
                              toMint: SOLANA_TOKENS.AUDD.mint, toAmount: auddOut.toString(),
                              solanaTxHash: swapTxHash,
                            });
                            await botInstance.telegram.sendMessage(
                              userId,
                              `🎉 *AUDD Deposit Complete!*\n\n` +
                              `Your Naira bank transfer has been confirmed and AUDD has been credited to your Zend account.\n\n` +
                              `Received: ~${auddOut.toFixed(2)} AUDD\n` +
                              `Reference: \`${event.reference}\``,
                              { parse_mode: 'Markdown' }
                            );
                            notified = true;
                          } else {
                            console.error('[AUDD On-ramp] Dev wallet AUDD balance too low:', devAuddBalance, 'needed:', auddOut);
                          }
                        }
                      }
                    }
                  }
                }
              } catch (swapErr) {
                console.error('[AUDD On-ramp] Hidden swap failed:', swapErr);
              }

              // Notify user (default USDT notification)
              try {
                if (!notified && txRows.length > 0) {
                  const userId = txRows[0].userId;
                  await botInstance.telegram.sendMessage(
                    userId,
                    `🎉 *Naira Deposit Received!*\n\n` +
                    `Your bank transfer has been confirmed and Dollars (USDT) have been credited to your Zend account.\n\n` +
                    `Reference: \`${event.reference}\``,
                    { parse_mode: 'Markdown' }
                  );
                }
              } catch (notifyErr) {
                console.log('[PAJ Webhook] Could not notify user:', notifyErr);
              }
              break;
            }
            case 'onramp.deposit.failed': {
              const txRows = await db.select().from(transactions)
                .where(eq(transactions.pajReference, event.reference))
                .limit(1);
              if (txRows.length > 0) {
                await db.update(transactions)
                  .set({ status: 'failed' })
                  .where(eq(transactions.pajReference, event.reference));
              } else {
                console.warn('[PAJ Webhook] No transaction found for failed deposit:', event.reference);
              }
              break;
            }
            case 'offramp.settlement.confirmed': {
              await db.update(transactions)
                .set({ status: 'completed', completedAt: new Date() })
                .where(eq(transactions.pajReference, event.reference));

              // Notify user
              try {
                const txRows = await db.select().from(transactions)
                  .where(eq(transactions.pajReference, event.reference))
                  .limit(1);
                if (txRows.length > 0) {
                  const userId = txRows[0].userId;
                  await botInstance.telegram.sendMessage(
                    userId,
                    `✅ *Cash Out Complete!*\n\n` +
                    `Your Naira has been settled to your bank account.\n\n` +
                    `Reference: \`${event.reference}\``,
                    { parse_mode: 'Markdown' }
                  );
                }
              } catch (notifyErr) {
                console.log('[PAJ Webhook] Could not notify user:', notifyErr);
              }
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
                `✅ *Deposit Received!*\n\n` +
                `${amount || ''} ${token || 'USDT'} has arrived in your Zend account.\n\n` +
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

    // BitRefill Webhooks
    if (url === '/webhooks/bitrefill' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          console.log('📩 BitRefill Webhook:', event.event, event.invoice_id);

          // Find our order record
          const orders = await db.select().from(bitrefillOrders)
            .where(eq(bitrefillOrders.bitrefillInvoiceId, event.invoice_id))
            .limit(1);

          if (!orders.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
            return;
          }

          const order = orders[0];
          const userId = order.userId;

          if (event.event === 'invoice.complete' || event.status === 'complete') {
            await db.update(bitrefillOrders)
              .set({
                status: 'complete',
                codes: event.codes || event.redemption_codes || [],
                completedAt: new Date(),
              })
              .where(eq(bitrefillOrders.id, order.id));

            const codes = event.codes || event.redemption_codes || [];
            let codesText = '';
            if (codes.length) {
              codesText = '\n\n' + codes.map((c: any) =>
                c.pin
                  ? `Code: \`${c.code}\`\nPin: \`${c.pin}\``
                  : `Code: \`${c.code}\``
              ).join('\n\n');
            }

            await botInstance.telegram.sendMessage(
              userId,
              `🎉 *Order Complete!*\n\n` +
              `${order.productName}\n` +
              `${order.currencyFiat} ${order.amountFiat}` +
              `${codesText}\n\n` +
              `Reference: \`${order.id}\``,
              { parse_mode: 'Markdown' }
            );
          } else if (event.event === 'invoice.failed' || event.status === 'failed') {
            await db.update(bitrefillOrders)
              .set({ status: 'failed', metadata: event })
              .where(eq(bitrefillOrders.id, order.id));

            await botInstance.telegram.sendMessage(
              userId,
              `❌ *Order Failed*\n\n` +
              `${order.productName} could not be fulfilled.\n\n` +
              `If you paid, a refund will be processed to your wallet.\n` +
              `Reference: \`${order.id}\``,
              { parse_mode: 'Markdown' }
            );
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('[BitRefill Webhook] Error:', err);
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

    // ─── Landing page forms ───
    if (url === '/api/ambassador' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { name, tgHandle, isStudent, focus } = data;
          if (!name || !tgHandle || !isStudent || !focus) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'All fields are required' }));
            return;
          }
          await db.insert(ambassadorApplications).values({
            name: String(name).trim(),
            tgHandle: String(tgHandle).trim(),
            isStudent: String(isStudent).trim(),
            focus: String(focus).trim(),
          });
          console.log('📩 Ambassador application received:', name, tgHandle);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          console.error('[Webhook] Ambassador error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save application' }));
        }
      });
      return;
    }

    if (url === '/api/device-suspend' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { fullName, email, phone, handle, deviceLost, lastUsed, reason, details } = data;
          if (!fullName || !email || !phone || !handle || !deviceLost || !lastUsed || !reason) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Required fields missing' }));
            return;
          }
          await db.insert(deviceSuspensionRequests).values({
            fullName: String(fullName).trim(),
            email: String(email).trim(),
            phone: String(phone).trim(),
            handle: String(handle).trim(),
            deviceLost: String(deviceLost).trim(),
            lastUsed: String(lastUsed).trim(),
            reason: String(reason).trim(),
            details: details ? String(details).trim() : null,
          });
          console.log('📩 Device suspension request received:', fullName, email);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          console.error('[Webhook] Device suspension error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save request' }));
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
    console.log(`   BitRefill webhook URL: https://${host}/webhooks/bitrefill`);
    console.log(`   Telegram webhook URL: https://${host}/webhook/telegram`);
    console.log(`   Ambassador API: https://${host}/api/ambassador`);
    console.log(`   Device Suspend API: https://${host}/api/device-suspend`);
  });

  return server;
}

// ═════════════════════════════════════════════════════════════════════════════
// LAUNCH
// ═════════════════════════════════════════════════════════════════════════════

// ─── Scheduled Transfer Executor ───
let _scheduledRunning = false;
async function runScheduledTransfers() {
  if (_scheduledRunning) {
    console.log('[Schedule] Skipping: previous run still in progress');
    return;
  }
  _scheduledRunning = true;
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
              `To: ${md(acc.accountName)}\n` +
              `Bank: ${md(acc.bankName)} • \`${acc.accountNumber}\`\n\n` +
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
              `To: ${md(acc.accountName)}\n` +
              `Bank: ${md(acc.bankName)} • \`${acc.accountNumber}\`\n\n` +
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
  } finally {
    _scheduledRunning = false;
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

  // ChainRails startup check
  const chainRails = getChainRailsClient();
  if (chainRails) {
    try {
      const chains = await chainRails.getSupportedChains('mainnet');
      console.log('🔗 ChainRails supported chains:', chains.join(', '));
    } catch (err: any) {
      console.warn('⚠️  ChainRails chains check failed:', err.message);
    }
  } else {
    console.warn('⚠️  ChainRails not configured');
  }

  // Seed bot features table for AI awareness
  await seedBotFeatures();

  // Start webhook server (runs alongside bot)
  startWebhookServer(bot);

  // Launch bot — webhooks in production, polling for local dev only
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  const isRailway = !!process.env.RAILWAY_PUBLIC_DOMAIN;
  let isWebhookMode = false;

  // Always clear any existing webhook first to prevent 429 conflicts
  async function clearWebhook(retries = 3): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('[Bot] Webhook cleared successfully');
        return true;
      } catch (err: any) {
        console.warn(`[Bot] Failed to clear webhook (attempt ${i + 1}/${retries}):`, err.message);
        if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
      }
    }
    return false;
  }

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
      await clearWebhook();
      bot.launch({ dropPendingUpdates: true });
    }
  } else {
    console.log('🤖 Bot running in polling mode (local dev)...');
    await clearWebhook();
    bot.launch({ dropPendingUpdates: true });
  }

  // Start scheduled transfer executor (every 60 seconds)
  setInterval(runScheduledTransfers, 60000);
  console.log('📅 Scheduled transfer executor started (every 60s)');

  // Balance change detector disabled — was hitting Solana RPC rate limits.
  // Re-enable later with batching + retry logic if needed.
  // setInterval(() => checkBalanceChanges(bot), 120000);
  // checkBalanceChanges(bot).catch(console.error);
  console.log('🔔 Balance change detector: DISABLED (RPC rate limit protection)');

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
// Railway deploy trigger Wed May 20 10:32:40 WAT 2026
