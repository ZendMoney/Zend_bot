CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"action" varchar(50) NOT NULL,
	"resource" varchar(50) NOT NULL,
	"details" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_otps" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"email" varchar(255) NOT NULL,
	"code" varchar(6) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_id" varchar(50) NOT NULL,
	"referred_id" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"reward_amount" numeric(20, 9),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "saved_bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"bank_code" varchar(10) NOT NULL,
	"bank_name" varchar(100) NOT NULL,
	"account_number" varchar(10) NOT NULL,
	"account_name" varchar(100) NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"recipient_bank_account_id" integer NOT NULL,
	"amount_ngn" numeric(20, 2) NOT NULL,
	"frequency" varchar(10) NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"max_runs" integer,
	"run_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" varchar(20) PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"type" varchar(30) NOT NULL,
	"status" varchar(20) NOT NULL,
	"from_mint" varchar(44),
	"from_amount" numeric(30, 9),
	"to_mint" varchar(44),
	"to_amount" numeric(30, 9),
	"solana_tx_hash" varchar(88),
	"ngn_amount" numeric(20, 2),
	"ngn_rate" numeric(20, 4),
	"paj_fee_bps" integer,
	"zend_spread_bps" integer,
	"recipient_bank_code" varchar(10),
	"recipient_bank_name" varchar(100),
	"recipient_account_number" varchar(10),
	"recipient_account_name" varchar(100),
	"recipient_wallet_address" varchar(44),
	"paj_reference" varchar(50),
	"paj_pool_address" varchar(44),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"telegram_username" varchar(50),
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100),
	"email" varchar(255),
	"email_verified" boolean DEFAULT false NOT NULL,
	"wallet_address" varchar(44) NOT NULL,
	"wallet_encrypted_key" text NOT NULL,
	"virtual_account" jsonb,
	"tier" integer DEFAULT 1 NOT NULL,
	"auto_save_rate_bps" integer DEFAULT 0 NOT NULL,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"voice_replies_enabled" boolean DEFAULT false NOT NULL,
	"voice_input_enabled" boolean DEFAULT true NOT NULL,
	"transaction_pin" varchar(255),
	"referral_code" varchar(20),
	"referred_by" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"type" varchar(20) NOT NULL,
	"purpose" varchar(100),
	"locked_amount" numeric(30, 9),
	"unlock_at" timestamp with time zone,
	"save_rate_bps" integer,
	"token_account" varchar(44) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_id_users_id_fk" FOREIGN KEY ("referred_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_bank_accounts" ADD CONSTRAINT "saved_bank_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transfers" ADD CONSTRAINT "scheduled_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transfers" ADD CONSTRAINT "scheduled_transfers_recipient_bank_account_id_saved_bank_accounts_id_fk" FOREIGN KEY ("recipient_bank_account_id") REFERENCES "public"."saved_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_users_id_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;