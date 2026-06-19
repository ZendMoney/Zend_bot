import { WalletService } from '@zend/solana';

/** Basis points from env — ZEND_FEE_BPS=100 means 1% */
export const ZEND_FEE_NORMAL_BPS = parseInt(process.env.ZEND_FEE_BPS || '100', 10);
/** Percentage option when we sponsor gas (compared against gas recovery) */
export const ZEND_FEE_FUNDED_BPS = parseInt(
  process.env.ZEND_FEE_FUNDED_BPS || String(Math.round(ZEND_FEE_NORMAL_BPS * 1.5)),
  10
);
export const ZEND_FEE_NORMAL_CAP_USDT = parseFloat(process.env.ZEND_FEE_CAP_USDT || '2');
export const ZEND_FEE_FUNDED_CAP_USDT = parseFloat(process.env.ZEND_FEE_FUNDED_CAP_USDT || '3');
/** Small flat fee on top of SOL recovery (the "little extra") */
export const ZEND_GAS_EXTRA_FLAT_USDT = parseFloat(process.env.ZEND_GAS_EXTRA_FLAT_USDT || '0.25');

export const MIN_SOL_FOR_GAS = 0.003;
export const ATA_RENT_SOL = 0.002039;
export const NEW_USER_SOL_BUFFER_MULTIPLIER = 2;

export type SponsoredFeeMode = 'percentage' | 'gas_recovery';

export function calcRequiredSol(needsAtaCount: number, isNewUser = false): number {
  const base = MIN_SOL_FOR_GAS + needsAtaCount * ATA_RENT_SOL;
  return isNewUser ? base * NEW_USER_SOL_BUFFER_MULTIPLIER : base;
}

export function calcZendFeeUsdt(transferUsdt: number, bps: number, capUsdt: number): number {
  return Math.min(transferUsdt * (bps / 10000), capUsdt);
}

export function calcGasShortfallSol(
  solBalance: number,
  needsAtaCount: number,
  isNewUser: boolean
): number {
  const required = calcRequiredSol(needsAtaCount, isNewUser);
  return Math.max(0, required - solBalance);
}

/**
 * Gas-sponsored fee: pick the higher of
 *   (A) percentage of transfer, or
 *   (B) USDT value of SOL we fund + small flat fee.
 * Small sends → usually (B). Large sends → usually (A).
 */
export function calcSponsoredSendFeeUsdt(
  shortfallSol: number,
  solPriceUsdt: number,
  transferUsdt: number
): {
  zendFeeUsdt: number;
  feeSol: number;
  gasCostUsdt: number;
  extraFeeUsdt: number;
  percentageFeeUsdt: number;
  feeBps: number;
  feeMode: SponsoredFeeMode;
} {
  const gasCostUsdt = shortfallSol * solPriceUsdt;
  const extraFeeUsdt = ZEND_GAS_EXTRA_FLAT_USDT;
  const gasRecoveryTotal = gasCostUsdt + extraFeeUsdt;
  const percentageFeeUsdt = calcZendFeeUsdt(transferUsdt, ZEND_FEE_FUNDED_BPS, ZEND_FEE_FUNDED_CAP_USDT);

  const usePercentage = percentageFeeUsdt >= gasRecoveryTotal;
  return {
    zendFeeUsdt: usePercentage ? percentageFeeUsdt : gasRecoveryTotal,
    feeSol: shortfallSol,
    gasCostUsdt,
    extraFeeUsdt,
    percentageFeeUsdt,
    feeBps: ZEND_FEE_FUNDED_BPS,
    feeMode: usePercentage ? 'percentage' : 'gas_recovery',
  };
}

export interface SendFeeInfo {
  zendFeeUsdt: number;
  feeSol: number;
  feeBps: number;
  willFundSol: boolean;
  transferUsdt: number;
  totalUsdt: number;
  gasCostUsdt?: number;
  extraFeeUsdt?: number;
  percentageFeeUsdt?: number;
  feeMode?: SponsoredFeeMode;
}

export interface CalculateSendFeeOptions {
  getSolPriceInUsdt?: () => Promise<number>;
  needsAtaCount?: number;
}

