import { pgTable, varchar, timestamp, integer, boolean, jsonb, text, decimal, serial } from 'drizzle-orm/pg-core';

// Users table
export const users = pgTable('users', {
  id: varchar('id', { length: 50 }).primaryKey(), // Telegram user ID
  telegramUsername: varchar('telegram_username', { length: 50 }),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }),
  email: varchar('email', { length: 255 }),
  emailVerified: boolean('email_verified').default(false).notNull(),
  
  // Solana wallet
  walletAddress: varchar('wallet_address', { length: 44 }).notNull().unique(),
  walletEncryptedKey: text('wallet_encrypted_key').notNull(),
  
  // PAJ virtual account (cached)
  virtualAccount: jsonb('virtual_account'),
  
  // PAJ session (cached)
  pajSessionToken: varchar('paj_session_token', { length: 500 }),
  pajSessionExpiresAt: timestamp('paj_session_expires_at', { withTimezone: true }),
  pajContact: varchar('paj_contact', { length: 255 }), // email or phone used for PAJ
  
  // Settings
  tier: integer('tier').default(1).notNull(),
  autoSaveRateBps: integer('auto_save_rate_bps').default(0).notNull(),
  language: varchar('language', { length: 10 }).default('en').notNull(),
  voiceRepliesEnabled: boolean('voice_replies_enabled').default(false).notNull(),
  voiceInputEnabled: boolean('voice_input_enabled').default(true).notNull(),
  transactionPin: varchar('transaction_pin', { length: 255 }), // hashed
  
  // Referral
  referralCode: varchar('referral_code', { length: 20 }).unique(),
  referredBy: varchar('referred_by', { length: 50 }).references((): any => users.id),
  ambassadorReferralCode: varchar('ambassador_referral_code', { length: 50 }),

  // Admin
  isAdmin: boolean('is_admin').default(false).notNull(),

  // Onboarding
  onboardingComplete: boolean('onboarding_complete').default(false).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Saved bank accounts (for off-ramp recipients)
