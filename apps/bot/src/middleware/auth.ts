import { MiddlewareFn } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';

/**
 * Auth middleware: ensures user exists in DB.
 * If not, redirects to /start.
 */
export const authMiddleware: MiddlewareFn<any> = async (ctx, next) => {
  if (!ctx.from) return next();

  const userId = ctx.from.id.toString();

  // Skip auth for /start command
  if (ctx.message && 'text' in ctx.message && ctx.message.text === '/start') {
    return next();
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply(
      '👋 Welcome! Please run /start to create your Zend wallet.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Attach user to context for handlers
  (ctx as any).zendUser = user[0];

  return next();
};
