ALTER TABLE "users" ADD COLUMN "default_mode" varchar(20) DEFAULT 'personal' NOT NULL;

CREATE TABLE "businesses" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"name" varchar(200),
	"email" varchar(255),
	"phone" varchar(30),
	"logo_url" text,
	"bank_code" varchar(10),
	"bank_name" varchar(100),
	"account_number" varchar(20),
	"account_name" varchar(100),
	"usdc_wallet_address" varchar(100),
	"invoice_prefix" varchar(10) DEFAULT 'INV-' NOT NULL,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"invoice_quota_remaining" integer DEFAULT 3 NOT NULL,
	"subscription_plan" varchar(20) DEFAULT 'starter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_user_id_unique" UNIQUE("user_id")
);

CREATE TABLE "business_wallets" (
	"business_id" integer PRIMARY KEY NOT NULL,
	"ngn_balance" numeric(20, 2) DEFAULT '0' NOT NULL,
	"usdc_balance" numeric(20, 9) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "business_sessions" (
	"user_id" varchar(50) PRIMARY KEY NOT NULL,
	"active_mode" varchar(20) DEFAULT 'personal' NOT NULL,
	"current_flow" varchar(50),
	"current_step" varchar(50),
	"flow_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"return_to_flow" varchar(50),
	"return_to_step" varchar(50),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "business_clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"email" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invoices" (
	"id" varchar(20) PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"client_id" integer,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"subtotal_ngn" numeric(20, 2) DEFAULT '0' NOT NULL,
	"vat_ngn" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_ngn" numeric(20, 2) DEFAULT '0' NOT NULL,
	"payment_threshold_ngn" numeric(20, 2),
	"amount_received_ngn" numeric(20, 2) DEFAULT '0' NOT NULL,
	"overpayment_rule" varchar(30),
	"payment_method" varchar(20),
	"settlement_preference" varchar(30),
	"recurring_interval" varchar(20),
	"expires_at" timestamp with time zone,
	"generation_fee_ngn" numeric(20, 2),
	"settlement_fee_bps" integer,
	"image_url" text,
	"pdf_url" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);

CREATE TABLE "invoice_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"amount_ngn" numeric(20, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invoice_payment_rails" (
	"invoice_id" varchar(20) PRIMARY KEY NOT NULL,
	"fw_virtual_account" jsonb,
	"crypto_deposit_addresses" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invoice_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" varchar(20) NOT NULL,
	"amount_ngn" numeric(20, 2) NOT NULL,
	"source" varchar(20) NOT NULL,
	"webhook_id" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invoice_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" varchar(20) NOT NULL,
	"type" varchar(20) NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fee_ngn" numeric(20, 2) DEFAULT '0',
	"custom_message" text
);

CREATE TABLE "business_fee_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"invoice_id" varchar(20),
	"fee_type" varchar(30) NOT NULL,
	"amount_ngn" numeric(20, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "business_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"plan" varchar(20) NOT NULL,
	"amount_ngn" numeric(20, 2) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invoice_bundle_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"bundle_size" integer NOT NULL,
	"remaining_count" integer NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invoice_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_id" integer NOT NULL,
	"client_id" integer,
	"name" varchar(200) NOT NULL,
	"line_items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "business_disputes" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" varchar(20) NOT NULL,
	"business_id" integer NOT NULL,
	"dispute_type" varchar(50) NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auto_resolution_attempted" boolean DEFAULT false NOT NULL,
	"resolution_status" varchar(20) DEFAULT 'open' NOT NULL,
	"support_agent_id" varchar(50),
	"metadata" jsonb
);

ALTER TABLE "businesses" ADD CONSTRAINT "businesses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_wallets" ADD CONSTRAINT "business_wallets_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_sessions" ADD CONSTRAINT "business_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_clients" ADD CONSTRAINT "business_clients_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_business_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."business_clients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_payment_rails" ADD CONSTRAINT "invoice_payment_rails_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_fee_ledger" ADD CONSTRAINT "business_fee_ledger_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_fee_ledger" ADD CONSTRAINT "business_fee_ledger_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_bundle_credits" ADD CONSTRAINT "invoice_bundle_credits_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_templates" ADD CONSTRAINT "invoice_templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_templates" ADD CONSTRAINT "invoice_templates_client_id_business_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."business_clients"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_disputes" ADD CONSTRAINT "business_disputes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "business_disputes" ADD CONSTRAINT "business_disputes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "business_clients_business_email_idx" ON "business_clients" ("business_id", "email");