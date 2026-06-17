import { Markup } from 'telegraf';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { ConversationState, SOLANA_TOKENS } from '@zend/shared';
import { DEV_WALLET_SECRET, walletService } from '../deps.js';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { isGroupChat, promptPrivateChat } from '../lib/group.js';
import { getSession, setSession } from '../session/store.js';
import { getSwapQuote, getTokenBySymbol, formatTokenAmount } from '../services/jupiter.js';
import { executeSwap } from '../services/swap.js';
import { getAuddPriceInUsdt } from '../services/pricing.js';
import { AUDD_ENABLED, isAuddSwapPair } from '../utils/flags.js';
import { getSolPriceInUsdt } from '../utils/sol-price.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showSwapMenu(ctx: ZendContext, userId: string) {
  await ctx.reply(
    `🔄 *Convert Currency*\n\n` +
    `Exchange money in your account instantly.\n\n` +
    `Select a pair:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('SOL → USDT', 'swap:SOL:USDT')],
        [Markup.button.callback('USDC → USDT', 'swap:USDC:USDT')],
        [Markup.button.callback('USDT → SOL', 'swap:USDT:SOL')],
        ...(AUDD_ENABLED
          ? [
              [Markup.button.callback('SOL → AUDD', 'swap:SOL:AUDD')],
              [Markup.button.callback('AUDD → SOL', 'swap:AUDD:SOL')],
              [Markup.button.callback('USDT → AUDD', 'swap:USDT:AUDD')],
              [Markup.button.callback('AUDD → USDT', 'swap:AUDD:USDT')],
            ]
          : []),
        [Markup.button.callback('NEAR → USDT', 'swap:NEAR:USDT')],
        [Markup.button.callback('USDT → NEAR', 'swap:USDT:NEAR')],
        [Markup.button.callback('NEAR → SOL', 'swap:NEAR:SOL')],
        [Markup.button.callback('SOL → NEAR', 'swap:SOL:NEAR')],
        [Markup.button.callback('❌ Cancel', 'cancel_swap')],
      ]),
    }
  );
}

export async function handleSwapAmount(ctx: ZendContext, userId: string, text: string) {
  const session = getSession(userId);
  const pt = session.pendingTransaction;
  if (!pt?.fromMint || !pt.toMint || !pt.fromSymbol || !pt.toSymbol || !pt.fromDecimals) {
    await ctx.reply('❌ Session expired. Please start over.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const amount = parseFloat(text.trim());
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Please enter a valid amount. Example: 0.1, 1, 10', cancelKeyboard);
    return;
  }

  const fromToken = getTokenBySymbol(pt.fromSymbol as string)!;
  const toToken = getTokenBySymbol(pt.toSymbol as string)!;
  const amountBase = Math.round(amount * Math.pow(10, pt.fromDecimals as number));

  const isAuddPair = pt.fromMint === SOLANA_TOKENS.AUDD.mint || pt.toMint === SOLANA_TOKENS.AUDD.mint;
  if (isAuddPair) {
    await ctx.replyWithChatAction('typing');
    try {
      const solPrice = await getSolPriceInUsdt();
      const auddPrice = await getAuddPriceInUsdt();

      let outAmount = 0;
      if (pt.fromMint === SOLANA_TOKENS.SOL.mint && pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        outAmount = amount * solPrice / auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.AUDD.mint && pt.toMint === SOLANA_TOKENS.SOL.mint) {
        outAmount = amount * auddPrice / solPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.USDT.mint && pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        outAmount = amount / auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.AUDD.mint && pt.toMint === SOLANA_TOKENS.USDT.mint) {
        outAmount = amount * auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.USDC.mint && pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        outAmount = amount / auddPrice;
      } else if (pt.fromMint === SOLANA_TOKENS.AUDD.mint && pt.toMint === SOLANA_TOKENS.USDC.mint) {
        outAmount = amount * auddPrice;
      }

      if (!DEV_WALLET_SECRET) {
        await ctx.reply('❌ AUDD swap not available: dev wallet not configured.', mainMenu);
        setSession(userId, { state: ConversationState.IDLE });
        return;
      }
      const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));

      if (pt.toMint === SOLANA_TOKENS.AUDD.mint) {
        const devBal = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.AUDD.mint);
        if (devBal < outAmount) {
          await ctx.reply(`❌ AUDD liquidity is low. Only ${devBal.toFixed(2)} AUDD available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      } else if (pt.toMint === SOLANA_TOKENS.USDT.mint) {
        const devBal = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.USDT.mint);
        if (devBal < outAmount) {
          await ctx.reply(`❌ USDT liquidity is low. Only ${devBal.toFixed(2)} USDT available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      } else if (pt.toMint === SOLANA_TOKENS.USDC.mint) {
        const devBal = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.USDC.mint);
        if (devBal < outAmount) {
          await ctx.reply(`❌ USDC liquidity is low. Only ${devBal.toFixed(2)} USDC available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      } else if (pt.toMint === SOLANA_TOKENS.SOL.mint) {
        const devBal = await walletService.getSolBalance(devKeypair.publicKey.toBase58());
        if (devBal < outAmount) {
          await ctx.reply(`❌ SOL liquidity is low. Only ${devBal.toFixed(4)} SOL available in pool.`, mainMenu);
          setSession(userId, { state: ConversationState.IDLE });
          return;
        }
      }

      const outAmountBase = Math.round(outAmount * Math.pow(10, toToken.decimals));
      session.pendingTransaction = {
        ...pt,
        swapAmountBase: amountBase,
        swapQuote: { outAmount: String(outAmountBase), inAmount: String(amountBase), otherAmountThreshold: String(outAmountBase), priceImpactPct: '0' },
        swapOutAmount: outAmount,
        swapMinOut: outAmount,
        swapPriceImpact: 0,
        isLocalSwap: true,
      };
      session.state = ConversationState.AWAITING_CONFIRMATION;
      setSession(userId, session);

      let msg = `🔄 *Exchange Rate (Local Swap)*\n\n`;
      msg += `${amount.toFixed(fromToken.decimals === 9 ? 4 : 2)} ${fromToken.symbol} → ${outAmount.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
      msg += `Rate: 1 ${fromToken.symbol} ≈ ${(outAmount / amount).toFixed(6)} ${toToken.symbol}\n`;
      msg += `Price impact: 0%\n\n`;
      msg += `Confirm?`;

      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm Swap', 'confirm_swap')],
          [Markup.button.callback('❌ Cancel', 'cancel_swap')],
        ]),
      });
      return;
    } catch (err: any) {
      await ctx.reply(`❌ Could not calculate local swap rate: ${err.message}`, mainMenu);
      setSession(userId, { state: ConversationState.IDLE });
      return;
    }
  }

  await ctx.replyWithChatAction('typing');
  const quote = await getSwapQuote(pt.fromMint, pt.toMint, amountBase, 50);

  if (!quote) {
    await ctx.reply('❌ Could not get an exchange rate. Not enough available right now. Please try again later.', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const outAmount = Number(quote.outAmount) / Math.pow(10, toToken.decimals);
  const minOut = Number(quote.otherAmountThreshold) / Math.pow(10, toToken.decimals);
  const priceImpact = parseFloat(quote.priceImpactPct);

  session.pendingTransaction = {
    ...pt,
    swapAmountBase: amountBase,
    swapQuote: quote,
    swapOutAmount: outAmount,
    swapMinOut: minOut,
    swapPriceImpact: priceImpact,
  };
  session.state = ConversationState.AWAITING_CONFIRMATION;
  setSession(userId, session);

  let msg = `🔄 *Exchange Rate*\n\n`;
  msg += `${formatTokenAmount(Number(quote.inAmount), fromToken.decimals)} ${fromToken.symbol} → ${outAmount.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
  msg += `Minimum you'll get: ${minOut.toFixed(toToken.decimals === 9 ? 4 : 2)} ${toToken.symbol}\n`;
  msg += `Price impact: ${priceImpact < 0.01 ? '<0.01%' : priceImpact.toFixed(2) + '%'}\n`;
  msg += `Price protection: 0.5%\n\n`;
  msg += `Confirm?`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm Swap', 'confirm_swap')],
      [Markup.button.callback('❌ Cancel', 'cancel_swap')],
    ]),
  });
}

