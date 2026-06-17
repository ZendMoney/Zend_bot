import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { SOLANA_TOKENS, PAJ_MIN_DEPOSIT_NGN } from '@zend/shared';
import { Currency, Chain, getPAJClient, getPajWebhookUrl } from '../deps.js';
import { mainMenu } from '../keyboards/index.js';
import { AUDD_ENABLED } from '../utils/flags.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showReceive(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const walletAddress = user[0].walletAddress;
  let virtualAccount = user[0].virtualAccount as any;

  const hasPajSession = user[0]?.pajSessionToken && user[0]?.pajSessionExpiresAt && new Date(user[0].pajSessionExpiresAt) > new Date();
  if (hasPajSession) {
    const pajClient = await getPAJClient();
    if (pajClient) {
      try {
        const order = await pajClient.createOnramp({
          fiatAmount: PAJ_MIN_DEPOSIT_NGN,
          currency: Currency.NGN,
          recipient: walletAddress,
          mint: SOLANA_TOKENS.USDT.mint,
          chain: Chain.SOLANA,
          webhookURL: getPajWebhookUrl(),
        }, user[0].pajSessionToken!);

        virtualAccount = {
          bankCode: 'WEM',
          bankName: order.bank,
          accountNumber: order.accountNumber,
          accountName: order.accountName,
          orderId: order.id,
          amount: PAJ_MIN_DEPOSIT_NGN,
          createdAt: new Date().toISOString(),
        };

        await db.update(users)
          .set({ virtualAccount })
          .where(eq(users.id, userId));

        console.log('[PAJ] Fresh VA generated on Receive:', order.accountNumber);
      } catch (err: any) {
        console.error('[PAJ] Refresh VA on Receive failed:', err);
      }
    }
  }

  const hasVA = virtualAccount?.accountNumber;

  let msg = `📥 *Receive Money*\n\n`;
  msg += `Choose how you want to get paid:\n\n`;

  msg += `*🪙 Crypto*\n`;
  msg += `Send Dollars (USDT/USDC)${AUDD_ENABLED ? ', AUDD' : ''} or SOL to:\n`;
  msg += `${walletAddress}\n\n`;

  if (hasVA) {
    msg += `*🇳🇬 Naira (Bank Transfer)*\n`;
    msg += `Send NGN to your virtual account:\n\n`;
    msg += `🏦 *Bank:* ${virtualAccount.bankName || 'ZendPay Bank'}\n`;
    msg += `👤 *Name:* ${virtualAccount.accountName || user[0].firstName + ' ' + (user[0].lastName || '')}\n`;
    msg += `🔢 *Number:* \`${virtualAccount.accountNumber}\`\n\n`;
  } else {
    msg += `*🇳🇬 Naira (Bank Transfer)*\n`;
    msg += `You don't have a virtual account yet.\n`;
    msg += `Tap *💵 Add Naira* below to create one.\n\n`;
  }

  msg += `\n*🌉 From Other Apps*\n`;
  msg += `Send Dollars from Binance, MetaMask, Trust Wallet, etc. → receive in your ZendPay account.\n\n`;

  msg += `💡 *Crypto arrives instantly*\n`;
  msg += `⏱️ *Naira takes 2–5 minutes* after bank transfer`;

  const kbRows: any[] = [];
  kbRows.push([{ text: '📋 Copy Crypto Address', copy_text: { text: walletAddress } } as any]);
  if (hasVA) {
    kbRows.push([{ text: '📋 Copy Account Number', copy_text: { text: virtualAccount.accountNumber } } as any]);
  } else {
    kbRows.push([Markup.button.callback('💵 Add Naira', 'add_naira_start')]);
  }
  if (AUDD_ENABLED) {
    kbRows.push([Markup.button.callback('🇦🇺 Add AUDD', 'add_aud_start')]);
  }
  kbRows.push([Markup.button.callback('🌉 Receive from Other Apps', 'bridge_start')]);
  kbRows.push([Markup.button.callback('📤 Send to Other Apps', 'withdraw_start')]);

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(kbRows),
  });
}

export function registerReceiveHandlers({ bot: b }: HandlerContext): void {
  b.hears('📥 Receive', async (ctx) => {
    await showReceive(ctx, ctx.from.id.toString());
  });
}