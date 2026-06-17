import { Markup } from 'telegraf';
import { getNearIntentsClient, NEAR_INTENTS_ASSETS, CHAIN_DISPLAY_NAMES } from '@zend/near-intents-client';
import { ConversationState } from '@zend/shared';
import { mainMenu } from '../keyboards/index.js';
import { setSession } from '../session/store.js';
import { DEPOSIT_CHAINS, SOLANA_DEST_ASSETS } from '../services/near-intents-flow.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showBridgeMenu(ctx: ZendContext, userId: string) {
  const nearIntents = getNearIntentsClient();
  if (!nearIntents) {
    await ctx.reply(
      `🌉 *Deposit from Other Apps*\n\n` +
      `Receive Dollars from Binance, MetaMask, or any app.\n\n` +
      `⚠️ *Service not configured.*\n\n` +
      `For now, use:\n` +
      `• 💵 *Add Naira* — NGN bank transfer → Dollars\n` +
      `• 📥 *Receive* — Direct crypto deposit`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  const rows: any[] = [];
  for (let i = 0; i < DEPOSIT_CHAINS.length; i += 2) {
    const row = [
      Markup.button.callback(CHAIN_DISPLAY_NAMES[DEPOSIT_CHAINS[i]], `bridge_chain:${DEPOSIT_CHAINS[i]}`),
    ];
    if (DEPOSIT_CHAINS[i + 1]) {
      row.push(Markup.button.callback(CHAIN_DISPLAY_NAMES[DEPOSIT_CHAINS[i + 1]], `bridge_chain:${DEPOSIT_CHAINS[i + 1]}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('❌ Cancel', 'cancel_bridge')]);

  await ctx.reply(
    `🌉 *Deposit from Other Apps*\n\n` +
    `Send crypto from any wallet → receive Dollars in Zend via NEAR Intents.\n\n` +
    `Select the chain you're sending from:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    }
  );
}


export function registerBridgeHandlers({ bot: b }: HandlerContext): void {
  b.action('bridge_start', async (ctx) => {
    await ctx.answerCbQuery();
    await showBridgeMenu(ctx, ctx.from!.id.toString());
  });


  b.command('bridge', async (ctx) => {
  await showBridgeMenu(ctx, ctx.from.id.toString());
});

// Step 2: After chain selected, show token options
  b.action(/bridge_chain:([a-z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainKey = ctx.match[1];
  const assets = NEAR_INTENTS_ASSETS[chainKey];
  if (!assets) {
    await ctx.editMessageText('❌ Unsupported chain.');
    return;
  }

  const chainDisplay = CHAIN_DISPLAY_NAMES[chainKey] || chainKey;
  const buttons: any[] = [];
  for (const symbol of Object.keys(assets)) {
    buttons.push(Markup.button.callback(symbol, `bridge:${chainKey}:${symbol}`));
  }

  await ctx.editMessageText(
    `🌉 *Deposit from Other Apps*\n\n` +
    `From: *${chainDisplay}*\n\n` +
    `What are you sending?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        buttons,
        [Markup.button.callback('← Back', 'bridge_back')],
        [Markup.button.callback('❌ Cancel', 'cancel_bridge')],
      ]),
    }
  );
});

  b.action('bridge_back', async (ctx) => {
  await ctx.answerCbQuery();
  await showBridgeMenu(ctx, ctx.from!.id.toString());
});

  b.action(/bridge:([a-z]+):([A-Z]+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const token = ctx.match[2];

  const assetId = NEAR_INTENTS_ASSETS[chainKey]?.[token];
  if (!assetId) {
    await ctx.editMessageText(`❌ ${token} is not supported from ${CHAIN_DISPLAY_NAMES[chainKey] || chainKey} yet.`);
    return;
  }

  const chainDisplay = CHAIN_DISPLAY_NAMES[chainKey] || chainKey;

  // Store partial bridge data and ask for destination token
  setSession(userId, {
    state: ConversationState.IDLE,
    bridgeData: { chainKey, sourceChain: chainKey, token, assetId },
  });

  await ctx.editMessageText(
    `🌉 *Deposit from Other Apps*\n\n` +
    `From: *${chainDisplay}*\n` +
    `Currency: *${token}*\n\n` +
    `Receive in Zend as:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('USDT', `bridge_dest:${chainKey}:${token}:USDT`)],
        [Markup.button.callback('USDC', `bridge_dest:${chainKey}:${token}:USDC`)],
        [Markup.button.callback('← Back', `bridge_chain:${chainKey}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_bridge')],
      ]),
    }
  );
});

  b.action(/bridge_dest:([a-z]+):([A-Z]+):(USDT|USDC)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const chainKey = ctx.match[1];
  const token = ctx.match[2];
  const destSymbol = ctx.match[3];

  const assetId = NEAR_INTENTS_ASSETS[chainKey]?.[token];
  if (!assetId) {
    await ctx.editMessageText(`❌ ${token} is not supported from ${CHAIN_DISPLAY_NAMES[chainKey] || chainKey} yet.`);
    return;
  }

  const destinationAsset = SOLANA_DEST_ASSETS[destSymbol];
  if (!destinationAsset) {
    await ctx.editMessageText(`❌ ${destSymbol} is not supported as a receive token.`);
    return;
  }

  setSession(userId, {
    state: ConversationState.AWAITING_BRIDGE_AMOUNT,
    bridgeData: { chainKey, sourceChain: chainKey, token, assetId, destinationAsset, destinationSymbol: destSymbol },
  });

  await ctx.editMessageText(
    `🌉 *Deposit from Other Apps*\n\n` +
    `From: *${CHAIN_DISPLAY_NAMES[chainKey] || chainKey}*\n` +
    `Currency: *${token}*\n` +
    `Receive as: *${destSymbol}*\n\n` +
    `How much ${token} do you want to deposit?\n\n` +
    `Examples:\n` +
    `• 10\n` +
    `• 50\n` +
    `• 100`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_bridge')]]) }
  );
});

  b.action('cancel_bridge', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.IDLE });
  await ctx.editMessageText('❌ Cancelled.');
});
}
