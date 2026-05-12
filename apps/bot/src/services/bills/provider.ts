/**
 * VTpass Bill Payment Provider
 * Supports airtime, data, electricity, and cable TV.
 * Falls back to demo mode when no API key is configured.
 */

import {
  type AirtimePurchase,
  type DataPurchase,
  type ElectricityPurchase,
  type CablePurchase,
  type BillPaymentResult,
  type MeterValidationResult,
  type DataPlan,
  DEMO_DATA_PLANS,
} from './types.js';

const API_KEY = process.env.VTPASS_API_KEY;
const API_URL = process.env.VTPASS_API_URL || 'https://sandbox.vtpass.com/api';
const IS_DEMO = !API_KEY;

function generateReference(): string {
  return `ZND-BILL-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function vtpassRequest(endpoint: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${Buffer.from(`${API_KEY}:${API_KEY}`).toString('base64')}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VTpass HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── DEMO MODE ───

function demoAirtime(purchase: AirtimePurchase): BillPaymentResult {
  return {
    success: true,
    reference: generateReference(),
    externalReference: `DEMO-${Date.now()}`,
    message: `₦${purchase.amount} ${purchase.network.toUpperCase()} airtime sent to ${purchase.phone}`,
    commission: Math.round(purchase.amount * 0.02),
  };
}

function demoData(purchase: DataPurchase): BillPaymentResult {
  return {
    success: true,
    reference: generateReference(),
    externalReference: `DEMO-${Date.now()}`,
    message: `${purchase.network.toUpperCase()} data plan activated for ${purchase.phone}`,
    commission: 50,
  };
}

function demoElectricity(purchase: ElectricityPurchase): BillPaymentResult {
  return {
    success: true,
    reference: generateReference(),
    externalReference: `DEMO-${Date.now()}`,
    token: `${Math.floor(Math.random() * 9000000000) + 1000000000}`,
    units: `${(purchase.amount / 60).toFixed(2)} kWh`,
    message: `₦${purchase.amount} ${purchase.disco} ${purchase.meterType} token purchased for ${purchase.meterNumber}`,
    commission: Math.round(purchase.amount * 0.03),
  };
}

function demoCable(purchase: CablePurchase): BillPaymentResult {
  return {
    success: true,
    reference: generateReference(),
    externalReference: `DEMO-${Date.now()}`,
    message: `${purchase.provider.toUpperCase()} subscription renewed for ${purchase.smartCardNumber}`,
    commission: 100,
  };
}

// ─── REAL API CALLS ───

async function realAirtime(purchase: AirtimePurchase): Promise<BillPaymentResult> {
  const res = await vtpassRequest('/pay', {
    request_id: generateReference(),
    serviceID: purchase.network,
    amount: purchase.amount,
    phone: purchase.phone,
  });

  return {
    success: res.code === '000',
    reference: res.requestId,
    externalReference: res.transactionId,
    message: res.response_description || 'Airtime purchase completed',
    commission: res.amount ? Math.round(Number(res.amount) * 0.02) : undefined,
    raw: res,
  };
}

async function realData(purchase: DataPurchase): Promise<BillPaymentResult> {
  const res = await vtpassRequest('/pay', {
    request_id: generateReference(),
    serviceID: purchase.network,
    variation_code: purchase.planCode,
    phone: purchase.phone,
    billersCode: purchase.phone,
    amount: 0, // amount is determined by plan
    subscription_type: 'VTU',
  });

  return {
    success: res.code === '000',
    reference: res.requestId,
    externalReference: res.transactionId,
    message: res.response_description || 'Data purchase completed',
    commission: res.amount ? Math.round(Number(res.amount) * 0.02) : undefined,
    raw: res,
  };
}

async function realElectricity(purchase: ElectricityPurchase): Promise<BillPaymentResult> {
  const res = await vtpassRequest('/pay', {
    request_id: generateReference(),
    serviceID: purchase.disco,
    amount: purchase.amount,
    phone: purchase.meterNumber, // required field
    billersCode: purchase.meterNumber,
    variation_code: purchase.meterType,
  });

  return {
    success: res.code === '000',
    reference: res.requestId,
    externalReference: res.transactionId,
    token: res.token,
    units: res.units,
    message: res.response_description || 'Electricity token purchased',
    commission: res.amount ? Math.round(Number(res.amount) * 0.03) : undefined,
    raw: res,
  };
}

async function realCable(purchase: CablePurchase): Promise<BillPaymentResult> {
  const res = await vtpassRequest('/pay', {
    request_id: generateReference(),
    serviceID: purchase.provider,
    variation_code: purchase.bouquetCode,
    billersCode: purchase.smartCardNumber,
    phone: purchase.smartCardNumber,
    subscription_type: 'CHANGE', // or 'RENEWAL'
  });

  return {
    success: res.code === '000',
    reference: res.requestId,
    externalReference: res.transactionId,
    message: res.response_description || 'Cable subscription completed',
    commission: res.amount ? Math.round(Number(res.amount) * 0.02) : undefined,
    raw: res,
  };
}

// ─── PUBLIC API ───

export async function purchaseAirtime(purchase: AirtimePurchase): Promise<BillPaymentResult> {
  if (IS_DEMO) return demoAirtime(purchase);
  return realAirtime(purchase);
}

export async function purchaseData(purchase: DataPurchase): Promise<BillPaymentResult> {
  if (IS_DEMO) return demoData(purchase);
  return realData(purchase);
}

export async function purchaseElectricity(purchase: ElectricityPurchase): Promise<BillPaymentResult> {
  if (IS_DEMO) return demoElectricity(purchase);
  return realElectricity(purchase);
}

export async function purchaseCable(purchase: CablePurchase): Promise<BillPaymentResult> {
  if (IS_DEMO) return demoCable(purchase);
  return realCable(purchase);
}

export async function getDataPlans(network: string): Promise<DataPlan[]> {
  if (IS_DEMO) {
    return DEMO_DATA_PLANS[network] || [];
  }

  const res = await fetch(`${API_URL}/service-variations?serviceID=${network}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${API_KEY}:${API_KEY}`).toString('base64')}` },
  });

  if (!res.ok) throw new Error('Failed to fetch data plans');
  const data = await res.json() as any;

  return (data.content?.varations || []).map((v: any) => ({
    planCode: v.variation_code,
    name: v.name,
    amount: Number(v.variation_amount),
    validity: v.validity || '',
  }));
}

