CREATE TABLE "ambassador_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"tg_handle" varchar(40) NOT NULL,
	"is_student" varchar(10) NOT NULL,
	"focus" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bitrefill_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"bitrefill_invoice_id" varchar(100) NOT NULL,
	"product_id" varchar(100) NOT NULL,
	"product_name" varchar(200) NOT NULL,
	"category" varchar(50) NOT NULL,
	"amount_fiat" numeric(20, 2),
	"currency_fiat" varchar(10),
	"amount_crypto" numeric(30, 9),
	"crypto_currency" varchar(20),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"codes" jsonb,
	"recipient_phone" varchar(20),
	"recipient_email" varchar(255),
	"payment_address" varchar(100),
	"payment_uri" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_suspension_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" varchar(100) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"handle" varchar(50) NOT NULL,
	"device_lost" varchar(100) NOT NULL,
	"last_used" varchar(50) NOT NULL,
	"reason" varchar(20) NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bitrefill_orders" ADD CONSTRAINT "bitrefill_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;