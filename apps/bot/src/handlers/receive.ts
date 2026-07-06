import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { mainMenu } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';
import { AUDD_ENABLED } from '../utils/flags.js';
import { startAddNaira } from './onramp.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showReceive(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const walletAddress = user[0].walletAddress;
  const virtualAccount = user[0].virtualAccount as any;
  const hasVA = virtualAccount?.accountNumber;

  let msg = `📥 *Receive Money*\n\n`;
  msg += `Choose how you want to get paid:\n\n`;

  msg += `*🪙 Crypto*\n`;
  msg += `Send Dollars (USDT/USDC)${AUDD_ENABLED ? ', AUDD' : ''} or SOL to:\n`;
  msg += `${walletAddress}\n\n`;

  if (hasVA) {
    msg += `*🇳🇬 Naira (Bank Transfer)*\n`;
    msg += `Send NGN to your virtual account:\n\n`;
    if (virtualAccount.amount) {
      msg += `💰 *Amount for this account:* ${formatNgn(Number(virtualAccount.amount))}\n\n`;
    }
    msg += `🏦 *Bank:* ${virtualAccount.bankName || 'ZendPay Bank'}\n`;
    msg += `👤 *Name:* ${virtualAccount.accountName || user[0].firstName + ' ' + (user[0].lastName || '')}\n`;
    msg += `🔢 *Number:* \`${virtualAccount.accountNumber}\`\n\n`;
    msg += `Need a different amount? Tap *Add Different Naira Amount* below.\n\n`;
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
    kbRows.push([Markup.button.callback('💵 Add Different Naira Amount', 'receive_naira_amount')]);
  } else {
    kbRows.push([Markup.button.callback('💵 Add Naira', 'add_naira_start')]);
  }
  if (AUDD_ENABLED) {
    kbRows.push([Markup.button.callback('🇦🇺 Add AUDD', 'add_aud_start')]);
  }
  kbRows.push([Markup.button.callback('🌉 Receive from Other Apps', 'bridge_start')]);

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(kbRows),
  });
}

export function registerReceiveHandlers({ bot: b }: HandlerContext): void {
  b.hears('📥 Receive', async (ctx) => {
    await showReceive(ctx, ctx.from.id.toString());
  });

  b.action('receive_naira_amount', async (ctx) => {
    await ctx.answerCbQuery();
    await startAddNaira(ctx, ctx.from!.id.toString());
  });
}