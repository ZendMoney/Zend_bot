import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { db, transactions, ambassadorApplications, deviceSuspensionRequests } from '@zend/db';
import { eq } from 'drizzle-orm';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const app = new Hono();
const PORT = parseInt(process.env.API_PORT || '3001');

// ─── Helper: send Telegram notification ───
async function notifyUser(userId: string, text: string) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: userId, text, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.log('[API] Could not notify user:', err);
  }
}

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
      const txRows = await db.select().from(transactions)
        .where(eq(transactions.pajReference, event.reference))
        .limit(1);

      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.pajReference, event.reference));

      if (txRows.length > 0) {
        await notifyUser(
          txRows[0].userId,
          `🎉 *Naira Deposit Received!*\n\n` +
          `Your bank transfer has been confirmed and Dollars (USDT) have been credited to your Zend account.\n\n` +
          `Reference: \`${event.reference}\``
        );
      }
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
      const txRows = await db.select().from(transactions)
        .where(eq(transactions.pajReference, event.reference))
        .limit(1);

      await db.update(transactions)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(transactions.pajReference, event.reference));

      if (txRows.length > 0) {
        await notifyUser(
          txRows[0].userId,
          `✅ *Cash Out Complete!*\n\n` +
          `Your Naira has been settled to your bank account.\n\n` +
          `Reference: \`${event.reference}\``
        );
      }
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

// ─── Landing page forms ───

app.post('/api/ambassador', async (c) => {
  const body = await c.req.json();
  const { name, tgHandle, isStudent, focus } = body;

  if (!name || !tgHandle || !isStudent || !focus) {
    return c.json({ error: 'All fields are required' }, 400);
  }

  try {
    await db.insert(ambassadorApplications).values({
      name: String(name).trim(),
      tgHandle: String(tgHandle).trim(),
      isStudent: String(isStudent).trim(),
      focus: String(focus).trim(),
    });
    console.log('📩 Ambassador application received:', name, tgHandle);
    return c.json({ success: true });
  } catch (err) {
    console.error('[API] Ambassador insert error:', err);
    return c.json({ error: 'Failed to save application' }, 500);
  }
});

app.post('/api/device-suspend', async (c) => {
  const body = await c.req.json();
  const { fullName, email, phone, handle, deviceLost, lastUsed, reason, details } = body;

  if (!fullName || !email || !phone || !handle || !deviceLost || !lastUsed || !reason) {
    return c.json({ error: 'Required fields missing' }, 400);
  }

  try {
    await db.insert(deviceSuspensionRequests).values({
      fullName: String(fullName).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      handle: String(handle).trim(),
      deviceLost: String(deviceLost).trim(),
      lastUsed: String(lastUsed).trim(),
      reason: String(reason).trim(),
      details: details ? String(details).trim() : null,
    });
    console.log('📩 Device suspension request received:', fullName, email);
    return c.json({ success: true });
  } catch (err) {
    console.error('[API] Device suspension insert error:', err);
    return c.json({ error: 'Failed to save request' }, 500);
  }
});

// Start server
serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`🚀 API server running on http://localhost:${PORT}`);
