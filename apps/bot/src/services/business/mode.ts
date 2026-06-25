import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import type { ZendMode } from '@zend/shared';
import { getActiveMode, setActiveMode } from './session.js';

export async function resolveActiveMode(userId: string): Promise<ZendMode> {
  const userRows = await db.select({ defaultMode: users.defaultMode }).from(users).where(eq(users.id, userId)).limit(1);
  const fallback = (userRows[0]?.defaultMode as ZendMode) ?? 'personal';
  return getActiveMode(userId, fallback);
}

export async function switchMode(userId: string, mode: ZendMode): Promise<void> {
  await setActiveMode(userId, mode);
}