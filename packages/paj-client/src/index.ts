import { createHmac } from 'crypto';
import type {
  PAJRateResponse,
  PAJVirtualAccount,
  PAJOffRampRequest,
  PAJOffRampResponse,
  PAJWebhookEvent,
} from '@zend/shared';

export interface PAJConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
}

export class PAJClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(config: PAJConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-PAJ-API-Key': this.apiKey,
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`PAJ API error: ${response.status} ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // Get current NGN/USDT rate and fee
  async getRate(): Promise<PAJRateResponse> {
    return this.request<PAJRateResponse>('/v1/rates/ngn-usdt');
  }

  // Get PAJ pool address for off-ramp
  async getPoolAddress(): Promise<string> {
    const response = await this.request<{ poolAddress: string }>('/v1/pool-address');
    return response.poolAddress;
  }

  // Provision a virtual bank account for on-ramp
  async provisionVirtualAccount(walletAddress: string): Promise<PAJVirtualAccount> {
    return this.request<PAJVirtualAccount>('/v1/virtual-accounts', {
      method: 'POST',
      body: JSON.stringify({ walletAddress }),
    });
  }

  // Get existing virtual account
  async getVirtualAccount(walletAddress: string): Promise<PAJVirtualAccount | null> {
    try {
      return await this.request<PAJVirtualAccount>(`/v1/virtual-accounts/${walletAddress}`);
    } catch {
      return null;
    }
  }

  // Initiate off-ramp (crypto → NGN)
  async initiateOffRamp(params: PAJOffRampRequest): Promise<PAJOffRampResponse> {
    return this.request<PAJOffRampResponse>('/v1/offramp', {
      method: 'POST',
      body: JSON.stringify({
        amountUsdt: params.amountUsdt,
        ngnAmount: params.ngnAmount,
        bankCode: params.bankCode,
        accountNumber: params.accountNumber,
        accountName: params.accountName,
        walletAddress: params.walletAddress,
      }),
    });
  }

  // Get off-ramp status
  async getOffRampStatus(reference: string): Promise<PAJOffRampResponse> {
    return this.request<PAJOffRampResponse>(`/v1/offramp/${reference}`);
  }

  // Verify webhook signature
  verifyWebhookSignature(payload: string, signature: string): boolean {
    const expected = createHmac('sha256', this.apiSecret)
      .update(payload)
      .digest('hex');
    return signature === expected;
  }

  // Parse webhook event
  parseWebhookEvent(payload: string): PAJWebhookEvent {
    return JSON.parse(payload) as PAJWebhookEvent;
  }
}

export { PAJRateResponse, PAJVirtualAccount, PAJOffRampRequest, PAJOffRampResponse, PAJWebhookEvent };
