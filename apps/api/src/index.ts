import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { db, transactions } from '@zend/db';
import { eq } from 'drizzle-orm';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const app = new Hono();
const PORT = parseInt(process.env.API_PORT || '3001');

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// ─── PAJ Webhooks ───
app.post('/webhooks/paj', async (c) => {
  const signature = c.req.header('x-paj-signature');
  const body = await c.req.text();

  // TODO: Verify PAJ webhook signature
  // if (!verifyPAJSignature(body, signature)) return c.json({ error: 'Unauthorized' }, 401);

  const event = JSON.parse(body);

  console.log('📩 PAJ Webhook:', event.type, event.reference);

  switch (event.type) {
    case 'onramp.deposit.confirmed': {
      // User sent NGN → PAJ detected → USDT credited
      // Update transaction, notify user
      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.pajReference, event.reference));
      break;
    }

    case 'onramp.deposit.failed': {
      await db.update(transactions)
        .set({ status: 'failed' })
        .where(eq(transactions.pajReference, event.reference));
      break;
    }

    case 'offramp.settlement.confirmed': {
      // PAJ settled NGN to bank
      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.pajReference, event.reference));
      break;
    }

    case 'offramp.settlement.failed': {
      await db.update(transactions)
        .set({ status: 'failed' })
        .where(eq(transactions.pajReference, event.reference));
      break;
    }
  }

  return c.json({ received: true });
});

// ─── Chain Rails Webhooks (placeholder) ───
app.post('/webhooks/chain-rails', async (c) => {
  const body = await c.req.json();
  console.log('📩 ChainRails Webhook:', body);
  return c.json({ received: true });
});

// Start server
serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`🚀 API server running on http://localhost:${PORT}`);
