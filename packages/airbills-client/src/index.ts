// ─── AirBills API Client ───
// Nigerian bill payments powered by Solana stablecoins
// Docs: https://app.airbills.org — contact @0xpsolite for API access

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
  token?: string;
  metadata?: any;
}

export interface CreateOrderParams {
  service: string;
  planId?: string;
  recipient: string;
  amount?: number;
  currency?: string;
  email?: string;
  webhookUrl?: string;
  network?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

interface AirbillsApiResponse<T> {
  status: string;
  message: string;
  data: T | null;
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
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });

    const text = await response.text().catch(() => '');
    let parsed: AirbillsApiResponse<T> | T;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`AirBills API error ${response.status}: ${text.slice(0, 200)}`);
    }

    // Wrapped response: { status, message, data }
    if (parsed && typeof parsed === 'object' && 'status' in parsed && 'message' in parsed) {
      const wrapped = parsed as AirbillsApiResponse<T>;
      const ok = wrapped.status === '00' || wrapped.status === '0' || wrapped.status === 'success';
      if (!ok) {
        throw new Error(`AirBills: ${wrapped.message || 'Request failed'} (status ${wrapped.status})`);
      }
      if (wrapped.data === null || wrapped.data === undefined) {
        throw new Error(`AirBills: empty response — ${wrapped.message || 'no data'}`);
      }
      return wrapped.data;
    }

    if (!response.ok) {
      throw new Error(`AirBills API error ${response.status}: ${text.slice(0, 200)}`);
    }

    return parsed as T;
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
      body: JSON.stringify({
        service: params.service,
        planId: params.planId,
        recipient: params.recipient,
        amount: params.amount,
        currency: params.currency || 'NGN',
        email: params.email,
        webhookUrl: params.webhookUrl,
        network: params.network,
        provider: params.provider,
        metadata: params.metadata,
      }),
    });
  }

  async getOrder(orderId: string): Promise<AirbillsOrder> {
    return this.request<AirbillsOrder>(`/orders/${orderId}`);
  }

  /** Health check — throws if API key is invalid */
  async ping(): Promise<{ status: string }> {
    return this.request<{ status: string }>('/ping');
  }
}