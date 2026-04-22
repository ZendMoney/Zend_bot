import type { MiddlewareFn } from 'telegraf';
import type { Context } from 'telegraf';
import type { Redis } from 'ioredis';
import { ConversationState } from '@zend/shared';
import type { UserSession } from '@zend/shared';

export interface ZendContext extends Context {
  session: UserSession;
}

export function sessionMiddleware(redis: Redis): MiddlewareFn<ZendContext> {
  return async (ctx, next) => {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      return next();
    }

    const sessionKey = `zend:session:${userId}`;
    
    // Try to get existing session
    const existing = await redis.get(sessionKey);
    
    if (existing) {
      ctx.session = JSON.parse(existing);
    } else {
      // Create new session
      ctx.session = {
        userId,
        state: ConversationState.IDLE,
        lastActivity: new Date(),
      };
    }

    // Update activity time
    ctx.session.lastActivity = new Date();

    // Continue with handler
    await next();

    // Save session back to Redis (30 min TTL)
    await redis.setex(sessionKey, 1800, JSON.stringify(ctx.session));
  };
}
