/**
 * USDT/USDC helpers — PAJ and NEAR Intents settle in USDT; auto-swap USDC when needed.
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, transactions } from '@zend/db';
import { SOLANA_TOKENS } from '@zend/shared';
import { DEV_WALLET_SECRET, walletService } from '../deps.js';
import { generateTxId } from '../lib/ids.js';
import { decryptPrivateKey } from '../utils/wallet.js';
import { indexTransaction } from './nlp.js';
import { buildSwapTransaction, getSwapQuote } from './jupiter.js';

export interface StablecoinBalances {
  usdt: number;
  usdc: number;
  /** Treat USDC ≈ USDT for spending checks */
  total: number;
}

export async function getStablecoinBalances(walletAddress: string): Promise<StablecoinBalances> {
  const [usdt, usdc] = await Promise.all([
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint),
    walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDC.mint),
  ]);
  return { usdt, usdc, total: usdt + usdc };
}

/**
 * Swap USDC → USDT via Jupiter until `targetUsdt` is available (or throw).
 * Returns updated USDT balance.
 */
export async function ensureUsdtBalance(
  userId: string,
  walletAddress: string,
  walletEncryptedKey: string,
  targetUsdt: number,
  label = 'transaction'
): Promise<number> {
  let usdt = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
  if (usdt >= targetUsdt) return usdt;

  const usdc = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDC.mint);
  const shortfall = targetUsdt - usdt;

  if (usdc < shortfall * 0.99) {
    throw new Error(
      `Insufficient Dollars. You need ${targetUsdt.toFixed(2)} USDT for this ${label} ` +
      `(you have ${usdt.toFixed(2)} USDT + ${usdc.toFixed(2)} USDC).`
    );
  }

  const swapAmountUsdc = Math.min(usdc, shortfall * 1.05);
  const swapAmountBase = Math.round(swapAmountUsdc * 10 ** SOLANA_TOKENS.USDC.decimals);
  const quote = await getSwapQuote(SOLANA_TOKENS.USDC.mint, SOLANA_TOKENS.USDT.mint, swapAmountBase, 100);
  if (!quote) {
    throw new Error('Could not convert USDC to USDT right now. Please try again in a moment.');
  }

  const outAmountUsdt = Number(quote.outAmount) / 10 ** SOLANA_TOKENS.USDT.decimals;
  if (outAmountUsdt < shortfall) {
    throw new Error(
      `USDC conversion would only give ${outAmountUsdt.toFixed(2)} USDT. ` +
      `Add more USDT or try a smaller amount.`
    );
  }

  const serializedTx = await buildSwapTransaction(quote, walletAddress, true);
  if (!serializedTx) throw new Error('Failed to prepare USDC conversion.');

  const secretKey = await decryptPrivateKey(walletEncryptedKey);
  const keypair = Keypair.fromSecretKey(secretKey);
  const swapTxHash = await walletService.signAndSendSerialized(keypair, serializedTx);
  console.log(`[Stablecoin] Auto USDC→USDT for ${label}:`, swapTxHash);

  const swapTxId = generateTxId();
  await db.insert(transactions).values({
    id: swapTxId,
    userId,
    type: 'swap',
    status: 'completed',
    fromMint: SOLANA_TOKENS.USDC.mint,
    fromAmount: swapAmountUsdc.toString(),
    toMint: SOLANA_TOKENS.USDT.mint,
    toAmount: outAmountUsdt.toString(),
    solanaTxHash: swapTxHash,
  });
  await indexTransaction(userId, swapTxId, `Auto-swapped ${swapAmountUsdc.toFixed(2)} USDC → ${outAmountUsdt.toFixed(2)} USDT`, {
    fromAmount: swapAmountUsdc,
    toAmount: outAmountUsdt,
    fromToken: 'USDC',
    toToken: 'USDT',
  });

  usdt = await walletService.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint);
  if (usdt < targetUsdt) {
    throw new Error('USDC was converted but balance is still short. Please try again.');
  }
  return usdt;
}