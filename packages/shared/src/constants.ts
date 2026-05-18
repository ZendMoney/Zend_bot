// Nigerian Banks (CBN codes)
export const NIGERIAN_BANKS = [
  { code: 'GTB', name: 'GTBank' },
  { code: 'UBA', name: 'UBA' },
  { code: 'ACC', name: 'Access Bank' },
  { code: 'ZEN', name: 'Zenith Bank' },
  { code: 'FBN', name: 'First Bank' },
  { code: 'ECO', name: 'Ecobank' },
  { code: 'WEM', name: 'Wema Bank' },
  { code: 'FID', name: 'Fidelity Bank' },
  { code: 'SKY', name: 'Polaris Bank' },
  { code: 'STA', name: 'Stanbic IBTC' },
  { code: 'UNI', name: 'Union Bank' },
  { code: 'KEC', name: 'Keystone Bank' },
  { code: 'JAB', name: 'Jaiz Bank' },
  { code: 'TIT', name: 'Titan Trust Bank' },
  { code: 'GLO', name: 'Globus Bank' },
  { code: 'PRO', name: 'Providus Bank' },
  { code: 'SUN', name: 'SunTrust Bank' },
  { code: 'PAR', name: 'Parallex Bank' },
  { code: 'COR', name: 'Coronation Merchant Bank' },
  { code: 'FSD', name: 'FSDH Merchant Bank' },
  { code: 'RAN', name: 'Rand Merchant Bank' },
  { code: 'NOV', name: 'Nova Merchant Bank' },
  // Fintechs / MMOs
  { code: 'OPY', name: 'OPay' },
  { code: 'MON', name: 'Moniepoint' },
  { code: 'KUD', name: 'Kuda' },
  { code: 'PAL', name: 'PalmPay' },
  { code: 'PAG', name: 'Paga' },
  { code: 'VFD', name: 'VFD Microfinance Bank' },
  { code: 'CAR', name: 'Carbon' },
  { code: 'FAI', name: 'FairMoney' },
  { code: 'BRA', name: 'Branch' },
] as const;

// Solana Token Mints (Mainnet)
export const SOLANA_TOKENS = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
    name: 'Solana',
  },
  USDT: {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6,
    name: 'Tether USD',
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
  },
} as const;

// Conversation States
export enum ConversationState {
  IDLE = 'idle',
  AWAITING_SEND_AMOUNT = 'awaiting_send_amount',
  AWAITING_SEND_RECIPIENT = 'awaiting_send_recipient',
  AWAITING_BANK_DETAILS = 'awaiting_bank_details',
  AWAITING_CONFIRMATION = 'awaiting_confirmation',
  AWAITING_SWAP_FROM = 'awaiting_swap_from',
  AWAITING_SWAP_TO = 'awaiting_swap_to',
  AWAITING_SWAP_AMOUNT = 'awaiting_swap_amount',
  AWAITING_LOCK_AMOUNT = 'awaiting_lock_amount',
  AWAITING_LOCK_DATE = 'awaiting_lock_date',
  AWAITING_SCHEDULE_RECIPIENT = 'awaiting_schedule_recipient',
  AWAITING_SCHEDULE_AMOUNT = 'awaiting_schedule_amount',
  AWAITING_SCHEDULE_FREQUENCY = 'awaiting_schedule_frequency',
  AWAITING_SCHEDULE_START = 'awaiting_schedule_start',
  AWAITING_EMAIL = 'awaiting_email',
  AWAITING_OTP = 'awaiting_otp',
  AWAITING_PIN = 'awaiting_pin',
  AWAITING_PIN_VERIFY = 'awaiting_pin_verify',
  AWAITING_BANK_ACCOUNT_NUMBER = 'awaiting_bank_account_number',
  AWAITING_BANK_ACCOUNT_NAME = 'awaiting_bank_account_name',
  AWAITING_ONRAMP_AMOUNT = 'awaiting_onramp_amount',
  AWAITING_BRIDGE_AMOUNT = 'awaiting_bridge_amount',
  AWAITING_SHOP_AMOUNT = 'awaiting_shop_amount',
  AWAITING_SHOP_PHONE = 'awaiting_shop_phone',
}

// Transaction Types
export enum TransactionType {
  NGN_SEND = 'ngn_send',
  NGN_RECEIVE = 'ngn_receive',
  CRYPTO_SEND = 'crypto_send',
  CRYPTO_RECEIVE = 'crypto_receive',
  SWAP = 'swap',
  VAULT_AUTO_SAVE = 'vault_auto_save',
  VAULT_LOCK = 'vault_lock',
  VAULT_UNLOCK = 'vault_unlock',
  SCHEDULED = 'scheduled',
}

// Transaction Status
export enum TransactionStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

// User Tiers
export enum UserTier {
  BASIC = 1,
  VERIFIED = 2,
  PREMIUM = 3,
}

// Limits per tier (daily, in NGN)
export const TIER_LIMITS = {
  [UserTier.BASIC]: {
    sendNgn: 500_000,
    receiveNgn: 1_000_000,
    swap: Infinity,
  },
  [UserTier.VERIFIED]: {
    sendNgn: 5_000_000,
    receiveNgn: 10_000_000,
    swap: Infinity,
  },
  [UserTier.PREMIUM]: {
    sendNgn: 50_000_000,
    receiveNgn: 100_000_000,
    swap: Infinity,
  },
} as const;

// PAJ Constants
export const PAJ_FEE_BPS = 80; // 0.8%
export const PAJ_MIN_DEPOSIT_NGN = 1_000;

// Auto-save rates (in basis points)
export const AUTO_SAVE_RATES = [100, 200, 300, 500, 1000] as const; // 1%, 2%, 3%, 5%, 10%

// Zend spread (your margin on top of PAJ)
export const ZEND_SPREAD_BPS = 50; // 0.5% - adjust as needed
