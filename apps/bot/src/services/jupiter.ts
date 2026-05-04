/**
 * Jupiter Swap Service for Zend Bot
 * Integrates Jupiter DEX aggregator for token swaps on Solana
 */

import { SOLANA_TOKENS } from '@zend/shared';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  otherAmountThreshold: number;
  swapMode: string;
  slippageBps: number;
  platformFee: number | null;
  priceImpactPct: number;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
}

export interface SwapResult {
  txId: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
}

/**
 * Get a swap quote from Jupiter
 */
export async function getSwapQuote(
  inputMint: string,
  outputMint: string,
  amount: number, // in base units (lamports for SOL, micro-tokens for USDT/USDC)
  slippageBps: number = 50 // 0.5% default
): Promise<SwapQuote | null> {
  try {
    const url = new URL(`${JUPITER_API}/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount.toString());
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('onlyDirectRoutes', 'false');
    url.searchParams.set('asLegacyTransaction', 'false');

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.text();
      console.error('[Jupiter] Quote failed:', error);
      return null;
    }

    const data = await response.json() as any;
    return {
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inAmount: Number(data.inAmount),
      outAmount: Number(data.outAmount),
      otherAmountThreshold: Number(data.otherAmountThreshold),
      swapMode: data.swapMode,
      slippageBps: data.slippageBps,
      platformFee: data.platformFee,
      priceImpactPct: Number(data.priceImpactPct),
      routePlan: data.routePlan,
      contextSlot: data.contextSlot,
      timeTaken: data.timeTaken,
    };
  } catch (err) {
    console.error('[Jupiter] Quote error:', err);
    return null;
  }
}

/**
 * Build swap transaction from quote
 * Returns base64-encoded transaction
 */
export async function buildSwapTransaction(
  quoteResponse: SwapQuote,
  userPublicKey: string,
  wrapUnwrapSOL: boolean = true,
  feeAccount?: string // Zend fee wallet for platform fee
): Promise<string | null> {
  try {
    const body: any = {
      quoteResponse,
      userPublicKey,
      wrapUnwrapSOL,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 100000,
          priorityLevel: 'medium',
        },
      },
    };

    if (feeAccount) {
      body.feeAccount = feeAccount;
    }

    const response = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Jupiter] Build swap failed:', error);
      return null;
    }

    const data = await response.json() as any;
    return data.swapTransaction;
  } catch (err) {
    console.error('[Jupiter] Build swap error:', err);
    return null;
  }
}

/**
 * Human-readable token info for swap UI
 */
export const SWAP_TOKENS = [
  { mint: SOLANA_TOKENS.SOL.mint, symbol: 'SOL', decimals: 9, name: 'Solana' },
  { mint: SOLANA_TOKENS.USDT.mint, symbol: 'USDT', decimals: 6, name: 'Tether USD' },
  { mint: SOLANA_TOKENS.USDC.mint, symbol: 'USDC', decimals: 6, name: 'USD Coin' },
] as const;

export function getTokenBySymbol(symbol: string) {
  return SWAP_TOKENS.find(t => t.symbol === symbol);
}

export function formatTokenAmount(amount: number, decimals: number): string {
  return (amount / Math.pow(10, decimals)).toFixed(decimals === 9 ? 4 : 2);
}
