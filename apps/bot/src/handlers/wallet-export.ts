import bs58 from 'bs58';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { mainMenu } from '../keyboards/index.js';
import { decryptPrivateKey } from '../utils/wallet.js';
import type { ZendContext } from '../session/types.js';

export async function doExportKey(ctx: ZendContext, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  try {
    const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);

    const msg = await ctx.reply(
      `🔑 *Secret Recovery Code*\n\n` +
      `⚠️ *SECURITY WARNING*\n` +
      `Never share this with anyone. Zend will NEVER ask for it.\n\n` +
      `*Your Secret Code:*\n\n` +
      `${bs58.encode(secretKey)}\n\n` +
      `Copy this and store it in a password manager or write it down.\n` +
      `This message will self-destruct in 1 minute.`,
      { parse_mode: 'Markdown' }
    );

    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id);
      } catch (err) {
        // Message may already be deleted
      }
    }, 60000);
  } catch (err) {
    console.error('Export key error:', err);
    await ctx.reply('❌ Could not export secret code. Please contact support.', mainMenu);
  }
}