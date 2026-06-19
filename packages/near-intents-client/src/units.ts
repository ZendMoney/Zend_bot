/**
 * Convert a human-readable token amount to NEAR Intents base units (integer string).
 * Avoids floating-point/scientific-notation bugs (e.g. 1000 ETH → "1e+21").
 */
export function toBaseUnits(humanAmount: string | number, decimals: number): string {
  const normalized = String(humanAmount).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid amount: ${humanAmount}`);
  }
  if (decimals < 0 || decimals > 36 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const [whole, frac = ''] = normalized.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  const digits = (whole.replace(/^0+/, '') || '0') + fracPadded;

  return BigInt(digits).toString();
}