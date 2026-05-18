// ─── BitRefill API Client (v2) ───
// Docs: https://docs.bitrefill.com

const BASE_URL = 'https://api.bitrefill.com/v2';

export interface BitRefillProduct {
  id: string;
  name: string;
  category: string;
  country: string;
  currency: string;
  type: string;
  packages?: BitRefillPackage[];
  range?: { min: number; max: number; step: number };
  in_stock: boolean;
  image_url?: string;
  rating?: number;
  review_count?: number;
}

export interface BitRefillPackage {
  package_id: string;
  value: number;
  currency: string;
  price: number;
  price_currency: string;
}

export interface BitRefillInvoice {
  id: string;
  status: 'unpaid' | 'paid' | 'processing' | 'complete' | 'expired' | 'failed' | 'denied' | 'payment_error';
  payment_method?: string;
  payment?: {
    address?: string;
    amount?: string;
    currency?: string;
    BIP21?: string;
    lightning_invoice?: string;
  };
  total: number;
  total_currency: string;
  crypto_amount?: string;
  crypto_currency?: string;
  orders: BitRefillOrderRef[];
  expires_at: string;
  created_at: string;
}

export interface BitRefillOrderRef {
  id: string;
  product_id: string;
  status: string;
}

export interface BitRefillOrder {
  id: string;
  status: string;
  product_id: string;
  product_name: string;
  value: number;
  currency: string;
  redemption_info?: {
    code?: string;
    pin?: string;
    link?: string;
    instructions?: string;
    expiration_date?: string;
  };
}

export interface CreateInvoiceParams {
  products: {
    product_id: string;
    package_id?: string;
    value?: number;
    quantity?: number;
    phone_number?: string;
  }[];
  payment_method?: string; // 'balance' | 'bitcoin' | 'ethereum' | 'usdt' | 'usdc' | 'solana' | etc.
  refund_address?: string;
  webhook_url?: string;
  auto_pay?: boolean;
  email?: string;
}

export class BitRefillClient {
  private apiKey?: string;
  private apiId?: string;
  private apiSecret?: string;
  private baseUrl: string;

  /** Personal API: Bearer token */
  constructor(apiKey: string, baseUrl?: string);
  /** Business API: Basic auth (apiId, apiSecret) */
  constructor(apiId: string, apiSecret: string, baseUrl?: string);

  constructor(...args: any[]) {
    this.baseUrl = BASE_URL;
    if (args.length >= 2 && typeof args[1] === 'string' && !args[1].startsWith('http')) {
      // Business API
      this.apiId = args[0];
      this.apiSecret = args[1];
      this.baseUrl = args[2] || BASE_URL;
    } else {
      // Personal API
      this.apiKey = args[0];
      this.baseUrl = (args[1] as string) || BASE_URL;
    }
  }

  private getAuthHeader(): string {
    if (this.apiId && this.apiSecret) {
      const token = Buffer.from(`${this.apiId}:${this.apiSecret}`).toString('base64');
      return `Basic ${token}`;
    }
    return `Bearer ${this.apiKey}`;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error');
      throw new Error(`BitRefill API error ${res.status}: ${text}`);
    }

    const json = await res.json() as any;
    return json.data ?? json;
  }

  // ─── Health ───

  async ping(): Promise<{ message: string }> {
    return this.request('/ping');
  }

  // ─── Products ───

  async getProducts(params?: {
    country?: string;
    category?: string;
    query?: string;
    limit?: number;
    page?: number;
  }): Promise<{ data: BitRefillProduct[]; meta: { _next?: string; _previous?: string } }> {
    const qs = new URLSearchParams();
    if (params?.country) qs.set('country', params.country);
    if (params?.category) qs.set('category', params.category);
    if (params?.query) qs.set('q', params.query);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.page) qs.set('page', String(params.page));

    return this.request(`/products?${qs.toString()}`);
  }

  async getProduct(id: string): Promise<BitRefillProduct> {
    return this.request(`/products/${id}`);
  }

  // ─── Invoices ───

  async createInvoice(params: CreateInvoiceParams): Promise<BitRefillInvoice> {
    return this.request('/invoices', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getInvoice(id: string): Promise<BitRefillInvoice> {
    return this.request(`/invoices/${id}`);
  }

  async payInvoice(id: string): Promise<BitRefillInvoice> {
    return this.request(`/invoices/${id}/pay`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  // ─── Orders ───

  async getOrder(id: string): Promise<BitRefillOrder> {
    return this.request(`/orders/${id}`);
  }
}
