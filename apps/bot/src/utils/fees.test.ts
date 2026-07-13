import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  calcZendFeeUsdt,
  calcRequiredSol,
  calcSponsoredSendFeeUsdt,
  calculateSendFee,
  fitFeeToAvailableBalance,
  ZEND_FEE_NORMAL_BPS,
  ZEND_FEE_FUNDED_BPS,
  ZEND_GAS_EXTRA_FLAT_USDT,
} from './fees.js';

describe('calcZendFeeUsdt', () => {
  it('applies basis points', () => {
    expect(calcZendFeeUsdt(100, 100, 2)).toBe(1);
  });

  it('caps at max USDT', () => {
    expect(calcZendFeeUsdt(1000, 100, 2)).toBe(2);
  });
});

describe('calcRequiredSol', () => {
  it('doubles buffer for new users', () => {
    const experienced = calcRequiredSol(1, false);
    const newbie = calcRequiredSol(1, true);
    expect(newbie).toBeGreaterThan(experienced);
  });
});

describe('calcSponsoredSendFeeUsdt', () => {
  it('uses gas recovery + flat fee on small transfers', () => {
    // 0.002139 SOL @ $100 = $0.2139 gas + $0.25 flat
    // 1.5% of $10 = $0.15 → gas recovery wins
    const result = calcSponsoredSendFeeUsdt(0.002139, 100, 10);
    expect(result.feeMode).toBe('gas_recovery');
    expect(result.zendFeeUsdt).toBeCloseTo(0.2139 + ZEND_GAS_EXTRA_FLAT_USDT, 4);
    expect(result.percentageFeeUsdt).toBeLessThan(result.zendFeeUsdt);
  });

  it('uses percentage on large transfers', () => {
    // 0.005 SOL @ $100 = $0.75 recovery
    // 1.5% of $500 = $7.50 (capped at $3 default) → percentage wins
    const result = calcSponsoredSendFeeUsdt(0.005, 100, 500);
    expect(result.feeMode).toBe('percentage');
    expect(result.zendFeeUsdt).toBe(calcZendFeeUsdt(500, ZEND_FEE_FUNDED_BPS, 3));
  });
});

describe('calculateSendFee', () => {
  const walletService = { getSolBalance: vi.fn() };

  beforeEach(() => {
    walletService.getSolBalance.mockReset();
  });

  it('uses normal fee when user has enough SOL', async () => {
    walletService.getSolBalance.mockResolvedValue(1);
    const result = await calculateSendFee(50, 'wallet', walletService as any, false);
    expect(result.willFundSol).toBe(false);
    expect(result.feeBps).toBe(ZEND_FEE_NORMAL_BPS);
  });

  it('picks best sponsored fee when SOL is low', async () => {
    walletService.getSolBalance.mockResolvedValue(0);
    const result = await calculateSendFee(10, 'wallet', walletService as any, false, {
      getSolPriceInUsdt: async () => 100,
      needsAtaCount: 1,
    });
    expect(result.willFundSol).toBe(true);
    expect(result.feeMode).toBe('gas_recovery');
    expect(result.gasCostUsdt).toBeGreaterThan(0);
  });
});

describe('fitFeeToAvailableBalance', () => {
  it('keeps full fee when balance covers order + fee', () => {
    const r = fitFeeToAvailableBalance(12.28, 0.1228, 20);
    expect(r.ok).toBe(true);
    expect(r.feeReduced).toBe(false);
    expect(r.feeUsdt).toBeCloseTo(0.1228, 6);
  });

  it('reduces fee by a few cents when slightly short (prod 12.40 needed / 12.38 held)', () => {
    // order 12.28 + fee 0.1228 = 12.4028; user has 12.38
    const r = fitFeeToAvailableBalance(12.28, 0.1228, 12.38);
    expect(r.ok).toBe(true);
    expect(r.feeReduced).toBe(true);
    expect(r.totalUsdt).toBeLessThanOrEqual(12.38);
    expect(r.feeUsdt).toBeCloseTo(0.1, 4); // 12.38 - 12.28
  });

  it('fails when balance cannot cover PAJ order amount', () => {
    const r = fitFeeToAvailableBalance(12.28, 0.12, 12.0);
    expect(r.ok).toBe(false);
    expect(r.shortfall).toBeCloseTo(0.28, 4);
  });
});