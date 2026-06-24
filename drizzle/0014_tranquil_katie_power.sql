CREATE TABLE "push_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"admin_id" varchar(50) NOT NULL,
	"message" text NOT NULL,
	"segment" varchar(50) DEFAULT 'all' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"recipient_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "from_mint" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "to_mint" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "recipient_wallet_address" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "push_notifications" ADD CONSTRAINT "push_notifications_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;