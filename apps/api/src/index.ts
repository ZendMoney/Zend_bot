import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { pajWebhookRoute } from './routes/paj-webhook.js';
import { healthRoute } from './routes/health.js';

const app = new Hono();

// Middleware
app.use(logger());
app.use(cors());

// Routes
app.route('/webhooks', pajWebhookRoute);
app.route('/health', healthRoute);

// 404
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Error handler
app.onError((err, c) => {
  console.error('API error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

const port = Number(process.env.API_PORT) || 3000;

serve({
  fetch: app.fetch,
  port,
});

console.log(`🚀 Zend API running on port ${port}`);
