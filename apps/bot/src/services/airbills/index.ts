/**
 * AirBills Payment Service
 * Integrates AirBills business gateway (Solana-native Nigerian bill payments) into ZendPay.
 * Docs: https://developer.airbills.org
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, billPayments, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { WalletService } from '@zend/solana';
import { SOLANA_TOKENS } from '@zend/shared';
import type { BillPaymentResult } from '../bills/types.js';
import {
  AirbillsClient,
  type AirbillsCablePackage,
  type AirbillsElectProvider,
} from '@zend/airbills-client';
import { decryptPrivateKey } from '../../utils/wallet.js';
import { fundSolIfNeeded, gasFundingErrorToUserMessage } from '../gas.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const walletService = new WalletService(SOLANA_RPC);

/** AirBills recommended default mode — sign their pre-built Solana tx. Set transfer to revert. */
function getAirbillsPayWith(): 'default' | 'transfer' {
  const mode = process.env.AIRBILLS_PAY_WITH?.trim().toLowerCase();
  return mode === 'transfer' ? 'transfer' : 'default';
}

function generateReference(): string {
  return `ZND-AB-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function networkCodeToId(network: string): string | undefined {
  const map: Record<string, string> = {
    mtn: '01',
    glo: '02',
    etisalat: '03',
    airtel: '04',
  };
  return map[network.toLowerCase()];
}

async function ensureGasForPayment(
  walletAddress: string,
  userId: string,
  paymentAddress?: string
): Promise<void> {
  const funding = await fundSolIfNeeded(
    walletAddress,
    paymentAddress,
    paymentAddress ? SOLANA_TOKENS.USDT.mint : undefined,
    undefined,
    userId
  );
  if (!funding.error) return;
  if (funding.error.includes('Dev wallet not configured')) {
    throw new Error('Insufficient SOL for gas. Add a small amount of SOL to your wallet or contact support.');
  }
  throw new Error(gasFundingErrorToUserMessage(funding.error, funding.shortfall));
}

async function findElectId(client: AirbillsClient, provider: string): Promise<string | undefined> {
  // Common hardcoded fallback mapping
  const fallback: Record<string, string> = {
    'ikeja-electric': 'IKEDC',
    'eko-electric': 'EKEDC',
    'abuja-electric': 'AEDC',
    'ibadan-electric': 'IBEDC',
    'enugu-electric': 'EEDC',
    'portharcourt-electric': 'PHEDC',
    'kano-electric': 'KEDCO',
    'kaduna-electric': 'KAEDCO',
    'jos-electric': 'JEDC',
    'benin-electric': 'BEDC',
    'yola-electric': 'YEDC',
  };
  const normalized = provider.toLowerCase();
  if (fallback[normalized]) return fallback[normalized];

  try {
    const providers = await client.listElectricity();
    const match = providers.find(
      (p) =>
        p.electId.toLowerCase() === normalized ||
        p.name.toLowerCase().includes(normalized.replace(/-/g, ' ')) ||
        normalized.includes(p.name.toLowerCase().split(' ')[0])
    );
    return match?.electId;
  } catch {
    return fallback[normalized];
  }
}

async function findCablePackage(
  client: AirbillsClient,
  provider: string,
  amountNgn?: number
): Promise<AirbillsCablePackage | undefined> {
  try {
    const packages = await client.listCable();
    const normalized = provider.toLowerCase();
    const byProvider = packages.filter(
      (p) => p.provider.toLowerCase() === normalized || normalized.includes(p.provider.toLowerCase())
    );
    if (byProvider.length === 0) return undefined;
    if (amountNgn) {
      const exact = byProvider.find((p) => p.prodAmount === amountNgn);
      if (exact) return exact;
    }
    return byProvider[0];
  } catch {
    return undefined;
  }
}

interface AirbillsPaymentOptions {
  userId: string;
  productCode: string;
  amountNgn: number;
  data: {
    phoneNumber?: string;
    networkId?: string;
    prodId?: string;
    meterNo?: string;
    electId?: string;
    smartCardNo?: string;
    customerId?: string;
  };
}

async function executeAirbillsPayment(
  client: AirbillsClient,
  opts: AirbillsPaymentOptions
): Promise<BillPaymentResult> {
  const { userId, productCode, amountNgn, data } = opts;

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRows.length || !userRows[0].walletEncryptedKey) {
    return { success: false, reference: '', message: 'User wallet not found.' };
  }
  const user = userRows[0];

  let transaction;
  try {
    const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || '';
    const callbackUrl = webhookBaseUrl ? `${webhookBaseUrl.replace(/\/$/, '')}/webhooks/airbills` : undefined;

    const payWith = getAirbillsPayWith();
    transaction = await client.createTransaction({
      productCode,
      payWith,
      callbackUrl,
      data: {
        ...data,
        pubKey: user.walletAddress,
        token: 'USDT',
        amount: amountNgn,
      },
    });
    console.log(`[AirBills] createTransaction id=${transaction.id} payWith=${payWith}`);
  } catch (err: any) {
    console.error('[AirBills] createTransaction failed:', err);
    const msg = err.message?.includes('status 03')
      ? 'AirBills API key is invalid or missing. Contact support.'
      : err.message?.includes('status 04')
      ? 'AirBills request is invalid. Please check the details and try again.'
      : (err.message || 'Could not create AirBills transaction');
    return { success: false, reference: '', message: msg };
  }

  const ref = generateReference();

  const usdtBalance = await walletService.getTokenBalance(user.walletAddress, SOLANA_TOKENS.USDT.mint);
  if (usdtBalance < transaction.amountInToken) {
    return {
      success: false,
      reference: ref,
      message: `Insufficient USDT. You have ${usdtBalance.toFixed(2)} USDT but need ${transaction.amountInToken.toFixed(4)} USDT.`,
    };
  }

  const payWith = transaction.payWith || getAirbillsPayWith();

  try {
    await ensureGasForPayment(
      user.walletAddress,
      userId,
      payWith === 'transfer' ? transaction.wallet : undefined
    );
  } catch (gasErr: any) {
    return { success: false, reference: ref, message: gasErr.message };
  }

  let solanaTxHash: string | undefined;
  try {
    const secretKey = await decryptPrivateKey(user.walletEncryptedKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    if (payWith === 'default') {
      if (!transaction.transactionIx) {
        return {
          success: false,
          reference: ref,
          message: 'AirBills did not return a payment transaction. Please try again.',
        };
      }
      solanaTxHash = await walletService.signAndSendSerialized(keypair, transaction.transactionIx);
      console.log('[AirBills] Signed default-mode tx:', solanaTxHash);
    } else {
      if (!transaction.wallet) {
        return {
          success: false,
          reference: ref,
          message: 'AirBills did not return a deposit wallet. Please try again.',
        };
      }
      solanaTxHash = await walletService.sendSplToken(
        keypair,
        transaction.wallet,
        SOLANA_TOKENS.USDT.mint,
        transaction.amountInToken,
        SOLANA_TOKENS.USDT.decimals
      );
      console.log('[AirBills] USDT sent (transfer mode):', solanaTxHash, 'to', transaction.wallet);
    }
  } catch (err: any) {
    console.error('[AirBills] On-chain payment failed:', err);
    return { success: false, reference: ref, message: `Payment failed: ${err.message || 'Could not complete payment'}` };
  }

  await db.insert(billPayments).values({
    userId,
    type: productCodeToType(productCode),
    provider: data.networkId || data.electId || data.prodId || 'airbills',
    recipient: data.phoneNumber || data.meterNo || data.smartCardNo || '',
    amountNgn: String(amountNgn),
    amountUsdt: String(transaction.amountInToken),
    status: 'pending',
    reference: ref,
    externalReference: transaction.id,
    metadata: { transaction, solanaTxHash, ...data },
  });

  // Notify AirBills to fulfill the bill (retry — on-chain confirm can lag a few seconds)
  try {
    const processResult = await processWithRetries(client, productCode, transaction.id);
    const fulfillment = interpretProcessResult(processResult);

    if (fulfillment.outcome === 'success') {
      await db.update(billPayments)
        .set({
          status: 'success',
          token: fulfillment.token as string | undefined,
          completedAt: new Date(),
          metadata: { transaction, solanaTxHash, processResult },
        })
        .where(eq(billPayments.externalReference, transaction.id));

      return {
        success: true,
        reference: ref,
        externalReference: transaction.id,
        message: `₦${amountNgn.toLocaleString()} ${productCodeToLabel(productCode)} paid` +
          (fulfillment.token ? '' : ' successfully'),
        token: fulfillment.token as string | undefined,
        raw: processResult,
      };
    }

    if (fulfillment.outcome === 'pending') {
      console.log('[AirBills] processTransaction pending — awaiting webhook:', transaction.id);
      return {
        success: true,
        reference: ref,
        externalReference: transaction.id,
        message: `Payment sent. Your ${productCodeToLabel(productCode)} order is processing — you'll be notified when complete.`,
        raw: processResult,
      };
    }

    console.error('[AirBills] processTransaction failed:', processResult);
    await db.update(billPayments)
      .set({ status: 'failed', metadata: processResult })
      .where(eq(billPayments.externalReference, transaction.id));

    return {
      success: false,
      reference: ref,
      externalReference: transaction.id,
      message: processResult.message || 'AirBills could not fulfil the order. Contact support for a refund.',
      raw: processResult,
    };
  } catch (err: any) {
    console.error('[AirBills] processTransaction error:', err);
    // USDT already sent — leave pending and let webhook/callback update
    return {
      success: true,
      reference: ref,
      externalReference: transaction.id,
      message: `Payment sent. Your ${productCodeToLabel(productCode)} order is processing — you'll be notified when complete.`,
      raw: transaction,
    };
  }
}

