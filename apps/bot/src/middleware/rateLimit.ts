import { MiddlewareFn } from 'telegraf';

// Simple in-memory rate limiter (replace with Redis in production)
const rateMap = new Map<string, { count: number; resetAt: number }>();

const LIMIT = 30; // messages per minute
const WINDOW_MS = 60_000;

export const rateLimitMiddleware: MiddlewareFn<any> = async (ctx, next) => {
  if (!ctx.from) return next();

  const userId = ctx.from.id.toString();
  const now = Date.now();

  const record = rateMap.get(userId);

  if (!record || now > record.resetAt) {
    rateMap.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  if (record.count >= LIMIT) {
    await ctx.reply('⏳ Too many messages. Please slow down.');
    return;
  }

  record.count++;
  return next();
};