export const savedBankAccounts = pgTable('saved_bank_accounts', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull().references((): any => users.id),
  bankCode: varchar('bank_code', { length: 10 }).notNull(),
  bankName: varchar('bank_name', { length: 100 }).notNull(),
  accountNumber: varchar('account_number', { length: 20 }).notNull(),
  accountName: varchar('account_name', { length: 100 }).notNull(),
  verified: boolean('verified').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Transactions
export const transactions = pgTable('transactions', {
  id: varchar('id', { length: 20 }).primaryKey(), // ZND-XXXXX
  userId: varchar('user_id', { length: 50 }).notNull().references((): any => users.id),
  type: varchar('type', { length: 30 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  
  // Crypto side
  fromMint: varchar('from_mint', { length: 128 }),
  fromAmount: decimal('from_amount', { precision: 30, scale: 9 }),
  toMint: varchar('to_mint', { length: 128 }),
  toAmount: decimal('to_amount', { precision: 30, scale: 9 }),
  solanaTxHash: varchar('solana_tx_hash', { length: 88 }),
  
  // Fiat side
  ngnAmount: decimal('ngn_amount', { precision: 20, scale: 2 }),
  ngnRate: decimal('ngn_rate', { precision: 20, scale: 4 }),
  pajFeeBps: integer('paj_fee_bps'),
  zendSpreadBps: integer('zend_spread_bps'),
  zendFeeUsdt: decimal('zend_fee_usdt', { precision: 20, scale: 9 }),
  
  // Recipient
  recipientBankCode: varchar('recipient_bank_code', { length: 10 }),
  recipientBankName: varchar('recipient_bank_name', { length: 100 }),
  recipientAccountNumber: varchar('recipient_account_number', { length: 20 }),
  recipientAccountName: varchar('recipient_account_name', { length: 100 }),
  recipientWalletAddress: varchar('recipient_wallet_address', { length: 100 }),
  
  // PAJ
  pajReference: varchar('paj_reference', { length: 50 }),
  pajPoolAddress: varchar('paj_pool_address', { length: 44 }),
  
  // ChainRails (deprecated — hidden in favor of NEAR Intents)
  chainrailsIntentAddress: varchar('chainrails_intent_address', { length: 100 }),
  
  // NEAR Intents
  nearIntentDepositAddress: varchar('near_intent_deposit_address', { length: 100 }),
  
  // Metadata
  metadata: jsonb('metadata'),
  
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// Vaults (savings)
export const vaults = pgTable('vaults', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull().references((): any => users.id),
  type: varchar('type', { length: 20 }).notNull(), // auto_save | time_lock
  
  // For time-lock
  purpose: varchar('purpose', { length: 100 }),
  lockedAmount: decimal('locked_amount', { precision: 30, scale: 9 }),
  unlockAt: timestamp('unlock_at', { withTimezone: true }),
  
  // For auto-save
  saveRateBps: integer('save_rate_bps'),
  
  // SPL token account for this vault
  tokenAccount: varchar('token_account', { length: 44 }).notNull(),
  
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Scheduled transfers
export const scheduledTransfers = pgTable('scheduled_transfers', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull().references((): any => users.id),
  recipientBankAccountId: integer('recipient_bank_account_id').notNull().references((): any => savedBankAccounts.id),
  amountNgn: decimal('amount_ngn', { precision: 20, scale: 2 }).notNull(),
  frequency: varchar('frequency', { length: 10 }).notNull(), // once | daily | weekly | monthly
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }),
  maxRuns: integer('max_runs'),
  runCount: integer('run_count').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Email OTP
export const emailOTPs = pgTable('email_otps', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  code: varchar('code', { length: 6 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  verified: boolean('verified').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Referrals
export const referrals = pgTable('referrals', {
  id: serial('id').primaryKey(),
  referrerId: varchar('referrer_id', { length: 50 }).notNull().references((): any => users.id),
  referredId: varchar('referred_id', { length: 50 }).notNull().references((): any => users.id),
  status: varchar('status', { length: 20 }).default('pending').notNull(),
  rewardAmount: decimal('reward_amount', { precision: 20, scale: 9 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// Bill payments (airtime, data, electricity, cable TV)
export const billPayments = pgTable('bill_payments', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull().references((): any => users.id),
  type: varchar('type', { length: 20 }).notNull(), // airtime | data | electricity | cable
  provider: varchar('provider', { length: 50 }).notNull(), // mtn | airtel | glo | ikeja_electric | dstv
  recipient: varchar('recipient', { length: 50 }).notNull(), // phone | meter | smartcard
  amountNgn: decimal('amount_ngn', { precision: 20, scale: 2 }).notNull(),
  amountUsdt: decimal('amount_usdt', { precision: 20, scale: 9 }),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending | success | failed
  reference: varchar('reference', { length: 100 }).notNull(),
  externalReference: varchar('external_reference', { length: 100 }), // VTpass reference
  commissionNgn: decimal('commission_ngn', { precision: 20, scale: 2 }),
  token: varchar('token', { length: 255 }), // electricity token or data PIN
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// BitRefill orders (gift cards, airtime, eSIMs)
export const bitrefillOrders = pgTable('bitrefill_orders', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull().references(() => users.id),
  bitrefillInvoiceId: varchar('bitrefill_invoice_id', { length: 100 }).notNull(),
  productId: varchar('product_id', { length: 100 }).notNull(),
  productName: varchar('product_name', { length: 200 }).notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  amountFiat: decimal('amount_fiat', { precision: 20, scale: 2 }),
  currencyFiat: varchar('currency_fiat', { length: 10 }),
  amountCrypto: decimal('amount_crypto', { precision: 30, scale: 9 }),
  cryptoCurrency: varchar('crypto_currency', { length: 20 }),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  codes: jsonb('codes'),
  recipientPhone: varchar('recipient_phone', { length: 20 }),
  recipientEmail: varchar('recipient_email', { length: 255 }),
  paymentAddress: varchar('payment_address', { length: 100 }),
  paymentUri: text('payment_uri'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// Audit log (immutable)
export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull(),
  action: varchar('action', { length: 50 }).notNull(),
  resource: varchar('resource', { length: 50 }).notNull(),
  details: jsonb('details'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── Landing page form submissions ───

export const ambassadorApplications = pgTable('ambassador_applications', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  tgHandle: varchar('tg_handle', { length: 40 }).notNull(),
  isStudent: varchar('is_student', { length: 10 }).notNull(),
  focus: varchar('focus', { length: 120 }).notNull(),
  customReferralCode: varchar('custom_referral_code', { length: 50 }).unique(),
  status: varchar('status', { length: 20 }).default('pending').notNull(), // pending | confirmed | removed
  tier: varchar('tier', { length: 20 }).default('entry').notNull(), // entry | pro | elite
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const deviceSuspensionRequests = pgTable('device_suspension_requests', {
  id: serial('id').primaryKey(),
  fullName: varchar('full_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 30 }).notNull(),
  handle: varchar('handle', { length: 50 }).notNull(),
  deviceLost: varchar('device_lost', { length: 100 }).notNull(),
  lastUsed: varchar('last_used', { length: 50 }).notNull(),
  reason: varchar('reason', { length: 20 }).notNull(),
  details: text('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── Bot Features (AI awareness + admin toggles) ───

export const botFeatures = pgTable('bot_features', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description').notNull(),
  category: varchar('category', { length: 30 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  isAiVisible: boolean('is_ai_visible').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── User Feedback ───

export const feedback = pgTable('feedback', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 50 }).notNull().references((): any => users.id),
  message: text('message').notNull(),
  category: varchar('category', { length: 30 }).notNull().default('general'), // general | bug | feature | support
  status: varchar('status', { length: 20 }).notNull().default('open'), // open | in_progress | resolved | closed
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