export async function validateMeter(
  disco: string,
  meterNumber: string,
  meterType: 'prepaid' | 'postpaid'
): Promise<MeterValidationResult> {
  if (IS_DEMO) {
    return {
      valid: true,
      customerName: 'John Doe',
      customerAddress: '123 Lagos Street, Nigeria',
      minAmount: 500,
      maxAmount: 500000,
    };
  }

  const res = await vtpassRequest('/merchant-verify', {
    serviceID: disco,
    billersCode: meterNumber,
    type: meterType,
  });

  return {
    valid: res.code === '000',
    customerName: res.content?.Customer_Name,
    customerAddress: res.content?.Address,
    minAmount: res.content?.MinimumAmount,
    maxAmount: res.content?.MaximumAmount,
    message: res.response_description,
  };
}

export async function validateSmartCard(
  provider: string,
  smartCardNumber: string
): Promise<{ valid: boolean; customerName?: string; currentBouquet?: string; message?: string }> {
  if (IS_DEMO) {
    return {
      valid: true,
      customerName: 'Jane Doe',
      currentBouquet: 'Compact',
    };
  }

  const res = await vtpassRequest('/merchant-verify', {
    serviceID: provider,
    billersCode: smartCardNumber,
  });

  return {
    valid: res.code === '000',
    customerName: res.content?.Customer_Name,
    currentBouquet: res.content?.CurrentBouquet,
    message: res.response_description,
  };
}

export function isDemoMode(): boolean {
  return IS_DEMO;
}
