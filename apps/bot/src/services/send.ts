import { Keypair, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { db, users, transactions } from '@zend/db';
import { eq } from 'drizzle-orm';
import { SOLANA_TOKENS, NIGERIAN_BANKS } from '@zend/shared';
import { Chain, Currency, DEV_WALLET_SECRET, getPAJClient, getPajWebhookUrl, walletService } from '../deps.js';
import { generateTxId } from '../lib/ids.js';
import { getAuddPriceInUsdt } from './pricing.js';
import { indexTransaction } from './nlp.js';
import { decryptPrivateKey } from '../utils/wallet.js';
import { getSwapQuote, buildSwapTransaction } from './jupiter.js';
import { fundSolIfNeeded, gasFundingErrorToUserMessage } from './gas.js';
import {
  clearPajSession,
  getPajBankList,
  isPajSessionError,
  scoreBankMatch,
} from './paj.js';

export interface SendTxData {
  amountNgn: number;
  amountUsdt: number;
  ngnRate?: number;
  zendFeeUsdt?: number;
  feeSol?: number;
  fromMint?: string;
  recipientBankCode?: string;
  recipientBankName?: string;
  recipientAccountNumber?: string;
  recipientAccountName?: string;
  recipientName?: string;
}

export async function executeSendCore(
  userId: string,
  txData: SendTxData
): Promise<{ success: boolean; txId: string; solanaTxHash?: string; offRampRef?: string; error?: string }> {
  const userFromMint = txData.fromMint || SOLANA_TOKENS.USDT.mint;
  const userFromToken = Object.values(SOLANA_TOKENS).find(t => t.mint === userFromMint) || SOLANA_TOKENS.USDT;
  const userFromSymbol = userFromToken.symbol;
  const pajMint = SOLANA_TOKENS.USDT.mint; // PAJ only accepts USDT
  const pajToken = SOLANA_TOKENS.USDT;
  const finalAccountName = txData.recipientAccountName || txData.recipientName || 'Recipient';
  const finalBankName = txData.recipientBankName || 'Unknown';
  const finalBankCode = txData.recipientBankCode || 'UNKNOWN';
  const finalAccountNumber = txData.recipientAccountNumber || '0000000000';

  const txId = generateTxId();
  const feeUsdt = txData.zendFeeUsdt || 0;
  await db.insert(transactions).values({
    id: txId,
    userId,
    type: 'ngn_send',
    status: 'processing',
    ngnAmount: txData.amountNgn.toString(),
    ngnRate: (txData.ngnRate || 1550).toString(),
    fromAmount: txData.amountUsdt.toString(),
    fromMint: userFromMint,
    zendFeeUsdt: feeUsdt.toString(),
    recipientBankCode: finalBankCode,
    recipientBankName: finalBankName,
    recipientAccountNumber: finalAccountNumber,
    recipientAccountName: finalAccountName,
  });

  // Index for semantic search
  await indexTransaction(userId, txId, `Sent ₦${txData.amountNgn} to ${finalAccountName} at ${finalBankName}`, {
    amount: txData.amountNgn,
    bank: finalBankName,
    recipient: finalAccountName,
  });

  let offRampRef = 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  let solanaTxHash: string | undefined;

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0 || !user[0].walletEncryptedKey) {
      throw new Error('Account not found. Please run /start first.');
    }

    const pajClient = await getPAJClient();
    if (pajClient && user[0].pajSessionToken) {
      const pajBanks = await getPajBankList(user[0].pajSessionToken);
      const ourBank = NIGERIAN_BANKS.find(b => b.code === finalBankCode);

      // Use the same robust scoring as verifyBankAccount
      let bestMatch: { bank: any; score: number } | null = null;
      for (const pb of pajBanks) {
        const score = scoreBankMatch(pb.name, finalBankCode);
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { bank: pb, score };
        }
      }

      if (!bestMatch || bestMatch.score < 20) {
        console.log('[PAJ] Available banks for send:', pajBanks.map(b => b.name).join(', '));
        throw new Error(`Bank "${ourBank?.name}" not found on PAJ`);
      }

      const pajBank = bestMatch.bank;
      console.log(`[PAJ] Send bank matched: ${ourBank?.name} → ${pajBank.name} (score: ${bestMatch.score})`);

      const webhookUrl = getPajWebhookUrl();
      const order = await pajClient.createOfframp({
        bank: pajBank.id,
        accountNumber: finalAccountNumber,
        currency: Currency.NGN,
        fiatAmount: txData.amountNgn,
        mint: pajMint,
        chain: Chain.SOLANA,
        webhookURL: webhookUrl,
      } as any, user[0].pajSessionToken);

      offRampRef = order.id;
      console.log('[PAJ] Off-ramp order created:', order.id, 'deposit address:', order.address, 'amount:', order.amount);

      let tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, pajMint);

      // Auto-swap AUDD → USDT via local pool (hidden from user)
      if (userFromMint === SOLANA_TOKENS.AUDD.mint) {
        const auddBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.AUDD.mint);
        if (auddBalance <= 0) {
          throw new Error('No AUDD balance. Please deposit AUDD first.');
        }
        const usdtNeeded = order.amount;
        const auddRate = await getAuddPriceInUsdt();
        const auddNeeded = usdtNeeded / auddRate;
        if (auddBalance < auddNeeded) {
          throw new Error(`Not enough AUDD. You have ${auddBalance.toFixed(2)} AUDD but need ${auddNeeded.toFixed(2)} AUDD (rate: 1 AUDD = ${auddRate.toFixed(4)} USDT).`);
        }
        if (!DEV_WALLET_SECRET) {
          throw new Error('AUDD swap not available: dev wallet not configured.');
        }
        const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
        const devUsdtBalance = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.USDT.mint);
        if (devUsdtBalance < usdtNeeded) {
          throw new Error('AUDD swap not available: liquidity pool is low. Please try again later or contact support.');
        }
        const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
        const keypair = Keypair.fromSecretKey(secretKey);
        const swapTxHash = await walletService.executeLocalSwap(
          keypair,
          devKeypair,
          SOLANA_TOKENS.AUDD.mint,
          SOLANA_TOKENS.USDT.mint,
          auddNeeded,
          usdtNeeded,
          SOLANA_TOKENS.AUDD.decimals,
          SOLANA_TOKENS.USDT.decimals,
          user[0].walletAddress // dev sends USDT back to user wallet
        );
        console.log('[LocalSwap] AUDD→USDT:', swapTxHash);
        const swapTxId = generateTxId();
        await db.insert(transactions).values({
          id: swapTxId, userId, type: 'swap', status: 'completed',
          fromMint: SOLANA_TOKENS.AUDD.mint, fromAmount: auddNeeded.toString(),
          toMint: SOLANA_TOKENS.USDT.mint, toAmount: usdtNeeded.toString(),
          solanaTxHash: swapTxHash,
        });
        tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDT.mint);
      }

      // Auto-swap USDC → USDT if needed
      if (tokenBalance < order.amount) {
        const usdcBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDC.mint);
        if (usdcBalance >= order.amount) {
          const swapAmountUsdc = Math.min(usdcBalance, order.amount * 1.03);
          const swapAmountBase = Math.round(swapAmountUsdc * Math.pow(10, SOLANA_TOKENS.USDC.decimals));
          const quote = await getSwapQuote(SOLANA_TOKENS.USDC.mint, SOLANA_TOKENS.USDT.mint, swapAmountBase, 100);
          if (!quote) {
            throw new Error('Exchange not available right now. Please deposit Dollars (USDT).');
          }
          const outAmountUsdt = Number(quote.outAmount) / Math.pow(10, SOLANA_TOKENS.USDT.decimals);
          if (outAmountUsdt < order.amount) {
            throw new Error(`Conversion would only give ${outAmountUsdt.toFixed(2)} Dollars. Deposit more USDT.`);
          }
          const serializedTx = await buildSwapTransaction(quote, user[0].walletAddress, true);
          if (!serializedTx) throw new Error('Failed to build swap transaction.');
          const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
          const keypair = Keypair.fromSecretKey(secretKey);
          const swapTxHash = await walletService.signAndSendSerialized(keypair, serializedTx);
          console.log('[Jupiter] Auto-swap USDC→USDT:', swapTxHash);
          const swapTxId = generateTxId();
          await db.insert(transactions).values({
            id: swapTxId, userId, type: 'swap', status: 'completed',
            fromMint: SOLANA_TOKENS.USDC.mint, fromAmount: swapAmountUsdc.toString(),
            toMint: SOLANA_TOKENS.USDT.mint, toAmount: outAmountUsdt.toString(),
            solanaTxHash: swapTxHash,
          });
          await indexTransaction(userId, swapTxId, `Swapped ${swapAmountUsdc.toFixed(2)} USDC to ${outAmountUsdt.toFixed(2)} USDT`, {
            fromAmount: swapAmountUsdc,
            toAmount: outAmountUsdt,
            fromToken: 'USDC',
            toToken: 'USDT',
          });
          tokenBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.USDT.mint);
        }
      }

      const feeWallet = process.env.ZEND_FEE_WALLET;
      const feeUsdt = txData.zendFeeUsdt || 0;

      // Gas sponsorship: top up exact shortfall (including ATA rent if needed)
      const { funded, gasSponsored, shortfall, error: fundError } = await fundSolIfNeeded(
        user[0].walletAddress,
        order.address,
        pajMint,
        feeWallet || undefined,
        userId
      );
      if (shortfall && !funded) {
        const userMsg = gasFundingErrorToUserMessage(fundError, shortfall);
        throw new Error(userMsg);
      }

      // Check token balance covers transfer + fee
      const totalUsdtNeeded = order.amount + feeUsdt;
      if (tokenBalance < totalUsdtNeeded) {
        throw new Error(`Insufficient ${userFromSymbol} balance. You have: ${tokenBalance.toFixed(2)}, need: ${totalUsdtNeeded.toFixed(2)} for the transfer and fee.`);
      }

      // Build USDT fee transfer instruction to bundle with main send
      const feeInstructions: any[] = [];
      if (feeWallet && feeUsdt > 0) {
        const feeWalletPubkey = new PublicKey(feeWallet);
        const pajMintPubkey = new PublicKey(pajMint);
        const senderPubkey = new PublicKey(user[0].walletAddress);

        const senderTokenAccount = await getAssociatedTokenAddress(pajMintPubkey, senderPubkey);
        const feeWalletTokenAccount = await getAssociatedTokenAddress(pajMintPubkey, feeWalletPubkey);

        const rawFeeAmount = BigInt(Math.round(feeUsdt * Math.pow(10, pajToken.decimals)));

        feeInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            senderPubkey,
            feeWalletTokenAccount,
            feeWalletPubkey,
            pajMintPubkey
          ),
          createTransferInstruction(
            senderTokenAccount,
            feeWalletTokenAccount,
            senderPubkey,
            rawFeeAmount
          )
        );
      }

      const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      solanaTxHash = await walletService.sendSplToken(
        keypair, order.address, pajMint, order.amount, pajToken.decimals,
        feeInstructions.length > 0 ? feeInstructions : undefined,
        totalUsdtNeeded
      );
      console.log(`[Solana] ${userFromSymbol} sent to PAJ via USDT (+ USDT fee bundled):`, solanaTxHash);

      await db.update(transactions)
        .set({ solanaTxHash, pajReference: offRampRef })
        .where(eq(transactions.id, txId));
    } else {
      throw new Error(
        !user[0].pajSessionToken
          ? 'Your PAJ session is not linked. Please verify your identity in Settings first.'
          : 'Payment partner is temporarily unavailable. Please try again later.'
      );
    }

    setTimeout(async () => {
      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.id, txId));
    }, 3000);

    return { success: true, txId, solanaTxHash, offRampRef };
  } catch (err: any) {
    console.error('Off-ramp failed:', err);
    if (isPajSessionError(err)) {
      await clearPajSession(userId);
      return { success: false, txId, error: 'Your PAJ session expired. Please re-link in Settings.' };
    }
    // PAJ infrastructure error — no available deposit wallets
    const errMsg = (err?.message || '').toLowerCase();
    if (errMsg.includes('no available wallet') || errMsg.includes('no available deposit')) {
      return {
        success: false,
        txId,
        error: 'Our payment partner is temporarily at capacity. Please try again in 1–2 minutes. No funds were deducted.',
      };
    }
    await db.update(transactions)
      .set({ status: 'failed' })
      .where(eq(transactions.id, txId));
    return { success: false, txId, error: err.message || 'Unknown error' };
  }
}