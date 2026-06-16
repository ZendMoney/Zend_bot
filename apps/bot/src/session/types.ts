import type { Context } from 'telegraf';
import { ConversationState } from '@zend/shared';

export interface ZendSession {
  state: ConversationState;
  pendingTransaction?: Partial<{
    amountNgn: number;
    amountUsdt: number;
    recipientName: string;
    recipientBankCode: string;
    recipientBankName: string;
    recipientAccountNumber: string;
    recipientAccountName: string;
    recipientWalletAddress: string;
    zendFeeUsdt?: number;
    feeSol?: number;
    ngnRate?: number;
    fromMint?: string;
    toMint?: string;
    fromSymbol?: string;
    toSymbol?: string;
    fromDecimals?: number;
    swapAmountBase?: number;
    swapQuote?: any;
    swapOutAmount?: number;
    swapMinOut?: number;
    swapPriceImpact?: number;
    isLocalSwap?: boolean;
  }>;
  pinVerifyAction?: 'swap' | 'export' | 'withdraw' | 'send' | 'bulk_send' | 'schedule';
  withdrawData?: {
    destChain: string;
    destToken: string;
    destAssetId: string;
    sourceSymbol: 'USDT' | 'USDC';
    recipientAddress?: string;
    amount?: number;
    depositAddress?: string;
    txId?: string;
    amountOutFormatted?: string;
  };
  pajContact?: string;
  onrampAmount?: number;
  onrampTargetToken?: 'USDT' | 'AUDD';
  voiceAnalysis?: {
    text: string;
    amount: number | null;
    recipientName: string | null;
    bankCode: string | null;
    bankName: string | null;
    accountNumber: string | null;
    walletAddress: string | null;
  };
  scheduleData?: {
    recipientBankAccountId?: number;
    recipientName?: string;
    bankName?: string;
    accountNumber?: string;
    amountNgn?: number;
    frequency?: 'once' | 'daily' | 'weekly' | 'monthly';
    startAt?: Date;
    pendingAccountNumber?: string;
  };
  bridgeData?: {
    chainKey: string;
    sourceChain: string;
    token: string;
    assetId: string;
    destinationAsset?: string;
    destinationSymbol?: string;
  };
  billData?: {
    type?: 'airtime' | 'data' | 'electricity' | 'cable';
    network?: string;
    phone?: string;
    planCode?: string;
    planId?: string;
    planAmount?: number;
    disco?: string;
    meterNumber?: string;
    meterType?: 'prepaid' | 'postpaid';
    provider?: string;
    smartCardNumber?: string;
    bouquetCode?: string;
    bouquetAmount?: number;
    amount?: number;
  };
  lastBotMessageId?: number;
}

export interface ZendContext extends Context {
  session: ZendSession;
}