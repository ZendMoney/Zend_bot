import { describe, it, expect } from 'vitest';
import { checkSendBalance } from './send-balance.js';

describe('checkSendBalance', () => {
  it('requires transfer + fee in token balance', () => {
    const result = checkSendBalance({
      tokenBalance: 50,
      solBalance: 1,
      transferUsdt: 49,
      zendFeeUsdt: 1,
      willFundSol: false,
      isAudd: false,
    });
    expect(result.ok).toBe(true);
    expect(result.usdtNeeded).toBe(50);
  });

  it('fails when token balance excludes fee', () => {
    const result = checkSendBalance({
      tokenBalance: 49,
      solBalance: 1,
      transferUsdt: 49,
      zendFeeUsdt: 1,
      willFundSol: false,
      isAudd: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('insufficient_token');
    expect(result.shortfall).toBe(1);
  });

  it('requires SOL when gas is not sponsored', () => {
    const result = checkSendBalance({
      tokenBalance: 100,
      solBalance: 0,
      transferUsdt: 10,
      zendFeeUsdt: 0.1,
      willFundSol: false,
      isAudd: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('insufficient_sol');
  });

  it('allows zero AUDD check separately', () => {
    expect(
      checkSendBalance({
        tokenBalance: 0,
        solBalance: 1,
        transferUsdt: 10,
        zendFeeUsdt: 0.1,
        willFundSol: false,
        isAudd: true,
      }).error
    ).toBe('no_audd');
  });
});