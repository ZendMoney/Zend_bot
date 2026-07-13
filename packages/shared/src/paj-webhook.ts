import crypto from 'crypto';

const processedEvents = new Map<string, number>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function pruneIdempotencyCache() {
  const now = Date.now();
  for (const [key, ts] of processedEvents) {
    if (now - ts > IDEMPOTENCY_TTL_MS) processedEvents.delete(key);
  }
}

export function webhookEventKey(parts: Record<string, string | undefined>): string | null {
  const type = parts.type || parts.status || parts.transactionType;
  const ref = parts.reference || parts.id;
  if (!type || !ref) return null;
  return `${type}:${ref}`;
}

export function isDuplicateWebhook(key: string): boolean {
  pruneIdempotencyCache();
  return processedEvents.has(key);
}

export function markWebhookProcessed(key: string): void {
  processedEvents.set(key, Date.now());
}

/** Pull PAJ/HMAC signature from common header names providers use. */
export function extractPajSignatureHeader(
  headers: Record<string, string | string[] | undefined> | {
    get?: (name: string) => string | null | undefined;
  }
): string | null {
  const names = [
    'x-paj-signature',
    'x-signature',
    'x-hub-signature-256',
    'x-hub-signature',
    'paj-signature',
    'signature',
  ];

  const read = (name: string): string | undefined => {
    if (typeof (headers as any).get === 'function') {
      const v = (headers as { get: (n: string) => string | null | undefined }).get(name)
        ?? (headers as { get: (n: string) => string | null | undefined }).get(name.toLowerCase());
      return v ?? undefined;
    }
    const h = headers as Record<string, string | string[] | undefined>;
    const v = h[name] ?? h[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  for (const name of names) {
    const v = read(name)?.trim();
    if (v) return v;
  }
  return null;
}

export function verifyPajWebhookSignature(rawBody: string, signatureHeader?: string | null): boolean {
  const secret = process.env.PAJ_WEBHOOK_SECRET || process.env.PAJ_BUSINESS_API_KEY;
  if (!secret) {
    console.warn('[PAJ Webhook] No webhook secret configured — skipping signature check');
    return process.env.NODE_ENV !== 'production';
  }
  if (!signatureHeader) {
    console.warn('[PAJ Webhook] Missing signature header (tried x-paj-signature, x-signature, x-hub-signature-256, …)');
    return false;
  }

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBase64 = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  const candidates = [
    expectedHex,
    expectedBase64,
    `sha256=${expectedHex}`,
    `sha256=${expectedBase64}`,
  ];

  const provided = signatureHeader.trim();
  for (const candidate of candidates) {
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(candidate);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      // try next
    }
  }

  if (/^[a-f0-9]{64}$/i.test(provided)) {
    try {
      const a = Buffer.from(provided, 'hex');
      const b = Buffer.from(expectedHex, 'hex');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      return false;
    }
  }

  console.warn(
    `[PAJ Webhook] Signature mismatch (header present, length=${provided.length}). ` +
    `Check PAJ_WEBHOOK_SECRET matches the secret configured in PAJ dashboard.`
  );
  return false;
}

export function normalizePajWebhookEvent(body: any): {
  type: string;
  reference: string;
  status?: string;
  transactionType?: string;
  raw: any;
} | null {
  if (!body || typeof body !== 'object') return null;

  if (body.type && body.reference) {
    return { type: body.type, reference: String(body.reference), raw: body };
  }

  if (body.id && body.status) {
    const txType = String(body.transactionType || '').toUpperCase();
    const status = String(body.status).toUpperCase();
    let type: string;

    if (txType === 'ON_RAMP' || txType === 'ONRAMP') {
      if (status === 'COMPLETED' || status === 'PAID') type = 'onramp.deposit.confirmed';
      else if (status === 'FAILED' || status === 'CANCELLED') type = 'onramp.deposit.failed';
      else return null;
    } else if (txType === 'OFF_RAMP' || txType === 'OFFRAMP') {
      if (status === 'COMPLETED' || status === 'PAID') type = 'offramp.settlement.confirmed';
      else if (status === 'FAILED' || status === 'CANCELLED') type = 'offramp.settlement.failed';
      else return null;
    } else {
      return null;
    }

    return {
      type,
      reference: String(body.id),
      status,
      transactionType: txType,
      raw: body,
    };
  }

  return null;
}