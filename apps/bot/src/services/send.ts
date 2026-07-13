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
import { ensureUsdtBalance, getStablecoinBalances } from './stablecoin.js';
import { fundSolIfNeeded, gasFundingErrorToUserMessage, calculateSendFee } from './gas.js';
import {
  calcZendFeeUsdt,
  fitFeeToAvailableBalance,
  ZEND_FEE_NORMAL_BPS,
  ZEND_FEE_NORMAL_CAP_USDT,
} from '../utils/fees.js';
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
): Promise<{ success: boolean; txId: string; solanaTxHash?: string; offRampRef?: string; error?: string; finalFeeUsdt?: number }> {
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
    zendFeeUsdt: (txData.zendFeeUsdt || 0).toString(),
    recipientBankCode: finalBankCode,
    recipientBankName: finalBankName,
    recipientAccountNumber: finalAccountNumber,
    recipientAccountName: finalAccountName,
  });

  // Index for semantic search in the background — never block the send path on QVAC embed load
  void indexTransaction(userId, txId, `Sent ₦${txData.amountNgn} to ${finalAccountName} at ${finalBankName}`, {
    amount: txData.amountNgn,
    bank: finalBankName,
    recipient: finalAccountName,
  }).catch((err) => console.warn('[NLP] indexTransaction failed (non-blocking):', err?.message || err));

  let offRampRef = 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  let solanaTxHash: string | undefined;
  let finalFeeUsdt = txData.zendFeeUsdt || 0;

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

      const feeWallet = process.env.ZEND_FEE_WALLET?.trim() || undefined;

      // Pre-flight balance check BEFORE creating a PAJ order (avoids orphaned orders).
      // Quote is approximate (rate may differ from final PAJ amount by a few cents).
      if (userFromMint !== SOLANA_TOKENS.AUDD.mint) {
        const preBalances = await getStablecoinBalances(user[0].walletAddress);
        const preFee = await calculateSendFee(txData.amountUsdt, user[0].walletAddress, userId, {
          assumeRecipientAta: true,
        });
        // Need at least the transfer amount; fee can flex slightly after PAJ quotes.
        if (preBalances.total + 1e-9 < txData.amountUsdt) {
          throw new Error(
            `Insufficient Dollars. You need ~${(txData.amountUsdt + preFee.zendFeeUsdt).toFixed(2)} USDT ` +
            `(incl. ~${preFee.zendFeeUsdt.toFixed(2)} fee) for this bank transfer ` +
            `(you have ${preBalances.usdt.toFixed(2)} USDT + ${preBalances.usdc.toFixed(2)} USDC).`
          );
        }
      }

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

      // Recompute fee based on the actual PAJ order amount and real recipient address
      const feeInfo = await calculateSendFee(order.amount, user[0].walletAddress, userId, {
        recipientAddress: order.address,
      });
      finalFeeUsdt = feeInfo.zendFeeUsdt;

      // Auto-swap AUDD → USDT via local pool (hidden from user)
      if (userFromMint === SOLANA_TOKENS.AUDD.mint) {
        const auddBalance = await walletService.getTokenBalance(user[0].walletAddress, SOLANA_TOKENS.AUDD.mint);
        if (auddBalance <= 0) {
          throw new Error('No AUDD balance. Please deposit AUDD first.');
        }
        // Reserve enough for order + quoted fee (fee may be reduced slightly later)
        const usdtNeeded = order.amount + finalFeeUsdt;
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
      }

      // Ensure we hold enough USDT for the PAJ deposit first; fee fitted after.
      await ensureUsdtBalance(
        userId,
        user[0].walletAddress,
        user[0].walletEncryptedKey,
        order.amount,
        'bank transfer'
      );

      // Gas sponsorship: top up exact shortfall (including ATA rent if needed)
      const { funded, gasSponsored, shortfall, error: fundError } = await fundSolIfNeeded(
        user[0].walletAddress,
        order.address,
        pajMint,
        feeWallet,
        userId
      );
      if (shortfall && !funded) {
        const userMsg = gasFundingErrorToUserMessage(fundError, shortfall);
        throw new Error(userMsg);
      }

      // Quote may assume ATAs that already exist; only charge sponsorship if we actually funded SOL.
      if (!gasSponsored && !funded && !fundError) {
        const normalFee = calcZendFeeUsdt(order.amount, ZEND_FEE_NORMAL_BPS, ZEND_FEE_NORMAL_CAP_USDT);
        if (normalFee < finalFeeUsdt) {
          console.log(`[Gas] User had enough SOL; fee ${finalFeeUsdt.toFixed(4)} → ${normalFee.toFixed(4)} USDT`);
          finalFeeUsdt = normalFee;
        }
      }

      // Fit fee to actual USDT available so a 1–2¢ quote drift does not fail the whole send.
      const usdtAvailable = await walletService.getTokenBalance(user[0].walletAddress, pajMint);
      const fitted = fitFeeToAvailableBalance(order.amount, finalFeeUsdt, usdtAvailable);
      if (!fitted.ok) {
        throw new Error(
          `Insufficient Dollars. You need ${order.amount.toFixed(2)} USDT for this bank transfer ` +
          `(you have ${usdtAvailable.toFixed(2)} USDT).`
        );
      }
      if (fitted.feeReduced) {
        console.log(
          `[Fees] Reduced fee ${finalFeeUsdt.toFixed(6)} → ${fitted.feeUsdt.toFixed(6)} USDT ` +
          `to fit balance ${usdtAvailable.toFixed(6)} (order ${order.amount})`
        );
      }
      finalFeeUsdt = fitted.feeUsdt;
      const totalUsdtNeeded = fitted.totalUsdt;

      // Build USDT fee transfer instruction to bundle with main send
      // Fees go to ZEND_FEE_WALLET (NOT the gas-sponsor dev wallet, unless they are the same address).
      const feeInstructions: any[] = [];
      if (feeWallet && finalFeeUsdt > 0) {
        const feeWalletPubkey = new PublicKey(feeWallet);
        const pajMintPubkey = new PublicKey(pajMint);
        const senderPubkey = new PublicKey(user[0].walletAddress);

        const senderTokenAccount = await getAssociatedTokenAddress(pajMintPubkey, senderPubkey);
        const feeWalletTokenAccount = await getAssociatedTokenAddress(pajMintPubkey, feeWalletPubkey);

        const rawFeeAmount = BigInt(Math.round(finalFeeUsdt * Math.pow(10, pajToken.decimals)));

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
        console.log(`[Fees] Will collect ${finalFeeUsdt.toFixed(6)} USDT → fee wallet ${feeWallet}`);
      } else if (!feeWallet) {
        console.warn('[Fees] ZEND_FEE_WALLET unset — sending without on-chain fee transfer');
      } else {
        console.log('[Fees] Fee is 0 — no fee transfer instruction');
      }

      const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      solanaTxHash = await walletService.sendSplToken(
        keypair, order.address, pajMint, order.amount, pajToken.decimals,
        feeInstructions.length > 0 ? feeInstructions : undefined,
        totalUsdtNeeded
      );
      console.log(
        `[Solana] ${userFromSymbol} sent to PAJ via USDT` +
        (finalFeeUsdt > 0 ? ` (+ ${finalFeeUsdt.toFixed(6)} USDT fee → ${feeWallet})` : ' (no fee)') +
        `:`,
        solanaTxHash
      );

      await db.update(transactions)
        .set({
          solanaTxHash,
          pajReference: offRampRef,
          zendFeeUsdt: finalFeeUsdt.toString(),
          fromAmount: totalUsdtNeeded.toString(),
        })
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

    return { success: true, txId, solanaTxHash, offRampRef, finalFeeUsdt };
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