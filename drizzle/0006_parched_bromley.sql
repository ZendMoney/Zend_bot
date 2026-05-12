CREATE TABLE "bill_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(50) NOT NULL,
	"type" varchar(20) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"recipient" varchar(50) NOT NULL,
	"amount_ngn" numeric(20, 2) NOT NULL,
	"amount_usdt" numeric(20, 9),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"reference" varchar(100) NOT NULL,
	"external_reference" varchar(100),
	"commission_ngn" numeric(20, 2),
	"token" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;