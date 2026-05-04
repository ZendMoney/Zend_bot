/**
 * ChainRails Client for Zend
 * Real API integration for cross-chain deposits
 * Docs: https://docs.chainrails.io
 */

const CHAINRAILS_API_URL = process.env.CHAINRAILS_API_URL || 'https://api.chainrails.io/api/v1';
const CHAINRAILS_API_KEY = process.env.CHAINRAILS_API_KEY;

// Token contract addresses by chain
export const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  ETHEREUM_MAINNET: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  BASE_MAINNET: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  BSC_MAINNET: {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    BNB: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  ARBITRUM_MAINNET: {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  OPTIMISM_MAINNET: {
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  POLYGON_MAINNET: {
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    MATIC: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  SOLANA_MAINNET: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    SOL: 'So11111111111111111111111111111111111111112',
  },
};

export const CHAIN_NAMES: Record<string, string> = {
  ETHEREUM_MAINNET: 'Ethereum',
  BASE_MAINNET: 'Base',
  BSC_MAINNET: 'BNB Chain',
  ARBITRUM_MAINNET: 'Arbitrum',
  OPTIMISM_MAINNET: 'Optimism',
  POLYGON_MAINNET: 'Polygon',
  AVALANCHE_MAINNET: 'Avalanche',
  STARKNET_MAINNET: 'Starknet',
  SOLANA_MAINNET: 'Solana',
};

export interface ChainRailsIntent {
  id: number;
  client_id: string;
  sender: string;
  initialAmount: string;
  fees_in_usd: string;
  app_fee_in_usd: string;
  total_amount_in_usd: string;
  total_amount_in_asset_token: string;
  fees_in_asset_token: string;
  app_fee_in_asset_token: string;
  asset_token_symbol: string;
  asset_token_decimals: number;
  slippage: string;
  tokenIn: string;
  tokenOut: string;
  intent_address: string;
  source_chain: string;
  destination_chain: string;
  recipient: string;
  refund_address: string;
  relayer: string;
  coordinator: string;
  bridger: string;
  bridgeExtraData: string;
  intent_nonce: number;
  intent_status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  tx_hash: string | null;
  needs_relay: boolean;
  expires_at: string;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface ChainRailsQuote {
  totalFee: string;
  totalFeeFormatted: string;
  route: {
    tokenIn: string;
    tokenOut: string;
    sourceChain: string;
    destinationChain: string;
    amount: string;
    bridge: string;
    recipient: string | null;
  };
}

class ChainRailsClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string = CHAINRAILS_API_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ChainRails ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  /** Get best quote for a cross-chain transfer */
  async getBestQuote(params: {
    tokenIn: string;
    tokenOut: string;
    sourceChain: string;
    destinationChain: string;
    amount: string;
    amountSymbol?: string;
    recipient?: string;
  }): Promise<ChainRailsQuote> {
    const url = new URL(`${this.baseUrl}/quotes/best`);
    url.searchParams.set('tokenIn', params.tokenIn);
    url.searchParams.set('tokenOut', params.tokenOut);
    url.searchParams.set('sourceChain', params.sourceChain);
    url.searchParams.set('destinationChain', params.destinationChain);
    url.searchParams.set('amount', params.amount);
    if (params.amountSymbol) url.searchParams.set('amountSymbol', params.amountSymbol);
    if (params.recipient) url.searchParams.set('recipient', params.recipient);

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ChainRails quote ${response.status}: ${errorText}`);
    }
    return response.json();
  }

  /** Create a cross-chain payment intent (returns deposit address) */
  async createIntent(params: {
    amount: string;
    amountSymbol: string;
    tokenIn: string;
    sourceChain: string;
    destinationChain: string;
    recipient: string;
    sender?: string;
    refundAddress?: string;
    metadata?: Record<string, any>;
  }): Promise<ChainRailsIntent> {
    const body: any = {
      amount: params.amount,
      amountSymbol: params.amountSymbol,
      tokenIn: params.tokenIn,
      source_chain: params.sourceChain,
      destination_chain: params.destinationChain,
      recipient: params.recipient,
    };
    if (params.sender) body.sender = params.sender;
    if (params.refundAddress) body.refund_address = params.refundAddress;
    if (params.metadata) body.metadata = params.metadata;

    return this.request('POST', '/intents', body);
  }

  /** Get intent by its contract address */
  async getIntentByAddress(address: string): Promise<ChainRailsIntent> {
    return this.request('GET', `/intents/${address}`);
  }

  /** Get intent by ID */
  async getIntentById(id: number): Promise<ChainRailsIntent> {
    return this.request('GET', `/intents/by-id/${id}`);
  }

  /** Manually trigger intent processing (fallback when indexer misses funding) */
  async triggerProcessing(address: string): Promise<void> {
    await this.request('POST', `/intents/${address}/trigger-processing`);
  }

  /** Get supported chains */
  async getSupportedChains(network?: 'mainnet' | 'testnet'): Promise<string[]> {
    const qs = network ? `?network=${network}` : '';
    return this.request('GET', `/chains${qs}`);
  }
}

// Singleton instance
let _client: ChainRailsClient | null = null;

export async function getChainRailsClient(): Promise<ChainRailsClient | null> {
  if (_client) return _client;
  if (!CHAINRAILS_API_KEY) {
    console.warn('⚠️  ChainRails not configured — set CHAINRAILS_API_KEY');
    return null;
  }
  _client = new ChainRailsClient(CHAINRAILS_API_KEY);
  return _client;
}

export { ChainRailsClient };
