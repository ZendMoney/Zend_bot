/**
 * System monitor — full app snapshot for admin + AI diagnostics.
 * Authenticate with ADMIN_MONITOR_SECRET (Bearer or ?key=).
 */

import { timingSafeEqual } from 'crypto';
import {
  db,
  users,
  transactions,
  businesses,
  invoices,
  feedback,
  billPayments,
  ambassadorApplications,
  deviceSuspensionRequests,
} from '@zend/db';
import { checkConnection } from '@zend/db';
import { eq, sql, gte, and, desc } from 'drizzle-orm';
import { getNearIntentsClient } from '@zend/near-intents-client';
import { getQVACStatus, QVAC_ENABLED } from './qvac/index.js';
import { getAdminStats } from './admin.js';
import { getBotFeatures } from './bot-features.js';
import { getSessionStoreStats } from '../session/store.js';
import { runStartupHealthChecks } from '../launch/health.js';
import { getPAJClient, airbillsClient, getPublicBaseUrl, SOLANA_RPC } from '../deps.js';
import { checkAirbillsHealth } from './airbills/index.js';
import { validateFeeWallet, ZEND_FEE_NORMAL_BPS, ZEND_FEE_FUNDED_BPS } from '../utils/fees.js';
import { AUDD_ENABLED } from '../utils/flags.js';

const STARTED_AT = Date.now();

export interface MonitorRoute {
  method: string;
  path: string;
  auth: 'none' | 'admin_monitor' | 'webhook_signature';
  description: string;
  probe?: 'internal' | 'external_only';
}

export const MONITOR_ROUTES: MonitorRoute[] = [
  { method: 'GET', path: '/health', auth: 'none', description: 'Liveness ping', probe: 'internal' },
  { method: 'GET', path: '/api/system', auth: 'none', description: 'Monitor API manifest (for AI discovery)' },
  { method: 'GET', path: '/api/system/ping', auth: 'admin_monitor', description: 'Parallel health probes with latency' },
  { method: 'GET', path: '/api/system/snapshot', auth: 'admin_monitor', description: 'Full system state for AI/admin analysis' },
  { method: 'POST', path: '/webhooks/paj', auth: 'webhook_signature', description: 'PAJ deposit/settlement events', probe: 'external_only' },
  { method: 'POST', path: '/webhooks/airbills', auth: 'webhook_signature', description: 'AirBills payment callbacks', probe: 'external_only' },
  { method: 'POST', path: '/webhooks/near-intents', auth: 'webhook_signature', description: 'NEAR Intents status updates', probe: 'external_only' },
  { method: 'POST', path: '/webhook/telegram', auth: 'webhook_signature', description: 'Telegram bot updates (if webhook mode)', probe: 'external_only' },
  { method: 'POST', path: '/api/ambassador', auth: 'none', description: 'Landing page ambassador form' },
  { method: 'POST', path: '/api/device-suspend', auth: 'none', description: 'Landing page device suspension form' },
];

function maskSecret(value: string | undefined, visibleTail = 4): string | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  if (v.length <= visibleTail) return '***';
  return `***${v.slice(-visibleTail)}`;
}

export function verifyMonitorSecret(provided: string | undefined): boolean {
  const expected = process.env.ADMIN_MONITOR_SECRET?.trim();
  if (!expected || !provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function extractMonitorSecret(req: { headers: Record<string, string | string[] | undefined>; url?: string }): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const headerKey = req.headers['x-admin-monitor-key'];
  if (typeof headerKey === 'string') return headerKey.trim();

  const url = req.url || '';
  const qIndex = url.indexOf('?');
  if (qIndex >= 0) {
    const params = new URLSearchParams(url.slice(qIndex + 1));
    const key = params.get('key');
    if (key) return key;
  }
  return undefined;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; label: string; detail?: T; error?: string }> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - t0, label, detail };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - t0, label, error: err.message || String(err) };
  }
}

