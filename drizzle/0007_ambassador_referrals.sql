-- Customized referral links for ambassadors
ALTER TABLE "ambassador_applications" ADD COLUMN IF NOT EXISTS "custom_referral_code" varchar(50) UNIQUE;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ambassador_referral_code" varchar(50);
