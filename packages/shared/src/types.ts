// User
export interface User {
  id: string;              // Telegram user ID
  telegramUsername?: string;
  firstName: string;
  lastName?: string;
  email?: string;
  emailVerified: boolean;
  walletAddress: string;   // Solana public key
  walletEncryptedKey: string; // AES-256-GCM encrypted private key
  virtualAccount?: VirtualAccount;
  tier: number;
  autoSaveRateBps: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VirtualAccount {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  createdAt: Date;
}

// Wallet
export interface WalletBalance {
  mint: string;
  symbol: string;
  decimals: number;
  amount: string;          // Raw amount (string for precision)
  uiAmount: number;        // Human-readable
  ngnEquivalent: number;
}

// Bank Account (saved by user for off-ramp)
export interface SavedBankAccount {
  id: string;
  userId: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  verified: boolean;
  createdAt: Date;
}

// Transaction
export interface Transaction {
  id: string;              // ZND-XXXXX
  userId: string;
  type: string;            // TransactionType
  status: string;          // TransactionStatus
  
  // Crypto side
  fromMint?: string;
  fromAmount?: string;
  toMint?: string;
  toAmount?: string;
  solanaTxHash?: string;
  
  // Fiat side
  ngnAmount?: number;
  ngnRate?: number;
  pajFeeBps?: number;
  zendSpreadBps?: number;
  
  // Recipient (for sends)
  recipientBankCode?: string;
  recipientBankName?: string;
  recipientAccountNumber?: string;
  recipientAccountName?: string;
  recipientWalletAddress?: string;
  
  // PAJ reference
  pajReference?: string;
  pajPoolAddress?: string;
  
  // Metadata
  metadata?: Record<string, unknown>;
  
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

// Vault
export interface Vault {
  id: string;
  userId: string;
  type: 'auto_save' | 'time_lock';
  
  // For time-lock
  purpose?: string;
  lockedAmount?: string;
  unlockAt?: Date;
  
  // For auto-save
  saveRateBps?: number;
  
  // SPL token account for this vault
  tokenAccount: string;
  
  createdAt: Date;
  updatedAt: Date;
}

// Scheduled Transfer
export interface ScheduledTransfer {
  id: string;
  userId: string;
  recipientBankAccountId: string;
  amountNgn: number;
  frequency: 'once' | 'daily' | 'weekly' | 'monthly';
  startAt: Date;
  nextRunAt: Date;
  endAt?: Date;
  maxRuns?: number;
  runCount: number;
  isActive: boolean;
  createdAt: Date;
}

// NLU
export interface ParsedIntent {
  intent: string;
  confidence: number;
  entities: Entity[];
  rawText: string;
}

export interface Entity {
  type: string;
  value: string | number;
  start?: number;
  end?: number;
}

// PAJ Types
export interface PAJRateResponse {
  rate: number;            // NGN per USDT
  feeBps: number;
  validUntil: Date;
}

export interface PAJVirtualAccount {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface PAJOffRampRequest {
  amountUsdt: string;
  ngnAmount: number;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  walletAddress: string;
}

export interface PAJOffRampResponse {
  reference: string;
  poolAddress: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export interface PAJWebhookEvent {
  type: 'onramp.deposit.confirmed' | 'onramp.deposit.failed' | 'offramp.settlement.confirmed' | 'offramp.settlement.failed';
  reference: string;
  walletAddress: string;
  ngnAmount?: number;
  cryptoAmount?: string;
  txHash?: string;
  reason?: string;
  timestamp: Date;
}

// Session (Redis)
export interface UserSession {
  userId: string;
  state: string;           // ConversationState
  pendingTransaction?: Partial<Transaction>;
  pendingIntent?: ParsedIntent;
  bridgeData?: {
    chainKey: string;
    sourceChain: string;
    token: string;
    tokenIn: string;
  };
  lastActivity: Date;
}

// Bot Context
export interface ZendContext {
  user?: User;
  session: UserSession;
}

// Jupiter Swap
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  priceImpact: number;
  route: string[];
  slippageBps: number;
}

// Email OTP
export interface EmailOTP {
  email: string;
  code: string;
  expiresAt: Date;
  verified: boolean;
}

// Referral
export interface Referral {
  id: string;
  referrerId: string;
  referredId: string;
  status: 'pending' | 'completed';
  rewardAmount?: number;
  createdAt: Date;
  completedAt?: Date;
}
