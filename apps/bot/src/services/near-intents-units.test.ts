import { describe, it, expect } from 'vitest';
import { toBaseUnits, fromBaseUnits } from '@zend/near-intents-client';
import { normalizeVoiceTranscript } from './nlp.js';
import { formatNearIntentsError } from '../utils/api-errors.js';

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

describe('fromBaseUnits', () => {
  it('converts NEAR yocto back to human', () => {
    expect(fromBaseUnits('80654506743476286791266', 24)).toBe('0.080654506743476286791266');
    expect(fromBaseUnits('1000000000000000000000000', 24)).toBe('1');
  });
});

describe('normalizeVoiceTranscript', () => {
  it('fixes "1 key" → "1k"', () => {
    expect(normalizeVoiceTranscript('Hi, send, 1 key to 7082406410.')).toBe(
      'Hi, send, 1k to 7082406410.'
    );
  });
});

describe('formatNearIntentsError min amount', () => {
  it('shows human minimum for NEAR', () => {
    const err = new Error(
      'NearIntents 400: {"message":"Amount is too low for bridge, try at least 80654506743476286791266"}'
    );
    const msg = formatNearIntentsError(err, { symbol: 'NEAR', decimals: 24 });
    expect(msg).toMatch(/~0\.08\d+ NEAR/);
  });
});