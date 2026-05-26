-- Ambassador programme: status, tier, confirmedAt
ALTER TABLE "ambassador_applications" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'pending' NOT NULL;
ALTER TABLE "ambassador_applications" ADD COLUMN IF NOT EXISTS "tier" varchar(20) DEFAULT 'entry' NOT NULL;
ALTER TABLE "ambassador_applications" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
