import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, users, transactions } from '@zend/db';
import { eq } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { DEV_WALLET_SECRET, walletService } from '../deps.js';
import { mainMenu } from '../keyboards/index.js';
import { generateTxId } from '../lib/ids.js';
import { setSession } from '../session/store.js';
import type { ZendContext, ZendSession } from '../session/types.js';
import { decryptPrivateKey } from '../utils/wallet.js';
import { getSolPriceInUsdt } from '../utils/sol-price.js';
import { fundSolIfNeeded, gasFundingErrorToUserMessage } from './gas.js';
import { getSwapQuote, buildSwapTransaction, getTokenBySymbol, formatTokenAmount } from './jupiter.js';
import { indexTransaction } from './nlp.js';

export async function executeSwap(
  ctx: ZendContext,
  userId: string,
  pt: NonNullable<ZendSession['pendingTransaction']>
) {
  const fromSymbol = pt.fromSymbol as string;
  const toSymbol = pt.toSymbol as string;
  const quote = pt.swapQuote as any;
  const outAmount = pt.swapOutAmount as number;

  await ctx.reply('⏳ Converting...');

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0 || !user[0].walletEncryptedKey) {
      throw new Error('Account not found. Please run /start first.');
    }

    // Gas sponsorship for swaps
    const { funded, gasSponsored, shortfall, error: fundError } = await fundSolIfNeeded(user[0].walletAddress, undefined, undefined, undefined, userId);
    if (shortfall && !funded) {
      const userMsg = gasFundingErrorToUserMessage(fundError, shortfall);
      throw new Error(userMsg);
    }

    let txHash: string;
    const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    // ─── Local swap (AUDD pairs via dev wallet) ───
    if ((pt as any).isLocalSwap) {
      if (!DEV_WALLET_SECRET) throw new Error('Dev wallet not configured for local swap.');
      const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
      const fromDecimals = getTokenBySymbol(fromSymbol)!.decimals;
      const toDecimals = getTokenBySymbol(toSymbol)!.decimals;
      const fromAmount = Number(quote.inAmount) / Math.pow(10, fromDecimals);

      await ctx.replyWithChatAction('typing');
      txHash = await walletService.executeLocalSwap(
        keypair,
        devKeypair,
        pt.fromMint!,
        pt.toMint!,
        fromAmount,
        outAmount,
        fromDecimals,
        toDecimals,
        user[0].walletAddress
      );
      console.log('[LocalSwap] Executed:', txHash);

      // Collect gas sponsorship fee for local swaps (0.5% of output value, paid in SOL)
      if (gasSponsored) {
        const feeWallet = process.env.ZEND_FEE_WALLET;
        if (feeWallet) {
          try {
            const solPrice = await getSolPriceInUsdt();
            const sponsorshipFeeSol = (outAmount * 0.0005) / solPrice;
            await walletService.sendSol(keypair, feeWallet, sponsorshipFeeSol);
            console.log('[Gas] Local swap sponsorship fee collected:', sponsorshipFeeSol.toFixed(6), 'SOL');
          } catch (feeErr: any) {
            console.error('[Gas] Local swap fee collection failed (non-critical):', feeErr.message);
          }
        }
      }
    } else {
      // ─── Jupiter swap (non-AUDD pairs) ───
      const serializedTx = await buildSwapTransaction(quote, user[0].walletAddress, true);
      if (!serializedTx) {
        throw new Error('Failed to build swap transaction');
      }

      await ctx.replyWithChatAction('typing');
      txHash = await walletService.signAndSendSerialized(keypair, serializedTx);
      console.log('[Jupiter] Swap executed:', txHash);

      // Collect gas sponsorship fee for swaps (0.5% of output value, paid in SOL)
      if (gasSponsored) {
        const feeWallet = process.env.ZEND_FEE_WALLET;
        if (feeWallet) {
          try {
            const solPrice = await getSolPriceInUsdt();
            const sponsorshipFeeSol = (outAmount * 0.0005) / solPrice;
            await walletService.sendSol(keypair, feeWallet, sponsorshipFeeSol);
            console.log('[Gas] Swap sponsorship fee collected:', sponsorshipFeeSol.toFixed(6), 'SOL');
          } catch (feeErr: any) {
            console.error('[Gas] Swap fee collection failed (non-critical):', feeErr.message);
          }
        }
      }
    }

    // Record in DB
    const txId = generateTxId();
    const fromAmt = Number(quote.inAmount) / Math.pow(10, getTokenBySymbol(fromSymbol)!.decimals);
    await db.insert(transactions).values({
      id: txId,
      userId,
      type: 'swap',
      status: 'completed',
      fromMint: pt.fromMint,
      fromAmount: fromAmt.toString(),
      toMint: pt.toMint,
      toAmount: outAmount.toString(),
      solanaTxHash: txHash,
    });
    await indexTransaction(userId, txId, `Swapped ${fromAmt.toFixed(2)} ${fromSymbol} to ${outAmount.toFixed(2)} ${toSymbol}`, {
      fromAmount: fromAmt,
      toAmount: outAmount,
      fromToken: fromSymbol,
      toToken: toSymbol,
    });

    setSession(userId, { state: ConversationState.IDLE });

    await ctx.reply(
      `✅ *Conversion Complete!*\n\n` +
      `${formatTokenAmount(Number(quote.inAmount), getTokenBySymbol(fromSymbol)!.decimals)} ${fromSymbol} → ${outAmount.toFixed(2)} ${toSymbol}\n\n` +
      `View: [Transaction Details](https://solscan.io/tx/${txHash})\n` +
      `Reference: \`${txId}\``, 
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } catch (err: any) {
    console.error('[Swap] Failed:', err);
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.reply(
      `❌ *Swap Failed*\n\n` +
      `Error: ${err.message || 'Unknown error'}\n` +
      `No funds were deducted.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }
}