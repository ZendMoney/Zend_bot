import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { NIGERIAN_BANKS } from '@zend/shared';
import { getPAJClient } from '../deps.js';

let _pajRates: { onRampRate: number; offRampRate: number } | null = null;
let _pajRatesTime = 0;

let _pajBankCache: Array<{ id: string; name: string; code: string }> | null = null;
let _pajBankCacheTime = 0;

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

export function isPajSessionError(err: any): boolean {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.statusCode || err?.status || err?.response?.status;
  return status === 401 ||
    msg.includes('session is invalid') ||
    msg.includes('session expired') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid token');
}

export async function clearPajSession(userId: string): Promise<void> {
  console.log('[PAJ] Clearing expired session for user:', userId);
  try {
    await db.update(users)
      .set({ pajSessionToken: null, pajSessionExpiresAt: null, pajContact: null })
      .where(eq(users.id, userId));
  } catch (e) {
    console.error('[PAJ] Failed to clear session:', e);
  }
}

export async function getPAJRates(): Promise<{ onRampRate: number; offRampRate: number }> {
  if (_pajRates && Date.now() - _pajRatesTime < 300000) {
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
  } catch {
    console.log('[PAJ] Rate fetch failed, using cache/fallback');
    return _pajRates || { onRampRate: 1550, offRampRate: 1550 };
  }
}

export async function getPajBankList(sessionToken: string, userId?: string): Promise<Array<{ id: string; name: string; code: string }>> {
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

export function scoreBankMatch(pajName: string, ourCode: string): number {
  const ourBank = NIGERIAN_BANKS.find(b => b.code === ourCode);
  if (!ourBank) return 0;

  const p = pajName.toLowerCase();
  const o = ourBank.name.toLowerCase();
  const aliases = BANK_NAME_ALIASES[ourCode] || [];

  if (p === o) return 100;
  if (p.includes(o) || o.includes(p)) return 80;
  for (const alias of aliases) {
    if (p.includes(alias.toLowerCase())) return 70;
  }
  const pWords = p.split(/\s+/);
  const oWords = o.split(/\s+/);
  const overlap = pWords.filter(w => oWords.includes(w)).length;
  if (overlap > 0) return overlap * 20;

  return 0;
}

export async function verifyBankAccount(
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