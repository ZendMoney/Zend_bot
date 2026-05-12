/**
 * Bill Payment Service
 * Orchestrates bill purchases: validates input, deducts balance, calls provider, saves to DB.
 */

import { db, billPayments } from '@zend/db';
import { eq } from 'drizzle-orm';
import {
  purchaseAirtime,
  purchaseData,
  purchaseElectricity,
  purchaseCable,
  getDataPlans,
  validateMeter,
  validateSmartCard,
  isDemoMode,
} from './provider.js';
import {
  type AirtimePurchase,
  type DataPurchase,
  type ElectricityPurchase,
  type CablePurchase,
  type BillPaymentResult,
  type DataPlan,
  type MeterValidationResult,
  NETWORKS,
  DISCOS,
  CABLE_PROVIDERS,
} from './types.js';

export { NETWORKS, DISCOS, CABLE_PROVIDERS, getDataPlans, validateMeter, validateSmartCard, isDemoMode };
export type { DataPlan, MeterValidationResult, BillPaymentResult };

/**
 * Get user's USDT balance (simplified — reads from DB or on-chain).
 * For now, returns a mock balance. Replace with real wallet query.
 */
export async function getUserUsdtBalance(userId: string): Promise<number> {
  // TODO: Replace with actual on-chain balance query
  // For demo, return a high balance so purchases work
  return 1000;
}

/**
 * Convert NGN amount to USDT using PAJ rate.
 */
export async function ngnToUsdt(ngnAmount: number): Promise<number> {
  const rate = 1400; // TODO: Use live PAJ rate
  return ngnAmount / rate;
}

/**
 * Deduct USDT from user balance.
 * Returns true if successful.
 */
export async function deductUsdt(userId: string, usdtAmount: number): Promise<boolean> {
  // TODO: Replace with actual on-chain transfer or balance update
  console.log(`[Bills] Deducted ${usdtAmount.toFixed(4)} USDT from user ${userId}`);
  return true;
}

// ─── Purchase Orchestration ───

export async function buyAirtime(
  userId: string,
  purchase: AirtimePurchase
): Promise<BillPaymentResult> {
  const usdtAmount = await ngnToUsdt(purchase.amount);
  const balance = await getUserUsdtBalance(userId);

  if (balance < usdtAmount) {
    return { success: false, reference: '', message: 'Insufficient USDT balance. Add Naira first.' };
  }

  const result = await purchaseAirtime(purchase);

  await db.insert(billPayments).values({
    userId,
    type: 'airtime',
    provider: purchase.network,
    recipient: purchase.phone,
    amountNgn: purchase.amount.toString(),
    amountUsdt: usdtAmount.toFixed(9),
    status: result.success ? 'success' : 'failed',
    reference: result.reference,
    externalReference: result.externalReference,
    commissionNgn: result.commission?.toString(),
    metadata: result.raw || { demo: isDemoMode(), phone: purchase.phone },
    completedAt: result.success ? new Date() : undefined,
  });

  if (result.success) {
    await deductUsdt(userId, usdtAmount);
  }

  return result;
}

export async function buyData(
  userId: string,
  purchase: DataPurchase,
  planAmount: number
): Promise<BillPaymentResult> {
  const usdtAmount = await ngnToUsdt(planAmount);
  const balance = await getUserUsdtBalance(userId);

  if (balance < usdtAmount) {
    return { success: false, reference: '', message: 'Insufficient USDT balance. Add Naira first.' };
  }

  const result = await purchaseData(purchase);

  await db.insert(billPayments).values({
    userId,
    type: 'data',
    provider: purchase.network,
    recipient: purchase.phone,
    amountNgn: planAmount.toString(),
    amountUsdt: usdtAmount.toFixed(9),
    status: result.success ? 'success' : 'failed',
    reference: result.reference,
    externalReference: result.externalReference,
    commissionNgn: result.commission?.toString(),
    metadata: result.raw || { demo: isDemoMode(), phone: purchase.phone, plan: purchase.planCode },
    completedAt: result.success ? new Date() : undefined,
  });

  if (result.success) {
    await deductUsdt(userId, usdtAmount);
  }

  return result;
}

export async function buyElectricity(
  userId: string,
  purchase: ElectricityPurchase
): Promise<BillPaymentResult> {
  const usdtAmount = await ngnToUsdt(purchase.amount);
  const balance = await getUserUsdtBalance(userId);

  if (balance < usdtAmount) {
    return { success: false, reference: '', message: 'Insufficient USDT balance. Add Naira first.' };
  }

  const result = await purchaseElectricity(purchase);

  await db.insert(billPayments).values({
    userId,
    type: 'electricity',
    provider: purchase.disco,
    recipient: purchase.meterNumber,
    amountNgn: purchase.amount.toString(),
    amountUsdt: usdtAmount.toFixed(9),
    status: result.success ? 'success' : 'failed',
    reference: result.reference,
    externalReference: result.externalReference,
    token: result.token,
    commissionNgn: result.commission?.toString(),
    metadata: result.raw || { demo: isDemoMode(), meter: purchase.meterNumber, type: purchase.meterType },
    completedAt: result.success ? new Date() : undefined,
  });

  if (result.success) {
    await deductUsdt(userId, usdtAmount);
  }

  return result;
}

export async function buyCable(
  userId: string,
  purchase: CablePurchase,
  bouquetAmount: number
): Promise<BillPaymentResult> {
  const usdtAmount = await ngnToUsdt(bouquetAmount);
  const balance = await getUserUsdtBalance(userId);

  if (balance < usdtAmount) {
    return { success: false, reference: '', message: 'Insufficient USDT balance. Add Naira first.' };
  }

  const result = await purchaseCable(purchase);

  await db.insert(billPayments).values({
    userId,
    type: 'cable',
    provider: purchase.provider,
    recipient: purchase.smartCardNumber,
    amountNgn: bouquetAmount.toString(),
    amountUsdt: usdtAmount.toFixed(9),
    status: result.success ? 'success' : 'failed',
    reference: result.reference,
    externalReference: result.externalReference,
    commissionNgn: result.commission?.toString(),
    metadata: result.raw || { demo: isDemoMode(), smartCard: purchase.smartCardNumber, bouquet: purchase.bouquetCode },
    completedAt: result.success ? new Date() : undefined,
  });

  if (result.success) {
    await deductUsdt(userId, usdtAmount);
  }

  return result;
}
