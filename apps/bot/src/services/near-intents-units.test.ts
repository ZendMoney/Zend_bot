import { describe, it, expect } from 'vitest';
import { toBaseUnits } from '@zend/near-intents-client';

describe('toBaseUnits', () => {
  it('converts USDT (6 decimals)', () => {
    expect(toBaseUnits(50, 6)).toBe('50000000');
    expect(toBaseUnits('0.01', 6)).toBe('10000');
  });

  it('converts ETH (18 decimals) without scientific notation', () => {
    expect(toBaseUnits(10, 18)).toBe('10000000000000000000');
    expect(toBaseUnits('0.01', 18)).toBe('10000000000000000');
    expect(toBaseUnits(1000, 18)).toBe('1000000000000000000000');
  });

  it('strips commas', () => {
    expect(toBaseUnits('1,000.5', 6)).toBe('1000500000');
  });

  it('rejects invalid amounts', () => {
    expect(() => toBaseUnits('abc', 6)).toThrow();
  });
});