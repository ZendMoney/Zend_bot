import type { MiddlewareFn } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import type { ZendContext } from './session.js';

export const authMiddleware: MiddlewareFn<ZendContext> = async (ctx, next) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    return next();
  }

  // Try to find user in database
  const user = await db.query.users.findFirst({
    where: eq(users.id, telegramId),
  });

  if (user) {
    // Attach user to context
    (ctx as any).user = user;
  }

  await next();
};
