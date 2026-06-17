import type { Telegraf } from 'telegraf';
import { db, users } from '@zend/db';
import { walletService } from '../deps.js';

const balanceSnapshots = new Map<string, { sol: number; usdt: number; usdc: number; audd: number; near: number }>();

/** Disabled in production — was hitting Solana RPC rate limits */
export async function checkBalanceChanges(botInstance: Telegraf<any>): Promise<void> {
  try {
    const allUsers = await db.select({ id: users.id, walletAddress: users.walletAddress }).from(users);
    for (const user of allUsers) {
      try {
        const balances = await walletService.getAllBalances(user.walletAddress);
        const current = {
          sol: balances.find((b: any) => b.symbol === 'SOL')?.amount || 0,
          usdt: balances.find((b: any) => b.symbol === 'USDT')?.amount || 0,
          usdc: balances.find((b: any) => b.symbol === 'USDC')?.amount || 0,
          audd: balances.find((b: any) => b.symbol === 'AUDD')?.amount || 0,
          near: balances.find((b: any) => b.symbol === 'NEAR')?.amount || 0,
        };

        const prev = balanceSnapshots.get(user.id);
        if (prev) {
          const solDiff = current.sol - prev.sol;
          const usdtDiff = current.usdt - prev.usdt;
          const usdcDiff = current.usdc - prev.usdc;

          if (solDiff > 0.000001) {
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${solDiff.toFixed(6)} SOL* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.sol.toFixed(6)} SOL*`,
              { parse_mode: 'Markdown' }
            );
          }
          if (usdtDiff > 0.000001) {
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${usdtDiff.toFixed(2)} USDT* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.usdt.toFixed(2)} USDT*`,
              { parse_mode: 'Markdown' }
            );
          }
          if (usdcDiff > 0.000001) {
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${usdcDiff.toFixed(2)} USDC* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.usdc.toFixed(2)} USDC*`,
              { parse_mode: 'Markdown' }
            );
          }
          if (current.audd - (prev?.audd || 0) > 0.000001) {
            const auddDiff = current.audd - (prev?.audd || 0);
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${auddDiff.toFixed(2)} AUDD* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.audd.toFixed(2)} AUDD*`,
              { parse_mode: 'Markdown' }
            );
          }
          if (current.near - (prev?.near || 0) > 0.000001) {
            const nearDiff = current.near - (prev?.near || 0);
            await botInstance.telegram.sendMessage(
              user.id,
              `🎉 *Funds Received!*\n\n` +
              `*+${nearDiff.toFixed(4)} NEAR* has arrived in your Zend wallet.\n\n` +
              `New balance: *${current.near.toFixed(4)} NEAR*`,
              { parse_mode: 'Markdown' }
            );
          }
        }

        balanceSnapshots.set(user.id, current);
      } catch (err) {
        console.error(`[BalancePoll] Error checking user ${user.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[BalancePoll] Error fetching users:', err);
  }
}