export function registerSwapHandlers({ bot: b }: HandlerContext): void {
  b.hears('🔄 Swap', async (ctx) => {
    if (isGroupChat(ctx)) {
      await promptPrivateChat(ctx, 'swap tokens');
      return;
    }
    const userId = ctx.from.id.toString();
    await showSwapMenu(ctx, userId);
  });

  b.action(/swap:([A-Z]+):([A-Z]+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    const fromSymbol = ctx.match[1];
    const toSymbol = ctx.match[2];

    if (!AUDD_ENABLED && isAuddSwapPair(fromSymbol, toSymbol)) {
      await ctx.editMessageText('❌ AUDD swaps are not available right now.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    const fromToken = getTokenBySymbol(fromSymbol);
    const toToken = getTokenBySymbol(toSymbol);
    if (!fromToken || !toToken) {
      await ctx.editMessageText('❌ Invalid pair selected.');
      return;
    }

    setSession(userId, {
      state: ConversationState.AWAITING_SWAP_AMOUNT,
      pendingTransaction: {
        fromMint: fromToken.mint,
        toMint: toToken.mint,
        fromSymbol: fromToken.symbol,
        toSymbol: toToken.symbol,
        fromDecimals: fromToken.decimals,
      },
    });

    await ctx.editMessageText(
      `🔄 *Convert ${fromSymbol} → ${toSymbol}*\n\n` +
      `How much ${fromSymbol} do you want to convert?\n\n` +
      `Example: 0.1, 1, 10`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', 'cancel_swap')],
        ]),
      }
    );
  });

  b.action('cancel_swap', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.editMessageText('❌ Swap cancelled.');
    await ctx.reply('Menu:', mainMenu);
  });

  b.action('confirm_swap', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();

    if (isGroupChat(ctx)) {
      await promptPrivateChat(ctx, 'swap tokens');
      return;
    }

    const session = getSession(userId);

    if (session.state !== ConversationState.AWAITING_CONFIRMATION || !session.pendingTransaction?.swapQuote) {
      await ctx.editMessageText('❌ Session expired. Please start over.');
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user.length === 0) {
      await ctx.reply('Please run /start first.', mainMenu);
      return;
    }

    if (user[0].transactionPin) {
      setSession(userId, { ...session, state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'swap' });
      await ctx.editMessageText(
        `🔐 *Security Check*\n\n` +
        `Enter your 4-digit PIN to confirm this swap:`,
        { parse_mode: 'Markdown' }
      );
      const waitMsg = await ctx.reply('Waiting for PIN...', cancelKeyboard);
      getSession(userId).lastBotMessageId = waitMsg.message_id;
      return;
    }

    await executeSwap(ctx, userId, session.pendingTransaction);
  });
}