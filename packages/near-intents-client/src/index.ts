/**
 * NEAR Intents 1Click API Client for ZendPay
 * Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api
 */

const ONECLICK_API_URL = process.env.NEAR_INTENTS_API_URL || 'https://1click.chaindefuser.com/v0';
const ONECLICK_JWT = process.env.NEAR_INTENTS_JWT;
const NEAR_INTENTS_REFUND_ADDRESS = process.env.NEAR_INTENTS_REFUND_ADDRESS || 'zendpay_refund.near';

export interface NearIntentsToken {
  assetId: string;
  symbol: string;
  name: string;
  decimals: number;
  blockchain: string;
  chainId?: number;
  contractAddress?: string;
}

export interface NearIntentsQuote {
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    minAmountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    timeEstimate: number;
    refundFee: string;
    withdrawFee: string;
    deadline: string;
    timeWhenInactive: string;
    depositAddress: string;
  };
  quoteRequest: {
    dry: boolean;
    swapType: string;
    slippageTolerance: number;
    originAsset: string;
    depositType: string;
    destinationAsset: string;
    amount: string;
    recipient: string;
    recipientType: string;
    refundTo: string;
    refundType: string;
    deadline: string;
  };
  signature: string;
  timestamp: string;
  correlationId: string;
}

export interface NearIntentsStatus {
  depositAddress: string;
  status:
    | 'PENDING_DEPOSIT'
    | 'KNOWN_DEPOSIT_TX'
    | 'PROCESSING'
    | 'SUCCESS'
    | 'INCOMPLETE_DEPOSIT'
    | 'REFUNDED'
    | 'FAILED';
  originAsset: NearIntentsToken;
  destinationAsset: NearIntentsToken;
  amountIn?: string;
  amountOut?: string;
  txHash?: string;
  destinationTxHash?: string;
  refundTxHash?: string;
  createdAt: string;
  updatedAt: string;
}

// Common NEAR Intents asset IDs by origin chain and symbol
// These are bridged representations used in the 1Click API
export const NEAR_INTENTS_ASSETS: Record<string, Record<string, string>> = {
  ethereum: {
    USDT: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
    USDC: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    ETH: 'nep141:eth.omft.near',
    DAI: 'nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near',
    WBTC: 'nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near',
  },
  base: {
    USDC: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    USDT: 'nep141:base-0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb.omft.near',
    ETH: 'nep141:base.omft.near',
    WETH: 'nep141:base-0x4200000000000000000000000000000000000006.omft.near',
  },
  bsc: {
    USDT: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g',
    USDC: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r',
    BNB: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
  },
  arbitrum: {
    USDC: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    ETH: 'nep141:arb.omft.near',
  },
  optimism: {
    USDC: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
    USDT: 'nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo',
    ETH: 'nep245:v2_1.omni.hot.tg:10_11111111111111111111',
  },
  polygon: {
    USDC: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
    USDT: 'nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr',
  },
  solana: {
    USDT: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
    USDC: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    SOL: 'nep141:sol.omft.near',
  },
  bitcoin: {
    BTC: 'nep141:btc.omft.near',
  },
  near: {
    NEAR: 'nep141:wrap.near',
    USDT: 'nep141:usdt.tether-token.near',
    USDC: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  },
};

export const CHAIN_DISPLAY_NAMES: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  bsc: 'BNB Chain',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon: 'Polygon',
  solana: 'Solana',
  bitcoin: 'Bitcoin',
  near: 'NEAR',
};

/** Map ZendPay chain keys to 1Click API `blockchain` values from /v0/tokens */
export const CHAIN_TO_API_BLOCKCHAIN: Record<string, string> = {
  ethereum: 'eth',
  base: 'base',
  bsc: 'bsc',
  arbitrum: 'arb',
  optimism: 'op',
  polygon: 'pol',
  solana: 'sol',
  bitcoin: 'btc',
  near: 'near',
};

// Decimals for base-unit conversion per chain
export { toBaseUnits } from './units.js';

export const TOKEN_DECIMALS: Record<string, Record<string, number>> = {
  ethereum: { USDT: 6, USDC: 6, ETH: 18, DAI: 18, WBTC: 8 },
  base: { USDT: 6, USDC: 6, ETH: 18, WETH: 18 },
  bsc: { USDT: 18, USDC: 18, BNB: 18 },
  arbitrum: { USDT: 6, USDC: 6, ETH: 18 },
  optimism: { USDT: 6, USDC: 6, ETH: 18 },
  polygon: { USDT: 6, USDC: 6 },
  solana: { USDT: 6, USDC: 6, SOL: 9 },
  bitcoin: { BTC: 8 },
  near: { NEAR: 24, USDT: 6, USDC: 6 },
};

class NearIntentsClient {
  private baseUrl: string;
  private jwt?: string;

