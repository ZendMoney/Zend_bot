/** Set ZEND_AUDD_ENABLED=true to show AUDD in menus (hidden by default). */
export const AUDD_ENABLED = process.env.ZEND_AUDD_ENABLED === 'true';

export function isAuddSymbol(symbol: string): boolean {
  return symbol.toUpperCase() === 'AUDD';
}

export function isAuddSwapPair(from: string, to: string): boolean {
  return isAuddSymbol(from) || isAuddSymbol(to);
}