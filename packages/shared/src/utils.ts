import { SOLANA_TOKENS } from './constants.js';

// Format NGN amount with comma separators
export function formatNgn(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}

// Format crypto amount with symbol
export function formatCrypto(amount: number, symbol: string): string {
  return `${amount.toFixed(symbol === 'SOL' ? 4 : 2)} ${symbol}`;
}

// Truncate Solana address for display
export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// Convert USDT amount to NGN
export function usdtToNgn(usdtAmount: number, rate: number): number {
  return Math.floor(usdtAmount * rate);
}

// Convert NGN amount to USDT
export function ngnToUsdt(ngnAmount: number, rate: number): number {
  return ngnAmount / rate;
}

// Calculate PAJ fee
export function calculatePajFee(ngnAmount: number, feeBps: number): number {
  return Math.floor(ngnAmount * (feeBps / 10000));
}

// Calculate total USDT needed (including fee)
export function calculateTotalUsdt(ngnAmount: number, rate: number, feeBps: number): number {
  const ngnWithFee = ngnAmount + calculatePajFee(ngnAmount, feeBps);
  return ngnToUsdt(ngnWithFee, rate);
}

// Parse amount from user input (handles "50k", "50,000", "fifty thousand")
export function parseAmountInput(input: string): { value: number; currency: 'NGN' | 'USDT' | 'USDC' | 'SOL' | null } | null {
  const cleaned = input.toLowerCase().replace(/,/g, '').trim();
  
  // Check for currency indicators
  let currency: 'NGN' | 'USDT' | 'USDC' | 'SOL' | null = null;
  if (cleaned.includes('naira') || cleaned.includes('₦') || cleaned.includes('ngn')) currency = 'NGN';
  else if (cleaned.includes('usdt')) currency = 'USDT';
  else if (cleaned.includes('usdc')) currency = 'USDC';
  else if (cleaned.includes('sol')) currency = 'SOL';
  
  // Extract number
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?/);
  if (!match) return null;
  
  let value = parseFloat(match[1]);
  const multiplier = match[2];
  
  if (multiplier === 'k' || multiplier === 'thousand') value *= 1000;
  if (multiplier === 'm' || multiplier === 'million') value *= 1_000_000;
  
  return { value, currency };
}

// Normalize bank name to code
export function normalizeBank(input: string): { code: string; name: string } | null {
  const cleaned = input.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  
  const bankMap: Record<string, { code: string; name: string }> = {
    'gtb': { code: 'GTB', name: 'GTBank' },
    'gtbank': { code: 'GTB', name: 'GTBank' },
    'guaranty': { code: 'GTB', name: 'GTBank' },
    'uba': { code: 'UBA', name: 'UBA' },
    'united bank': { code: 'UBA', name: 'UBA' },
    'access': { code: 'ACC', name: 'Access Bank' },
    'access bank': { code: 'ACC', name: 'Access Bank' },
    'zenith': { code: 'ZEN', name: 'Zenith Bank' },
    'zenith bank': { code: 'ZEN', name: 'Zenith Bank' },
    'first bank': { code: 'FBN', name: 'First Bank' },
    'fbn': { code: 'FBN', name: 'First Bank' },
    'ecobank': { code: 'ECO', name: 'Ecobank' },
    'wema': { code: 'WEM', name: 'Wema Bank' },
    'fidelity': { code: 'FID', name: 'Fidelity Bank' },
    'polaris': { code: 'SKY', name: 'Polaris Bank' },
    'stanbic': { code: 'STA', name: 'Stanbic IBTC' },
    'union': { code: 'UNI', name: 'Union Bank' },
  };
  
  return bankMap[cleaned] || null;
}

// Generate Zend reference ID
export function generateReference(): string {
  const random = Math.floor(Math.random() * 90000) + 10000;
  return `ZND-${random}`;
}

// Sleep utility
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if string is valid Solana address
export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

// Check if string is valid Nigerian account number
export function isValidAccountNumber(accountNumber: string): boolean {
  return /^\d{10}$/.test(accountNumber);
}

// Format date for display
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Get token info by mint
export function getTokenByMint(mint: string) {
  return Object.values(SOLANA_TOKENS).find(t => t.mint === mint);
}

// Get token info by symbol
export function getTokenBySymbol(symbol: string) {
  return Object.values(SOLANA_TOKENS).find(t => t.symbol === symbol.toUpperCase());
}
