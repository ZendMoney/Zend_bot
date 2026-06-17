import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { isSuperAdmin } from '../../services/admin.js';
import type { ZendContext } from '../../session/types.js';

const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

export async function checkAdmin(userId: string, username?: string): Promise<boolean> {
  if (isSuperAdmin(userId)) return true;
  if (ADMIN_TELEGRAM_IDS.length > 0) {
    if (ADMIN_TELEGRAM_IDS.includes(userId)) return true;
    if (username && ADMIN_TELEGRAM_IDS.includes(username.toLowerCase())) return true;
  }
  const u = await db.select({ isAdmin: users.isAdmin, telegramUsername: users.telegramUsername }).from(users).where(eq(users.id, userId)).limit(1);
  if (u.length > 0 && u[0].isAdmin) return true;
  if (u.length > 0 && u[0].telegramUsername && ADMIN_TELEGRAM_IDS.includes(u[0].telegramUsername.toLowerCase())) return true;
  return false;
}

export async function requireAdminAction(ctx: ZendContext): Promise<boolean> {
  const userId = ctx.from!.id.toString();
  const username = ctx.from?.username;
  if (!(await checkAdmin(userId, username))) {
    await ctx.answerCbQuery('❌ Not authorized');
    return false;
  }
  return true;
}

export async function requireAdminCommand(ctx: ZendContext): Promise<boolean> {
  const userId = ctx.from!.id.toString();
  const username = ctx.from?.username;
  if (!(await checkAdmin(userId, username))) {
    await ctx.reply('❌ You do not have permission to access the admin panel.');
    return false;
  }
  return true;
}