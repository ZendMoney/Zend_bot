import { db, vaults } from '@zend/db';
import { eq } from 'drizzle-orm';
import { formatCrypto, formatNgn } from '@zend/shared';
import type { ZendContext } from '../middleware/session.js';

// Mock rate
const MOCK_NGN_RATE = 4900;

export async function vaultHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  const userVaults = await db.query.vaults.findMany({
    where: eq(vaults.userId, user.id),
  });

  const autoSaveVault = userVaults.find(v => v.type === 'auto_save');
  const timeLockVaults = userVaults.filter(v => v.type === 'time_lock');

  const totalSaved = userVaults.reduce((sum, v) => {
    return sum + Number(v.lockedAmount || 0);
  }, 0);

  let message = `🏦 *Your Savings*\n\n`;
  message += `💰 Total Saved: ${formatCrypto(totalSaved, 'USDT')} (≈${formatNgn(Math.floor(totalSaved * MOCK_NGN_RATE))})\n\n`;

  if (autoSaveVault) {
    const amount = Number(autoSaveVault.lockedAmount || 0);
    message += `┌─ *Auto-Save* ─────────────────┐\n`;
    message += `│ Rate: ${(autoSaveVault.saveRateBps || 0) / 100}% of every spend\n`;
    message += `│ Balance: ${formatCrypto(amount, 'USDT')}\n`;
    message += `│ [💸 Withdraw] [✏️ Change %]\n`;
    message += `└───────────────────────────────┘\n\n`;
  }

  if (timeLockVaults.length > 0) {
    message += `┌─ *Time-Lock Vaults* ──────────┐\n`;
    for (const vault of timeLockVaults) {
      const amount = Number(vault.lockedAmount || 0);
      const unlockDate = vault.unlockAt ? new Date(vault.unlockAt).toLocaleDateString() : 'N/A';
      const isLocked = vault.unlockAt ? new Date() < new Date(vault.unlockAt) : false;
      message += `│\n`;
      message += `│ ${vault.purpose || 'Vault'}\n`;
      message += `│    ${formatCrypto(amount, 'USDT')} • Unlock: ${unlockDate}\n`;
      message += `│    [${isLocked ? '🔒 Locked' : '🔓 Unlocked'}]\n`;
    }
    message += `│\n`;
    message += `└───────────────────────────────┘\n\n`;
  }

  message += `[➕ Create New Vault]`;

  await ctx.reply(message, { parse_mode: 'Markdown' });
}
