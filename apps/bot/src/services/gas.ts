import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, transactions } from '@zend/db';
import { eq, and, sql } from 'drizzle-orm';
import { DEV_WALLET_SECRET, walletService } from '../deps.js';
import {
  calculateSendFee as calcSendFee,
  MIN_SOL_FOR_GAS,
  calcRequiredSol,
  calcZendFeeUsdt,
  ZEND_FEE_NORMAL_BPS,
  ZEND_FEE_NORMAL_CAP_USDT,
  type SendFeeInfo,
} from '../utils/fees.js';
import { getSolPriceInUsdt } from '../utils/sol-price.js';
import { SOLANA_TOKENS } from '@zend/shared';

export interface CountNeededAtasOptions {
  recipientAddress?: string;
  feeWalletAddress?: string;
  /** When PAJ deposit address isn't known yet, assume one recipient ATA may be created */
  assumeRecipientAta?: boolean;
}

/** Mirror fundSolIfNeeded ATA logic so fee quotes match execution. */
export async function countNeededAtas(
  mintAddress: string,
  options: CountNeededAtasOptions = {}
): Promise<number> {
  let needsAtaCount = 0;

  if (options.recipientAddress) {
    try {
      const exists = await walletService.ataExists(options.recipientAddress, mintAddress);
      if (!exists) needsAtaCount++;
    } catch {
      needsAtaCount++;
    }
  } else if (options.assumeRecipientAta !== false) {
    needsAtaCount++;
  }

  if (options.feeWalletAddress) {
    try {
      const exists = await walletService.ataExists(options.feeWalletAddress, mintAddress);
      if (!exists) needsAtaCount++;
    } catch {
      needsAtaCount++;
    }
  }

  return needsAtaCount;
}

const DEV_WALLET_LOW_BALANCE_THRESHOLD = 0.05;
const DEV_WALLET_CRITICAL_THRESHOLD = 0.01;

export async function isNewUser(userId: string): Promise<boolean> {
  try {
    const txnCount = await db.select({ count: sql`count(*)` }).from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));
    return Number(txnCount[0]?.count) === 0;
  } catch (err) {
    console.error('[Gas] isNewUser check failed:', err);
    return false;
  }
}

export async function calculateSendFee(
  transferUsdt: number,
  userWalletAddress: string,
  userId?: string,
  options?: CountNeededAtasOptions
): Promise<SendFeeInfo> {
  const newUser = userId ? await isNewUser(userId) : false;
  const needsAtaCount = await countNeededAtas(SOLANA_TOKENS.USDT.mint, {
    recipientAddress: options?.recipientAddress,
    feeWalletAddress: process.env.ZEND_FEE_WALLET?.trim() || undefined,
    assumeRecipientAta: options?.assumeRecipientAta,
  });
  return calcSendFee(transferUsdt, userWalletAddress, walletService, newUser, {
    getSolPriceInUsdt,
    needsAtaCount,
  });
}

export async function getDevWalletBalance(): Promise<number> {
  if (!DEV_WALLET_SECRET) return 0;
  try {
    const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
    return await walletService.getSolBalance(devKeypair.publicKey.toBase58());
  } catch {
    return 0;
  }
}

export async function checkDevWalletHealth(): Promise<{ healthy: boolean; balance: number; level: 'ok' | 'low' | 'critical' }> {
  const balance = await getDevWalletBalance();
  let level: 'ok' | 'low' | 'critical' = 'ok';
  if (balance < DEV_WALLET_CRITICAL_THRESHOLD) {
    level = 'critical';
    console.error(`[Gas][ALERT] Dev wallet CRITICAL: ${balance.toFixed(6)} SOL. Gas sponsorship will fail soon. Top up immediately.`);
  } else if (balance < DEV_WALLET_LOW_BALANCE_THRESHOLD) {
    level = 'low';
    console.warn(`[Gas][ALERT] Dev wallet LOW: ${balance.toFixed(6)} SOL. Consider topping up before user volume spikes.`);
  } else {
    console.log(`[Gas] Dev wallet health OK: ${balance.toFixed(6)} SOL`);
  }
  return { healthy: level === 'ok', balance, level };
}

export function gasFundingErrorToUserMessage(error: string | undefined, shortfall?: number): string {
  if (!error) {
    return 'We could not cover the network fee for this transaction. Please try again in a moment.';
  }
  const e = error.toLowerCase();
  if (e.includes('dev wallet not configured') || e.includes('no dev wallet')) {
    return 'Gas sponsorship is temporarily unavailable. Please contact support.';
  }
  if (e.includes('low on sol') || e.includes('dev wallet low')) {
    return 'Our gas station is running low on SOL right now. Please try again in a few minutes or add a small amount of SOL to your wallet.';
  }
  if (e.includes('blockhash') || e.includes('timeout') || e.includes('expired')) {
    return 'The Solana network was too slow to confirm the gas top-up. Please try again.';
  }
  if (e.includes('insufficient funds')) {
    return 'We could not reserve enough SOL to process this transaction. Please try a smaller amount or contact support.';
  }
  if (shortfall && shortfall > 0) {
    return `We tried to top up your wallet with ${shortfall.toFixed(6)} SOL for network fees, but it didn't go through. Please try again or add a small amount of SOL manually.`;
  }
  return 'We could not cover the network fee for this transaction. Please try again or contact support if this keeps happening.';
}