function normalizeTxnStatus(status: unknown): string {
  return String(status || '').toLowerCase();
}

function extractToken(data?: Record<string, unknown>): string | undefined {
  if (!data) return undefined;
  const token = data.token ?? data.meterToken ?? data.pin ?? data.voucher;
  return token != null ? String(token) : undefined;
}

function interpretProcessResult(result: { status: string; message: string; data?: Record<string, unknown> }): {
  outcome: 'success' | 'pending' | 'failed';
  token?: string;
} {
  const apiStatus = result.status;
  const txnStatus = normalizeTxnStatus(result.data?.status);

  if (apiStatus === '00' || apiStatus === '06') {
    if (txnStatus === 'failed') {
      return { outcome: 'failed' };
    }
    if (txnStatus === 'successful' || txnStatus === 'success' || txnStatus === 'completed') {
      return { outcome: 'success', token: extractToken(result.data) };
    }
    // API accepted — bill may still be fulfilling async
    return { outcome: 'pending', token: extractToken(result.data) };
  }

  return { outcome: 'failed' };
}

async function processWithRetries(
  client: AirbillsClient,
  productCode: string,
  transactionId: string,
  maxAttempts = 5
) {
  let lastResult: Awaited<ReturnType<AirbillsClient['processTransaction']>> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.processTransaction({ productCode, id: transactionId });
    lastResult = result;
    const fulfillment = interpretProcessResult(result);
    console.log(
      `[AirBills] process attempt ${attempt}/${maxAttempts}: api=${result.status} txn=${result.data?.status ?? 'n/a'}`
    );

    if (shouldStopProcessRetries(result)) {
      return result;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return lastResult!;
}

function shouldStopProcessRetries(result: { status: string; message: string; data?: Record<string, unknown> }): boolean {
  const fulfillment = interpretProcessResult(result);
  if (fulfillment.outcome === 'success' || fulfillment.outcome === 'failed') return true;
  // Auth/validation errors won't resolve with retries
  if (result.status === '03' || result.status === '04') return true;
  return false;
}

function productCodeToType(code: string): string {
  switch (code) {
    case '100': return 'airtime';
    case '101': return 'electricity';
    case '102': return 'data';
    case '104': return 'cable';
    default: return 'bill';
  }
}

function productCodeToLabel(code: string): string {
  switch (code) {
    case '100': return 'airtime';
    case '101': return 'electricity';
    case '102': return 'data';
    case '104': return 'cable TV';
    default: return 'bill';
  }
}

export async function purchaseAirtime(
  client: AirbillsClient,
  userId: string,
  phone: string,
  amountNgn: number,
  network: string
): Promise<BillPaymentResult> {
  const networkId = networkCodeToId(network);
  if (!networkId) {
    return { success: false, reference: '', message: `Unsupported network: ${network}` };
  }
  return executeAirbillsPayment(client, {
    userId,
    productCode: '100',
    amountNgn,
    data: { phoneNumber: phone, networkId },
  });
}

export async function purchaseData(
  client: AirbillsClient,
  userId: string,
  phone: string,
  amountNgn: number,
  network: string,
  planId?: string
): Promise<BillPaymentResult> {
  const networkId = networkCodeToId(network);
  if (!networkId) {
    return { success: false, reference: '', message: `Unsupported network: ${network}` };
  }
  if (!planId) {
    return { success: false, reference: '', message: 'Data plan ID is required.' };
  }
  return executeAirbillsPayment(client, {
    userId,
    productCode: '102',
    amountNgn,
    data: { phoneNumber: phone, networkId, prodId: planId },
  });
}

export async function purchaseElectricity(
  client: AirbillsClient,
  userId: string,
  meterNumber: string,
  amountNgn: number,
  disco: string,
  meterType: 'prepaid' | 'postpaid' = 'prepaid'
): Promise<BillPaymentResult> {
  if (amountNgn < 2000) {
    return { success: false, reference: '', message: 'Minimum electricity amount is ₦2,000.' };
  }
  const electId = await findElectId(client, disco);
  if (!electId) {
    return { success: false, reference: '', message: `Could not map electricity provider: ${disco}` };
  }

  try {
    const validation = await client.validateMeter({ meterNo: meterNumber, electId });
    if (!validation.valid) {
      return { success: false, reference: '', message: 'Meter number could not be validated for this provider.' };
    }
  } catch (err: any) {
    console.warn('[AirBills] Meter validation failed:', err.message);
    // Continue anyway; provider may still accept
  }

  return executeAirbillsPayment(client, {
    userId,
    productCode: '101',
    amountNgn,
    data: { meterNo: meterNumber, electId, prodId: meterType },
  });
}

export async function purchaseCable(
  client: AirbillsClient,
  userId: string,
  smartCardNumber: string,
  amountNgn: number,
  provider: string,
  planId?: string
): Promise<BillPaymentResult> {
  let prodId = planId;
  if (!prodId) {
    const pkg = await findCablePackage(client, provider, amountNgn);
    if (!pkg) {
      return { success: false, reference: '', message: `Could not find a cable package for ${provider}.` };
    }
    prodId = pkg.prodId;
    amountNgn = pkg.prodAmount;
  }

  return executeAirbillsPayment(client, {
    userId,
    productCode: '104',
    amountNgn,
    data: { smartCardNo: smartCardNumber, prodId },
  });
}

/** Startup health check */
export async function checkAirbillsHealth(client: AirbillsClient): Promise<boolean> {
  try {
    await client.listInternet();
    return true;
  } catch (err: any) {
    console.warn('[AirBills] Health check failed:', err.message);
    return false;
  }
}