  constructor(baseUrl: string = ONECLICK_API_URL, jwt?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.jwt = jwt;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.jwt) {
      h['Authorization'] = `Bearer ${this.jwt}`;
    }
    return h;
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      // @ts-ignore
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`NearIntents ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  /** Fetch supported tokens across all chains */
  async getTokens(): Promise<NearIntentsToken[]> {
    return this.request('GET', '/tokens');
  }

  /** Get best quote for a cross-chain swap/deposit */
  async getQuote(params: {
    originAsset: string;
    destinationAsset: string;
    amount: string;
    recipient: string;
    refundTo?: string;
    swapType?: 'EXACT_INPUT' | 'EXACT_OUTPUT';
    slippageTolerance?: number;
    depositType?: 'ORIGIN_CHAIN' | 'INTENTS';
    recipientType?: 'DESTINATION_CHAIN' | 'INTENTS';
    refundType?: 'ORIGIN_CHAIN' | 'INTENTS';
    deadline?: string;
    dry?: boolean;
  }): Promise<NearIntentsQuote> {
    const body: any = {
      dry: params.dry ?? false,
      swapType: params.swapType || 'EXACT_INPUT',
      slippageTolerance: params.slippageTolerance ?? 100,
      originAsset: params.originAsset,
      depositType: params.depositType || 'ORIGIN_CHAIN',
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      recipient: params.recipient,
      recipientType: params.recipientType || 'DESTINATION_CHAIN',
      refundTo: params.refundTo || NEAR_INTENTS_REFUND_ADDRESS,
      refundType: params.refundType || 'INTENTS',
      deadline: params.deadline || new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };

    return this.request('POST', '/quote', body);
  }

  /** Submit a transaction hash to speed up deposit detection (optional) */
  async submitDepositTx(depositAddress: string, txHash: string): Promise<void> {
    await this.request('POST', '/deposit/submit', { depositAddress, txHash });
  }

  /** Check swap status by deposit address */
  async getStatus(depositAddress: string): Promise<NearIntentsStatus> {
    return this.request('GET', `/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  }
}

// Token cache
let _tokenCache: NearIntentsToken[] | null = null;
let _tokenCacheTime = 0;
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Get cached tokens or fetch from API */
export async function getNearIntentsTokens(): Promise<NearIntentsToken[]> {
  if (_tokenCache && Date.now() - _tokenCacheTime < TOKEN_CACHE_TTL) {
    return _tokenCache;
  }
  const client = getNearIntentsClient();
  if (!client) return [];
  try {
    _tokenCache = await client.getTokens();
    _tokenCacheTime = Date.now();
    return _tokenCache;
  } catch (err) {
    console.warn('[NearIntents] Failed to fetch tokens:', err);
    return _tokenCache || [];
  }
}

/** Get tokens filtered by ZendPay chain key or raw API blockchain name */
export async function getTokensByBlockchain(chainKey: string): Promise<NearIntentsToken[]> {
  const tokens = await getNearIntentsTokens();
  const apiChain =
    CHAIN_TO_API_BLOCKCHAIN[chainKey]?.toLowerCase() || chainKey.toLowerCase();
  return tokens.filter((t) => t.blockchain.toLowerCase() === apiChain);
}

/** Resolve assetId from live /tokens, falling back to NEAR_INTENTS_ASSETS */
export async function resolveAssetId(chainKey: string, symbol: string): Promise<string | undefined> {
  const staticId = NEAR_INTENTS_ASSETS[chainKey]?.[symbol];
  if (staticId) return staticId;

  try {
    const tokens = await getTokensByBlockchain(chainKey);
    const match = tokens.find((t) => t.symbol?.toUpperCase() === symbol.toUpperCase());
    return match?.assetId;
  } catch (err) {
    console.warn('[NearIntents] Could not resolve assetId from API:', err);
    return undefined;
  }
}

/** Resolve token decimals — static table first, then live /tokens API. */
export async function resolveTokenDecimals(
  chainKey: string,
  tokenSymbol: string,
  assetId?: string
): Promise<number> {
  const staticDec = TOKEN_DECIMALS[chainKey]?.[tokenSymbol];
  if (staticDec != null) return staticDec;

  try {
    const tokens = await getNearIntentsTokens();
    if (assetId) {
      const byContract = tokens.find(
        (t) => (t as { assetId?: string }).assetId === assetId
      );
      if (byContract?.decimals != null) return byContract.decimals;
    }
    const apiChain =
      CHAIN_TO_API_BLOCKCHAIN[chainKey]?.toLowerCase() || chainKey.toLowerCase();
    const byChain = tokens.find(
      (t) =>
        t.blockchain?.toLowerCase() === apiChain &&
        t.symbol?.toUpperCase() === tokenSymbol.toUpperCase()
    );
    if (byChain?.decimals != null) return byChain.decimals;
  } catch (err) {
    console.warn('[NearIntents] Could not resolve decimals from API:', err);
  }

  return 6;
}

// Singleton instance
let _client: NearIntentsClient | null = null;

export function getNearIntentsClient(): NearIntentsClient | null {
  if (_client) return _client;
  _client = new NearIntentsClient(ONECLICK_API_URL, ONECLICK_JWT);
  return _client;
}

export { NearIntentsClient };
