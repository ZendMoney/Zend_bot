import { db, businessSessions } from '@zend/db';
import { eq } from 'drizzle-orm';
import type { ZendMode } from '@zend/shared';

export interface BusinessSessionRow {
  userId: string;
  activeMode: ZendMode;
  currentFlow: string | null;
  currentStep: string | null;
  flowData: Record<string, unknown>;
  returnToFlow: string | null;
  returnToStep: string | null;
  updatedAt: Date;
}

export async function getBusinessSession(userId: string): Promise<BusinessSessionRow | null> {
  const rows = await db.select().from(businessSessions).where(eq(businessSessions.userId, userId)).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    userId: row.userId,
    activeMode: row.activeMode as ZendMode,
    currentFlow: row.currentFlow,
    currentStep: row.currentStep,
    flowData: (row.flowData as Record<string, unknown>) ?? {},
    returnToFlow: row.returnToFlow,
    returnToStep: row.returnToStep,
    updatedAt: row.updatedAt,
  };
}

export async function ensureBusinessSession(
  userId: string,
  activeMode: ZendMode = 'personal',
): Promise<BusinessSessionRow> {
  const existing = await getBusinessSession(userId);
  if (existing) return existing;

  await db.insert(businessSessions).values({
    userId,
    activeMode,
    flowData: {},
  });

  return (await getBusinessSession(userId))!;
}

export async function setActiveMode(userId: string, mode: ZendMode): Promise<void> {
  await ensureBusinessSession(userId, mode);
  await db
    .update(businessSessions)
    .set({ activeMode: mode, updatedAt: new Date() })
    .where(eq(businessSessions.userId, userId));
}

export async function getActiveMode(userId: string, fallback: ZendMode = 'personal'): Promise<ZendMode> {
  const session = await getBusinessSession(userId);
  return session?.activeMode ?? fallback;
}

export async function updateBusinessSession(
  userId: string,
  patch: Partial<{
    activeMode: ZendMode;
    currentFlow: string | null;
    currentStep: string | null;
    flowData: Record<string, unknown>;
    returnToFlow: string | null;
    returnToStep: string | null;
  }>,
): Promise<void> {
  await ensureBusinessSession(userId);
  await db
    .update(businessSessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(businessSessions.userId, userId));
}

export async function clearBusinessFlow(userId: string): Promise<void> {
  await updateBusinessSession(userId, {
    currentFlow: null,
    currentStep: null,
    returnToFlow: null,
    returnToStep: null,
  });
}