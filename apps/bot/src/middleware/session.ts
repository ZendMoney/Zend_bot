import type { MiddlewareFn } from 'telegraf';
import type { ZendContext } from '../session/types.js';
import { getSession, hydrateSession } from '../session/store.js';

export const sessionMiddleware: MiddlewareFn<ZendContext> = async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (userId) {
    await hydrateSession(userId);
    ctx.session = getSession(userId);
  }
  await next();
};