export function formatBalance(amount: number, symbol: string): string {
  return `${amount.toFixed(symbol === 'SOL' ? 4 : 2)} ${symbol}`;
}

export function formatNgn(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}