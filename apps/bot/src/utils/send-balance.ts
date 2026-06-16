import { MIN_SOL_FOR_GAS } from './fees.js';

export type SendBalanceError =
  | 'no_audd'
  | 'insufficient_token'
  | 'insufficient_sol';

export interface SendBalanceCheckInput {
  tokenBalance: number;
  solBalance: number;
  transferUsdt: number;
  zendFeeUsdt: number;
  willFundSol: boolean;
  isAudd: boolean;
}

export interface SendBalanceCheckResult {
  ok: boolean;
  error?: SendBalanceError;
  usdtNeeded: number;
  shortfall?: number;
}

/** Pure balance gate used before send confirmation (testable without Telegram/DB). */
export function checkSendBalance(input: SendBalanceCheckInput): SendBalanceCheckResult {
  const usdtNeeded = input.transferUsdt + input.zendFeeUsdt;

  if (input.isAudd) {
    if (input.tokenBalance <= 0) {
      return { ok: false, error: 'no_audd', usdtNeeded };
    }
    return { ok: true, usdtNeeded };
  }

  if (input.tokenBalance < usdtNeeded) {
    return {
      ok: false,
      error: 'insufficient_token',
      usdtNeeded,
      shortfall: usdtNeeded - input.tokenBalance,
    };
  }

  if (!input.willFundSol && input.solBalance < MIN_SOL_FOR_GAS) {
    return { ok: false, error: 'insufficient_sol', usdtNeeded };
  }

  return { ok: true, usdtNeeded };
}