/**
 * AirBills Payment Service
 * Integrates AirBills (Solana-native Nigerian bill payments) into Zend.
 *
 * Flow:
 * 1. Create AirBills order (recipient, amount, service)
 * 2. Check user USDT balance
 * 3. Send USDT from user wallet → AirBills payment address
 * 4. Poll AirBills until complete/failed
 * 5. Save record + return result
 */

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, billPayments, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { WalletService } from '@zend/solana';
import { SOLANA_TOKENS } from '@zend/shared';
import type { BillPaymentResult } from '../bills/types.js';
import { AirbillsClient } from '@zend/airbills-client';
import { decryptPrivateKey } from '../../utils/wallet.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const walletService = new WalletService(SOLANA_RPC);

function generateReference(): string {
  return `ZND-AB-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

interface AirbillsPaymentOptions {
  userId: string;
  service: string;
  recipient: string;
  amountNgn: number;
  metadata?: Record<string, any>;
}

/**
 * Core payment flow — used by all bill types.
 */
async function executeAirbillsPayment(
  client: AirbillsClient,
  opts: AirbillsPaymentOptions
): Promise<BillPaymentResult> {
  const { userId, service, recipient, amountNgn, metadata } = opts;

  // 1. Fetch user
  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRows.length || !userRows[0].walletEncryptedKey) {
    return { success: false, reference: '', message: 'User wallet not found.' };
  }
  const user = userRows[0];

  // 2. Create AirBills order
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
    });
  } catch (err: any) {
    console.error('[AirBills] createOrder failed:', err);
    return { success: false, reference: '', message: `AirBills error: ${err.message || 'Could not create order'}` };
  }

  const ref = generateReference();

  // 3. Check USDT balance
  const usdtBalance = await walletService.getTokenBalance(user.walletAddress, SOLANA_TOKENS.USDT.mint);
  if (usdtBalance < order.amountCrypto) {
    return {
      success: false,
      reference: ref,
      message: `Insufficient USDT balance. You have ${usdtBalance.toFixed(2)} USDT but need ${order.amountCrypto.toFixed(4)} USDT.`,
    };
  }

  // 4. Send USDT to AirBills payment address
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

  // 5. Save pending record
  await db.insert(billPayments).values({
    userId,
    type: service as any,
    provider: 'airbills',
    recipient,
    amountNgn: String(amountNgn),
    amountUsdt: String(order.amountCrypto),
    status: 'pending',
    reference: ref,
    externalReference: order.id,
    metadata: { order, solanaTxHash },
  });

  // 6. Poll for completion
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
          message: 'AirBills could not fulfil the order. Your USDT will be refunded.',
          raw: finalOrder,
        };
      }
    } catch (err: any) {
      console.error('[AirBills] Poll error:', err.message);
    }
  }

  // Timeout — still pending, webhook will handle completion
  return {
    success: true,
    reference: ref,
    externalReference: order.id,
    message: `Payment sent. Your ${service} order is processing and will be delivered shortly.`,
    raw: finalOrder,
  };
}

// ─── Public API ───

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
    metadata: { network },
  });
}

export async function purchaseData(
  client: AirbillsClient,
  userId: string,
  phone: string,
  amountNgn: number,
  network: string
): Promise<BillPaymentResult> {
  return executeAirbillsPayment(client, {
    userId,
    service: 'data',
    recipient: phone,
    amountNgn,
    metadata: { network },
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
    metadata: { disco },
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
    metadata: { provider },
  });
}
