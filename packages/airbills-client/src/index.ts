// ─── AirBills Business Gateway API Client ───
// Docs: https://developer.airbills.org
// Base path: /api/vendor/gateway

const DEFAULT_BASE_URL = 'https://api.airbills.org/api/vendor/gateway';

export interface AirbillsTransaction {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  productCode: string;
  payWith: 'default' | 'transfer';
  token: string;
  tokenMint: string;
  amountInToken: number;
  wallet?: string;
  transactionIx?: string;
}

export interface AirbillsDataPlan {
  prodId: string;
  prodAmount: number;
  description: string;
  networkId: string;
}

export interface AirbillsCablePackage {
  prodId: string;
  prodAmount: number;
  description: string;
  provider: string;
}

export interface AirbillsElectProvider {
  electId: string;
  name: string;
}

export interface AirbillsNetworkCheck {
  network: string;
  networkId: string;
}

export interface CreateTransactionData {
  pubKey: string;
  token: 'USDT' | 'USDC';
  amount: number;
  phoneNumber?: string;
  networkId?: string;
  prodId?: string;
  meterNo?: string;
  electId?: string;
  smartCardNo?: string;
  customerId?: string;
}

export interface CreateTransactionParams {
  productCode: string;
  payWith?: 'default' | 'transfer';
  callbackUrl?: string;
  data: CreateTransactionData;
}

export interface ProcessTransactionParams {
  productCode: string;
  id: string;
}

export interface ValidateMeterParams {
  meterNo: string;
  electId: string;
}

interface AirbillsApiResponse<T> {
  status: string;
  message: string;
  data: T | null;
}

export class AirbillsClient {
  private secretKey: string;
  private baseUrl: string;

  constructor(secretKey: string, baseUrl?: string) {
    this.secretKey = secretKey.trim();
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        secretkey: this.secretKey,
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

    if (parsed && typeof parsed === 'object' && 'status' in parsed && 'message' in parsed) {
      const wrapped = parsed as AirbillsApiResponse<T>;
      const ok = wrapped.status === '00' || wrapped.status === '0' || wrapped.status === 'success' || wrapped.status === '06';
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

  async createTransaction(params: CreateTransactionParams): Promise<AirbillsTransaction> {
    return this.request<AirbillsTransaction>('/transact', {
      method: 'POST',
      body: JSON.stringify({
        productCode: params.productCode,
        payWith: params.payWith || 'transfer',
        callbackUrl: params.callbackUrl,
        data: params.data,
      }),
    });
  }

  async processTransaction(params: ProcessTransactionParams): Promise<{ status: string; message: string; data?: any }> {
    return this.request<{ status: string; message: string; data?: any }>('/transact/process', {
      method: 'POST',
      body: JSON.stringify({
        productCode: params.productCode,
        id: params.id,
      }),
    });
  }

  async listInternet(): Promise<AirbillsDataPlan[]> {
    return this.request<AirbillsDataPlan[]>('/list/internet');
  }

  async listCable(): Promise<AirbillsCablePackage[]> {
    return this.request<AirbillsCablePackage[]>('/list/cable');
  }

  async listElectricity(): Promise<AirbillsElectProvider[]> {
    return this.request<AirbillsElectProvider[]>('/list/elect');
  }

  async validateMeter(params: ValidateMeterParams): Promise<{ valid: boolean; name?: string }> {
    const data = await this.request<{ name?: string; customerName?: string }>('/validate/elect', {
      method: 'POST',
      body: JSON.stringify({ meterNo: params.meterNo, electId: params.electId }),
    });
    return { valid: true, name: data.name || data.customerName };
  }

  async checkNetwork(phone: string): Promise<AirbillsNetworkCheck> {
    return this.request<AirbillsNetworkCheck>(`/network-checker?${new URLSearchParams({ phone }).toString()}`);
  }

  /** Health check — calls list endpoint to verify auth */
  async ping(): Promise<{ status: string }> {
    await this.listInternet();
    return { status: 'ok' };
  }
}
