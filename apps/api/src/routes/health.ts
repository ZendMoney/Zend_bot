import { Hono } from 'hono';
import { checkConnection } from '@zend/db';

export const healthRoute = new Hono();

healthRoute.get('/', async (c) => {
  const dbConnected = await checkConnection();
  
  return c.json({
    status: dbConnected ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbConnected ? 'connected' : 'disconnected',
    },
  });
});