export async function fundSolIfNeeded(
  walletAddress: string,
  recipientAddress?: string,
  mintAddress?: string,
  feeWalletAddress?: string,
  userId?: string
): Promise<{ funded: boolean; gasSponsored: boolean; shortfall?: number; error?: string }> {
  console.log(`[Gas] fundSolIfNeeded called for wallet=${walletAddress}, recipient=${recipientAddress || 'none'}, mint=${mintAddress || 'none'}, feeWallet=${feeWalletAddress || 'none'}, userId=${userId || 'unknown'}`);

  let needsAtaCount = 0;
  if (recipientAddress && mintAddress) {
    try {
      const exists = await walletService.ataExists(recipientAddress, mintAddress);
      console.log(`[Gas] Recipient ATA exists=${exists} for ${recipientAddress}`);
      if (!exists) needsAtaCount++;
    } catch (err: any) {
      console.warn(`[Gas] ATA check failed for recipient ${recipientAddress}:`, err.message);
      needsAtaCount++;
    }
  }
  if (feeWalletAddress && mintAddress) {
    try {
      const exists = await walletService.ataExists(feeWalletAddress, mintAddress);
      console.log(`[Gas] Fee wallet ATA exists=${exists} for ${feeWalletAddress}`);
      if (!exists) needsAtaCount++;
    } catch (err: any) {
      console.warn(`[Gas] ATA check failed for fee wallet ${feeWalletAddress}:`, err.message);
      needsAtaCount++;
    }
  }

  const newUser = userId ? await isNewUser(userId) : false;
  const required = calcRequiredSol(needsAtaCount, newUser);
  console.log(`[Gas] Required SOL=${required.toFixed(6)} (newUser=${newUser}, needsAta=${needsAtaCount})`);

  const balance = await walletService.getSolBalance(walletAddress);
  console.log(`[Gas] User SOL balance=${balance.toFixed(6)} for ${walletAddress}`);

  if (balance >= required) {
    console.log(`[Gas] No funding needed. Balance ${balance.toFixed(6)} >= required ${required.toFixed(6)}`);
    return { funded: false, gasSponsored: false };
  }

  const shortfall = required - balance;
  console.log(`[Gas] Shortfall=${shortfall.toFixed(6)} SOL`);

  const health = await checkDevWalletHealth();
  if (!health.healthy) {
    console.warn(`[Gas] Proceeding with sponsorship despite dev wallet level=${health.level}`);
  }

  if (!DEV_WALLET_SECRET) {
    console.warn('[Gas] No dev wallet secret set — cannot fund SOL');
    return { funded: false, gasSponsored: false, shortfall, error: 'Dev wallet not configured' };
  }

  const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
  const devBalance = await walletService.getSolBalance(devKeypair.publicKey.toBase58());
  const devNeeds = shortfall + MIN_SOL_FOR_GAS;
  console.log(`[Gas] Dev wallet balance=${devBalance.toFixed(6)} SOL, needs=${devNeeds.toFixed(6)} SOL`);
  if (devBalance < devNeeds) {
    console.error(`[Gas] Dev wallet has ${devBalance.toFixed(6)} SOL but needs ${devNeeds.toFixed(6)} SOL to fund user ${walletAddress}`);
    return { funded: false, gasSponsored: false, shortfall, error: `Dev wallet low on SOL (${devBalance.toFixed(6)}). Please top up the dev wallet.` };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[Gas] Funding attempt ${attempt}/3: sending ${shortfall.toFixed(6)} SOL to ${walletAddress}`);
    try {
      await walletService.sendSol(devKeypair, walletAddress, shortfall);
      console.log(`[Gas] SUCCESS: Funded ${shortfall.toFixed(6)} SOL (needsAta=${needsAtaCount}, newUser=${newUser}) to ${walletAddress}`);
      return { funded: true, gasSponsored: true, shortfall };
    } catch (err: any) {
      console.error(`[Gas] Attempt ${attempt}/3 failed to fund SOL:`, err.message);
      if (attempt === 3) {
        console.error(`[Gas] FATAL: All 3 funding attempts exhausted for ${walletAddress}. Error:`, err.message);
        return { funded: false, gasSponsored: false, shortfall, error: err.message };
      }
      const delay = attempt * 500 + Math.random() * 200;
      console.log(`[Gas] Retrying in ${delay.toFixed(0)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error(`[Gas] FATAL: Funding failed after 3 retries for ${walletAddress}`);
  return { funded: false, gasSponsored: false, shortfall, error: 'Funding failed after 3 retries' };
}