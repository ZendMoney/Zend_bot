/**
 * ChainRails Client for Zend
 * Cross-chain deposit/withdrawal bridge
 *
 * NOTE: This is a scaffold. Replace with actual ChainRails API endpoints
 * once API keys are available from https://chainrails.io
 */

const CHAINRAILS_API_URL = process.env.CHAINRAILS_API_URL || 'https://api.chainrails.io/v1';
const CHAINRAILS_API_KEY = process.env.CHAINRAILS_API_KEY;

export interface ChainRailsDepositRequest {
  fromChain: string;      // e.g., 'ethereum', 'bsc', 'base'
  fromToken: string;      // e.g., 'USDC', 'USDT'
  toChain: string;        // e.g., 'solana'
  toToken: string;        // e.g., 'USDT'
  toAddress: string;      // user's Solana wallet address
  amount?: string;        // optional: expected amount
}

export interface ChainRailsDeposit {
  id: string;
  depositAddress: string; // address on source chain for user to send to
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  toAddress: string;
  status: 'pending' | 'deposit_detected' | 'confirming' | 'completed' | 'failed';
  amount?: string;
  txHash?: string;        // source chain tx
  destinationTxHash?: string; // destination chain tx (Solana)
  createdAt: string;
  updatedAt: string;
}

export interface ChainRailsWithdrawalRequest {
  fromChain: string;      // 'solana'
  fromToken: string;      // 'USDT'
  toChain: string;        // e.g., 'ethereum'
  toToken: string;        // 'USDC'
  toAddress: string;      // destination address
  amount: string;
}

export interface ChainRailsWithdrawal {
  id: string;
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  toAddress: string;
  amount: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  txHash?: string;
  destinationTxHash?: string;
  createdAt: string;
  updatedAt: string;
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
      const error = await response.text();
      throw new Error(`ChainRails API error: ${response.status} ${error}`);
    }

    return response.json();
  }

  /** Create a cross-chain deposit (bridge in) */
  async createDeposit(params: ChainRailsDepositRequest): Promise<ChainRailsDeposit> {
    return this.request('POST', '/deposits', params);
  }

  /** Get deposit status */
  async getDeposit(id: string): Promise<ChainRailsDeposit> {
    return this.request('GET', `/deposits/${id}`);
  }

  /** Create a cross-chain withdrawal (bridge out) */
  async createWithdrawal(params: ChainRailsWithdrawalRequest): Promise<ChainRailsWithdrawal> {
    return this.request('POST', '/withdrawals', params);
  }

  /** Get withdrawal status */
  async getWithdrawal(id: string): Promise<ChainRailsWithdrawal> {
    return this.request('GET', `/withdrawals/${id}`);
  }

  /** Get supported chains and tokens */
  async getSupportedRoutes(): Promise<Array<{ fromChain: string; fromToken: string; toChain: string; toToken: string }>> {
    return this.request('GET', '/routes');
  }
}

// Singleton instance
let _chainRailsClient: ChainRailsClient | null = null;

export async function getChainRailsClient(): Promise<ChainRailsClient | null> {
  if (_chainRailsClient) return _chainRailsClient;
  if (!CHAINRAILS_API_KEY) {
    console.warn('⚠️  ChainRails not configured — set CHAINRAILS_API_KEY');
    return null;
  }
  _chainRailsClient = new ChainRailsClient(CHAINRAILS_API_KEY);
  return _chainRailsClient;
}

export { ChainRailsClient };
