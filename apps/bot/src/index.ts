import './env.js';

import { createServer } from 'http';
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
import { users, transactions, savedBankAccounts, scheduledTransfers, ambassadorApplications, deviceSuspensionRequests, botFeatures, billPayments, feedback } from '@zend/db';
import { eq, sql, and, desc } from 'drizzle-orm';
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

import crypto from 'crypto';
import { PIN_TTL_MS } from './middleware/auto-delete.js';
import { getSession, setSession, initSessionStore } from './session/store.js';
import type { ZendContext, ZendSession } from './session/types.js';
import { checkSendBalance } from './utils/send-balance.js';
import { runStartupHealthChecks } from './launch/health.js';
import { getAdminStats, isSuperAdmin, isAdminUser } from './services/admin.js';
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
  calculateSendFee as calcSendFee,
  formatSendFeeLabel,
  MIN_SOL_FOR_GAS,
  ATA_RENT_SOL,
  calcRequiredSol,
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
} from './deps.js';
import { bot } from './bot.js';
import {
  mainMenu,
  cancelKeyboard,
  billsMenu,
  billsBackKeyboard,
  adminMenu,
  REPLY_KEYBOARD_BUTTONS,
} from './keyboards/index.js';
import { md, escapeTelegramMarkdown } from './lib/telegram.js';
import { isGroupChat, getBotUsername, promptPrivateChat } from './lib/group.js';

const DEV_WALLET_LOW_BALANCE_THRESHOLD = 0.05; // alert if below ~$8–10 worth of SOL
const DEV_WALLET_CRITICAL_THRESHOLD = 0.01; // critical alert if below this

/** Check whether a user has never completed a transaction (new user). */
async function isNewUser(userId: string): Promise<boolean> {
  try {
    const txnCount = await db.select({ count: sql`count(*)` }).from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));
    return Number(txnCount[0]?.count) === 0;
  } catch (err) {
    console.error('[Gas] isNewUser check failed:', err);
    return false; // assume experienced user to avoid over-funding
  }
}

