/**
 * Shared bot dependencies — singletons created once at startup.
 * Handlers receive `deps` over time; index.ts still imports named exports during migration.
 */
import { WalletService } from '@zend/solana';
import { AirbillsClient } from '@zend/airbills-client';
import type { PAJClient } from '@zend/paj-client';

const _pajEnums = await import('@zend/paj-client');
export const Currency = _pajEnums.Currency;
export const Chain = _pajEnums.Chain;

export const BOT_TOKEN = process.env.BOT_TOKEN!;
export const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let _pajClient: PAJClient | null = null;

export async function getPAJClient(): Promise<PAJClient | null> {
  if (_pajClient) return _pajClient;
  const { createPAJClient } = await import('@zend/paj-client');
  _pajClient = createPAJClient();
  return _pajClient;
}

export const walletService = new WalletService(SOLANA_RPC);

export const airbillsClient = process.env.AIRBILLS_API_KEY
  ? new AirbillsClient(process.env.AIRBILLS_API_KEY, process.env.AIRBILLS_BASE_URL)
  : null;

export const DEV_WALLET_SECRET = process.env.ZEND_DEV_WALLET_SECRET || process.env.PV_KEY || '';

/** Public HTTPS base URL for PAJ/AirBills callbacks (not used for Telegram delivery). */
export function getPublicBaseUrl(): string | undefined {
  const explicit = process.env.WEBHOOK_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway.replace(/\/$/, '')}`;
  return undefined;
}

export function getPajWebhookUrl(): string {
  const base = getPublicBaseUrl();
  return base ? `${base}/webhooks/paj` : 'https://example.com/webhook';
}

export interface BotDeps {
  botToken: string;
  solanaRpc: string;
  walletService: WalletService;
  airbillsClient: AirbillsClient | null;
  getPAJClient: () => Promise<PAJClient | null>;
  devWalletSecret: string;
  currency: typeof Currency;
  chain: typeof Chain;
  getPublicBaseUrl: () => string | undefined;
  getPajWebhookUrl: () => string;
}

export const deps: BotDeps = {
  botToken: BOT_TOKEN,
  solanaRpc: SOLANA_RPC,
  walletService,
  airbillsClient,
  getPAJClient,
  devWalletSecret: DEV_WALLET_SECRET,
  currency: Currency,
  chain: Chain,
  getPublicBaseUrl,
  getPajWebhookUrl,
};