export async function buildSystemPing(): Promise<Record<string, unknown>> {
  const probes = await Promise.all([
    timed('database', () => checkConnection()),
    timed('paj_rates', async () => {
      const client = await getPAJClient();
      if (!client) throw new Error('PAJ not configured');
      const rates = await client.getAllRates();
      return { onRamp: rates.onRampRate.rate, offRamp: rates.offRampRate.rate };
    }),
    timed('near_intents_tokens', async () => {
      const client = getNearIntentsClient();
      if (!client) throw new Error('NEAR Intents not configured');
      const tokens = await client.getTokens();
      return { count: tokens.length };
    }),
    timed('airbills', async () => {
      if (!airbillsClient) return { configured: false };
      const ok = await checkAirbillsHealth(airbillsClient);
      return { configured: true, healthy: ok };
    }),
    timed('solana_rpc', async () => {
      const res = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: AbortSignal.timeout(8000),
      });
      const json = (await res.json()) as { result?: unknown; error?: unknown };
      return { status: res.status, result: json.result ?? json.error };
    }),
  ]);

  const allOk = probes.every((p) => p.ok && (p.detail !== false));
  return {
    generatedAt: new Date().toISOString(),
    healthy: allOk,
    probes,
  };
}

export async function buildSystemSnapshot(): Promise<Record<string, unknown>> {
  const publicBase = getPublicBaseUrl();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [health, adminStats, features, ping] = await Promise.all([
    runStartupHealthChecks({ getPAJClient, airbillsClient }),
    getAdminStats(),
    getBotFeatures(),
    buildSystemPing(),
  ]);

  const [
    usersTotal,
    usersOnboarded,
    txByStatus,
    txFailedRecent,
    pendingNear,
    pendingBills,
    openFeedback,
    businessCount,
    invoiceByStatus,
    ambassadorPending,
    deviceSuspendPending,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(users),
    db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.onboardingComplete, true)),
    db
      .select({ status: transactions.status, count: sql<number>`count(*)` })
      .from(transactions)
      .groupBy(transactions.status),
    db
      .select({
        id: transactions.id,
        type: transactions.type,
        status: transactions.status,
        userId: transactions.userId,
        ngnAmount: transactions.ngnAmount,
        updatedAt: transactions.updatedAt,
      })
      .from(transactions)
      .where(and(eq(transactions.status, 'failed'), gte(transactions.updatedAt, dayAgo)))
      .orderBy(desc(transactions.updatedAt))
      .limit(15),
    db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(
        and(
          sql`${transactions.nearIntentDepositAddress} IS NOT NULL`,
          sql`${transactions.status} IN ('pending', 'processing')`,
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(billPayments)
      .where(eq(billPayments.status, 'pending')),
    db.select({ count: sql<number>`count(*)` }).from(feedback).where(eq(feedback.status, 'open')),
    db.select({ count: sql<number>`count(*)` }).from(businesses),
    db
      .select({ status: invoices.status, count: sql<number>`count(*)` })
      .from(invoices)
      .groupBy(invoices.status),
    db
      .select({ count: sql<number>`count(*)` })
      .from(ambassadorApplications)
      .where(eq(ambassadorApplications.status, 'pending')),
    db.select({ count: sql<number>`count(*)` }).from(deviceSuspensionRequests),
  ]);

  const mem = process.memoryUsage();
  const qvac = getQVACStatus();

  const routesWithUrls = MONITOR_ROUTES.map((r) => ({
    ...r,
    url: publicBase ? `${publicBase}${r.path}` : null,
  }));

  return {
    _ai_instructions:
      'Full Zend system snapshot. Use health.probes for integration status, stats for usage, ' +
      'transactions.failedRecent24h for bugs, routes for available HTTP endpoints. ' +
      'Re-fetch /api/system/ping for a faster health-only check.',
    generatedAt: now.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    version: process.env.npm_package_version || '0.1.0',
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
      railwayService: process.env.RAILWAY_SERVICE_NAME || null,
      publicBaseUrl: publicBase || null,
    },
    routes: routesWithUrls,
    links: publicBase
      ? {
          manifest: `${publicBase}/api/system`,
          ping: `${publicBase}/api/system/ping?key=<ADMIN_MONITOR_SECRET>`,
          snapshot: `${publicBase}/api/system/snapshot?key=<ADMIN_MONITOR_SECRET>`,
          health: `${publicBase}/health`,
        }
      : null,
    runtime: {
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        externalMb: Math.round(mem.external / 1024 / 1024),
      },
      sessionStore: getSessionStoreStats(),
      telegramWebhookMode: process.env.TELEGRAM_USE_WEBHOOK === 'true',
    },
    health: {
      ...health,
      probes: ping.probes,
      healthy: ping.healthy,
    },
    integrations: {
      paj: { configured: !!process.env.PAJ_BUSINESS_API_KEY, healthy: health.paj },
      nearIntents: { configured: !!process.env.NEAR_INTENTS_JWT, healthy: health.nearIntents },
      airbills: {
        configured: !!airbillsClient,
        healthy: health.airbills === true,
        payWith: process.env.AIRBILLS_PAY_WITH || 'default',
      },
      solanaRpc: SOLANA_RPC.replace(/api-key=[^&]+/, 'api-key=***'),
      qvac: { ...qvac, enabled: QVAC_ENABLED },
      feeWallet: health.feeWallet,
      feeRatesBps: { normal: ZEND_FEE_NORMAL_BPS, funded: ZEND_FEE_FUNDED_BPS },
    },
    featureFlags: {
      auddEnabled: AUDD_ENABLED,
      telegramWebhook: process.env.TELEGRAM_USE_WEBHOOK === 'true',
      qvacLightModels: process.env.QVAC_USE_LIGHT_MODELS !== 'false',
      qvacMaxLoadedModels: process.env.QVAC_MAX_LOADED_MODELS || '1',
    },
    stats: {
      ...adminStats,
      users: {
        total: Number(usersTotal[0]?.count ?? 0),
        onboardingComplete: Number(usersOnboarded[0]?.count ?? 0),
      },
      transactionsByStatus: Object.fromEntries(
        txByStatus.map((r) => [r.status, Number(r.count)]),
      ),
      pendingNearIntents: Number(pendingNear[0]?.count ?? 0),
      pendingBillPayments: Number(pendingBills[0]?.count ?? 0),
      openFeedbackTickets: Number(openFeedback[0]?.count ?? 0),
      ambassadorApplicationsPending: Number(ambassadorPending[0]?.count ?? 0),
      deviceSuspensionRequests: Number(deviceSuspendPending[0]?.count ?? 0),
    },
    business: {
      businesses: Number(businessCount[0]?.count ?? 0),
      invoicesByStatus: Object.fromEntries(
        invoiceByStatus.map((r) => [r.status, Number(r.count)]),
      ),
    },
    botFeatures: features.map((f) => ({
      key: f.key,
      name: f.name,
      category: f.category,
      active: f.isActive,
    })),
    transactions: {
      failedRecent24h: txFailedRecent.map((t) => ({
        id: t.id,
        type: t.type,
        userId: t.userId,
        ngnAmount: t.ngnAmount ? Number(t.ngnAmount) : null,
        updatedAt: t.updatedAt,
      })),
    },
    secretsConfigured: {
      botToken: !!process.env.BOT_TOKEN,
      databaseUrl: !!process.env.DATABASE_URL,
      redisUrl: !!process.env.REDIS_URL,
      pajApiKey: maskSecret(process.env.PAJ_BUSINESS_API_KEY),
      nearIntentsJwt: maskSecret(process.env.NEAR_INTENTS_JWT),
      airbillsKey: maskSecret(process.env.AIRBILLS_SECRET_KEY || process.env.AIRBILLS_API_KEY),
      encryptionKey: !!process.env.ENCRYPTION_KEY,
      adminMonitorSecret: !!process.env.ADMIN_MONITOR_SECRET,
    },
  };
}

