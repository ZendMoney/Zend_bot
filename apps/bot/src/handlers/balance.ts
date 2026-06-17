import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { walletService } from '../deps.js';
import { mainMenu } from '../keyboards/index.js';
import { formatBalance, formatNgn } from '../lib/format.js';
import { showLoading, finishLoading } from '../lib/loading.js';
import { isGroupChat } from '../lib/group.js';
import { getPAJRates } from '../services/paj.js';
import { getSolPriceInUsdt } from '../utils/sol-price.js';
import { AUDD_ENABLED } from '../utils/flags.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function buildBalanceMessage(userId: string): Promise<string | null> {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) return null;

  const walletAddress = user[0].walletAddress;
  try {
    const balances = await walletService.getAllBalances(walletAddress);
    const rates = await getPAJRates();
    const offRampRate = rates.offRampRate;
    const solPrice = await getSolPriceInUsdt();

    let msg = `💰 *Your Balance*\n\n`;
    let totalNgn = 0;

    for (const bal of balances) {
      if (!AUDD_ENABLED && bal.symbol === 'AUDD') continue;
      let ngnEquiv = 0;
      if (bal.symbol === 'SOL') {
        ngnEquiv = bal.amount * solPrice * offRampRate;
      } else {
        ngnEquiv = bal.amount * offRampRate;
      }
      totalNgn += ngnEquiv;
      const emoji = bal.symbol === 'SOL' ? '🔵' : bal.symbol === 'USDT' ? '🟢' : bal.symbol === 'AUDD' ? '🇦🇺' : bal.symbol === 'NEAR' ? '⚡' : '🟡';
      msg += `${emoji} *${bal.symbol}*  ${formatBalance(bal.amount, bal.symbol)}  (≈${formatNgn(ngnEquiv)})\n`;
    }

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💵 Total: ≈${formatNgn(totalNgn)}\n`;
    msg += `📈 Rate: ${formatNgn(offRampRate)} per Dollar`;
    return msg;
  } catch (err: any) {
    console.error('Balance error:', err);
    const isRateLimit = err?.message?.includes('429') || err?.message?.includes('Too many requests');
    if (isRateLimit) {
      return `⏳ *Rate Limited*\n\nThe Solana network is busy right now. Please wait a few seconds and tap *Balance* again.`;
    }
    return null;
  }
}

export async function handleBalance(ctx: ZendContext, userId: string) {
  const loading = await showLoading(ctx, 'Fetching your balance...');

  const msg = await buildBalanceMessage(userId);
  if (!msg) {
    await finishLoading(ctx, loading.message_id, '❌ Could not fetch balance. Please try again.');
    await ctx.reply('Menu:', mainMenu);
    return;
  }

  await finishLoading(ctx, loading.message_id, msg, 'Markdown');
  await ctx.reply('Menu:', mainMenu);
}



export function registerBalanceHandlers({ bot: b }: HandlerContext): void {
b.hears('💰 Balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (isGroupChat(ctx)) {
    const name = ctx.from?.first_name || 'there';
    await ctx.reply(`📩 ${name}, check your DM for your balance.`);
    const msg = await buildBalanceMessage(userId);
    if (msg) {
      await ctx.telegram.sendMessage(ctx.from!.id, msg, { parse_mode: 'Markdown' });
      await ctx.telegram.sendMessage(ctx.from!.id, 'Menu:', mainMenu);
    } else {
      await ctx.telegram.sendMessage(ctx.from!.id, '❌ Could not fetch balance. Please try again.', mainMenu);
    }
    return;
  }
  await handleBalance(ctx, userId);
});
}
