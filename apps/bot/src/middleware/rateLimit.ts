import { MiddlewareFn } from 'telegraf';

// Simple in-memory rate limiter (replace with Redis in production)
const rateMap = new Map<string, { count: number; resetAt: number }>();

const LIMIT = 30; // messages per minute
const WINDOW_MS = 60_000;
const MAX_RATE_ENTRIES = 5000;

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [uid, record] of rateMap) {
    if (now > record.resetAt) rateMap.delete(uid);
  }
}, 300000);

export const rateLimitMiddleware: MiddlewareFn<any> = async (ctx, next) => {
  if (!ctx.from) return next();

  const userId = ctx.from.id.toString();
  const now = Date.now();

  // Evict oldest if over limit
  if (rateMap.size >= MAX_RATE_ENTRIES) {
    const oldest = rateMap.keys().next().value;
    if (oldest) rateMap.delete(oldest);
  }

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
