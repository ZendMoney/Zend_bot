-- NEAR Intents asset IDs (nep141:..., nep245:...) exceed Solana mint length (44)
ALTER TABLE "transactions" ALTER COLUMN "from_mint" TYPE varchar(128);
ALTER TABLE "transactions" ALTER COLUMN "to_mint" TYPE varchar(128);
-- External chain withdraw addresses (BTC, NEAR names) can exceed 44 chars
ALTER TABLE "transactions" ALTER COLUMN "recipient_wallet_address" TYPE varchar(100);