/**
 * Jupiter Swap Service for Zend Bot
 * Integrates Jupiter DEX aggregator for token swaps on Solana
 */

import { SOLANA_TOKENS } from '@zend/shared';

const JUPITER_API_V1 = 'https://api.jup.ag/swap/v1';
const JUPITER_API_V6 = 'https://api.jup.ag/v6';

async function fetchJupiterQuote(
  baseUrl: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<any> {
  const url = new URL(`${baseUrl}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': 'ZendBot/1.0' },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`status=${response.status} body=${errorText.slice(0, 500)}`);
  }

  return response.json();
}

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
function normalizeQuote(data: any): SwapQuote {
  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: Number(data.inAmount),
    outAmount: Number(data.outAmount),
    otherAmountThreshold: Number(data.otherAmountThreshold),
    swapMode: data.swapMode,
    slippageBps: data.slippageBps,
    platformFee: data.platformFee ?? null,
    priceImpactPct: Number(data.priceImpactPct),
    routePlan: data.routePlan,
    contextSlot: data.contextSlot,
    timeTaken: data.timeTaken,
  };
}

export async function getSwapQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<SwapQuote | null> {
  // Try v1 API first (current Jupiter recommendation)
  try {
    const data = await fetchJupiterQuote(JUPITER_API_V1, inputMint, outputMint, amount, slippageBps);
    console.log('[Jupiter] v1 quote success:', data.outputMint, 'outAmount:', data.outAmount);
    return normalizeQuote(data);
  } catch (v1Err: any) {
    console.log(`[Jupiter] v1 quote failed: ${v1Err.message}. Trying v6 fallback...`);
  }

  // Fallback to v6 API
  try {
    const data = await fetchJupiterQuote(JUPITER_API_V6, inputMint, outputMint, amount, slippageBps);
    console.log('[Jupiter] v6 quote success:', data.outputMint, 'outAmount:', data.outAmount);
    return normalizeQuote(data);
  } catch (v6Err: any) {
    console.error(`[Jupiter] v6 quote also failed: ${v6Err.message}`);
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

    // Try v1 API first
    let response = await fetch(`${JUPITER_API_V1}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ZendBot/1.0' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.log(`[Jupiter] v1 build swap failed: status=${response.status} body=${errorText.slice(0, 500)}. Trying v6 fallback...`);

      // Fallback to v6
      response = await fetch(`${JUPITER_API_V6}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ZendBot/1.0' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const v6ErrorText = await response.text().catch(() => '');
        console.error(`[Jupiter] v6 build swap also failed: status=${response.status} body=${v6ErrorText.slice(0, 500)}`);
        return null;
      }
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