/** Zend send fee — gas sponsorship = SOL funded (USDT) + extra service fee */
async function calculateSendFee(
  transferUsdt: number,
  userWalletAddress: string,
  userId?: string
): Promise<SendFeeInfo> {
  const newUser = userId ? await isNewUser(userId) : false;
  return calcSendFee(transferUsdt, userWalletAddress, walletService, newUser, {
    getSolPriceInUsdt,
    needsAtaCount: process.env.ZEND_FEE_WALLET?.trim() ? 2 : 1,
  });
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
 * Dev-wallet health check. Logs alerts when balance is low.
 * Call this before any gas sponsorship attempt.
 */
async function checkDevWalletHealth(): Promise<{ healthy: boolean; balance: number; level: 'ok' | 'low' | 'critical' }> {
  const balance = await getDevWalletBalance();
  let level: 'ok' | 'low' | 'critical' = 'ok';
  if (balance < DEV_WALLET_CRITICAL_THRESHOLD) {
    level = 'critical';
    console.error(`[Gas][ALERT] Dev wallet CRITICAL: ${balance.toFixed(6)} SOL. Gas sponsorship will fail soon. Top up immediately.`);
  } else if (balance < DEV_WALLET_LOW_BALANCE_THRESHOLD) {
    level = 'low';
    console.warn(`[Gas][ALERT] Dev wallet LOW: ${balance.toFixed(6)} SOL. Consider topping up before user volume spikes.`);
  } else {
    console.log(`[Gas] Dev wallet health OK: ${balance.toFixed(6)} SOL`);
  }
  return { healthy: level === 'ok', balance, level };
}

/**
 * Translate a low-level gas-funding error into a human-readable user message.
 */
function gasFundingErrorToUserMessage(error: string | undefined, shortfall?: number): string {
  if (!error) {
    return 'We could not cover the network fee for this transaction. Please try again in a moment.';
  }
  const e = error.toLowerCase();
  if (e.includes('dev wallet not configured') || e.includes('no dev wallet')) {
    return 'Gas sponsorship is temporarily unavailable. Please contact support.';
  }
  if (e.includes('low on sol') || e.includes('dev wallet low')) {
    return 'Our gas station is running low on SOL right now. Please try again in a few minutes or add a small amount of SOL to your wallet.';
  }
  if (e.includes('blockhash') || e.includes('timeout') || e.includes('expired')) {
    return 'The Solana network was too slow to confirm the gas top-up. Please try again.';
  }
  if (e.includes('insufficient funds')) {
    return 'We could not reserve enough SOL to process this transaction. Please try a smaller amount or contact support.';
  }
  if (shortfall && shortfall > 0) {
    return `We tried to top up your wallet with ${shortfall.toFixed(6)} SOL for network fees, but it didn't go through. Please try again or add a small amount of SOL manually.`;
  }
  return 'We could not cover the network fee for this transaction. Please try again or contact support if this keeps happening.';
}

/**
 * Smart gas funding — tops up the user with exactly the shortfall.
 * Checks recipient and fee wallet ATA needs.
 * Returns { funded: boolean; gasSponsored: boolean; shortfall?: number; error?: string }
 */
async function fundSolIfNeeded(
  walletAddress: string,
  recipientAddress?: string,
  mintAddress?: string,
  feeWalletAddress?: string,
  userId?: string
): Promise<{ funded: boolean; gasSponsored: boolean; shortfall?: number; error?: string }> {
  console.log(`[Gas] fundSolIfNeeded called for wallet=${walletAddress}, recipient=${recipientAddress || 'none'}, mint=${mintAddress || 'none'}, feeWallet=${feeWalletAddress || 'none'}, userId=${userId || 'unknown'}`);

  let needsAtaCount = 0;
  if (recipientAddress && mintAddress) {
    try {
      const exists = await walletService.ataExists(recipientAddress, mintAddress);
      console.log(`[Gas] Recipient ATA exists=${exists} for ${recipientAddress}`);
      if (!exists) needsAtaCount++;
    } catch (err: any) {
      console.warn(`[Gas] ATA check failed for recipient ${recipientAddress}:`, err.message);
      needsAtaCount++; // assume worst case
    }
  }
  if (feeWalletAddress && mintAddress) {
    try {
      const exists = await walletService.ataExists(feeWalletAddress, mintAddress);
      console.log(`[Gas] Fee wallet ATA exists=${exists} for ${feeWalletAddress}`);
      if (!exists) needsAtaCount++;
    } catch (err: any) {
      console.warn(`[Gas] ATA check failed for fee wallet ${feeWalletAddress}:`, err.message);
      needsAtaCount++; // assume worst case
    }
  }

  const newUser = userId ? await isNewUser(userId) : false;
  const required = calcRequiredSol(needsAtaCount, newUser);
  console.log(`[Gas] Required SOL=${required.toFixed(6)} (newUser=${newUser}, needsAta=${needsAtaCount})`);

  const balance = await walletService.getSolBalance(walletAddress);
  console.log(`[Gas] User SOL balance=${balance.toFixed(6)} for ${walletAddress}`);

  if (balance >= required) {
    console.log(`[Gas] No funding needed. Balance ${balance.toFixed(6)} >= required ${required.toFixed(6)}`);
    return { funded: false, gasSponsored: false };
  }

  const shortfall = required - balance;
  console.log(`[Gas] Shortfall=${shortfall.toFixed(6)} SOL`);

  // Health check before attempting sponsorship
  const health = await checkDevWalletHealth();
  if (!health.healthy) {
    console.warn(`[Gas] Proceeding with sponsorship despite dev wallet level=${health.level}`);
  }

  if (!DEV_WALLET_SECRET) {
    console.warn('[Gas] No dev wallet secret set — cannot fund SOL');
    return { funded: false, gasSponsored: false, shortfall, error: 'Dev wallet not configured' };
  }

  const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
  const devBalance = await walletService.getSolBalance(devKeypair.publicKey.toBase58());
  const devNeeds = shortfall + MIN_SOL_FOR_GAS; // dev needs shortfall + its own tx fee
  console.log(`[Gas] Dev wallet balance=${devBalance.toFixed(6)} SOL, needs=${devNeeds.toFixed(6)} SOL`);
  if (devBalance < devNeeds) {
    console.error(`[Gas] Dev wallet has ${devBalance.toFixed(6)} SOL but needs ${devNeeds.toFixed(6)} SOL to fund user ${walletAddress}`);
    return { funded: false, gasSponsored: false, shortfall, error: `Dev wallet low on SOL (${devBalance.toFixed(6)}). Please top up the dev wallet.` };
  }

  // Retry up to 3 times with jitter
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[Gas] Funding attempt ${attempt}/3: sending ${shortfall.toFixed(6)} SOL to ${walletAddress}`);
    try {
      await walletService.sendSol(devKeypair, walletAddress, shortfall);
      console.log(`[Gas] SUCCESS: Funded ${shortfall.toFixed(6)} SOL (needsAta=${needsAtaCount}, newUser=${newUser}) to ${walletAddress}`);
      return { funded: true, gasSponsored: true, shortfall };
    } catch (err: any) {
      console.error(`[Gas] Attempt ${attempt}/3 failed to fund SOL:`, err.message);
      if (attempt === 3) {
        console.error(`[Gas] FATAL: All 3 funding attempts exhausted for ${walletAddress}. Error:`, err.message);
        return { funded: false, gasSponsored: false, shortfall, error: err.message };
      }
      // Jittered backoff: 500ms, 1000ms, 1500ms
      const delay = attempt * 500 + Math.random() * 200;
      console.log(`[Gas] Retrying in ${delay.toFixed(0)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error(`[Gas] FATAL: Funding failed after 3 retries for ${walletAddress}`);
  return { funded: false, gasSponsored: false, shortfall, error: 'Funding failed after 3 retries' };
}

// ─── Helpers ───
function generateTxId(): string {
  return 'ZND-' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

function generateReferralCode(): string {
  return 'ZND' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

import { encryptPrivateKey, decryptPrivateKey } from './utils/wallet.js';

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

// ─── Ambassador Program Helpers ───

async function getAmbassadorActiveUserCount(code: string): Promise<number> {
  const result = await db.select({ count: sql`count(distinct ${users.id})` })
    .from(users)
    .where(
      and(
        eq(users.ambassadorReferralCode, code),
        sql`exists (select 1 from ${transactions} where ${transactions.userId} = ${users.id} and ${transactions.status} = 'completed')`
      )
    );
  return Number(result[0]?.count || 0);
}

async function getAmbassadorMonthlyVolume(code: string, year: number, month: number): Promise<number> {
  const start = new Date(year, month - 1, 1).toISOString();
  const end = new Date(year, month, 1).toISOString();
  const result = await db.select({ sum: sql`coalesce(sum(${transactions.ngnAmount}), 0)` })
    .from(transactions)
    .innerJoin(users, eq(transactions.userId, users.id))
    .where(
      and(
        eq(users.ambassadorReferralCode, code),
        eq(transactions.status, 'completed'),
        sql`${transactions.createdAt} >= ${start}`,
        sql`${transactions.createdAt} < ${end}`
      )
    );
  return Number(result[0]?.sum || 0);
}

async function getAmbassadorTotalVolume(code: string): Promise<number> {
  const result = await db.select({ sum: sql`coalesce(sum(${transactions.ngnAmount}), 0)` })
    .from(transactions)
    .innerJoin(users, eq(transactions.userId, users.id))
    .where(
      and(
        eq(users.ambassadorReferralCode, code),
        eq(transactions.status, 'completed')
      )
    );
  return Number(result[0]?.sum || 0);
}

function getAmbassadorTierFromCount(activeCount: number): 'entry' | 'pro' | 'elite' {
  if (activeCount >= 300) return 'elite';
  if (activeCount >= 75) return 'pro';
  return 'entry';
}

function getCommissionRateBps(tier: string): number {
  const map: Record<string, number> = { entry: 25, pro: 30, elite: 35 };
  return map[tier] || 25;
}

function calculateCommissionNgn(volumeNgn: number, tier: string): number {
  return volumeNgn * (getCommissionRateBps(tier) / 10000);
}

function formatAmbassadorTier(tier: string): string {
  const map: Record<string, string> = {
    entry: '🥉 ZendER (Entry)',
    pro: '🥈 ZendER Pro',
    elite: '🥇 ZendER Elite',
  };
  return map[tier] || tier;
}

function formatAmbassadorStatus(status: string): string {
  const map: Record<string, string> = {
    pending: '⏳ Pending',
    confirmed: '✅ Confirmed',
    removed: '❌ Removed',
  };
  return map[status] || status;
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
    const features = [
      { key: 'balance', name: 'Check Balance', description: 'Dollars (USDT/USDC) and SOL with live Naira rates', category: 'payment', sortOrder: 1 },
      { key: 'add_naira', name: 'Add Naira', description: 'Bank transfer to a virtual account, get Dollars in your wallet', category: 'payment', sortOrder: 2 },
      { key: 'receive', name: 'Receive Money', description: 'Crypto address for direct deposit + virtual bank account for Naira', category: 'payment', sortOrder: 3 },
      { key: 'swap', name: 'Convert Currency', description: AUDD_ENABLED ? 'Exchange SOL ↔ USDT ↔ USDC ↔ AUDD' : 'Exchange SOL ↔ USDT ↔ USDC', category: 'payment', sortOrder: 4 },
      { key: 'deposit_crypto', name: 'Deposit from Other Apps', description: 'Send crypto from any wallet → receive in Zend via NEAR Intents', category: 'payment', sortOrder: 5 },
      { key: 'history', name: 'Transaction History', description: 'View all past transactions', category: 'info', sortOrder: 6 },
      { key: 'voice', name: 'Voice Commands', description: 'Send a voice note to execute commands', category: 'info', sortOrder: 7 },
      { key: 'bills', name: 'Bills & Utilities', description: 'Buy airtime, data, electricity and cable TV subscriptions', category: 'payment', sortOrder: 8 },
      { key: 'settings', name: 'Settings', description: 'PIN, language, auto-save, PAJ linking, wallet export', category: 'settings', sortOrder: 9 },
      { key: 'help', name: 'Help', description: 'Get support and join the Zend community', category: 'info', sortOrder: 10 },
      { key: 'how_to_use', name: 'How to Use', description: 'Step-by-step guide to using Zend', category: 'info', sortOrder: 11 },
      { key: 'features', name: 'Features', description: 'Explore everything Zend can do', category: 'info', sortOrder: 12 },
      { key: 'feedback', name: 'Feedback', description: 'Share ideas, report bugs, or ask for help', category: 'info', sortOrder: 13 },
    ];

    const existingRows = await db.select({ key: botFeatures.key }).from(botFeatures);
    const existingKeys = new Set(existingRows.map(r => r.key));

    let inserted = 0;
    for (const f of features) {
      if (existingKeys.has(f.key)) continue;
      await db.insert(botFeatures).values(f);
      inserted++;
    }

    if (inserted > 0) {
      console.log('[Features] Seeded', inserted, 'new features (total expected:', features.length, ')');
    }
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

// ═════════════════════════════════════════════════════════════════════════════
// /MYREF — Ambassador Self-Service Stats
// ═════════════════════════════════════════════════════════════════════════════

bot.command('myref', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  const handle = username ? username.toLowerCase().replace(/^@/, '') : '';

  if (!handle) {
    await ctx.reply('❌ You need a Telegram username to be an ambassador. Set one in Telegram Settings.');
    return;
  }

  const ambRows = await db.select().from(ambassadorApplications)
    .where(sql`LOWER(${ambassadorApplications.tgHandle}) = LOWER(${handle})`)
    .limit(1);

  if (ambRows.length === 0) {
    await ctx.reply(
      `🧑‍🎓 *ZendER Programme*\n\n` +
      `You are not registered as a Zend ambassador.\n\n` +
      `Apply at: https://zend-simple-payments-production.up.railway.app/ambassador`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const amb = ambRows[0];

  if (amb.status === 'pending') {
    await ctx.reply(
      `⏳ *ZendER Application Pending*\n\n` +
      `Hi ${escapeTelegramMarkdown(amb.name)}, your application is being reviewed.\n\n` +
      `Complete your starter tasks and the team will confirm you soon.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (amb.status === 'removed') {
    await ctx.reply(
      `❌ *ZendER Status Removed*\n\n` +
      `Your ambassador access has been revoked. Contact the programme manager for more info.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Confirmed ambassador — show stats
  let activeCount = 0;
  let totalVolume = 0;
  let currentMonthVolume = 0;
  if (amb.customReferralCode) {
    activeCount = await getAmbassadorActiveUserCount(amb.customReferralCode);
    totalVolume = await getAmbassadorTotalVolume(amb.customReferralCode);
    const now = new Date();
    currentMonthVolume = await getAmbassadorMonthlyVolume(amb.customReferralCode, now.getFullYear(), now.getMonth() + 1);
  }

  const computedTier = getAmbassadorTierFromCount(activeCount);
  const rate = getCommissionRateBps(computedTier);
  const monthCommission = calculateCommissionNgn(currentMonthVolume, computedTier);
  const totalCommission = calculateCommissionNgn(totalVolume, computedTier);
  const nextTier = computedTier === 'entry' ? 'Pro (75)' : computedTier === 'pro' ? 'Elite (300)' : 'Maxed';
  const toNext = computedTier === 'entry' ? Math.max(0, 75 - activeCount) : computedTier === 'pro' ? Math.max(0, 300 - activeCount) : 0;

  let text =
    `🎯 *Your ZendER Dashboard*\n\n` +
    `*Name:* ${escapeTelegramMarkdown(amb.name)}\n` +
    `*Tier:* ${formatAmbassadorTier(computedTier)}\n` +
    `*Commission Rate:* ${(rate / 100).toFixed(2)}%\n\n`;

  if (amb.customReferralCode) {
    text +=
      `🔗 *Your Referral Link*\n` +
      `\`t.me/zend_money_bot?start=${amb.customReferralCode}\`\n\n`;
  }

  text +=
    `📊 *Stats*\n` +
    `• Active Users: ${activeCount}${toNext > 0 ? ` (${toNext} to ${nextTier})` : ''}\n` +
    `• Total Volume: ₦${totalVolume.toLocaleString()}\n` +
    `• This Month Volume: ₦${currentMonthVolume.toLocaleString()}\n` +
    `• Est. Monthly Commission: ₦${Math.round(monthCommission).toLocaleString()}\n` +
    `• Est. Total Commission: ₦${Math.round(totalCommission).toLocaleString()}\n\n` +
    `💡 Only users who sign up *and complete a transaction* count as active.`;

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ═════════════════════════════════════════════════════════════════════════════
// /BULKSEND — Batch Send to Multiple Recipients
// ═════════════════════════════════════════════════════════════════════════════

async function startBulkSend(ctx: ZendContext, userId: string) {
  setSession(userId, { state: ConversationState.AWAITING_BULK_SEND_INPUT, pendingTransaction: { bulkRecipients: [] } as any });
  await ctx.reply(
    `📦 *Bulk Send*\n\n` +
    `Send money to multiple people at once.\n\n` +
    `Paste your recipient list. One per line, format:\n` +
    `\`AMOUNT BANK_CODE ACCOUNT_NUMBER ACCOUNT_NAME\`\n\n` +
    `*Example:*\n` +
    `\`\`\`\n` +
    `50000 GTB 0123456789 John Doe\n` +
    `30000 UBA 9876543210 Jane Smith\n` +
    `25000 OPY 1234567890 Mike Johnson\n` +
    `\`\`\`\n\n` +
    `Supported banks: GTB, UBA, ACC, ZEN, FBN, ECO, OPY, KUD, MON, etc.`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

bot.command('bulksend', async (ctx) => {
  const userId = ctx.from.id.toString();
  await startBulkSend(ctx, userId);
});

bot.hears('📦 Bulk Send', async (ctx) => {
  const userId = ctx.from.id.toString();
  await startBulkSend(ctx, userId);
});

// ─── Parse bulk recipient line ───
function parseBulkRecipient(line: string): { amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 4) return null;

  const amount = parseInt(tokens[0].replace(/[^0-9]/g, ''), 10);
  if (!amount || amount < 100) return null;

  const bankCodeInput = tokens[1].toUpperCase();
  const bank = NIGERIAN_BANKS.find(b => b.code === bankCodeInput);
  if (!bank) return null;

  const accountNumber = tokens[2];
  if (!/^\d{10}$/.test(accountNumber)) return null;

  const accountName = tokens.slice(3).join(' ');
  if (accountName.length < 2) return null;

  return { amountNgn: amount, bankCode: bank.code, bankName: bank.name, accountNumber, accountName };
}

// ─── Execute bulk send ───
async function executeBulkSend(
  ctx: ZendContext,
  userId: string,
  recipients: Array<{ amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string }>
): Promise<void> {
  const loading = await showLoading(ctx, `Executing ${recipients.length} transfers...`);

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const walletAddress = user[0]?.walletAddress;

  const pajClient = await getPAJClient();
  let rate = 1550;
  try {
    if (pajClient) {
      const rates = await getPAJRates();
      rate = rates.offRampRate;
    }
  } catch { /* fallback */ }

  const results: Array<{ success: boolean; recipient: string; amountNgn: number; error?: string; txId?: string }> = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const transferUsdt = r.amountNgn / rate;

    // Calculate per-recipient fee based on current SOL balance
    const feeInfo = walletAddress
      ? await calculateSendFee(transferUsdt, walletAddress, userId)
      : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
    const amountUsdt = transferUsdt + feeInfo.zendFeeUsdt;

    await updateLoading(ctx, loading.message_id, `Transfer ${i + 1}/${recipients.length}: ${r.accountName}...`);

    try {
      const result = await executeSendCore(userId, {
        amountNgn: r.amountNgn,
        amountUsdt,
        ngnRate: rate,
        zendFeeUsdt: feeInfo.zendFeeUsdt,
        feeSol: feeInfo.feeSol,
        recipientBankCode: r.bankCode,
        recipientBankName: r.bankName,
        recipientAccountNumber: r.accountNumber,
        recipientAccountName: r.accountName,
        recipientName: r.accountName,
      });

      results.push({
        success: result.success,
        recipient: r.accountName,
        amountNgn: r.amountNgn,
        txId: result.txId,
        error: result.error,
      });
    } catch (err: any) {
      results.push({
        success: false,
        recipient: r.accountName,
        amountNgn: r.amountNgn,
        error: err.message || 'Transfer failed',
      });
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const totalSent = results.filter(r => r.success).reduce((sum, r) => sum + r.amountNgn, 0);

  let report = `📦 *Bulk Send Complete*\n\n`;
  report += `✅ Successful: ${successCount}\n`;
  report += `❌ Failed: ${failCount}\n`;
  report += `💰 Total Sent: ₦${totalSent.toLocaleString()}\n\n`;

  if (failCount > 0) {
    report += `*Failed transfers:*\n`;
    report += results.filter(r => !r.success).map(r =>
      `• ${escapeTelegramMarkdown(r.recipient)} — ₦${r.amountNgn.toLocaleString()}: ${escapeTelegramMarkdown(r.error || 'Unknown error')}`
    ).join('\n');
    report += '\n\n';
  }

  if (successCount > 0) {
    report += `*Successful transfers:*\n`;
    report += results.filter(r => r.success).map(r =>
      `• ${escapeTelegramMarkdown(r.recipient)} — ₦${r.amountNgn.toLocaleString()}${r.txId ? ` (\`${r.txId}\`)` : ''}`
    ).join('\n');
  }

  await finishLoading(ctx, loading.message_id, report, 'Markdown');
  await ctx.reply('Menu:', mainMenu);
}

bot.action('bulk_send_confirm', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  const recipients = (session.pendingTransaction as any)?.bulkRecipients as Array<{ amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string }> | undefined;

  if (!recipients || recipients.length === 0) {
    await ctx.answerCbQuery('Session expired');
    await ctx.editMessageText('❌ Session expired. Please start over.');
    return;
  }

  setSession(userId, { state: ConversationState.IDLE });
  await ctx.answerCbQuery('Executing...');
  await executeBulkSend(ctx, userId, recipients);
});

bot.action('bulk_send_cancel', async (ctx) => {
  const userId = ctx.from.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Bulk send cancelled.');
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
    if (!existing[0].onboardingComplete) {
      await ctx.reply(`👋 Welcome back, ${firstName}!\n\nLet's finish setting up your account.`);
      await startOnboarding(ctx, userId);
      return;
    }
    await ctx.reply(`👋 Welcome back, ${firstName}!\n\nYour Zend account is ready.`, mainMenu);
    return;
  }

  // Parse deep link referral param: /start <code>
  const startPayload = ctx.message?.text?.split(' ')[1]?.trim() || '';
  let ambassadorRefCode: string | undefined;
  let referredByUserId: string | undefined;

  if (startPayload) {
    // Check if it's a confirmed ambassador's custom code
    const ambassadorMatch = await db.select().from(ambassadorApplications)
      .where(and(
        eq(ambassadorApplications.customReferralCode, startPayload.toLowerCase()),
        eq(ambassadorApplications.status, 'confirmed')
      )).limit(1);
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
    onboardingComplete: false,
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

  // Start onboarding: verify identity + set PIN
  await startOnboarding(ctx, userId);
});

async function startOnboarding(ctx: ZendContext, userId: string) {
  setSession(userId, { state: ConversationState.ONBOARDING_AWAITING_EMAIL });
  await ctx.reply(
    `🔐 *Let's Secure Your Account*\n\n` +
    `Before you start, we need to verify your identity and set a transaction PIN.\n\n` +
    `Step 1 of 3: Enter your email address\n` +
    `We'll send a verification code via PAJ.`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}
// ═════════════════════════════════════════════════════════════════════════════
// /ADMIN — Admin Dashboard
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

async function checkAdmin(userId: string, username?: string): Promise<boolean> {
  if (isSuperAdmin(userId)) return true;
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
  [Markup.button.callback('⚙️ Features', 'admin_page:features'), Markup.button.callback('📝 Feedback', 'admin_page:feedback')],
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
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_send'));
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
const AMBS_PER_PAGE = 10;

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
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_send'));
  const totalNgnIn = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));

  const offrampCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'ngn_send'));
  const onrampCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'ngn_receive'));
  const swapCount = await db.select({ count: sql`count(*)` }).from(transactions).where(eq(transactions.type, 'swap'));
  const billCount = await db.select({ count: sql`count(*)` }).from(billPayments);
  const billVolume = await db.select({ sum: sql`coalesce(sum(amount_ngn), 0)` }).from(billPayments).where(eq(billPayments.status, 'success'));

  const text =
    `💰 *Fees & Revenue*\n\n` +
    `🪙 Total Zend Fees: $${Number(totalZendFee[0]?.sum || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\n` +
    `📐 Fee config: ${ZEND_FEE_NORMAL_BPS / 100}% (normal) / max(${ZEND_FEE_FUNDED_BPS / 100}%, gas+$flat) (sponsored)\n\n` +
    `📊 *Volume by Type:*\n` +
    `📤 Off-Ramp: ${offrampCount[0]?.count || 0} tx | ₦${Number(totalNgnOut[0]?.sum || 0).toLocaleString()}\n` +
    `📥 On-Ramp: ${onrampCount[0]?.count || 0} tx | ₦${Number(totalNgnIn[0]?.sum || 0).toLocaleString()}\n` +
    `🔄 Swaps: ${swapCount[0]?.count || 0} tx\n` +
    `📱 Bill Payments: ${billCount[0]?.count || 0} | ₦${Number(billVolume[0]?.sum || 0).toLocaleString()}\n`;

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

// ─── Feedback (admin view) ───

const FEEDBACK_PER_PAGE = 10;

bot.action('admin_page:feedback', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(feedback);
  const openCount = await db.select({ count: sql`count(*)` }).from(feedback).where(eq(feedback.status, 'open'));
  const rows = await db.select().from(feedback).orderBy(desc(feedback.createdAt)).limit(FEEDBACK_PER_PAGE);

  let list = rows.map((f, i) => {
    const statusIcon = f.status === 'open' ? '🟡' : f.status === 'resolved' ? '✅' : f.status === 'in_progress' ? '🔵' : '⚪';
    const preview = escapeTelegramMarkdown(f.message.slice(0, 80));
    return `${i + 1}. ${statusIcon} #${f.id} | U\_${f.userId} | ${preview}${f.message.length > 80 ? '…' : ''}`;
  }).join('\n\n');

  const text =
    `📝 *User Feedback* (page 1)\n\n` +
    `Total: ${total[0]?.count || 0} | Open: ${openCount[0]?.count || 0}\n\n` +
    `${list || 'No feedback yet.'}\n\n` +
    `Tap a number to view / resolve.`;

  const buttons = rows.map(f => [
    Markup.button.callback(`#${f.id}`, `admin_feedback_detail:${f.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_feedback_detail:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const feedbackId = parseInt(ctx.match[1], 10);
  const rows = await db.select().from(feedback).where(eq(feedback.id, feedbackId)).limit(1);
  if (rows.length === 0) { await ctx.answerCbQuery('Feedback not found'); return; }
  const f = rows[0];

  const statusIcon = f.status === 'open' ? '🟡' : f.status === 'resolved' ? '✅' : f.status === 'in_progress' ? '🔵' : '⚪';
  const text =
    `📝 *Feedback #${f.id}* ${statusIcon}\n\n` +
    `*User:* \`${f.userId}\`\n` +
    `*Category:* ${f.category}\n` +
    `*Status:* ${f.status}\n` +
    `*Created:* ${f.createdAt ? new Date(f.createdAt).toLocaleString('en-NG') : '—'}\n\n` +
    `*Message:*\n${escapeTelegramMarkdown(f.message)}`;

  const buttons: any[] = [];
  if (f.status !== 'resolved') {
    buttons.push([Markup.button.callback('✅ Mark Resolved', `admin_feedback_resolve:${f.id}`)]);
  }
  if (f.status !== 'in_progress' && f.status !== 'resolved') {
    buttons.push([Markup.button.callback('🔵 Mark In Progress', `admin_feedback_progress:${f.id}`)]);
  }
  buttons.push([Markup.button.callback('◀️ Back', 'admin_page:feedback')]);

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_feedback_resolve:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const feedbackId = parseInt(ctx.match[1], 10);
  await db.update(feedback).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(feedback.id, feedbackId));
  await ctx.answerCbQuery('Marked resolved');
  await ctx.editMessageText(`✅ Feedback #${feedbackId} marked as resolved.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Back to Feedback', 'admin_page:feedback')]]));
});

bot.action(/admin_feedback_progress:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const feedbackId = parseInt(ctx.match[1], 10);
  await db.update(feedback).set({ status: 'in_progress' }).where(eq(feedback.id, feedbackId));
  await ctx.answerCbQuery('Marked in progress');
  await ctx.editMessageText(`🔵 Feedback #${feedbackId} marked as in progress.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Back to Feedback', 'admin_page:feedback')]]));
});

// ─── Ambassador Referrals ───

const REFS_PER_PAGE = 15;

bot.action('admin_page:ambassador_refs', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const ambassadors = await db.select().from(ambassadorApplications).orderBy(desc(ambassadorApplications.createdAt)).limit(REFS_PER_PAGE);

  // Compute stats per page
  const stats: Record<number, { signups: number; active: number; volume: number }> = {};
  for (const a of ambassadors) {
    if (a.customReferralCode) {
      const signups = await db.select({ count: sql`count(*)` }).from(users).where(eq(users.ambassadorReferralCode, a.customReferralCode));
      const active = await getAmbassadorActiveUserCount(a.customReferralCode);
      const volume = await getAmbassadorTotalVolume(a.customReferralCode);
      stats[a.id] = { signups: Number(signups[0]?.count || 0), active, volume };
    } else {
      stats[a.id] = { signups: 0, active: 0, volume: 0 };
    }
  }

  let list = ambassadors.map((a, i) => {
    const s = stats[a.id];
    const tierBadge = a.tier === 'elite' ? '🥇' : a.tier === 'pro' ? '🥈' : '🥉';
    const statusIcon = a.status === 'confirmed' ? '✅' : a.status === 'removed' ? '❌' : '⏳';
    return `${i + 1}. ${tierBadge} ${statusIcon} *${escapeTelegramMarkdown(a.name)}*\n   Active: ${s.active} | Vol: ₦${s.volume.toLocaleString()} | Code: ${a.customReferralCode ? `\`${a.customReferralCode}\`` : '—'}`;
  }).join('\n\n');

  const text = `🎯 *Ambassador Programme* (page 1) — ${total[0]?.count || 0} total\n\n${list || 'No ambassadors yet.'}\n\nTap an ambassador for details:`;

  const buttons = ambassadors.map(a => [
    Markup.button.callback(`${escapeTelegramMarkdown(a.name)}`, `admin_ambassador_detail:${a.id}`)
  ]);

  const navButtons = [];
  if (Number(total[0]?.count || 0) > REFS_PER_PAGE) {
    navButtons.push(Markup.button.callback('➡️ Next', 'admin_ref_page:1'));
  }
  if (navButtons.length) buttons.push(navButtons);
  buttons.push([Markup.button.callback('🏆 Leaderboard', 'admin_ambassador_leaderboard')]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_ref_page:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const page = parseInt(ctx.match[1], 10);
  const offset = page * REFS_PER_PAGE;

  const total = await db.select({ count: sql`count(*)` }).from(ambassadorApplications);
  const ambassadors = await db.select().from(ambassadorApplications).orderBy(desc(ambassadorApplications.createdAt)).limit(REFS_PER_PAGE).offset(offset);

  // Compute stats per page
  const stats: Record<number, { signups: number; active: number; volume: number }> = {};
  for (const a of ambassadors) {
    if (a.customReferralCode) {
      const signups = await db.select({ count: sql`count(*)` }).from(users).where(eq(users.ambassadorReferralCode, a.customReferralCode));
      const active = await getAmbassadorActiveUserCount(a.customReferralCode);
      const volume = await getAmbassadorTotalVolume(a.customReferralCode);
      stats[a.id] = { signups: Number(signups[0]?.count || 0), active, volume };
    } else {
      stats[a.id] = { signups: 0, active: 0, volume: 0 };
    }
  }

  let list = ambassadors.map((a, i) => {
    const s = stats[a.id];
    const tierBadge = a.tier === 'elite' ? '🥇' : a.tier === 'pro' ? '🥈' : '🥉';
    const statusIcon = a.status === 'confirmed' ? '✅' : a.status === 'removed' ? '❌' : '⏳';
    return `${offset + i + 1}. ${tierBadge} ${statusIcon} *${escapeTelegramMarkdown(a.name)}*\n   Active: ${s.active} | Vol: ₦${s.volume.toLocaleString()} | Code: ${a.customReferralCode ? `\`${a.customReferralCode}\`` : '—'}`;
  }).join('\n\n');

  const totalCount = Number(total[0]?.count || 0);
  const text = `🎯 *Ambassador Programme* (page ${page + 1}) — ${totalCount} total\n\n${list || 'No more ambassadors.'}\n\nTap an ambassador for details:`;

  const buttons = ambassadors.map(a => [
    Markup.button.callback(`${escapeTelegramMarkdown(a.name)}`, `admin_ambassador_detail:${a.id}`)
  ]);

  const navButtons = [];
  if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `admin_ref_page:${page - 1}`));
  if (totalCount > offset + REFS_PER_PAGE) navButtons.push(Markup.button.callback('➡️ Next', `admin_ref_page:${page + 1}`));
  if (navButtons.length) buttons.push(navButtons);
  buttons.push([Markup.button.callback('🏆 Leaderboard', 'admin_ambassador_leaderboard')]);
  buttons.push([Markup.button.callback('◀️ Back', 'admin_back')]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action('admin_ambassador_leaderboard', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambassadors = await db.select().from(ambassadorApplications).where(eq(ambassadorApplications.status, 'confirmed'));

  const board = [];
  for (const a of ambassadors) {
    if (!a.customReferralCode) continue;
    const active = await getAmbassadorActiveUserCount(a.customReferralCode);
    const volume = await getAmbassadorTotalVolume(a.customReferralCode);
    board.push({ ...a, active, volume });
  }
  board.sort((a, b) => b.active - a.active);

  let list = board.slice(0, 10).map((a, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} *${escapeTelegramMarkdown(a.name)}* — ${a.active} active | ₦${a.volume.toLocaleString()}`;
  }).join('\n\n');

  const text = `🏆 *ZendER Leaderboard* — Top ${board.length}\n\n${list || 'No confirmed ambassadors yet.'}`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'admin_page:ambassador_refs')]]) });
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

  let activeCount = 0;
  let totalVolume = 0;
  if (amb.customReferralCode) {
    activeCount = await getAmbassadorActiveUserCount(amb.customReferralCode);
    totalVolume = await getAmbassadorTotalVolume(amb.customReferralCode);
  }

  const computedTier = getAmbassadorTierFromCount(activeCount);
  const rate = getCommissionRateBps(computedTier);
  const commission = calculateCommissionNgn(totalVolume, computedTier);

  const text =
    `🧑‍🎓 *Ambassador Detail*\n\n` +
    `*Name:* ${escapeTelegramMarkdown(amb.name)}\n` +
    `*Handle:* @${escapeTelegramMarkdown(amb.tgHandle.replace(/^@/, ''))}\n` +
    `*Focus:* ${escapeTelegramMarkdown(amb.focus)}\n` +
    `*Student:* ${escapeTelegramMarkdown(amb.isStudent)}\n` +
    `*Status:* ${formatAmbassadorStatus(amb.status)}\n` +
    `*Tier:* ${formatAmbassadorTier(amb.tier)} (computed: ${formatAmbassadorTier(computedTier)})\n\n` +
    `*Referral Code:* ${amb.customReferralCode ? `\`${amb.customReferralCode}\`` : '_(not set)_'}\n` +
    `*Active Users:* ${activeCount}\n` +
    `*Total Volume:* ₦${totalVolume.toLocaleString()}\n` +
    `*Commission Rate:* ${(rate / 100).toFixed(2)}%\n` +
    `*Est. Commission:* ₦${Math.round(commission).toLocaleString()}\n` +
    `${amb.customReferralCode ? `*Link:* \`t.me/zend_money_bot?start=${amb.customReferralCode}\`` : ''}`;

  const buttons = [
    [Markup.button.callback('✏️ Set Code', `admin_set_ambassador_code:${amb.id}`)],
    [Markup.button.callback('👥 View Active Users', `admin_ambassador_signups:${amb.id}`)],
  ];
  if (amb.status === 'pending') {
    buttons.push([Markup.button.callback('✅ Confirm', `admin_confirm_ambassador:${amb.id}`)]);
  }
  if (amb.status !== 'removed') {
    buttons.push([Markup.button.callback('❌ Remove', `admin_remove_ambassador:${amb.id}`)]);
  }
  buttons.push([Markup.button.callback('◀️ Back', 'admin_page:ambassador_refs')]);

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action(/admin_confirm_ambassador:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  await db.update(ambassadorApplications)
    .set({ status: 'confirmed', confirmedAt: new Date() })
    .where(eq(ambassadorApplications.id, ambId));

  await ctx.answerCbQuery('✅ Ambassador confirmed');
  await ctx.editMessageText('✅ Ambassador confirmed successfully.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]));
});

bot.action(/admin_remove_ambassador:(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) { await ctx.answerCbQuery('❌ Not authorized'); return; }

  const ambId = parseInt(ctx.match[1], 10);
  await db.update(ambassadorApplications)
    .set({ status: 'removed' })
    .where(eq(ambassadorApplications.id, ambId));

  await ctx.answerCbQuery('❌ Ambassador removed');
  await ctx.editMessageText('❌ Ambassador removed. Their referral link is now deactivated.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]));
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

  // Show ACTIVE users only (users with ≥1 completed transaction)
  const activeUsers = await db.select({
    id: users.id,
    name: users.firstName,
    username: users.telegramUsername,
    createdAt: users.createdAt,
  }).from(users)
    .where(
      and(
        eq(users.ambassadorReferralCode, amb.customReferralCode),
        sql`exists (select 1 from ${transactions} where ${transactions.userId} = ${users.id} and ${transactions.status} = 'completed')`
      )
    )
    .orderBy(desc(users.createdAt))
    .limit(20);

  const totalActive = await getAmbassadorActiveUserCount(amb.customReferralCode);

  let list = activeUsers.map((u, i) =>
    `${i + 1}. ${escapeTelegramMarkdown(u.name || 'Unknown')}${u.username ? ` (@${escapeTelegramMarkdown(u.username.replace(/^@/, ''))})` : ''} — ${new Date(u.createdAt).toLocaleDateString('en-NG')}`
  ).join('\n');

  const text =
    `👥 *Active Users via ${escapeTelegramMarkdown(amb.name)}*\n` +
    `Code: \`${amb.customReferralCode}\` | Active: ${totalActive}\n\n` +
    (list || 'No active users yet.');

  const buttons = activeUsers.map(u => [Markup.button.callback(`View ${escapeTelegramMarkdown(u.name || 'User')}`, `admin_user:${u.id}`)]);
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
  if (txn.nearIntentDepositAddress) text += `📌 *NEAR Intents:* \`${txn.nearIntentDepositAddress}\`\n`;

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
  const totalNgnOut = await db.select({ sum: sql`coalesce(sum(ngn_amount), 0)` }).from(transactions).where(and(eq(transactions.userId, userRow.id), eq(transactions.type, 'ngn_send')));
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
// /ADMIN — Admin Dashboard
// ═════════════════════════════════════════════════════════════════════════════

bot.command('admin', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;

  // Grant access to super-admins or DB-flagged admins
  const hasAccess = isSuperAdmin(userId) || await isAdminUser(userId);
  if (!hasAccess) {
    await ctx.reply('❌ You do not have admin access.');
    return;
  }

  await ctx.reply(
    `🔐 *Admin Dashboard*\n\n` +
    `Welcome, ${ctx.from.first_name}.\n\n` +
    `Select a section below:`,
    { parse_mode: 'Markdown', ...adminMenu }
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
      if (!AUDD_ENABLED && bal.symbol === 'AUDD') continue;
      let ngnEquiv = 0;
      if (bal.symbol === 'SOL') {
        ngnEquiv = bal.amount * solPrice * offRampRate;
      } else {
        ngnEquiv = bal.amount * offRampRate;
      }
      totalNgn += ngnEquiv;
      const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : bal.symbol === 'AUDD' ? '🇦🇺' : bal.symbol === 'NEAR' ? '⚡' : '🟡';
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
  if (!AUDD_ENABLED) {
    await ctx.reply('🇦🇺 AUDD is not available right now. Use *💵 Add Naira* or *📥 Receive* for USDT.', { parse_mode: 'Markdown', ...mainMenu });
    return;
  }

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

  // ─── Pass reply-keyboard buttons to bot.hears() handlers ───
  if (REPLY_KEYBOARD_BUTTONS.has(text)) {
    return next();
  }

  // ─── Onboarding gate ───
  const isOnboardingState = session.state.startsWith('onboarding_');
  if (!isOnboardingState) {
    const userRow = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (userRow.length > 0 && !userRow[0].onboardingComplete) {
      await ctx.reply(
        `🔐 *Account Setup Required*\n\n` +
        `Please complete identity verification and PIN setup before using Zend.`,
        { parse_mode: 'Markdown' }
      );
      await startOnboarding(ctx, userId);
      return;
    }
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
      `\`t.me/zend_money_bot?start=${code}\``,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', `admin_ambassador_detail:${ambId}`)]]) }
    );
    return;
  }

  // ─── BULK SEND: AWAITING_BULK_SEND_INPUT ───
  if (session.state === ConversationState.AWAITING_BULK_SEND_INPUT) {
    const rawText = text.trim();
    if (!rawText) {
      await ctx.reply('❌ No recipients found. Please paste at least one recipient.', cancelKeyboard);
      return;
    }

    // Try AI parsing first
    const aiRecipients = await parseBulkSendWithAI(rawText);

    let recipients: Array<{ amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string }> = [];
    let usedAI = false;

    if (aiRecipients && aiRecipients.length > 0) {
      usedAI = true;
      for (const r of aiRecipients) {
        const bank = NIGERIAN_BANKS.find(b => b.code === r.bank_code);
        if (bank) {
          recipients.push({
            amountNgn: r.amount_ngn,
            bankCode: r.bank_code,
            bankName: bank.name,
            accountNumber: r.account_number,
            accountName: r.account_name,
          });
        }
      }
    }

    // Fallback to strict parser if AI returned nothing
    if (recipients.length === 0) {
      const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parsed = parseBulkRecipient(line);
        if (parsed) recipients.push(parsed);
      }
    }

    if (recipients.length === 0) {
      await ctx.reply(
        `❌ Could not parse any valid recipients.\n\n` +
        `Try describing each recipient naturally, e.g.:\n` +
        `\`Send 50k to John Doe at GTBank 0123456789\`\n` +
        `\`₦30,000 to Jane Smith UBA 9876543210\`\n\n` +
        `Or use the strict format:\n` +
        `\`AMOUNT BANK_CODE ACCOUNT_NUMBER ACCOUNT_NAME\``,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      return;
    }

    // Store recipients in session
    setSession(userId, { state: ConversationState.IDLE, pendingTransaction: { bulkRecipients: recipients } as any });

    // Calculate totals
    const totalNgn = recipients.reduce((sum, r) => sum + r.amountNgn, 0);
    const pajClient = await getPAJClient();
    let rate = 1550;
    try {
      if (pajClient) {
        const rates = await getPAJRates();
        rate = rates.offRampRate;
      }
    } catch { /* fallback */ }

    // Calculate per-recipient fees based on user's SOL balance
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const walletAddress = user[0]?.walletAddress;

    let totalUsdt = 0;
    let totalFeeUsdt = 0;
    let anyFunded = false;
    for (const r of recipients) {
      const transferUsdt = r.amountNgn / rate;
      const feeInfo = walletAddress
        ? await calculateSendFee(transferUsdt, walletAddress, userId)
        : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
      totalUsdt += transferUsdt;
      totalFeeUsdt += feeInfo.zendFeeUsdt;
      if (feeInfo.willFundSol) anyFunded = true;
    }
    const grandTotalUsdt = totalUsdt + totalFeeUsdt;

    // Check total balance
    let balanceOk = true;
    let balanceMsg = '';
    if (walletAddress) {
      const tokenBalance = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
      const solBalance = await walletService.getSolBalance(walletAddress);

      if (tokenBalance < grandTotalUsdt) {
        balanceOk = false;
        balanceMsg = `❌ Insufficient USDT. Need ${grandTotalUsdt.toFixed(2)} USDT, have ${tokenBalance.toFixed(2)} USDT.`;
      } else if (solBalance < MIN_SOL_FOR_GAS) {
        balanceOk = false;
        balanceMsg = `❌ Insufficient SOL for gas. Need ~${MIN_SOL_FOR_GAS} SOL.`;
      }
    }

    const feeRateText = anyFunded
      ? `max(${(ZEND_FEE_FUNDED_BPS / 100).toFixed(1)}%, gas cost + small fee)`
      : `1% capped at $2`;

    let summary =
      `📦 *Bulk Send Summary*\n\n` +
      `Recipients: ${recipients.length}\n` +
      `Total NGN: ₦${totalNgn.toLocaleString()}\n` +
      `Rate: ₦${rate.toLocaleString()} / USDT\n` +
      `Transfer: ${totalUsdt.toFixed(2)} USDT\n` +
      `Zend Fee: ${totalFeeUsdt.toFixed(2)} USDT (${feeRateText})\n` +
      `Grand Total: ${grandTotalUsdt.toFixed(2)} USDT\n\n` +
      `*Recipients:*\n`;

    summary += recipients.map((r, i) =>
      `${i + 1}. ${escapeTelegramMarkdown(r.accountName)} — ₦${r.amountNgn.toLocaleString()} → ${escapeTelegramMarkdown(r.bankName)} (\`${r.accountNumber}\`)`
    ).join('\n');

    if (!balanceOk) {
      summary += `\n\n${balanceMsg}`;
      await ctx.reply(summary, { parse_mode: 'Markdown', ...cancelKeyboard });
      return;
    }

    // Require PIN if set
    if (user[0]?.transactionPin) {
      setSession(userId, {
        state: ConversationState.AWAITING_PIN_VERIFY,
        pinVerifyAction: 'bulk_send',
        pendingTransaction: { bulkRecipients: recipients } as any,
      });
      await ctx.reply(
        `${summary}\n\n🔐 Enter your 4-digit PIN to confirm this bulk send:`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
      return;
    }

    // No PIN — confirm directly
    const confirmButtons = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm Bulk Send', 'bulk_send_confirm')],
      [Markup.button.callback('❌ Cancel', 'bulk_send_cancel')],
    ]);
    await ctx.reply(summary, { parse_mode: 'Markdown', ...confirmButtons });
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
    if (!bd || !bd.destinationAsset || !bd.destinationSymbol) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired. Please start over.', mainMenu);
      return;
    }

    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Please enter a valid amount. Example: 10, 50, 100', cancelKeyboard);
      return;
    }

    const decimals = NEAR_INTENTS_DECIMALS[bd.sourceChain]?.[bd.token] || 6;
    const baseAmount = Math.floor(amount * Math.pow(10, decimals)).toString();

    const nearIntents = getNearIntentsClient();
    if (!nearIntents) {
      await ctx.reply('❌ NEAR Intents not configured.', mainMenu);
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
      await ctx.reply('⏳ Generating deposit address via NEAR Intents...');

      const quote = await nearIntents.getQuote({
        originAsset: bd.assetId,
        destinationAsset: bd.destinationAsset,
        amount: baseAmount,
        recipient: user[0].walletAddress,
      });

      const depositAddress = quote.quote.depositAddress;
      const amountOutFormatted = quote.quote.amountOutFormatted;
      const feeLine = quote.quote.withdrawFee
        ? `• Est. network fee: ~${quote.quote.withdrawFee}\n`
        : '';

      // Record in DB
      const txId = generateTxId();
      await db.insert(transactions).values({
        id: txId,
        userId,
        type: 'crypto_receive',
        status: 'pending',
        nearIntentDepositAddress: depositAddress,
        recipientWalletAddress: user[0].walletAddress,
        fromAmount: amount.toString(),
        fromMint: bd.assetId,
        toMint: bd.destinationAsset,
      });

      const chainDisplay = CHAIN_DISPLAY_NAMES[bd.sourceChain] || bd.sourceChain;
      await indexTransaction(userId, txId, `Deposit from ${chainDisplay} via NEAR Intents`, {
        amount,
        chain: chainDisplay,
        depositAddress,
      });

      await ctx.reply(
        `🌉 *Deposit ${bd.token} from ${chainDisplay}*\n\n` +
        `Send *${amount} ${bd.token}* to this address:\n\n` +
        `${depositAddress}\n\n` +
        `⚠️ *Important:*\n` +
        `• Only send ${bd.token} on ${chainDisplay}\n` +
        `• You'll receive ~${amountOutFormatted} ${bd.destinationSymbol} in your Zend account\n` +
        feeLine +
        `• Expires: ${new Date(quote.quote.deadline).toLocaleString('en-NG')}\n\n` +
        `Reference: \`${txId}\``,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      await ctx.reply('📋 Tap to copy the address:', Markup.inlineKeyboard([
        [{ text: '📋 Copy Address', copy_text: { text: depositAddress } } as any]
      ]));
    } catch (err: any) {
      console.error('[Bridge] Failed:', err);
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply(
        `❌ *Deposit Error*\n\n` +
        `Could not generate deposit address.\n` +
        `Error: ${err.message || 'Unknown error'}\n\n` +
        `Please try again later or contact support.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }

    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  // ─── WITHDRAW: AWAITING_WITHDRAW_RECIPIENT ───
  if (session.state === ConversationState.AWAITING_WITHDRAW_RECIPIENT) {
    const wd = session.withdrawData;
    if (!wd) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired.', mainMenu);
      return;
    }

    const recipientAddress = text.trim();
    if (!validateChainAddress(wd.destChain, recipientAddress)) {
      await ctx.reply(
        `❌ Invalid address for ${formatChainName(wd.destChain)}.\nPlease check and try again.`,
        cancelKeyboard
      );
      return;
    }

    setSession(userId, {
      ...session,
      state: ConversationState.AWAITING_WITHDRAW_AMOUNT,
      withdrawData: { ...wd, recipientAddress },
    });

    await ctx.reply(
      `📤 *Withdraw Preview*\n\n` +
      `From: Zend *${wd.sourceSymbol}*\n` +
      `To: *${formatChainName(wd.destChain)}* (${wd.destToken})\n` +
      `Recipient: \`${recipientAddress}\`\n\n` +
      `How much ${wd.sourceSymbol} do you want to send?\n` +
      `Example: 10, 25, 50`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
    return;
  }

  // ─── WITHDRAW: AWAITING_WITHDRAW_AMOUNT ───
  if (session.state === ConversationState.AWAITING_WITHDRAW_AMOUNT) {
    const wd = session.withdrawData;
    if (!wd?.recipientAddress) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired.', mainMenu);
      return;
    }

    const amount = parseFloat(text.trim().replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Please enter a valid amount.', cancelKeyboard);
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0) {
      await ctx.reply('Please run /start first.', mainMenu);
      return;
    }

    const balance = await walletService.getTokenBalance(
      user[0].walletAddress,
      SOLANA_TOKENS[wd.sourceSymbol].mint
    );
    if (balance < amount) {
      await ctx.reply(
        `❌ Insufficient balance.\nYou have ${balance.toFixed(2)} ${wd.sourceSymbol}, need ${amount}.`,
        cancelKeyboard
      );
      return;
    }

    try {
      await ctx.reply('⏳ Getting quote from NEAR Intents...');

      const quote = await createWithdrawQuote({
        sourceSymbol: wd.sourceSymbol,
        amount,
        destChain: wd.destChain,
        destToken: wd.destToken,
        destAssetId: wd.destAssetId,
        recipientAddress: wd.recipientAddress,
        refundWallet: user[0].walletAddress,
      });

      const depositAddress = quote.quote.depositAddress;
      const amountOutFormatted = quote.quote.amountOutFormatted;
      const txId = generateTxId();

      await db.insert(transactions).values({
        id: txId,
        userId,
        type: 'crypto_send',
        status: 'pending',
        nearIntentDepositAddress: depositAddress,
        fromAmount: amount.toString(),
        fromMint: SOLANA_ORIGIN_ASSETS[wd.sourceSymbol],
        toMint: wd.destAssetId,
        recipientWalletAddress: wd.recipientAddress,
        metadata: { direction: 'withdraw', destChain: wd.destChain, destToken: wd.destToken },
      });

      setSession(userId, {
        state: ConversationState.IDLE,
        withdrawData: {
          ...wd,
          amount,
          depositAddress,
          txId,
          amountOutFormatted,
        },
      });

      await ctx.reply(
        `📤 *Confirm Withdrawal*\n\n` +
        `Send: *${amount} ${wd.sourceSymbol}*\n` +
        `To: *${formatChainName(wd.destChain)}*\n` +
        `Recipient: \`${wd.recipientAddress}\`\n` +
        `They receive: ~${amountOutFormatted} ${wd.destToken}\n` +
        (quote.quote.withdrawFee ? `Est. fee: ~${quote.quote.withdrawFee}\n` : '') +
        `\nReference: \`${txId}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm', 'confirm_withdraw')],
            [Markup.button.callback('❌ Cancel', 'cancel_withdraw')],
          ]),
        }
      );
    } catch (err: any) {
      console.error('[Withdraw] Quote failed:', err);
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply(
        `❌ Could not get withdrawal quote.\n${err.message || 'Try again later.'}`,
        mainMenu
      );
    }
    return;
  }

  // ─── ONBOARDING: AWAITING_EMAIL ───
  if (session.state === ConversationState.ONBOARDING_AWAITING_EMAIL) {
    const contact = text.trim();
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
      await ctx.reply('❌ PAJ service unavailable.', cancelKeyboard);
      return;
    }

    try {
      const pajContact = isPhone && contact.startsWith('+') ? contact.slice(1) : contact;
      const initiated = await pajClient.initiateSession(pajContact);
      console.log('[PAJ] OTP sent to:', initiated.email || initiated.phone);

      session.pajContact = contact;
      session.state = ConversationState.ONBOARDING_AWAITING_OTP;
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
        `Please try again.`,
        cancelKeyboard
      );
    }
    return;
  }

  // ─── ONBOARDING: AWAITING_OTP ───
  if (session.state === ConversationState.ONBOARDING_AWAITING_OTP) {
    const otp = text.trim();
    const contact = session.pajContact;

    const pajClient = await getPAJClient();
    if (!contact || !pajClient) {
      await ctx.reply('❌ Session expired. Please start over.', cancelKeyboard);
      setSession(userId, { state: ConversationState.ONBOARDING_AWAITING_EMAIL });
      return;
    }

    if (!/^\d{4,8}$/.test(otp)) {
      await ctx.reply('❌ Please enter a valid OTP (4-8 digits).', cancelKeyboard);
      return;
    }

    try {
      const pajContact = contact.startsWith('+') ? contact.slice(1) : contact;
      const verified = await pajClient.verifySession(pajContact, otp, {
        uuid: `zend-${userId}`,
        device: 'Telegram',
        os: 'Telegram Bot',
        browser: 'Telegram',
      });

      console.log('[PAJ] Session verified for:', verified.recipient);

      await db.update(users)
        .set({
          pajSessionToken: verified.token,
          pajSessionExpiresAt: new Date(verified.expiresAt),
          pajContact: contact,
        })
        .where(eq(users.id, userId));

      // Move to PIN setup
      session.state = ConversationState.ONBOARDING_AWAITING_PIN;
      setSession(userId, session);

      await ctx.reply(
        `✅ *Identity Verified!*\n\n` +
        `Step 3 of 3: Set a 4-digit transaction PIN\n` +
        `This PIN will be required for all transfers.`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
      );
    } catch (err: any) {
      console.error('[PAJ] Verify failed:', err);
      const errorMsg = err.message || '';
      if (errorMsg.includes('Invalid') || errorMsg.includes('invalid')) {
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

  // ─── ONBOARDING: AWAITING_PIN ───
  if (session.state === ConversationState.ONBOARDING_AWAITING_PIN) {
    const pin = text.trim();
    if (!/^\d{4}$/.test(pin)) {
      await ctx.reply('❌ Please enter a valid 4-digit PIN.', cancelKeyboard);
      return;
    }

    const hashed = await hashPin(pin);
    await db.update(users)
      .set({ transactionPin: hashed, onboardingComplete: true })
      .where(eq(users.id, userId));

    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply(
      `✅ *Setup Complete!*\n\n` +
      `Your account is secured and ready to use.\n\n` +
      `💰 Check your balance | 📤 Send money | 💵 Add Naira`,
      { parse_mode: 'Markdown', ...mainMenu }
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

    const transferUsdt = amount / rate;
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const feeInfo = user[0]?.walletAddress
      ? await calculateSendFee(transferUsdt, user[0].walletAddress, userId)
      : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
    const usdtNeeded = transferUsdt + feeInfo.zendFeeUsdt;

    session.pendingTransaction = {
      ...session.pendingTransaction,
      amountNgn: amount,
      amountUsdt: usdtNeeded,
      zendFeeUsdt: feeInfo.zendFeeUsdt,
      feeSol: feeInfo.feeSol,
    };
    session.state = ConversationState.AWAITING_SEND_RECIPIENT;
    setSession(userId, session);

    let msg = `📤 Send ${formatNgn(amount)}\n` +
      `Rate: ${formatNgn(rate)} per Dollar\n` +
      `${formatSendFeeLabel(feeInfo)}\n` +
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

    const feeLine = session.pendingTransaction?.zendFeeUsdt
      ? `Zend fee: ~${session.pendingTransaction.zendFeeUsdt.toFixed(2)} USDT\n`
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

  // ─── BILL PAYMENTS ───
  if (session.state === ConversationState.BILL_ENTER_PHONE) {
    const phone = text.trim().replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 15) {
      await ctx.reply('❌ Please enter a valid phone number (10-15 digits).', cancelKeyboard);
      return;
    }
    session.billData = { ...session.billData, phone };

    if (session.billData?.type === 'airtime') {
      session.state = ConversationState.BILL_ENTER_AMOUNT;
      setSession(userId, session);
      await ctx.reply('💵 Enter amount in Naira (e.g., 500, 1000, 2000):', cancelKeyboard);
      return;
    }

    if (session.billData?.type === 'data') {
      const loading = await showLoading(ctx, 'Fetching data plans...');
      try {
        let rows: ReturnType<typeof Markup.button.callback>[][] = [];
        if (airbillsClient) {
          let plans: Array<{ id: string; name: string; amount: number }> = [];
          try {
            plans = await airbillsClient.getPlans(session.billData.network!);
          } catch {
            plans = await airbillsClient.getPlans('data');
          }
          if (plans.length === 0) {
            await finishLoading(ctx, loading.message_id, '❌ No data plans found for this network.');
            setSession(userId, { state: ConversationState.IDLE });
            await ctx.reply('Menu:', mainMenu);
            return;
          }
          rows = plans.map((p) =>
            [Markup.button.callback(`${p.name} — ₦${p.amount.toLocaleString()}`, `bill_plan_${p.id}_${p.amount}`)]
          );
        } else {
          const plans = await getDataPlans(session.billData.network!);
          if (plans.length === 0) {
            await finishLoading(ctx, loading.message_id, '❌ No data plans found.');
            setSession(userId, { state: ConversationState.IDLE });
            await ctx.reply('Menu:', mainMenu);
            return;
          }
          rows = plans.map((p: DataPlan) =>
            [Markup.button.callback(`${p.name} — ₦${p.amount.toLocaleString()} (${p.validity})`, `bill_plan_${p.planCode}_${p.amount}`)]
          );
        }
        await finishLoading(ctx, loading.message_id, `🌐 Select a data plan for ${session.billData.phone}:`);
        await ctx.reply('Choose a plan:', Markup.inlineKeyboard(rows));
        setSession(userId, session);
      } catch (err: any) {
        await finishLoading(ctx, loading.message_id, '❌ Could not fetch plans. Please try again.');
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('Menu:', mainMenu);
      }
      return;
    }

    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply('❌ Unknown bill type. Please start over.', mainMenu);
    return;
  }

  if (session.state === ConversationState.BILL_ENTER_AMOUNT) {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!amount || amount < 50) {
      await ctx.reply('❌ Minimum amount is ₦50. Enter a valid amount:', cancelKeyboard);
      return;
    }

    const bill = session.billData;
    if (!bill) {
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply('❌ Session expired. Please start over.', mainMenu);
      return;
    }

    bill.amount = amount;
    session.billData = bill;
    setSession(userId, session);

    // Show confirmation
    let rate = 1400;
    try {
      const rates = await getPAJRates();
      rate = rates.offRampRate || 1400;
    } catch { /* fallback */ }
    const usdtAmount = amount / rate;

    const typeMap: Record<string, string> = {
      airtime: '📱 Airtime',
      data: '🌐 Data',
      electricity: '⚡ Electricity',
      cable: '📺 Cable TV',
    };

    await ctx.reply(
      `💳 *Confirm Purchase*\n\n` +
      `Type: ${typeMap[bill.type || ''] || bill.type}\n` +
      `${bill.network ? `Network: ${bill.network.toUpperCase()}\n` : ''}` +
      `${bill.disco ? `Disco: ${bill.disco}\n` : ''}` +
      `${bill.provider ? `Provider: ${bill.provider.toUpperCase()}\n` : ''}` +
      `${bill.phone ? `Phone: ${bill.phone}\n` : ''}` +
      `${bill.meterNumber ? `Meter: ${bill.meterNumber}\n` : ''}` +
      `${bill.smartCardNumber ? `Smart Card: ${bill.smartCardNumber}\n` : ''}` +
      `Amount: ₦${amount.toLocaleString()}\n` +
      `≈ ${usdtAmount.toFixed(4)} USDT\n\n` +
      `Tap Confirm to complete.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm', 'bill_confirm')],
          [Markup.button.callback('❌ Cancel', 'cancel_send')],
        ]),
      }
    );
    return;
  }

  if (session.state === ConversationState.BILL_ENTER_METER) {
    const meter = text.trim().replace(/\D/g, '');
    if (meter.length < 5 || meter.length > 20) {
      await ctx.reply('❌ Please enter a valid meter number.', cancelKeyboard);
      return;
    }
    session.billData = { ...session.billData, meterNumber: meter };
    session.state = ConversationState.BILL_ENTER_AMOUNT;
    setSession(userId, session);
    await ctx.reply('💵 Enter amount in Naira (e.g., 1000, 5000):', cancelKeyboard);
    return;
  }

  if (session.state === ConversationState.BILL_ENTER_SMARTCARD) {
    const card = text.trim().replace(/\D/g, '');
    if (card.length < 5 || card.length > 20) {
      await ctx.reply('❌ Please enter a valid smart card number.', cancelKeyboard);
      return;
    }
    session.billData = { ...session.billData, smartCardNumber: card };
    // For cable, we'd fetch bouquets here. For MVP, ask amount directly.
    session.state = ConversationState.BILL_ENTER_AMOUNT;
    setSession(userId, session);
    await ctx.reply('💵 Enter subscription amount in Naira:', cancelKeyboard);
    return;
  }

  // ─── NLP: Parse natural language when IDLE ───
  if (session.state === ConversationState.IDLE) {
    // ─── Instant greetings (no slow LLM) ───
    if (isCasualGreeting(text)) {
      const name = ctx.from?.first_name || 'there';
      await ctx.reply(
        `Hey ${name}! 👋 No wahala — I'm here.\n\n` +
        `Try *💰 Balance*, *📤 Send*, or say:\n` +
        `"Send 500 to 08123456789 Opay"`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }

    // ─── Semantic Transaction Search (QVAC Embeddings) ───
    const historyQueryPatterns = /\b(how much did i send|how much did i|did i send|transactions? with|payments? to|money i sent|what did i pay|show me my|search my)\b/i;
    if (historyQueryPatterns.test(text)) {
      const loading = await showLoading(ctx, 'Searching your history with QVAC...');
      try {
        const answer = await askTransactionQuestion(userId, text);
        if (answer) {
          await finishLoading(ctx, loading.message_id, `🔍 *Smart Search*\n\n${answer}`, 'Markdown');
        } else {
          await finishLoading(ctx, loading.message_id, '🔍 No matching transactions found. Try a different question or check your 📋 History.');
        }
      } catch (err: any) {
        console.error('[Search] Error:', err);
        await finishLoading(ctx, loading.message_id, '❌ Search failed. Please try 📋 History instead.');
      }
      await ctx.reply('Menu:', mainMenu);
      return;
    }

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

        const transferUsdt = parsed.amount / rate;
        const feeInfo = user[0]?.walletAddress
          ? await calculateSendFee(transferUsdt, user[0].walletAddress, userId)
          : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
        const usdtNeeded = transferUsdt + feeInfo.zendFeeUsdt;

        // ─── Check wallet balance before showing confirmation ───
        if (user[0]?.walletAddress) {
          const tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, fromMint);
          const solBalance = await walletService.getSolBalance(user[0].walletAddress);
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
          if (!feeInfo.willFundSol && solBalance < MIN_SOL_FOR_GAS) {
            await ctx.reply(
              `❌ *Insufficient SOL for gas*\n\n` +
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
          zendFeeUsdt: feeInfo.zendFeeUsdt,
          feeSol: feeInfo.feeSol,
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
          `${formatSendFeeLabel(feeInfo)}\n` +
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
            if (!AUDD_ENABLED && bal.symbol === 'AUDD') continue;
            let ngnEquiv = 0;
            if (bal.symbol === 'SOL') {
              ngnEquiv = bal.amount * solPrice * offRampRate;
            } else {
              ngnEquiv = bal.amount * offRampRate;
            }
            totalNgn += ngnEquiv;
            const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : bal.symbol === 'AUDD' ? '🇦🇺' : bal.symbol === 'NEAR' ? '⚡' : '🟡';
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
        const features = await getBotFeatures();
        const loading = await showLoading(ctx, 'Thinking...');
        const aiReply = (await chatWithAI(text, features)) ?? (await chatWithKimi(text, features));
        if (aiReply?.reply) {
          await finishLoading(ctx, loading.message_id, aiReply.reply);
          await ctx.reply('Menu:', mainMenu);
        } else {
          await finishLoading(
            ctx,
            loading.message_id,
            `I didn't catch that. Try the menu below or say something like:\n"Send 500 to 08123456789 Opay"`
          );
          await ctx.reply('Menu:', mainMenu);
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
    const savedPendingTx = session.pendingTransaction;
    const savedWithdrawData = session.withdrawData;

    if (action === 'swap') {
      const pt = savedPendingTx;
      if (!pt || !pt.swapQuote) {
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE, pendingTransaction: pt });
      await executeSwap(ctx, userId, pt);
    } else if (action === 'export') {
      setSession(userId, { state: ConversationState.IDLE });
      await doExportKey(ctx, userId);
    } else if (action === 'withdraw') {
      setSession(userId, { state: ConversationState.IDLE, withdrawData: savedWithdrawData });
      await executeNearIntentWithdraw(ctx, userId);
    } else if (action === 'send') {
      const pt = savedPendingTx;
      if (!pt?.amountNgn || !pt.amountUsdt) {
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE, pendingTransaction: pt });
      await executeSend(ctx, userId, {
        amountNgn: pt.amountNgn,
        amountUsdt: pt.amountUsdt,
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
    } else if (action === 'bulk_send') {
      const recipients = (savedPendingTx as any)?.bulkRecipients as Array<{
        amountNgn: number; bankCode: string; bankName: string; accountNumber: string; accountName: string;
      }> | undefined;
      if (!recipients?.length) {
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE });
      await executeBulkSend(ctx, userId, recipients);
    } else if (action === 'schedule') {
      const sd = session.scheduleData;
      const startAt = sd?.startAt;
      if (!sd?.amountNgn || !startAt) {
        setSession(userId, { state: ConversationState.IDLE });
        await ctx.reply('❌ Session expired. Please start over.', mainMenu);
        return;
      }
      setSession(userId, { state: ConversationState.IDLE });
      await saveScheduledTransfer(userId, sd, startAt);
      await ctx.reply(
        `✅ *Scheduled Transfer Created!*\n\n` +
        `To: ${md(sd.recipientName || 'Recipient')}\n` +
        `Bank: ${md(sd.bankName || '')}\n` +
        `Account: \`${sd.accountNumber}\`\n` +
        `Amount: ${formatNgn(sd.amountNgn)}\n` +
        `Frequency: ${sd.frequency}\n` +
        `Starts: ${startAt.toLocaleDateString('en-NG')}\n\n` +
        `Use *📅 Schedule* to view or cancel.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } else {
      setSession(userId, { state: ConversationState.IDLE });
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
      setSession(userId, {
        state: ConversationState.AWAITING_PIN_VERIFY,
        pinVerifyAction: 'schedule',
        scheduleData: sd,
      });
      const pinMsg = await ctx.reply(
        `🔐 *Security Check*\n\n` +
        `Enter your 4-digit PIN to confirm this scheduled transfer:`,
        { parse_mode: 'Markdown', ...cancelKeyboard }
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

  // ─── FEEDBACK: AWAITING_FEEDBACK_TEXT ───
  if (session.state === ConversationState.AWAITING_FEEDBACK_TEXT) {
    const feedbackText = text.trim();
    if (feedbackText.length < 3) {
      await ctx.reply('❌ Please write a bit more so we can understand your feedback.', cancelKeyboard);
      return;
    }
    if (feedbackText.length > 2000) {
      await ctx.reply('❌ Feedback is too long. Please keep it under 2000 characters.', cancelKeyboard);
      return;
    }
    try {
      await db.insert(feedback).values({
        userId,
        message: feedbackText,
        category: 'general',
        status: 'open',
      });
      setSession(userId, { state: ConversationState.IDLE });
      await ctx.reply(
        `📝 *Feedback Received*\n\n` +
        `Thank you\! We read every message and will follow up if needed.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } catch (err) {
      console.error('[Feedback] Save error:', err);
      await ctx.reply('❌ Could not save feedback. Please try again later.', mainMenu);
    }
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
  if (!user.length || !user[0].walletAddress) {
    await ctx.reply('❌ User profile incomplete. Please run /start.', mainMenu);
    return;
  }
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
  const webhookUrl = getPajWebhookUrl();

  // Always generate a fresh virtual account — PAJ accounts are one-time use
  const loadingVA = await showLoading(ctx, 'Creating your virtual bank account...');
  let order: any;
  try {
    order = await pajClient.createOnramp({
      fiatAmount,
      currency: Currency.NGN,
      recipient: walletAddress,
      mint: targetToken === 'AUDD' ? SOLANA_TOKENS.AUDD.mint : SOLANA_TOKENS.USDT.mint,
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
    console.error('[PAJ] createOnramp error details:', err.response?.data || err.body || 'No extra details');
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

  if (AUDD_ENABLED) {
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
    return;
  }

  setSession(userId, {
    state: ConversationState.AWAITING_SEND_AMOUNT,
    pendingTransaction: { fromMint: SOLANA_TOKENS.USDT.mint },
  });
  await ctx.reply(
    `📤 *Send Money*\n\n` +
    `How much do you want to send? (in Naira)\n\n` +
    `Examples: 50000, 100000, 5000`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
});

bot.action(/send_token:([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const tokenSymbol = ctx.match[1];

  if (!AUDD_ENABLED && tokenSymbol === 'AUDD') {
    await ctx.editMessageText('❌ AUDD sends are not available right now.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

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

  // Index for semantic search
  await indexTransaction(userId, txId, `Sent ₦${txData.amountNgn} to ${finalAccountName} at ${finalBankName}`, {
    amount: txData.amountNgn,
    bank: finalBankName,
    recipient: finalAccountName,
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

      const webhookUrl = getPajWebhookUrl();
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
          await indexTransaction(userId, swapTxId, `Swapped ${swapAmountUsdc.toFixed(2)} USDC to ${outAmountUsdt.toFixed(2)} USDT`, {
            fromAmount: swapAmountUsdc,
            toAmount: outAmountUsdt,
            fromToken: 'USDC',
            toToken: 'USDT',
          });
          tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDT.mint);
        }
      }

      const feeWallet = process.env.ZEND_FEE_WALLET;
      const feeUsdt = txData.zendFeeUsdt || 0;

      // Gas sponsorship: top up exact shortfall (including ATA rent if needed)
      const { funded, gasSponsored, shortfall, error: fundError } = await fundSolIfNeeded(
        user[0].walletAddress,
        order.address,
        pajMint,
        feeWallet || undefined,
        userId
      );
      if (shortfall && !funded) {
        const userMsg = gasFundingErrorToUserMessage(fundError, shortfall);
        throw new Error(userMsg);
      }

      // Check token balance covers transfer + fee
      const totalUsdtNeeded = order.amount + feeUsdt;
      if (tokenBalance < totalUsdtNeeded) {
        throw new Error(`Insufficient ${userFromSymbol} balance. You have: ${tokenBalance.toFixed(2)}, need: ${totalUsdtNeeded.toFixed(2)} for the transfer and fee.`);
      }

      // Build USDT fee transfer instruction to bundle with main send
      const feeInstructions: any[] = [];
      if (feeWallet && feeUsdt > 0) {
        const feeWalletPubkey = new PublicKey(feeWallet);
        const pajMintPubkey = new PublicKey(pajMint);
        const senderPubkey = new PublicKey(user[0].walletAddress);

        const senderTokenAccount = await getAssociatedTokenAddress(pajMintPubkey, senderPubkey);
        const feeWalletTokenAccount = await getAssociatedTokenAddress(pajMintPubkey, feeWalletPubkey);

        const rawFeeAmount = BigInt(Math.round(feeUsdt * Math.pow(10, pajToken.decimals)));

        feeInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            senderPubkey,
            feeWalletTokenAccount,
            feeWalletPubkey,
            pajMintPubkey
          ),
          createTransferInstruction(
            senderTokenAccount,
            feeWalletTokenAccount,
            senderPubkey,
            rawFeeAmount
          )
        );
      }

      const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      solanaTxHash = await walletService.sendSplToken(
        keypair, order.address, pajMint, order.amount, pajToken.decimals,
        feeInstructions.length > 0 ? feeInstructions : undefined,
        totalUsdtNeeded
      );
      console.log(`[Solana] ${userFromSymbol} sent to PAJ via USDT (+ USDT fee bundled):`, solanaTxHash);

      await db.update(transactions)
        .set({ solanaTxHash, pajReference: offRampRef })
        .where(eq(transactions.id, txId));
    } else {
      throw new Error(
        !user[0].pajSessionToken
          ? 'Your PAJ session is not linked. Please verify your identity in Settings first.'
          : 'Payment partner is temporarily unavailable. Please try again later.'
      );
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
    // PAJ infrastructure error — no available deposit wallets
    const errMsg = (err?.message || '').toLowerCase();
    if (errMsg.includes('no available wallet') || errMsg.includes('no available deposit')) {
      return {
        success: false,
        txId,
        error: 'Our payment partner is temporarily at capacity. Please try again in 1–2 minutes. No funds were deducted.',
      };
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
    `Fee: ~${(txData.zendFeeUsdt || 0).toFixed(2)} USDT\n` +
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
    const { funded, gasSponsored, shortfall, error: fundError } = await fundSolIfNeeded(user[0].walletAddress, undefined, undefined, undefined, userId);
    if (shortfall && !funded) {
      const userMsg = gasFundingErrorToUserMessage(fundError, shortfall);
      throw new Error(userMsg);
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
            const sponsorshipFeeSol = (outAmount * 0.0005) / solPrice;
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
            const sponsorshipFeeSol = (outAmount * 0.0005) / solPrice;
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
    const fromAmt = Number(quote.inAmount) / Math.pow(10, getTokenBySymbol(fromSymbol)!.decimals);
    await db.insert(transactions).values({
      id: txId,
      userId,
      type: 'swap',
      status: 'completed',
      fromMint: pt.fromMint,
      fromAmount: fromAmt.toString(),
      toMint: pt.toMint,
      toAmount: outAmount.toString(),
      solanaTxHash: txHash,
    });
    await indexTransaction(userId, txId, `Swapped ${fromAmt.toFixed(2)} ${fromSymbol} to ${outAmount.toFixed(2)} ${toSymbol}`, {
      fromAmount: fromAmt,
      toAmount: outAmount,
      fromToken: fromSymbol,
      toToken: toSymbol,
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

  const transferUsdt = amountNgn / rate;

  // ─── Calculate fee based on SOL balance ───
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  let feeInfo: SendFeeInfo = {
    zendFeeUsdt: 0, feeSol: 0, feeBps: 100, willFundSol: false,
    transferUsdt, totalUsdt: transferUsdt,
  };
  if (user[0]?.walletAddress) {
    feeInfo = await calculateSendFee(transferUsdt, user[0].walletAddress, userId);
  }
  const { zendFeeUsdt, feeSol, feeBps, willFundSol } = feeInfo;
  const usdtNeeded = transferUsdt + zendFeeUsdt;

  // ─── Check wallet balance before showing confirmation ───
  if (user[0]?.walletAddress) {
    const tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, selectedMint);
    const solBalance = await walletService.getSolBalance(user[0].walletAddress);
    const balanceCheck = checkSendBalance({
      tokenBalance,
      solBalance,
      transferUsdt,
      zendFeeUsdt,
      willFundSol,
      isAudd: selectedMint === SOLANA_TOKENS.AUDD.mint,
    });

    if (!balanceCheck.ok) {
      if (balanceCheck.error === 'no_audd') {
        await ctx.reply(
          `❌ *No AUDD Balance*\n\n` +
          `You don't have any AUDD to send.\n\n` +
          `Add AUDD to your wallet first.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        return;
      }
      if (balanceCheck.error === 'insufficient_token') {
        await ctx.reply(
          `❌ *Insufficient Balance*\n\n` +
          `You want to send ${formatNgn(amountNgn)}\n` +
          `You need: *${balanceCheck.usdtNeeded.toFixed(2)} ${selectedSymbol}* (incl. ${zendFeeUsdt.toFixed(2)} fee)\n` +
          `You have: *${tokenBalance.toFixed(2)} ${selectedSymbol}*\n` +
          `Short by: *${balanceCheck.shortfall!.toFixed(2)} ${selectedSymbol}*\n\n` +
          `Add more Dollars to your wallet or send a smaller amount.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        return;
      }
      if (balanceCheck.error === 'insufficient_sol') {
        await ctx.reply(
          `❌ *Insufficient SOL for gas*\n\n` +
          `Gas: ~${MIN_SOL_FOR_GAS} SOL\n` +
          `You have: ${solBalance.toFixed(6)} SOL\n\n` +
          `Top up your SOL balance first.`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
        return;
      }
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
    `${formatSendFeeLabel({ zendFeeUsdt, feeBps, willFundSol, gasCostUsdt: feeInfo.gasCostUsdt, extraFeeUsdt: feeInfo.extraFeeUsdt, feeSol, feeMode: feeInfo.feeMode, percentageFeeUsdt: feeInfo.percentageFeeUsdt })}\n` +
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
  let virtualAccount = user[0].virtualAccount as any;

  // Always generate a fresh virtual account on Receive if PAJ is linked
  const hasPajSession = user[0]?.pajSessionToken && user[0]?.pajSessionExpiresAt && new Date(user[0].pajSessionExpiresAt) > new Date();
  if (hasPajSession) {
    const pajClient = await getPAJClient();
    if (pajClient) {
      try {
        const order = await pajClient.createOnramp({
          fiatAmount: PAJ_MIN_DEPOSIT_NGN,
          currency: Currency.NGN,
          recipient: walletAddress,
          mint: SOLANA_TOKENS.USDT.mint,
          chain: Chain.SOLANA,
          webhookURL: getPajWebhookUrl(),
        }, user[0].pajSessionToken!);

        virtualAccount = {
          bankCode: 'WEM',
          bankName: order.bank,
          accountNumber: order.accountNumber,
          accountName: order.accountName,
          orderId: order.id,
          amount: PAJ_MIN_DEPOSIT_NGN,
          createdAt: new Date().toISOString(),
        };

        await db.update(users)
          .set({ virtualAccount })
          .where(eq(users.id, userId));

        console.log('[PAJ] Fresh VA generated on Receive:', order.accountNumber);
      } catch (err: any) {
        console.error('[PAJ] Refresh VA on Receive failed:', err);
        // Fall back to the cached virtual account (if any)
      }
    }
  }

  const hasVA = virtualAccount?.accountNumber;

  let msg = `📥 *Receive Money*\n\n`;
  msg += `Choose how you want to get paid:\n\n`;

  msg += `*🪙 Crypto*\n`;
  msg += `Send Dollars (USDT/USDC)${AUDD_ENABLED ? ', AUDD' : ''} or SOL to:\n`;
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
  if (AUDD_ENABLED) {
    kbRows.push([Markup.button.callback('🇦🇺 Add AUDD', 'add_aud_start')]);
  }
  kbRows.push([Markup.button.callback('🌉 Receive from Other Apps', 'bridge_start')]);
  kbRows.push([Markup.button.callback('📤 Send to Other Apps', 'withdraw_start')]);

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
import { getNearIntentsClient, type NearIntentsQuote } from '@zend/near-intents-client';
import {
  verifyPajWebhookSignature,
  normalizePajWebhookEvent,
  webhookEventKey,
  isDuplicateWebhook,
  markWebhookProcessed,
} from './utils/paj-webhook.js';
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
        ...(AUDD_ENABLED
          ? [
              [Markup.button.callback('SOL → AUDD', 'swap:SOL:AUDD')],
              [Markup.button.callback('AUDD → SOL', 'swap:AUDD:SOL')],
              [Markup.button.callback('USDT → AUDD', 'swap:USDT:AUDD')],
              [Markup.button.callback('AUDD → USDT', 'swap:AUDD:USDT')],
            ]
          : []),
        [Markup.button.callback('NEAR → USDT', 'swap:NEAR:USDT')],
        [Markup.button.callback('USDT → NEAR', 'swap:USDT:NEAR')],
        [Markup.button.callback('NEAR → SOL', 'swap:NEAR:SOL')],
        [Markup.button.callback('SOL → NEAR', 'swap:SOL:NEAR')],
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

  if (!AUDD_ENABLED && isAuddSwapPair(fromSymbol, toSymbol)) {
    await ctx.editMessageText('❌ AUDD swaps are not available right now.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

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
// 🌉 NEAR INTENTS DEPOSIT (Cross-chain Deposit)
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
// 🌉 NEAR INTENTS DEPOSIT (Cross-chain Deposit)
// ═════════════════════════════════════════════════════════════════════════════

import {
  NEAR_INTENTS_ASSETS,
  CHAIN_DISPLAY_NAMES,
  TOKEN_DECIMALS as NEAR_INTENTS_DECIMALS,
} from '@zend/near-intents-client';

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

async function executeNearIntentWithdraw(ctx: ZendContext, userId: string) {
  const session = getSession(userId);
  const wd = session.withdrawData;
  if (!wd?.amount || !wd.depositAddress || !wd.recipientAddress || !wd.txId) {
    await ctx.reply('❌ Withdrawal session expired. Please start over.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  try {
    await ctx.reply('⏳ Sending tokens via NEAR Intents...');

    const solanaTxHash = await fundNearIntentDeposit(
      user[0].walletEncryptedKey,
      wd.sourceSymbol,
      wd.amount,
      wd.depositAddress,
      SOLANA_RPC
    );

    const nearIntents = getNearIntentsClient();
    if (nearIntents) {
      try {
        await nearIntents.submitDepositTx(wd.depositAddress, solanaTxHash);
      } catch (submitErr) {
        console.warn('[Withdraw] submitDepositTx failed (non-fatal):', submitErr);
      }
    }

    await db.update(transactions)
      .set({
        status: 'processing',
        solanaTxHash,
        metadata: { direction: 'withdraw', destChain: wd.destChain, destToken: wd.destToken },
      })
      .where(eq(transactions.id, wd.txId));

    await indexTransaction(userId, wd.txId, `Withdraw to ${formatChainName(wd.destChain)} via NEAR Intents`, {
      amount: wd.amount,
      chain: wd.destChain,
      recipient: wd.recipientAddress,
    });

    setSession(userId, { state: ConversationState.IDLE });

    await ctx.reply(
      `✅ *Withdrawal Submitted!*\n\n` +
      `Sent: *${wd.amount} ${wd.sourceSymbol}*\n` +
      `To: *${formatChainName(wd.destChain)}* → \`${wd.recipientAddress}\`\n` +
      `Recipient receives: ~${wd.amountOutFormatted || '?'} ${wd.destToken}\n\n` +
      `Solana tx: \`https://solscan.io/tx/${solanaTxHash}\`\n` +
      `Reference: \`${wd.txId}\`\n\n` +
      `⏱️ Cross-chain delivery usually takes 2–15 minutes.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } catch (err: any) {
    console.error('[Withdraw] Failed:', err);
    await db.update(transactions)
      .set({ status: 'failed', metadata: { error: err.message } })
      .where(eq(transactions.id, wd.txId));
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply(
      `❌ *Withdrawal Failed*\n\n${err.message || 'Unknown error'}\nNo funds were deducted.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }
}

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
// ❓ HELP / HOW TO USE / FEATURES / FEEDBACK
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('❓ Help', async (ctx) => {
  await ctx.reply(
    `❓ *Zend Help*\n\n` +
    `Need support? Reach out anytime:\n\n` +
    `• 📖 Tap *How to Use* for a quick guide\n` +
    `• ✨ Tap *Features* to see what Zend can do\n` +
    `• 📝 Tap *Feedback* to share ideas or report bugs\n\n` +
    `👉 [Zend Community](https://t.me/zend_community)`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, ...mainMenu }
  );
});

bot.hears('📖 How to Use', async (ctx) => {
  await ctx.reply(
    `📖 *How to Use Zend*\n\n` +
    `*1. Add Money*\n` +
    `Tap 💰 *Balance* → *Add Naira* → follow the bank transfer instructions. Your virtual account converts Naira to USDT instantly.\n\n` +
    `*2. Send to Any Nigerian Bank*\n` +
    `Tap 📤 *Send* → enter amount → choose or add a bank account → confirm with your PIN.\n\n` +
    `*3. Receive Money*\n` +
    `Tap 📥 *Receive* → share your wallet address or virtual account details.\n\n` +
    `*4. Swap Crypto*\n` +
    `Tap 🔄 *Swap* → pick the token pair → enter amount → confirm.\n\n` +
    `*5. Pay Bills*\n` +
    `Tap 💳 *Bills* → choose Airtime, Data, Electricity, or Cable → fill details → pay with USDT.\n\n` +
    `*6. Bulk / Scheduled Sends*\n` +
    `Tap 📦 *Bulk Send* to pay many people at once, or 📅 *Schedule* for recurring payments.\n\n` +
    `*Tips:*\n` +
    `• Keep a tiny amount of SOL for network gas, or let Zend sponsor it for a small fee.\n` +
    `• Set a transaction PIN in ⚙️ *Settings* for extra security.\n` +
    `• Voice commands work too — just send a voice note.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

bot.hears('✨ Features', async (ctx) => {
  try {
    const features = await db.select().from(botFeatures).where(eq(botFeatures.isActive, true)).orderBy(botFeatures.sortOrder);
    if (!features.length) {
      await ctx.reply('✨ No features listed right now. Check back soon!', mainMenu);
      return;
    }
    let text = '✨ *Zend Features*\n\n';
    const byCategory: Record<string, typeof features> = {};
    for (const f of features) {
      byCategory[f.category] = byCategory[f.category] || [];
      byCategory[f.category].push(f);
    }
    for (const [category, list] of Object.entries(byCategory)) {
      text += `*${md(category.toUpperCase())}*\n`;
      for (const f of list) {
        text += `• *${md(f.name)}* — ${md(f.description)}\n`;
      }
      text += '\n';
    }
    await ctx.reply(text, { parse_mode: 'Markdown', ...mainMenu });
  } catch (err) {
    console.error('[Features] Handler error:', err);
    await ctx.reply('❌ Could not load features. Please try again.', mainMenu);
  }
});

bot.hears('📝 Feedback', async (ctx) => {
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.AWAITING_FEEDBACK_TEXT });
  await ctx.reply(
    `📝 *Send Feedback*\n\n` +
    `We read every message\. Share a bug, feature idea, or anything else:\n\n` +
    `Type your feedback below\. Tap ❌ Cancel to discard\.`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
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

// ═════════════════════════════════════════════════════════════════════════════
// 💳 BILL PAYMENTS — Airtime, Data, Electricity, Cable TV
// ═════════════════════════════════════════════════════════════════════════════

bot.hears('💳 Bills', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }
  setSession(userId, { state: ConversationState.BILL_SELECT_TYPE });
  await ctx.reply(
    `💳 *Bills & Airtime*\n\n` +
    `Pay for airtime, data, electricity, and cable TV with your USDT balance.\n\n` +
    `Select a service:`,
    { parse_mode: 'Markdown', ...billsMenu }
  );
});

bot.hears('📱 Airtime', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'airtime' };
  setSession(userId, session);

  const rows = NETWORKS.map((n) => [Markup.button.callback(n.name, `bill_airtime_${n.code}`)]);
  await ctx.reply('📱 Select network:', Markup.inlineKeyboard(rows));
});

bot.hears('🌐 Data', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'data' };
  setSession(userId, session);

  const rows = NETWORKS.map((n) => [Markup.button.callback(n.name, `bill_data_${n.code}`)]);
  await ctx.reply('🌐 Select network:', Markup.inlineKeyboard(rows));
});

bot.hears('⚡ Electricity', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'electricity' };
  setSession(userId, session);

  const rows = DISCOS.map((d) => [Markup.button.callback(d.name, `bill_electricity_${d.code}`)]);
  await ctx.reply('⚡ Select electricity distribution company:', Markup.inlineKeyboard(rows));
});

bot.hears('📺 Cable TV', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'cable' };
  setSession(userId, session);

  const rows = CABLE_PROVIDERS.map((p) => [Markup.button.callback(p.name, `bill_cable_${p.code}`)]);
  await ctx.reply('📺 Select cable TV provider:', Markup.inlineKeyboard(rows));
});

// ─── Airtime Network Selected ───
bot.action(/^bill_airtime_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const network = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'airtime', network };
  session.state = ConversationState.BILL_ENTER_PHONE;
  setSession(userId, session);
  await ctx.editMessageText(`📱 ${network.toUpperCase()} Airtime\n\nEnter the phone number:`);
  await ctx.reply('Enter recipient phone number:', cancelKeyboard);
});

// ─── Data Network Selected ───
bot.action(/^bill_data_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const network = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'data', network };
  session.state = ConversationState.BILL_ENTER_PHONE;
  setSession(userId, session);
  await ctx.editMessageText(`🌐 ${network.toUpperCase()} Data\n\nEnter the phone number:`);
  await ctx.reply('Enter recipient phone number:', cancelKeyboard);
});

// ─── Data Plan Selected ───
bot.action(/^bill_plan_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const planId = ctx.match![1];
  const planAmount = parseInt(ctx.match![2], 10);
  const session = getSession(userId);
  session.billData = airbillsClient
    ? { ...session.billData, planId, planAmount }
    : { ...session.billData, planCode: planId, planAmount };
  setSession(userId, session);

  const usdtAmount = planAmount / 1400;
  await ctx.editMessageText(
    `🌐 *Confirm Data Purchase*\n\n` +
    `Phone: ${session.billData?.phone}\n` +
    `Plan: ${planId}\n` +
    `Amount: ₦${planAmount.toLocaleString()}\n` +
    `≈ ${usdtAmount.toFixed(4)} USDT`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm', 'bill_confirm')],
        [Markup.button.callback('❌ Cancel', 'cancel_send')],
      ]),
    }
  );
});

// ─── Electricity Disco Selected ───
bot.action(/^bill_electricity_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const disco = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'electricity', disco };
  session.state = ConversationState.BILL_ENTER_METER;
  setSession(userId, session);
  await ctx.editMessageText(`⚡ ${disco.replace(/-/g, ' ').toUpperCase()}\n\nEnter your meter number:`);
  await ctx.reply('Enter meter number:', cancelKeyboard);
});

// ─── Cable Provider Selected ───
bot.action(/^bill_cable_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const provider = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'cable', provider };
  session.state = ConversationState.BILL_ENTER_SMARTCARD;
  setSession(userId, session);
  await ctx.editMessageText(`📺 ${provider.toUpperCase()}\n\nEnter your smart card number:`);
  await ctx.reply('Enter smart card number:', cancelKeyboard);
});

// ─── Confirm Bill Purchase ───
bot.action('bill_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  const bill = session.billData;

  if (!bill) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    await ctx.reply('Menu:', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const loading = await showLoading(ctx, 'Processing your purchase...');

  try {
    let result;

    // Use AirBills when configured, otherwise fall back to VTpass
    if (airbillsClient) {
      if (bill.type === 'airtime' && bill.phone && bill.amount && bill.network) {
        result = await airbillsBuyAirtime(airbillsClient, userId, bill.phone, bill.amount, bill.network);
      } else if (bill.type === 'data' && bill.phone && bill.planAmount && bill.network) {
        result = await airbillsBuyData(
          airbillsClient, userId, bill.phone, bill.planAmount, bill.network, bill.planId || bill.planCode
        );
      } else if (bill.type === 'electricity' && bill.meterNumber && bill.amount && bill.disco) {
        result = await airbillsBuyElectricity(airbillsClient, userId, bill.meterNumber, bill.amount, bill.disco);
      } else if (bill.type === 'cable' && bill.smartCardNumber && bill.amount && bill.provider) {
        result = await airbillsBuyCable(airbillsClient, userId, bill.smartCardNumber, bill.amount, bill.provider);
      } else {
        throw new Error('Invalid bill data');
      }
    } else {
      // Fallback to VTpass
      if (bill.type === 'airtime' && bill.phone && bill.amount && bill.network) {
        result = await buyAirtime(userId, { phone: bill.phone, amount: bill.amount, network: bill.network });
      } else if (bill.type === 'data' && bill.phone && bill.planCode && bill.network && bill.planAmount) {
        result = await buyData(userId, { phone: bill.phone, planCode: bill.planCode, network: bill.network }, bill.planAmount);
      } else if (bill.type === 'electricity' && bill.meterNumber && bill.amount && bill.disco) {
        result = await buyElectricity(userId, { meterNumber: bill.meterNumber, amount: bill.amount, disco: bill.disco, meterType: bill.meterType || 'prepaid' });
      } else if (bill.type === 'cable' && bill.smartCardNumber && bill.amount && bill.provider) {
        result = await buyCable(userId, { smartCardNumber: bill.smartCardNumber, bouquetCode: bill.bouquetCode || 'basic', provider: bill.provider }, bill.amount);
      } else {
        throw new Error('Invalid bill data');
      }
    }

    if (result.success) {
      let msg = `✅ *Purchase Successful!*\n\n${result.message}`;
      if (result.token) msg += `\n\n🔑 *Token:* \`${result.token}\``;
      if (result.units) msg += `\n⚡ *Units:* ${result.units}`;
      if (result.commission) msg += `\n💰 *Commission:* ₦${result.commission}`;
      if (isDemoMode()) msg += `\n\n_(Demo mode — no real transaction occurred)_`;
      await finishLoading(ctx, loading.message_id, msg, 'Markdown');
    } else {
      await finishLoading(ctx, loading.message_id, `❌ Purchase failed: ${result.message}`);
    }
  } catch (err: any) {
    console.error('[Bill] Purchase error:', err);
    await finishLoading(ctx, loading.message_id, '❌ Could not complete purchase. Please try again.');
  }

  setSession(userId, { state: ConversationState.IDLE });
  await ctx.reply('Menu:', mainMenu);
});

// ═════════════════════════════════════════════════════════════════════════════
// 🔐 ADMIN MENU HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

async function requireAdmin(ctx: ZendContext): Promise<boolean> {
  const userId = ctx.from!.id.toString();
  const username = ctx.from!.username;
  const hasAccess = isSuperAdmin(userId) || await isAdminUser(userId);
  if (!hasAccess) {
    await ctx.reply('❌ Admin access required.');
  }
  return hasAccess;
}

bot.hears('📊 Stats', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const stats = await getAdminStats();
    await ctx.reply(
      `📊 *Admin Stats*\n\n` +
      `*Users*\n` +
      `• Total: ${stats.totalUsers}\n` +
      `• Today: ${stats.usersToday}\n` +
      `• This Week: ${stats.usersThisWeek}\n` +
      `• This Month: ${stats.usersThisMonth}\n\n` +
      `*Transactions*\n` +
      `• Total: ${stats.totalTransactions}\n` +
      `• Today: ${stats.transactionsToday}\n` +
      `• Volume (₦): ${stats.totalVolumeNgn.toLocaleString()}\n\n` +
      `*Other*\n` +
      `• Saved Bank Accounts: ${stats.totalSavedBankAccounts}\n` +
      `• Scheduled Transfers: ${stats.totalScheduledTransfers}\n` +
      `• Active Scheduled: ${stats.activeScheduledTransfers}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Stats error:', err);
    await ctx.reply('❌ Could not fetch stats.', adminMenu);
  }
});

bot.hears('👤 Users', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const allUsers = await db.select().from(users).orderBy(sql`created_at DESC`).limit(20);
    if (allUsers.length === 0) {
      await ctx.reply('No users yet.', adminMenu);
      return;
    }
    const lines = allUsers.map((u, i) =>
      `${i + 1}. ${escapeTelegramMarkdown(u.firstName)}${u.telegramUsername ? ' (@' + escapeTelegramMarkdown(u.telegramUsername.replace(/^@/, '')) + ')' : ''} — ${u.walletAddress.slice(0, 6)}...${u.walletAddress.slice(-4)} | ${u.createdAt.toISOString().split('T')[0]}`
    );
    await ctx.reply(
      `👤 *Last 20 Users*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Users error:', err);
    await ctx.reply('❌ Could not fetch users.', adminMenu);
  }
});

bot.hears('💸 Transactions', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const txs = await db.select().from(transactions).orderBy(sql`created_at DESC`).limit(20);
    if (txs.length === 0) {
      await ctx.reply('No transactions yet.', adminMenu);
      return;
    }
    const lines = txs.map((t, i) =>
      `${i + 1}. ${t.type.toUpperCase()} | ${t.status} | ₦${Number(t.ngnAmount || 0).toLocaleString()} | ${t.createdAt.toISOString().split('T')[0]}`
    );
    await ctx.reply(
      `💸 *Last 20 Transactions*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Transactions error:', err);
    await ctx.reply('❌ Could not fetch transactions.', adminMenu);
  }
});

bot.hears('🏦 Bank Accounts', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const count = await db.select({ count: sql<number>`count(*)` }).from(savedBankAccounts);
    const list = await db.select().from(savedBankAccounts).orderBy(sql`created_at DESC`).limit(20);
    const lines = list.map((b, i) =>
      `${i + 1}. ${b.bankName} | ****${b.accountNumber.slice(-4)} | ${b.accountName}`
    );
    await ctx.reply(
      `🏦 *Bank Accounts* (Total: ${count[0]?.count ?? 0})\n\n${lines.join('\n') || 'No bank accounts saved.'}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Bank accounts error:', err);
    await ctx.reply('❌ Could not fetch bank accounts.', adminMenu);
  }
});

bot.hears('📅 Scheduled', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  try {
    const list = await db.select().from(scheduledTransfers).orderBy(sql`created_at DESC`).limit(20);
    if (list.length === 0) {
      await ctx.reply('No scheduled transfers.', adminMenu);
      return;
    }
    const lines = list.map((s, i) =>
      `${i + 1}. ₦${Number(s.amountNgn).toLocaleString()} | ${s.frequency} | ${s.isActive ? '✅ Active' : '⏸️ Paused'} | Next: ${s.nextRunAt.toISOString().split('T')[0]}`
    );
    await ctx.reply(
      `📅 *Scheduled Transfers*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...adminMenu }
    );
  } catch (err) {
    console.error('[Admin] Scheduled error:', err);
    await ctx.reply('❌ Could not fetch scheduled transfers.', adminMenu);
  }
});

bot.hears('🤖 QVAC Status', async (ctx) => {
  if (!await requireAdmin(ctx)) return;
  const status = getQVACStatus();
  const statusLines = Object.entries(status.models)
    .map(([name, loaded]) => `• ${name}: ${loaded ? '✅' : '❌'}`)
    .join('\n');
  await ctx.reply(
    `🤖 *QVAC AI Stack*\n\n` +
    `Ready: ${status.ready ? '✅' : '❌'}\n\n` +
    `${statusLines}\n\n` +
    `${status.errors.length ? 'Errors:\n' + status.errors.join('\n') : 'No errors.'}`,
    { parse_mode: 'Markdown', ...adminMenu }
  );
});

bot.hears('🔙 Back to Menu', async (ctx) => {
  await ctx.reply('Main menu:', mainMenu);
});

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

const balanceSnapshots = new Map<string, { sol: number; usdt: number; usdc: number; audd: number; near: number }>();

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
          near: balances.find((b: any) => b.symbol === 'NEAR')?.amount || 0,
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
          if (current.near - (prev?.near || 0) > 0.000001) {
            const nearDiff = current.near - (prev?.near || 0);
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${nearDiff.toFixed(4)} NEAR* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.near.toFixed(4)} NEAR*`,
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
          const signature = req.headers['x-paj-signature'] as string | undefined;
          if (!verifyPajWebhookSignature(body, signature)) {
            console.warn('[PAJ Webhook] Invalid signature');
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }

          const parsed = JSON.parse(body);
          const event = normalizePajWebhookEvent(parsed);
          if (!event) {
            console.log('[PAJ Webhook] Unrecognized payload:', body.slice(0, 200));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Unrecognized event' }));
            return;
          }

          const idemKey = webhookEventKey({ type: event.type, reference: event.reference });
          if (idemKey && isDuplicateWebhook(idemKey)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Duplicate' }));
            return;
          }

          console.log('📩 PAJ Webhook:', event.type, event.reference);

          switch (event.type) {
            case 'onramp.deposit.confirmed': {
              // Find or create transaction
              let txRows = await db.select().from(transactions)
                .where(eq(transactions.pajReference, event.reference))
                .limit(1);

              if (txRows.length > 0 && txRows[0].status === 'completed') {
                break;
              }

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
              const offrampRows = await db.select().from(transactions)
                .where(eq(transactions.pajReference, event.reference))
                .limit(1);

              if (offrampRows.length > 0 && offrampRows[0].status === 'completed') {
                break;
              }

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

          if (idemKey) markWebhookProcessed(idemKey);
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

    // NEAR Intents Webhooks
    if (url === '/webhooks/near-intents' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          console.log('📩 NEAR Intents Webhook:', event.status, event.depositAddress);

          const depositAddress = event.depositAddress || event.deposit_address;
          const status = event.status;
          const amount = event.amountOut || event.amount_out;
          const token = event.destinationAsset?.symbol || event.originAsset?.symbol || 'USDT';

          if (!depositAddress) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing depositAddress' }));
            return;
          }

          const idemKey = webhookEventKey({ status, reference: depositAddress });
          if (idemKey && isDuplicateWebhook(idemKey)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Duplicate' }));
            return;
          }

          // Find transaction by NEAR Intents deposit address
          const txRows = await db.select().from(transactions)
            .where(eq(transactions.nearIntentDepositAddress, depositAddress))
            .limit(1);

          if (txRows.length === 0) {
            console.warn('[NEAR Intents Webhook] No transaction found for deposit:', depositAddress);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'No matching transaction' }));
            return;
          }

          const tx = txRows[0];

          // Idempotency: don't re-process completed transactions
          if (tx.status === 'completed') {
            console.log('[NEAR Intents Webhook] Transaction already completed, skipping:', depositAddress);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Already completed' }));
            return;
          }

          const txStatus = status === 'SUCCESS' ? 'completed' : status === 'FAILED' || status === 'REFUNDED' ? 'failed' : 'processing';

          // Update transaction
          await db.update(transactions)
            .set({
              status: txStatus,
              toAmount: amount ? amount.toString() : tx.toAmount,
              completedAt: txStatus === 'completed' ? new Date() : undefined,
            })
            .where(eq(transactions.id, tx.id));

          // Notify user via Telegram
          const isWithdraw = tx.type === 'crypto_send' || (tx.metadata as any)?.direction === 'withdraw';
          if (txStatus === 'completed') {
            const userId = tx.userId;
            try {
              const msg = isWithdraw
                ? `✅ *Withdrawal Complete!*\n\n` +
                  `${amount || ''} ${token} delivered to the recipient address.\n\n` +
                  `Reference: \`${tx.id}\``
                : `✅ *Deposit Received!*\n\n` +
                  `${amount || ''} ${token} has arrived in your Zend account via NEAR Intents.\n\n` +
                  `Reference: \`${tx.id}\``;
              await botInstance.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown', ...mainMenu });
            } catch (notifyErr) {
              console.log('[NEAR Intents] Could not notify user:', notifyErr);
            }
          } else if (txStatus === 'failed' && isWithdraw) {
            try {
              await botInstance.telegram.sendMessage(
                tx.userId,
                `❌ *Withdrawal Failed*\n\nReference: \`${tx.id}\`\nFunds should be refunded to your Zend wallet.`,
                { parse_mode: 'Markdown', ...mainMenu }
              );
            } catch { /* non-critical */ }
          }

          if (idemKey) markWebhookProcessed(idemKey);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('NEAR Intents webhook error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // AirBills Webhooks
    if (url === '/webhooks/airbills' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          console.log('📩 AirBills Webhook:', event.event, event.orderId);

          const orders = await db.select().from(billPayments)
            .where(eq(billPayments.externalReference, event.orderId))
            .limit(1);

          if (!orders.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
            return;
          }

          const order = orders[0];

          if (event.status === 'completed') {
            await db.update(billPayments)
              .set({ status: 'success', token: event.token, completedAt: new Date() })
              .where(eq(billPayments.id, order.id));

            await botInstance.telegram.sendMessage(
              order.userId,
              `🎉 *Bill Payment Complete!*\n\n` +
              `${order.type?.toUpperCase()} — ₦${Number(order.amountNgn).toLocaleString()}\n` +
              `Recipient: ${order.recipient}` +
              (event.token ? `\n\n🔑 *Token:* \`${event.token}\`` : '') +
              `\n\nReference: \`${order.reference}\``,
              { parse_mode: 'Markdown' }
            );
          } else if (event.status === 'failed') {
            await db.update(billPayments)
              .set({ status: 'failed', metadata: event })
              .where(eq(billPayments.id, order.id));

            await botInstance.telegram.sendMessage(
              order.userId,
              `❌ *Bill Payment Failed*\n\n` +
              `${order.type?.toUpperCase()} — ₦${Number(order.amountNgn).toLocaleString()}\n` +
              `Recipient: ${order.recipient}\n\n` +
              `If USDT was deducted, it will be refunded.`,
              { parse_mode: 'Markdown' }
            );
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('[AirBills Webhook] Error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Telegram Bot Webhooks — ack immediately (Telegram times out if handler is slow)
    if (url.split('?')[0] === '/webhook/telegram' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(200);
        res.end('OK');
        try {
          const update = JSON.parse(body);
          botInstance.handleUpdate(update).catch((err: any) => {
            console.error('[Webhook] Telegram update error:', err);
          });
        } catch (err: any) {
          console.error('[Webhook] Telegram parse error:', err);
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

  server.listen(port, '0.0.0.0', () => {
    const host = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${port}`;
    console.log(`🌐 Webhook server running on http://${host}`);
    console.log(`   PAJ webhook URL: https://${host}/webhooks/paj`);
    console.log(`   NEAR Intents webhook URL: https://${host}/webhooks/near-intents`);
    console.log(`   AirBills webhook URL: https://${host}/webhooks/airbills`);
    console.log(`   Telegram webhook URL: https://${host}/webhook/telegram`);
    console.log(`   Ambassador API: https://${host}/api/ambassador`);
    console.log(`   Device Suspend API: https://${host}/api/device-suspend`);
  });

  return server;
}

// ═════════════════════════════════════════════════════════════════════════════
// LAUNCH
// ═════════════════════════════════════════════════════════════════════════════

// ─── NEAR Intents Status Poller (fallback when webhooks miss) ───
let _nearIntentPollRunning = false;

async function pollNearIntentTransactions(botInstance: Telegraf<any>) {
  if (_nearIntentPollRunning) return;
  _nearIntentPollRunning = true;
  try {
    const client = getNearIntentsClient();
    if (!client) return;

    const pending = await db.select().from(transactions)
      .where(and(
        sql`${transactions.nearIntentDepositAddress} IS NOT NULL`,
        sql`${transactions.status} IN ('pending', 'processing')`
      ))
      .limit(20);

    for (const tx of pending) {
      if (!tx.nearIntentDepositAddress) continue;
      try {
        const status = await client.getStatus(tx.nearIntentDepositAddress);
        const txStatus = status.status === 'SUCCESS' ? 'completed'
          : status.status === 'FAILED' || status.status === 'REFUNDED' ? 'failed'
          : 'processing';

        if (txStatus === tx.status) continue;

        await db.update(transactions)
          .set({
            status: txStatus,
            toAmount: status.amountOut || tx.toAmount,
            completedAt: txStatus === 'completed' ? new Date() : undefined,
            solanaTxHash: status.destinationTxHash || tx.solanaTxHash,
          })
          .where(eq(transactions.id, tx.id));

        const isWithdraw = tx.type === 'crypto_send';
        if (txStatus === 'completed') {
          const msg = isWithdraw
            ? `✅ *Withdrawal Complete!*\n\nYour cross-chain withdrawal has been delivered.\nReference: \`${tx.id}\``
            : `✅ *Deposit Received!*\n\nFunds have arrived in your Zend account.\nReference: \`${tx.id}\``;
          await botInstance.telegram.sendMessage(tx.userId, msg, { parse_mode: 'Markdown', ...mainMenu });
        } else if (txStatus === 'failed' && isWithdraw) {
          await botInstance.telegram.sendMessage(
            tx.userId,
            `❌ *Withdrawal Failed*\n\nReference: \`${tx.id}\``,
            { parse_mode: 'Markdown', ...mainMenu }
          );
        }
      } catch (pollErr) {
        console.warn('[NEAR Poll] Error for', tx.id, pollErr);
      }
    }
  } catch (err) {
    console.error('[NEAR Poll] Error:', err);
  } finally {
    _nearIntentPollRunning = false;
  }
}

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

        const transferUsdt = Number(s.amountNgn) / rate;

        // Calculate fee for scheduled transfer
        const userRow = await db.select().from(users).where(eq(users.id, s.userId)).limit(1);
        const feeInfo = userRow[0]?.walletAddress
          ? await calculateSendFee(transferUsdt, userRow[0].walletAddress, s.userId)
          : { zendFeeUsdt: Math.min(transferUsdt * 0.01, 2), feeSol: 0, feeBps: 100, willFundSol: false };
        const amountUsdt = transferUsdt + feeInfo.zendFeeUsdt;

        // Auto-execute the transfer
        const result = await executeSendCore(s.userId, {
          amountNgn: Number(s.amountNgn),
          amountUsdt,
          ngnRate: rate,
          zendFeeUsdt: feeInfo.zendFeeUsdt,
          feeSol: feeInfo.feeSol,
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
  await initSessionStore();

  const health = await runStartupHealthChecks({ getPAJClient, airbillsClient });
  if (!health.database) {
    process.exit(1);
  }

  // Initialize QVAC local AI stack
  try {
    await initQVAC();
    const qvacStatus = getQVACStatus();
    console.log('🧠 QVAC AI stack initialized');
    console.log('   Models:', JSON.stringify(qvacStatus.models));
  } catch (err: any) {
    console.warn('⚠️  QVAC init failed:', err.message);
  }

  // Seed bot features table for AI awareness
  await seedBotFeatures();

  // Start webhook server (runs alongside bot)
  startWebhookServer(bot);

  // Launch bot — polling by default (reliable on Railway). Telegram webhooks opt-in only.
  const publicBaseUrl = getPublicBaseUrl();
  const useTelegramWebhook = process.env.TELEGRAM_USE_WEBHOOK === 'true';
  let isWebhookMode = false;

  async function clearWebhook(retries = 3): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('[Bot] Telegram webhook cleared');
        return true;
      } catch (err: any) {
        console.warn(`[Bot] Failed to clear webhook (attempt ${i + 1}/${retries}):`, err.message);
        if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
      }
    }
    return false;
  }

  if (useTelegramWebhook && publicBaseUrl) {
    const telegramWebhookUrl = `${publicBaseUrl}/webhook/telegram`;
    try {
      await bot.telegram.setWebhook(telegramWebhookUrl, { drop_pending_updates: true });
      console.log('🤖 Zend bot running in Telegram webhook mode');
      console.log(`   Webhook URL: ${telegramWebhookUrl}`);
      isWebhookMode = true;
    } catch (webhookErr: any) {
      console.error('[Bot] Failed to set Telegram webhook:', webhookErr.message);
      console.log('🤖 Falling back to polling mode...');
      await clearWebhook();
      await bot.launch({ dropPendingUpdates: true });
      console.log('🤖 Zend bot running in polling mode (webhook fallback)');
    }
  } else {
    await clearWebhook();
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 Zend bot running in polling mode');
    if (!useTelegramWebhook) {
      console.log('   PAJ/AirBills HTTP webhooks still active on the same server');
      console.log('   (Set TELEGRAM_USE_WEBHOOK=true only if Telegram can reach your domain)');
    }
  }

  // Start scheduled transfer executor (every 60 seconds)
  setInterval(runScheduledTransfers, 60000);
  console.log('📅 Scheduled transfer executor started (every 60s)');

  // Poll NEAR Intents pending deposits/withdrawals (every 2 minutes)
  setInterval(() => pollNearIntentTransactions(bot), 120000);
  console.log('🔗 NEAR Intents status poller started (every 120s)');

  if (process.env.NODE_ENV === 'production' && SOLANA_RPC.includes('devnet')) {
    console.warn('⚠️  SOLANA_RPC_URL points to devnet in production — switch to mainnet for real funds');
  }

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
