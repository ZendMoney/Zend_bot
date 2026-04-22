import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { WalletService } from '@zend/solana';
import { formatNgn, formatCrypto, SOLANA_TOKENS } from '@zend/shared';
import type { ZendContext } from '../middleware/session.js';

const walletService = new WalletService(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  Buffer.from(process.env.FEE_PAYER_KEY || '', 'base64')
);

// Mock rate for now — replace with live PAJ rate
const MOCK_NGN_RATE = 4900;

export async function balanceHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  await ctx.reply('⏳ Fetching your balance...');

  try {
    const balances = await walletService.getAllBalances(user.walletAddress);
    
    let totalNgn = 0;
    const balanceLines = balances.map(b => {
      const ngnValue = b.amount * MOCK_NGN_RATE;
      totalNgn += ngnValue;
      
      const emoji = b.symbol === 'SOL' ? '🔵' : b.symbol === 'USDT' ? '🟢' : '🟡';
      return `${emoji} ${b.symbol.padEnd(6)} ${formatCrypto(b.amount, b.symbol).padStart(12)}  (≈${formatNgn(Math.floor(ngnValue))})`;
    });

    const message = 
      `💰 *Your Balance*\n\n` +
      `${balanceLines.join('\n')}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💵 Total: ≈${formatNgn(Math.floor(totalNgn))}`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Balance error:', err);
    await ctx.reply('⚠️ Could not fetch balance. Please try again.');
  }
}
