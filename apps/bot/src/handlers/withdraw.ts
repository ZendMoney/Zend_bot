import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { getNearIntentsClient, NEAR_INTENTS_ASSETS, CHAIN_DISPLAY_NAMES } from '@zend/near-intents-client';
import { ConversationState } from '@zend/shared';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { isGroupChat, promptPrivateChat } from '../lib/group.js';
import { getSession, setSession } from '../session/store.js';
import {
  WITHDRAW_CHAINS,
  getDestinationAssetId,
  formatChainName,
} from '../services/near-intents-flow.js';
import { executeNearIntentWithdraw } from './withdraw-execute.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showWithdrawMenu(ctx: ZendContext, userId: string) {
  const nearIntents = getNearIntentsClient();
  if (!nearIntents) {
    await ctx.reply(
      `📤 *Send to Other Apps*\n\n` +
      `⚠️ Cross-chain withdrawals are not configured.\n` +
      `Contact support or try again later.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  const rows: any[] = [];
  for (let i = 0; i < WITHDRAW_CHAINS.length; i += 2) {
    const row = [
      Markup.button.callback(CHAIN_DISPLAY_NAMES[WITHDRAW_CHAINS[i]], `withdraw_chain:${WITHDRAW_CHAINS[i]}`),
    ];
    if (WITHDRAW_CHAINS[i + 1]) {
      row.push(Markup.button.callback(CHAIN_DISPLAY_NAMES[WITHDRAW_CHAINS[i + 1]], `withdraw_chain:${WITHDRAW_CHAINS[i + 1]}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('❌ Cancel', 'cancel_withdraw')]);

  await ctx.reply(
    `📤 *Send to Other Apps*\n\n` +
    `Send Dollars from Zend to Binance, MetaMask, Trust Wallet, etc.\n\n` +
    `Select destination chain:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
}


export function registerWithdrawHandlers({ bot: b }: HandlerContext): void {

  b.action('withdraw_start', async (ctx) => {
  await ctx.answerCbQuery();
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'send crypto to other apps');
    return;
  }
  await showWithdrawMenu(ctx, ctx.from!.id.toString());
});

  b.action(/withdraw_chain:([a-z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainKey = ctx.match[1];
  const assets = NEAR_INTENTS_ASSETS[chainKey];
  if (!assets) {
    await ctx.editMessageText('❌ Unsupported chain.');
    return;
  }

  const buttons: any[] = Object.keys(assets).map(symbol =>
    Markup.button.callback(symbol, `withdraw_dest:${chainKey}:${symbol}`)
  );

  await ctx.editMessageText(
    `📤 *Send to ${formatChainName(chainKey)}*\n\n` +
    `What token should the recipient receive?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        buttons,
        [Markup.button.callback('← Back', 'withdraw_back')],
        [Markup.button.callback('❌ Cancel', 'cancel_withdraw')],
      ]),
    }
  );
});

  b.action('withdraw_back', async (ctx) => {
  await ctx.answerCbQuery();
  await showWithdrawMenu(ctx, ctx.from!.id.toString());
});

  b.action(/withdraw_dest:([a-z]+):([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const destToken = ctx.match[2];
  const destAssetId = getDestinationAssetId(chainKey, destToken);
  if (!destAssetId) {
    await ctx.editMessageText(`❌ ${destToken} is not supported on ${formatChainName(chainKey)}.`);
    return;
  }

  setSession(userId, {
    state: ConversationState.IDLE,
    withdrawData: { destChain: chainKey, destToken, destAssetId, sourceSymbol: 'USDT' },
  });

  await ctx.editMessageText(
    `📤 *Send to ${formatChainName(chainKey)}*\n\n` +
    `Recipient receives: *${destToken}*\n\n` +
    `Pay from your Zend balance:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('USDT', `withdraw_source:USDT`)],
        [Markup.button.callback('USDC', `withdraw_source:USDC`)],
        [Markup.button.callback('← Back', `withdraw_chain:${chainKey}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_withdraw')],
      ]),
    }
  );
});

  b.action(/withdraw_source:(USDT|USDC)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const sourceSymbol = ctx.match[1] as 'USDT' | 'USDC';
  const session = getSession(userId);
  if (!session.withdrawData) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    return;
  }

  setSession(userId, {
    ...session,
    state: ConversationState.AWAITING_WITHDRAW_RECIPIENT,
    withdrawData: { ...session.withdrawData, sourceSymbol },
  });

  await ctx.editMessageText(
    `📤 *Send ${sourceSymbol} → ${session.withdrawData.destToken}*\n` +
    `To: *${formatChainName(session.withdrawData.destChain)}*\n\n` +
    `Enter the recipient's wallet address on ${formatChainName(session.withdrawData.destChain)}:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_withdraw')]]) }
  );
});

  b.action('cancel_withdraw', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Cancelled.');
});

  b.action('confirm_withdraw', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'send crypto to other apps');
    return;
  }

  const session = getSession(userId);
  if (!session.withdrawData?.amount || !session.withdrawData.depositAddress) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  if (user[0].transactionPin) {
    setSession(userId, { ...session, state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'withdraw' });
    await ctx.editMessageText(
      `🔐 *Security Check*\n\nEnter your 4-digit PIN to confirm this withdrawal:`,
      { parse_mode: 'Markdown' }
    );
    const waitMsg = await ctx.reply('Waiting for PIN...', cancelKeyboard);
    getSession(userId).lastBotMessageId = waitMsg.message_id;
    return;
  }

  await executeNearIntentWithdraw(ctx, userId);
});
}
