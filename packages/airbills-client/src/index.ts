// ─── AirBills API Client ───
// Nigerian bill payments powered by Solana stablecoins
// Docs: Contact AirBills (0xpsolite) for API access

const DEFAULT_BASE_URL = 'https://api.airbills.org/v1';

export interface AirbillsService {
  id: string;
  name: string;
  slug: string;
  icon?: string;
}

export interface AirbillsPlan {
  id: string;
  name: string;
  amount: number;
  currency: string;
}

export interface AirbillsOrder {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  service: string;
  recipient: string;
  amountFiat: number;
  currencyFiat: string;
  amountCrypto: number;
  cryptoCurrency: string;
  paymentAddress: string;
  paymentUri?: string;
  createdAt: string;
  completedAt?: string;
  token?: string; // electricity token, data PIN, etc.
  metadata?: any;
}

export interface CreateOrderParams {
  service: string; // 'airtime' | 'data' | 'electricity' | 'cable' | 'betting' | 'transport'
  planId?: string;
  recipient: string; // phone, meter number, smartcard, etc.
  amount?: number; // for variable amounts (airtime)
  currency?: string;
  email?: string;
  webhookUrl?: string;
}

export class AirbillsClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AirBills API error ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json() as Promise<T>;
  }

  async getServices(): Promise<AirbillsService[]> {
    return this.request<AirbillsService[]>('/services');
  }

  async getPlans(serviceSlug: string): Promise<AirbillsPlan[]> {
    return this.request<AirbillsPlan[]>(`/services/${serviceSlug}/plans`);
  }

  async validateRecipient(serviceSlug: string, recipient: string): Promise<{ valid: boolean; name?: string }> {
    return this.request<{ valid: boolean; name?: string }>(`/services/${serviceSlug}/validate`, {
      method: 'POST',
      body: JSON.stringify({ recipient }),
    });
  }

  async createOrder(params: CreateOrderParams): Promise<AirbillsOrder> {
    return this.request<AirbillsOrder>('/orders', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getOrder(orderId: string): Promise<AirbillsOrder> {
    return this.request<AirbillsOrder>(`/orders/${orderId}`);
  }

  async ping(): Promise<{ status: string }> {
    return this.request<{ status: string }>('/ping');
  }
}