export function formatSendFeeLabel(info: Pick<
  SendFeeInfo,
  'zendFeeUsdt' | 'feeBps' | 'willFundSol' | 'gasCostUsdt' | 'extraFeeUsdt' | 'feeSol' | 'feeMode' | 'percentageFeeUsdt'
>): string {
  if (!info.willFundSol) {
    return `ZendPay fee (${(info.feeBps / 100).toFixed(2)}%): ~${info.zendFeeUsdt.toFixed(2)} USDT`;
  }
  if (info.feeMode === 'gas_recovery' && info.gasCostUsdt != null && info.extraFeeUsdt != null) {
    const solPart = info.feeSol > 0 ? `~${info.feeSol.toFixed(4)} SOL (≈${info.gasCostUsdt.toFixed(2)} USDT)` : '';
    return (
      `Network fee (we top up your SOL): ${solPart} + ${info.extraFeeUsdt.toFixed(2)} USDT service fee ` +
      `= ~${info.zendFeeUsdt.toFixed(2)} USDT total`
    );
  }
  if (info.feeMode === 'percentage') {
    return `ZendPay fee (${(info.feeBps / 100).toFixed(2)}%, gas sponsored): ~${info.zendFeeUsdt.toFixed(2)} USDT`;
  }
  return `ZendPay fee (gas sponsored): ~${info.zendFeeUsdt.toFixed(2)} USDT`;
}

export async function calculateSendFee(
  transferUsdt: number,
  userWalletAddress: string,
  walletService: WalletService,
  isNewUser: boolean,
  options?: CalculateSendFeeOptions
): Promise<SendFeeInfo> {
  const needsAta =
    options?.needsAtaCount ?? (process.env.ZEND_FEE_WALLET?.trim() ? 2 : 1);
  const solBalance = await walletService.getSolBalance(userWalletAddress);
  const normalRequired = calcRequiredSol(needsAta, isNewUser);
  const normalFee = calcZendFeeUsdt(transferUsdt, ZEND_FEE_NORMAL_BPS, ZEND_FEE_NORMAL_CAP_USDT);

  if (solBalance >= normalRequired) {
    return {
      zendFeeUsdt: normalFee,
      feeSol: 0,
      feeBps: ZEND_FEE_NORMAL_BPS,
      willFundSol: false,
      transferUsdt,
      totalUsdt: transferUsdt + normalFee,
    };
  }

  const shortfallSol = normalRequired - solBalance;

  if (options?.getSolPriceInUsdt) {
    try {
      const solPrice = await options.getSolPriceInUsdt();
      const sponsored = calcSponsoredSendFeeUsdt(shortfallSol, solPrice, transferUsdt);
      return {
        zendFeeUsdt: sponsored.zendFeeUsdt,
        feeSol: sponsored.feeSol,
        feeBps: sponsored.feeBps,
        willFundSol: true,
        transferUsdt,
        totalUsdt: transferUsdt + sponsored.zendFeeUsdt,
        gasCostUsdt: sponsored.gasCostUsdt,
        extraFeeUsdt: sponsored.extraFeeUsdt,
        percentageFeeUsdt: sponsored.percentageFeeUsdt,
        feeMode: sponsored.feeMode,
      };
    } catch {
      // fall through to percentage-only fallback
    }
  }

  const fallbackFee = calcZendFeeUsdt(transferUsdt, ZEND_FEE_FUNDED_BPS, ZEND_FEE_FUNDED_CAP_USDT);
  return {
    zendFeeUsdt: fallbackFee,
    feeSol: shortfallSol,
    feeBps: ZEND_FEE_FUNDED_BPS,
    willFundSol: true,
    transferUsdt,
    totalUsdt: transferUsdt + fallbackFee,
    feeMode: 'percentage',
  };
}

export function validateFeeWallet(): string | null {
  const wallet = process.env.ZEND_FEE_WALLET?.trim();
  if (!wallet) {
    console.warn('[Fees] ZEND_FEE_WALLET not set — fees will be calculated but NOT collected on-chain');
    return null;
  }
  return wallet;
}