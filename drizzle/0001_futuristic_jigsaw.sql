ALTER TABLE "users" ADD COLUMN "paj_session_token" varchar(500);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "paj_session_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "paj_contact" varchar(255);