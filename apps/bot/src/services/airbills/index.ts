/**
 * AirBills Payment Service
 * Integrates AirBills (Solana-native Nigerian bill payments) into ZendPay.
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, billPayments, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { WalletService } from '@zend/solana';
import { SOLANA_TOKENS } from '@zend/shared';
import type { BillPaymentResult } from '../bills/types.js';
import { AirbillsClient } from '@zend/airbills-client';
import { decryptPrivateKey } from '../../utils/wallet.js';
import { MIN_SOL_FOR_GAS } from '../../utils/fees.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const DEV_WALLET_SECRET = process.env.ZEND_DEV_WALLET_SECRET || process.env.PV_KEY || '';
const walletService = new WalletService(SOLANA_RPC);

function generateReference(): string {
  return `ZND-AB-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function ensureGasForPayment(walletAddress: string): Promise<void> {
  const hasGas = await walletService.hasEnoughSolForGas(walletAddress, MIN_SOL_FOR_GAS);
  if (hasGas) return;
  if (!DEV_WALLET_SECRET) {
    throw new Error('Insufficient SOL for gas. Add a small amount of SOL to your wallet or contact support.');
  }
  const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
  const devBalance = await walletService.getSolBalance(devKeypair.publicKey.toBase58());
  if (devBalance < MIN_SOL_FOR_GAS * 2) {
    throw new Error('Gas station is temporarily unavailable. Please try again shortly.');
  }
  await walletService.sendSol(devKeypair, walletAddress, MIN_SOL_FOR_GAS);
  console.log('[AirBills] Funded SOL for gas:', walletAddress);
}

interface AirbillsPaymentOptions {
  userId: string;
  service: string;
  recipient: string;
  amountNgn: number;
  network?: string;
  provider?: string;
  planId?: string;
}

async function executeAirbillsPayment(
  client: AirbillsClient,
  opts: AirbillsPaymentOptions
): Promise<BillPaymentResult> {
  const { userId, service, recipient, amountNgn, network, provider, planId } = opts;

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRows.length || !userRows[0].walletEncryptedKey) {
    return { success: false, reference: '', message: 'User wallet not found.' };
  }
  const user = userRows[0];

  let order;
  try {
    const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || '';
    const webhookUrl = webhookBaseUrl ? `${webhookBaseUrl.replace(/\/$/, '')}/webhooks/airbills` : undefined;

    order = await client.createOrder({
      service,
      recipient,
      amount: amountNgn,
      currency: 'NGN',
      email: user.email || undefined,
      webhookUrl,
      network,
      provider,
      planId,
      metadata: { network, provider, source: 'zend-bot' },
    });
  } catch (err: any) {
    console.error('[AirBills] createOrder failed:', err);
    const msg = err.message?.includes('Forbidden')
      ? 'AirBills API key is invalid or expired. Contact support.'
      : (err.message || 'Could not create order');
    return { success: false, reference: '', message: msg };
  }

  const ref = generateReference();

  const usdtBalance = await walletService.getTokenBalance(user.walletAddress, SOLANA_TOKENS.USDT.mint);
  if (usdtBalance < order.amountCrypto) {
    return {
      success: false,
      reference: ref,
      message: `Insufficient USDT. You have ${usdtBalance.toFixed(2)} USDT but need ${order.amountCrypto.toFixed(4)} USDT.`,
    };
  }

  try {
    await ensureGasForPayment(user.walletAddress);
  } catch (gasErr: any) {
    return { success: false, reference: ref, message: gasErr.message };
  }

  let solanaTxHash: string | undefined;
  try {
    const secretKey = await decryptPrivateKey(user.walletEncryptedKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    solanaTxHash = await walletService.sendSplToken(
      keypair,
      order.paymentAddress,
      SOLANA_TOKENS.USDT.mint,
      order.amountCrypto,
      SOLANA_TOKENS.USDT.decimals
    );
    console.log('[AirBills] USDT sent:', solanaTxHash, 'to', order.paymentAddress);
  } catch (err: any) {
    console.error('[AirBills] Payment transfer failed:', err);
    return { success: false, reference: ref, message: `Payment failed: ${err.message || 'Could not send USDT'}` };
  }

  await db.insert(billPayments).values({
    userId,
    type: service as any,
    provider: network || provider || 'airbills',
    recipient,
    amountNgn: String(amountNgn),
    amountUsdt: String(order.amountCrypto),
    status: 'pending',
    reference: ref,
    externalReference: order.id,
    metadata: { order, solanaTxHash, network, provider },
  });

  let finalOrder = order;
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    attempts++;
    await new Promise((r) => setTimeout(r, 3000));

    try {
      finalOrder = await client.getOrder(order.id);
      console.log(`[AirBills] Poll ${attempts}: order ${order.id} status = ${finalOrder.status}`);

      if (finalOrder.status === 'completed') {
        await db.update(billPayments)
          .set({ status: 'success', token: finalOrder.token, completedAt: new Date() })
          .where(eq(billPayments.externalReference, order.id));

        return {
          success: true,
          reference: ref,
          externalReference: order.id,
          message: `₦${amountNgn.toLocaleString()} ${service} paid to ${recipient}`,
          token: finalOrder.token,
          raw: finalOrder,
        };
      }

      if (finalOrder.status === 'failed') {
        await db.update(billPayments)
          .set({ status: 'failed', metadata: finalOrder })
          .where(eq(billPayments.externalReference, order.id));

        return {
          success: false,
          reference: ref,
          message: 'AirBills could not fulfil the order. Contact support for a refund.',
          raw: finalOrder,
        };
      }
    } catch (err: any) {
      console.error('[AirBills] Poll error:', err.message);
    }
  }

  return {
    success: true,
    reference: ref,
    externalReference: order.id,
    message: `Payment sent. Your ${service} order is processing — you'll be notified when complete.`,
    raw: finalOrder,
  };
}

export async function purchaseAirtime(
  client: AirbillsClient,
  userId: string,
  phone: string,
  amountNgn: number,
  network: string
): Promise<BillPaymentResult> {
  return executeAirbillsPayment(client, {
    userId,
    service: 'airtime',
    recipient: phone,
    amountNgn,
    network,
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
  return executeAirbillsPayment(client, {
    userId,
    service: 'data',
    recipient: phone,
    amountNgn,
    network,
    planId,
  });
}

export async function purchaseElectricity(
  client: AirbillsClient,
  userId: string,
  meterNumber: string,
  amountNgn: number,
  disco: string
): Promise<BillPaymentResult> {
  return executeAirbillsPayment(client, {
    userId,
    service: 'electricity',
    recipient: meterNumber,
    amountNgn,
    provider: disco,
  });
}

export async function purchaseCable(
  client: AirbillsClient,
  userId: string,
  smartCardNumber: string,
  amountNgn: number,
  provider: string
): Promise<BillPaymentResult> {
  return executeAirbillsPayment(client, {
    userId,
    service: 'cable',
    recipient: smartCardNumber,
    amountNgn,
    provider,
  });
}

/** Startup health check */
export async function checkAirbillsHealth(client: AirbillsClient): Promise<boolean> {
  try {
    await client.ping();
    return true;
  } catch (err: any) {
    console.warn('[AirBills] Health check failed:', err.message);
    return false;
  }
}