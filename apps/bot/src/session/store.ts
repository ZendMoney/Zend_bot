import { Redis } from 'ioredis';
import { ConversationState } from '@zend/shared';
import type { ZendSession } from './types.js';

export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_TTL_SEC = Math.ceil(SESSION_TTL_MS / 1000);
const MAX_SESSIONS = 10_000;
const REDIS_KEY_PREFIX = 'zend:session:';

type StoredSession = ZendSession & { _lastAccessed: number };

const memory = new Map<string, StoredSession>();

let redisClient: Redis | null = null;
let redisReady = false;

/** Connect Redis when REDIS_URL is set (optional — in-memory fallback always available). */
export async function initSessionStore(): Promise<'redis' | 'memory'> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    console.log('[Session] Using in-memory store (set REDIS_URL for persistence across restarts)');
    return 'memory';
  }
  try {
    redisClient = new Redis(url, { maxRetriesPerRequest: 2 });
    await redisClient.ping();
    redisReady = true;
    console.log('[Session] Redis connected — sessions persist across restarts');
    return 'redis';
  } catch (err: any) {
    console.warn('[Session] Redis unavailable, falling back to in-memory:', err.message);
    redisClient = null;
    redisReady = false;
    return 'memory';
  }
}

function redisKey(userId: string): string {
  return `${REDIS_KEY_PREFIX}${userId}`;
}

function persistToRedis(userId: string, sess: StoredSession): void {
  if (!redisReady || !redisClient) return;
  const payload = JSON.stringify(sess);
  redisClient.setex(redisKey(userId), SESSION_TTL_SEC, payload).catch((err: Error) => {
    console.warn('[Session] Redis write failed:', err.message);
  });
}

/** Load session from Redis into memory (call before handlers on each update). */
export async function hydrateSession(userId: string): Promise<void> {
  if (!redisReady || !redisClient || memory.has(userId)) return;
  try {
    const raw = await redisClient.get(redisKey(userId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed.scheduleData?.startAt) {
      parsed.scheduleData.startAt = new Date(parsed.scheduleData.startAt as unknown as string);
    }
    parsed._lastAccessed = Date.now();
    memory.set(userId, parsed);
  } catch (err: any) {
    console.warn('[Session] Redis read failed:', err.message);
  }
}

export function getSession(userId: string): ZendSession {
  const existing = memory.get(userId);
  if (existing) {
    existing._lastAccessed = Date.now();
    return existing;
  }
  const sess: StoredSession = { state: ConversationState.IDLE, _lastAccessed: Date.now() };
  memory.set(userId, sess);
  if (memory.size > MAX_SESSIONS) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  return sess;
}

export function setSession(userId: string, patch: Partial<ZendSession>): void {
  const existing = memory.get(userId);
  const base: ZendSession = existing ?? { state: ConversationState.IDLE };
  const stored: StoredSession = { ...base, ...patch, _lastAccessed: Date.now() };
  memory.set(userId, stored);
  persistToRedis(userId, stored);
}

export function evictStaleSessions(): void {
  const now = Date.now();
  for (const [uid, sess] of memory) {
    if (now - sess._lastAccessed > SESSION_TTL_MS) {
      memory.delete(uid);
    }
  }
}

export function getSessionStoreStats(): {
  backend: 'redis' | 'memory';
  inMemorySessions: number;
  maxSessions: number;
  ttlMinutes: number;
} {
  return {
    backend: redisReady ? 'redis' : 'memory',
    inMemorySessions: memory.size,
    maxSessions: MAX_SESSIONS,
    ttlMinutes: SESSION_TTL_MS / 60_000,
  };
}