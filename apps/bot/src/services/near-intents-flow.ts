/**
 * NEAR Intents cross-chain deposit & withdrawal helpers.
 * Deposit:  external chain → user's ZendPay Solana wallet
 * Withdraw: user's ZendPay Solana wallet → external chain address
 */

import { Keypair } from '@solana/web3.js';
import {
  getNearIntentsClient,
  NEAR_INTENTS_ASSETS,
  CHAIN_DISPLAY_NAMES,
  toBaseUnits,
  resolveTokenDecimals,
  type NearIntentsQuote,
} from '@zend/near-intents-client';
import { SOLANA_TOKENS } from '@zend/shared';
import { WalletService } from '@zend/solana';
import { decryptPrivateKey } from '../utils/wallet.js';

export const SOLANA_ORIGIN_ASSETS: Record<string, string> = {
  USDT: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
  USDC: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  SOL: 'nep141:sol.omft.near',
};

export const SOLANA_DEST_ASSETS: Record<string, string> = {
  USDT: SOLANA_ORIGIN_ASSETS.USDT,
  USDC: SOLANA_ORIGIN_ASSETS.USDC,
};

/** Chains users can deposit FROM (external → ZendPay) */
export const DEPOSIT_CHAINS = [
  'ethereum', 'base', 'bsc', 'arbitrum', 'optimism', 'polygon', 'bitcoin', 'solana', 'near',
] as const;

/** Chains users can withdraw TO (ZendPay → external) */
export const WITHDRAW_CHAINS = [
  'ethereum', 'base', 'bsc', 'arbitrum', 'optimism', 'polygon', 'bitcoin', 'near',
] as const;

export function getDestinationAssetId(chainKey: string, symbol: string): string | undefined {
  return NEAR_INTENTS_ASSETS[chainKey]?.[symbol];
}

export function validateChainAddress(chainKey: string, address: string): boolean {
  const trimmed = address.trim();
  switch (chainKey) {
    case 'ethereum':
    case 'base':
    case 'bsc':
    case 'arbitrum':
    case 'optimism':
    case 'polygon':
      return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
    case 'bitcoin':
      return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(trimmed);
    case 'near':
      return /^[a-z0-9._-]+\.near$/.test(trimmed) || /^[a-f0-9]{64}$/.test(trimmed);
    case 'solana':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
    default:
      return trimmed.length >= 8;
  }
}

export interface DepositQuoteParams {
  sourceChain: string;
  sourceToken: string;
  sourceAssetId: string;
  destinationAsset: string;
  destinationSymbol: string;
  amount: number;
  recipientWallet: string;
}

export async function createDepositQuote(params: DepositQuoteParams): Promise<NearIntentsQuote> {
  const client = getNearIntentsClient();
  if (!client) throw new Error('NEAR Intents not configured');

  const decimals = await resolveTokenDecimals(
    params.sourceChain,
    params.sourceToken,
    params.sourceAssetId
  );
  const baseAmount = toBaseUnits(params.amount, decimals);
  if (baseAmount === '0') {
    throw new Error('Amount is too small for this token.');
  }

  console.log(
    `[NearIntents] Deposit quote: ${params.amount} ${params.sourceToken} (${params.sourceChain}) → ${baseAmount} base units (${decimals} decimals)`
  );

  // Refunds go to a NEAR Intents account (NEAR_INTENTS_REFUND_ADDRESS).
  // ORIGIN_CHAIN requires an address on the deposit chain (e.g. 0x… for Ethereum),
  // which would fail for our shared zend-refund.near account.
  const refundTo = process.env.NEAR_INTENTS_REFUND_ADDRESS || 'zend-refund.near';

  return client.getQuote({
    originAsset: params.sourceAssetId,
    destinationAsset: params.destinationAsset,
    amount: baseAmount,
    recipient: params.recipientWallet,
    refundTo,
    refundType: 'INTENTS',
    depositType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
  });
}

export interface WithdrawQuoteParams {
  sourceSymbol: 'USDT' | 'USDC';
  amount: number;
  destChain: string;
  destToken: string;
  destAssetId: string;
  recipientAddress: string;
  refundWallet: string;
}

export async function createWithdrawQuote(params: WithdrawQuoteParams): Promise<NearIntentsQuote> {
  const client = getNearIntentsClient();
  if (!client) throw new Error('NEAR Intents not configured');

  const originAsset = SOLANA_ORIGIN_ASSETS[params.sourceSymbol];
  if (!originAsset) throw new Error(`Unsupported source token: ${params.sourceSymbol}`);

  const decimals = SOLANA_TOKENS[params.sourceSymbol].decimals;
  const baseAmount = toBaseUnits(params.amount, decimals);
  if (baseAmount === '0') {
    throw new Error('Amount is too small.');
  }

  return client.getQuote({
    originAsset,
    destinationAsset: params.destAssetId,
    amount: baseAmount,
    recipient: params.recipientAddress,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: params.refundWallet,
    refundType: 'ORIGIN_CHAIN',
    depositType: 'ORIGIN_CHAIN',
  });
}

/** Send SPL tokens from user's ZendPay wallet to NEAR Intents deposit address */
export async function fundNearIntentDeposit(
  walletEncryptedKey: string,
  sourceSymbol: 'USDT' | 'USDC',
  amount: number,
  depositAddress: string,
  rpcUrl: string
): Promise<string> {
  const secretKey = await decryptPrivateKey(walletEncryptedKey);
  const keypair = Keypair.fromSecretKey(secretKey);
  const walletService = new WalletService(rpcUrl);
  const mint = SOLANA_TOKENS[sourceSymbol].mint;
  const decimals = SOLANA_TOKENS[sourceSymbol].decimals;

  return walletService.sendSplToken(keypair, depositAddress, mint, amount, decimals);
}

export function formatChainName(chainKey: string): string {
  return CHAIN_DISPLAY_NAMES[chainKey] || chainKey;
}