/**
 * Bill Payment Types
 */

export type BillType = 'airtime' | 'data' | 'electricity' | 'cable';

export interface BillProvider {
  name: string;
  code: string; // VTpass / API service code
  type: BillType;
  logo?: string;
}

export interface AirtimePurchase {
  phone: string;
  amount: number;
  network: string; // mtn | airtel | glo | etisalat
}

export interface DataPurchase {
  phone: string;
  planCode: string;
  network: string;
}

export interface DataPlan {
  planCode: string;
  name: string;
  amount: number;
  validity: string;
}

export interface ElectricityPurchase {
  meterNumber: string;
  amount: number;
  disco: string; // e.g. ikeja-electric, eko-electric
  meterType: 'prepaid' | 'postpaid';
}

export interface CablePurchase {
  smartCardNumber: string;
  bouquetCode: string;
  provider: string; // dstv | gotv | startimes
}

export interface BillPaymentResult {
  success: boolean;
  reference: string;
  externalReference?: string;
  token?: string;
  units?: string;
  message: string;
  commission?: number;
  raw?: any;
}

export interface MeterValidationResult {
  valid: boolean;
  customerName?: string;
  customerAddress?: string;
  minAmount?: number;
  maxAmount?: number;
  message?: string;
}

// Nigerian networks
export const NETWORKS: BillProvider[] = [
  { name: 'MTN', code: 'mtn', type: 'airtime' },
  { name: 'Airtel', code: 'airtel', type: 'airtime' },
  { name: 'Glo', code: 'glo', type: 'airtime' },
  { name: '9mobile', code: 'etisalat', type: 'airtime' },
];

// Demo data plans (when no API key is available)
export const DEMO_DATA_PLANS: Record<string, DataPlan[]> = {
  mtn: [
    { planCode: 'mtn-100mb', name: '100MB Daily', amount: 100, validity: '1 day' },
    { planCode: 'mtn-500mb', name: '500MB Daily', amount: 150, validity: '1 day' },
    { planCode: 'mtn-1gb', name: '1GB Daily', amount: 300, validity: '1 day' },
    { planCode: 'mtn-2gb', name: '2GB Daily', amount: 500, validity: '1 day' },
    { planCode: 'mtn-3gb', name: '3GB Weekly', amount: 800, validity: '7 days' },
    { planCode: 'mtn-10gb', name: '10GB Monthly', amount: 3000, validity: '30 days' },
    { planCode: 'mtn-20gb', name: '20GB Monthly', amount: 5000, validity: '30 days' },
  ],
  airtel: [
    { planCode: 'airtel-100mb', name: '100MB Daily', amount: 100, validity: '1 day' },
    { planCode: 'airtel-500mb', name: '500MB Daily', amount: 150, validity: '1 day' },
    { planCode: 'airtel-1gb', name: '1GB Daily', amount: 350, validity: '1 day' },
    { planCode: 'airtel-3gb', name: '3GB Weekly', amount: 1000, validity: '7 days' },
    { planCode: 'airtel-10gb', name: '10GB Monthly', amount: 3000, validity: '30 days' },
    { planCode: 'airtel-20gb', name: '20GB Monthly', amount: 5500, validity: '30 days' },
  ],
  glo: [
    { planCode: 'glo-200mb', name: '200MB Daily', amount: 100, validity: '1 day' },
    { planCode: 'glo-500mb', name: '500MB Daily', amount: 150, validity: '1 day' },
    { planCode: 'glo-1gb', name: '1GB Daily', amount: 300, validity: '1 day' },
    { planCode: 'glo-2gb', name: '2GB Daily', amount: 500, validity: '1 day' },
    { planCode: 'glo-5gb', name: '5GB Weekly', amount: 1000, validity: '7 days' },
    { planCode: 'glo-10gb', name: '10GB Monthly', amount: 2500, validity: '30 days' },
    { planCode: 'glo-22gb', name: '22GB Monthly', amount: 5000, validity: '30 days' },
  ],
  etisalat: [
    { planCode: 'etisalat-100mb', name: '100MB Daily', amount: 100, validity: '1 day' },
    { planCode: 'etisalat-500mb', name: '500MB Daily', amount: 150, validity: '1 day' },
    { planCode: 'etisalat-1gb', name: '1GB Daily', amount: 350, validity: '1 day' },
    { planCode: 'etisalat-2gb', name: '2GB Daily', amount: 600, validity: '1 day' },
    { planCode: 'etisalat-5gb', name: '5GB Weekly', amount: 1200, validity: '7 days' },
    { planCode: 'etisalat-10gb', name: '10GB Monthly', amount: 3000, validity: '30 days' },
  ],
};

// Discos (electricity distribution companies)
export const DISCOS: BillProvider[] = [
  { name: 'Ikeja Electric', code: 'ikeja-electric', type: 'electricity' },
  { name: 'Eko Electric', code: 'eko-electric', type: 'electricity' },
  { name: 'Abuja Electric', code: 'abuja-electric', type: 'electricity' },
  { name: 'Ibadan Electric', code: 'ibadan-electric', type: 'electricity' },
  { name: 'Enugu Electric', code: 'enugu-electric', type: 'electricity' },
  { name: 'Port Harcourt Electric', code: 'portharcourt-electric', type: 'electricity' },
  { name: 'Kano Electric', code: 'kano-electric', type: 'electricity' },
  { name: 'Kaduna Electric', code: 'kaduna-electric', type: 'electricity' },
  { name: 'Jos Electric', code: 'jos-electric', type: 'electricity' },
  { name: 'Benin Electric', code: 'benin-electric', type: 'electricity' },
  { name: 'Yola Electric', code: 'yola-electric', type: 'electricity' },
];

// Cable TV providers
export const CABLE_PROVIDERS: BillProvider[] = [
  { name: 'DSTV', code: 'dstv', type: 'cable' },
  { name: 'GOTV', code: 'gotv', type: 'cable' },
  { name: 'Startimes', code: 'startimes', type: 'cable' },
];
