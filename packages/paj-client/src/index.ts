/**
 * PAJ Protocol Client
 * Wraps the official `paj_ramp` npm package.
 *
 * Auth flow (per user):
 *   1. initiate(email/phone, BUSINESS_API_KEY) → OTP sent to user
 *   2. verify(email/phone, OTP, deviceInfo, BUSINESS_API_KEY) → sessionToken
 *   3. All subsequent calls use sessionToken
 *
 * Required env:
 *   PAJ_BUSINESS_API_KEY = your business API key from PAJ dashboard
 *   PAJ_ENVIRONMENT = Production | Staging | Local
 *
 * Base URLs:
 *   Staging:    https://api-staging.paj.cash
 *   Production: https://api.paj.cash
 *   Local:      http://localhost:3000
 */

import {
  initializeSDK,
  initiate,
  verify,
  getAllRate,
  getRateByAmount,
  getRateByType,
  RateType,
  getTokenValue,
  getFiatValue,
  Currency,
  getBanks,
  resolveBankAccount,
  addBankAccount,
  getBankAccounts,
  getTokenInfo,
  Chain,
  createOfframpOrder,
  createOnrampOrder,
  getAllTransactions,
  getTransaction,
  submitKyc,
  Environment,
  type CreateOnrampOrder,
  type CreateOfframpOrder,
  type OnrampOrder,
  type OfframpOrder,
  type Bank,
  type RateBy,
  type RateByAmount,
  type TokenInfo,
  type ResolveBankAccount,
  type PajTransaction,
  type InitiateResponse,
  type Verify,
  type DeviceSignature,
  type AddBankAccount,
  type GetBankAccounts,
  type SubmitKyc,
} from 'paj_ramp';

// ─── Init ───
// Eager init: runs when module is first imported (after .env is loaded!)
const _env = (process.env.PAJ_ENVIRONMENT as Environment) || Environment.Staging;
initializeSDK(_env);
const _apiKey = process.env.PAJ_BUSINESS_API_KEY || '';
console.log('[PAJ] Initialized:', _env, 'Key:', _apiKey ? 'SET' : 'NOT SET');

// ─── Session Management ───

export interface PAJSession {
  token: string;
  recipient: string; // email or phone
  expiresAt: Date;
}

const sessions = new Map<string, PAJSession>(); // userId → session

// ─── Client ───

export class PAJClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // ─── Auth ───

  /** Step 1: Send OTP to user's email or phone */
  async initiateSession(contact: string): Promise<InitiateResponse> {
    return initiate(contact, this.apiKey);
  }

  /** Step 2: Verify OTP and get session token */
  async verifySession(
    contact: string,
    otp: string,
    deviceInfo: DeviceSignature
  ): Promise<Verify> {
    return verify(contact, otp, deviceInfo, this.apiKey);
  }

  // ─── Rates ───

  /** Get both on-ramp and off-ramp rates */
  async getAllRates(): Promise<ReturnType<typeof getAllRate>> {
    return getAllRate();
  }

  /** Get rate for a specific amount (includes fees) */
  async getRateByAmount(amountNgn: number): Promise<RateByAmount> {
    return getRateByAmount(amountNgn);
  }

  /** Get rate by type (onRamp or offRamp) */
  async getRate(type: RateType): Promise<RateBy> {
    return getRateByType(type);
  }

  // ─── Token Conversions ───

  /** Fiat amount → token amount (on-ramp) */
  async getTokenValue(
    params: { amount: number; mint: string; currency: Currency },
    sessionToken: string
  ): Promise<ReturnType<typeof getTokenValue>> {
    return getTokenValue(params, sessionToken);
  }

  /** Token amount → fiat amount (off-ramp) */
  async getFiatValue(
    params: { amount: number; mint: string; currency: Currency },
    sessionToken: string
  ): Promise<ReturnType<typeof getFiatValue>> {
    return getFiatValue(params, sessionToken);
  }

  // ─── Banks ───

  /** List all Nigerian banks */
  async getBanks(sessionToken: string): Promise<Bank[]> {
    return getBanks(sessionToken);
  }

  /** Verify bank account (get account name) */
  async resolveBankAccount(
    sessionToken: string,
    bankId: string,
    accountNumber: string
  ): Promise<ResolveBankAccount> {
    return resolveBankAccount(sessionToken, bankId, accountNumber);
  }

  /** Add a bank account to user's profile */
  async addBankAccount(
    sessionToken: string,
    bankId: string,
    accountNumber: string
  ): Promise<AddBankAccount> {
    return addBankAccount(sessionToken, bankId, accountNumber);
  }

  /** Get user's saved bank accounts */
  async getBankAccounts(sessionToken: string): Promise<GetBankAccounts[]> {
    return getBankAccounts(sessionToken);
  }

  // ─── Token Info ───

  /** Get token metadata (name, symbol, decimals, logo) */
  async getTokenInfo(mint: string, chain: Chain = Chain.SOLANA): Promise<TokenInfo> {
    return getTokenInfo(mint, chain);
  }

  // ─── KYC ───

  /** Submit KYC documents (BVN or NIN) */
  async submitKyc(
    sessionToken: string,
    idNumber: string,
    idType: 'BVN' | 'NIN',
    country: 'NG' | 'GH' | 'TZ' | 'KE' | 'ZA'
  ): Promise<{ message: string }> {
    return submitKyc(sessionToken, idNumber, idType as any, country as any);
  }

  // ─── Orders ───

  /** Create off-ramp order: crypto → NGN bank */
  async createOfframp(
    params: CreateOfframpOrder,
    sessionToken: string
  ): Promise<OfframpOrder> {
    return createOfframpOrder(params, sessionToken);
  }

  /** Create on-ramp order: NGN → crypto */
  async createOnramp(
    params: CreateOnrampOrder,
    sessionToken: string
  ): Promise<OnrampOrder> {
    return createOnrampOrder(params, sessionToken);
  }

  // ─── Transactions ───

  /** Get all transactions for user */
  async getTransactions(sessionToken: string): Promise<PajTransaction[]> {
    return getAllTransactions(sessionToken);
  }

  /** Get single transaction */
  async getTransaction(sessionToken: string, transactionId: string): Promise<PajTransaction> {
    return getTransaction(sessionToken, transactionId);
  }
}

// ─── Factory ───

export function createPAJClient(): PAJClient | null {
  if (!_apiKey || _apiKey === 'your_paj_business_api_key') {
    console.warn('⚠️  PAJ_BUSINESS_API_KEY not set. PAJ features disabled.');
    return null;
  }
  return new PAJClient(_apiKey);
}

// ─── Session Helpers ───

export function savePAJSession(userId: string, session: PAJSession): void {
  sessions.set(userId, session);
}

export function getPAJSession(userId: string): PAJSession | undefined {
  return sessions.get(userId);
}

export function clearPAJSession(userId: string): void {
  sessions.delete(userId);
}

// ─── Re-exports ───

export {
  Environment,
  RateType,
  Currency,
  Chain,
  TransactionStatus,
  TransactionType,
} from 'paj_ramp';

export type {
  OnrampOrder,
  OfframpOrder,
  Bank,
  RateBy,
  RateByAmount,
  TokenInfo,
  ResolveBankAccount,
  PajTransaction,
  InitiateResponse,
  Verify,
  DeviceSignature,
  AddBankAccount,
  GetBankAccounts,
  SubmitKyc,
  CreateOnrampOrder,
  CreateOfframpOrder,
};
