/**
 * USDT payment helpers — PAJ settles in USDT.
 * Auto-routes other wallet tokens (USDC, AUDD, NEAR, excess SOL) → USDT via Jupiter
 * so the user does not need to swap manually before a bank payment.
 */

import { Keypair } from '@solana/web3.js';
import { db, transactions } from '@zend/db';
import { SOLANA_TOKENS } from '@zend/shared';
import { walletService } from '../deps.js';
import { generateTxId } from '../lib/ids.js';
import { logError, logInfo, logWarn } from '../lib/logger.js';
import { decryptPrivateKey } from '../utils/wallet.js';
import { indexTransaction } from './nlp.js';
import { buildSwapTransaction, getSwapQuote } from './jupiter.js';

export interface StablecoinBalances {
  usdt: number;
  usdc: number;
  /** Treat USDC ≈ USDT for spending checks */
  total: number;
}

/** Tokens we will auto-swap into USDT for bank payments (order = priority). */
const AUTO_SWAP_SOURCES: Array<{
  symbol: string;
  mint: string;
  decimals: number;
  /** Keep this much unswapped (e.g. SOL for gas) */
  reserve?: number;
  /** Min human units to bother swapping */
  dust?: number;
}> = [
  { symbol: 'USDC', mint: SOLANA_TOKENS.USDC.mint, decimals: SOLANA_TOKENS.USDC.decimals, dust: 0.01 },
  { symbol: 'AUDD', mint: SOLANA_TOKENS.AUDD.mint, decimals: SOLANA_TOKENS.AUDD.decimals, dust: 0.01 },
  { symbol: 'NEAR', mint: SOLANA_TOKENS.NEAR.mint, decimals: SOLANA_TOKENS.NEAR.decimals, dust: 0.001 },
  // Leave SOL for network fees / ATA rent
  { symbol: 'SOL', mint: SOLANA_TOKENS.SOL.mint, decimals: SOLANA_TOKENS.SOL.decimals, reserve: 0.015, dust: 0.002 },
];

export async function getStablecoinBalances(walletAddress: string): Promise<StablecoinBalances> {
  const [usdt, usdc] = await Promise.all([
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint),
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDC.mint),
  ]);
  return { usdt, usdc, total: usdt + usdc };
}

export interface PaymentAssetSnapshot {
  usdt: number;
  usdc: number;
  audd: number;
  near: number;
  sol: number;
  /** Conservative liquid dollars without quoting (USDT+USDC only) */
  liquidUsdt: number;
}

export async function getPaymentAssetSnapshot(walletAddress: string): Promise<PaymentAssetSnapshot> {
  const [usdt, usdc, audd, near, sol] = await Promise.all([
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint),
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDC.mint),
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.AUDD.mint),
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.NEAR.mint),
    walletService.getSolBalance(walletAddress),
  ]);
  return {
    usdt,
    usdc,
    audd,
    near,
    sol,
    liquidUsdt: usdt + usdc,
  };
}

/**
 * Estimate whether the wallet can cover `targetUsdt` after auto-swaps.
 * Uses USDT+USDC at face value; quotes other tokens via Jupiter (best-effort).
 */
export async function estimatePayableUsdt(walletAddress: string): Promise<{
  payableUsdt: number;
  breakdown: Array<{ symbol: string; amount: number; usdtOut: number }>;
}> {
  const snap = await getPaymentAssetSnapshot(walletAddress);
  const breakdown: Array<{ symbol: string; amount: number; usdtOut: number }> = [];
  let payable = snap.usdt;
  breakdown.push({ symbol: 'USDT', amount: snap.usdt, usdtOut: snap.usdt });

  if (snap.usdc > 0.01) {
    payable += snap.usdc;
    breakdown.push({ symbol: 'USDC', amount: snap.usdc, usdtOut: snap.usdc });
  }

  for (const src of AUTO_SWAP_SOURCES) {
    if (src.symbol === 'USDC') continue; // already counted 1:1
    const raw =
      src.symbol === 'AUDD' ? snap.audd :
      src.symbol === 'NEAR' ? snap.near :
      src.symbol === 'SOL' ? snap.sol :
      0;
    const available = Math.max(0, raw - (src.reserve || 0));
    if (available < (src.dust || 0.01)) continue;

    const base = Math.floor(available * 10 ** src.decimals);
    if (base <= 0) continue;
    try {
      const quote = await getSwapQuote(src.mint, SOLANA_TOKENS.USDT.mint, base, 100);
      if (!quote) continue;
      const usdtOut = Number(quote.outAmount) / 10 ** SOLANA_TOKENS.USDT.decimals;
      if (usdtOut > 0) {
        payable += usdtOut;
        breakdown.push({ symbol: src.symbol, amount: available, usdtOut });
      }
    } catch (err) {
      logWarn('Stablecoin', 'estimate quote failed', { symbol: src.symbol, err: String((err as any)?.message || err) });
    }
  }

  return { payableUsdt: payable, breakdown };
}