export function buildSystemManifest(): Record<string, unknown> {
  const publicBase = getPublicBaseUrl();
  return {
    name: 'Zend System Monitor API',
    description:
      'Paste the snapshot URL (with admin key) into an AI assistant for full system analysis. ' +
      'Admin-only endpoints require ADMIN_MONITOR_SECRET via ?key=, Bearer header, or X-Admin-Monitor-Key.',
    generatedAt: new Date().toISOString(),
    publicBaseUrl: publicBase,
    endpoints: [
      {
        path: '/api/system',
        method: 'GET',
        auth: 'none',
        description: 'This manifest',
      },
      {
        path: '/api/system/ping',
        method: 'GET',
        auth: 'admin_monitor',
        description: 'Fast parallel health probes',
      },
      {
        path: '/api/system/snapshot',
        method: 'GET',
        auth: 'admin_monitor',
        description: 'Complete system state — users, txs, integrations, memory, routes',
      },
      {
        path: '/health',
        method: 'GET',
        auth: 'none',
        description: 'Simple liveness check',
      },
    ],
    routes: MONITOR_ROUTES,
    aiUsage: publicBase
      ? `Give this URL to your AI: ${publicBase}/api/system/snapshot?key=YOUR_ADMIN_MONITOR_SECRET`
      : 'Set WEBHOOK_BASE_URL or RAILWAY_PUBLIC_DOMAIN for full URLs',
  };
}