async function swapTokenToUsdt(
  userId: string,
  walletAddress: string,
  keypair: Keypair,
  source: (typeof AUTO_SWAP_SOURCES)[number],
  humanAmount: number,
  label: string
): Promise<{ usdtOut: number; txHash: string } | null> {
  const rawAmount = Math.floor(humanAmount * 10 ** source.decimals);
  if (rawAmount <= 0) return null;

  const quote = await getSwapQuote(source.mint, SOLANA_TOKENS.USDT.mint, rawAmount, 100);
  if (!quote) {
    logWarn('Stablecoin', 'No Jupiter quote', { symbol: source.symbol, amount: humanAmount, label });
    return null;
  }

  const usdtOut = Number(quote.outAmount) / 10 ** SOLANA_TOKENS.USDT.decimals;
  const serializedTx = await buildSwapTransaction(quote, walletAddress, true);
  if (!serializedTx) {
    logWarn('Stablecoin', 'Failed to build swap tx', { symbol: source.symbol, label });
    return null;
  }

  const swapTxHash = await walletService.signAndSendSerialized(keypair, serializedTx);
  logInfo('Stablecoin', `Auto ${source.symbol}→USDT`, {
    label,
    in: humanAmount,
    out: usdtOut,
    tx: swapTxHash,
  });

  const swapTxId = generateTxId();
  await db.insert(transactions).values({
    id: swapTxId,
    userId,
    type: 'swap',
    status: 'completed',
    fromMint: source.mint,
    fromAmount: humanAmount.toString(),
    toMint: SOLANA_TOKENS.USDT.mint,
    toAmount: usdtOut.toString(),
    solanaTxHash: swapTxHash,
  });
  void indexTransaction(
    userId,
    swapTxId,
    `Auto-swapped ${humanAmount.toFixed(4)} ${source.symbol} → ${usdtOut.toFixed(2)} USDT`,
    { fromAmount: humanAmount, toAmount: usdtOut, fromToken: source.symbol, toToken: 'USDT' }
  ).catch((err) => logWarn('Stablecoin', 'indexTransaction failed', { err: String(err?.message || err) }));

  return { usdtOut, txHash: swapTxHash };
}

/**
 * Ensure wallet holds at least `targetUsdt` USDT for PAJ payment.
 * Auto-swaps USDC / AUDD / NEAR / excess SOL as needed (user never manually swaps).
 * Returns final USDT balance.
 */
export async function ensureUsdtBalance(
  userId: string,
  walletAddress: string,
  walletEncryptedKey: string,
  targetUsdt: number,
  label = 'transaction'
): Promise<number> {
  let usdt = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
  if (usdt + 1e-9 >= targetUsdt) {
    logInfo('Stablecoin', 'USDT already sufficient', { userId, usdt, targetUsdt, label });
    return usdt;
  }

  logInfo('Stablecoin', 'Need auto-route to USDT', {
    userId,
    haveUsdt: usdt,
    targetUsdt,
    shortfall: targetUsdt - usdt,
    label,
  });

  const secretKey = await decryptPrivateKey(walletEncryptedKey);
  const keypair = Keypair.fromSecretKey(secretKey);

  for (const source of AUTO_SWAP_SOURCES) {
    usdt = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
    if (usdt + 1e-9 >= targetUsdt) break;

    const shortfall = targetUsdt - usdt;
    let available: number;
    if (source.symbol === 'SOL') {
      available = await walletService.getSolBalance(walletAddress);
    } else {
      available = await walletService.getTokenBalance(walletAddress, source.mint);
    }
    available = Math.max(0, available - (source.reserve || 0));
    if (available < (source.dust || 0.01)) continue;

    // Quote full available, then scale input to cover shortfall * buffer
    const fullBase = Math.floor(available * 10 ** source.decimals);
    if (fullBase <= 0) continue;
    const fullQuote = await getSwapQuote(source.mint, SOLANA_TOKENS.USDT.mint, fullBase, 100);
    if (!fullQuote) {
      logWarn('Stablecoin', 'Skip source — no quote', { symbol: source.symbol, available, label });
      continue;
    }
    const fullOut = Number(fullQuote.outAmount) / 10 ** SOLANA_TOKENS.USDT.decimals;
    if (fullOut <= 0) continue;

    // How much of `available` we need for shortfall (with 3% buffer)
    const fraction = Math.min(1, (shortfall * 1.03) / fullOut);
    const swapHuman = Math.min(available, available * fraction);
    // Never leave dust that fails; round down slightly
    const swapAmount = Math.floor(swapHuman * 10 ** source.decimals) / 10 ** source.decimals;
    if (swapAmount < (source.dust || 0.01)) continue;

    try {
      const result = await swapTokenToUsdt(userId, walletAddress, keypair, source, swapAmount, label);
      if (!result) continue;
    } catch (err) {
      logError('Stablecoin', `Auto-swap ${source.symbol}→USDT failed`, err, { userId, label });
      // try next source
    }
  }

  usdt = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
  if (usdt + 1e-9 < targetUsdt) {
    const snap = await getPaymentAssetSnapshot(walletAddress);
    logWarn('Stablecoin', 'Still short after auto-route', {
      userId,
      usdt,
      targetUsdt,
      usdc: snap.usdc,
      audd: snap.audd,
      near: snap.near,
      sol: snap.sol,
      label,
    });
    throw new Error(
      `Insufficient balance for this ${label}. You need ${targetUsdt.toFixed(2)} USDT ` +
      `(have ${usdt.toFixed(2)} USDT after auto-converting available tokens). ` +
      `Balances: ${snap.usdc.toFixed(2)} USDC, ${snap.audd.toFixed(2)} AUDD, ` +
      `${snap.near.toFixed(4)} NEAR, ${snap.sol.toFixed(4)} SOL.`
    );
  }

  logInfo('Stablecoin', 'USDT ready after auto-route', { userId, usdt, targetUsdt, label });
  return usdt;
}
