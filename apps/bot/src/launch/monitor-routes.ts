import type { IncomingMessage, ServerResponse } from 'http';
import {
  buildSystemManifest,
  buildSystemPing,
  buildSystemSnapshot,
  extractMonitorSecret,
  verifyMonitorSecret,
} from '../services/system-monitor.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, {
    error: 'Unauthorized',
    hint: 'Set ADMIN_MONITOR_SECRET and pass ?key=, Authorization: Bearer, or X-Admin-Monitor-Key',
  });
}

function requireMonitorAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const secret = extractMonitorSecret({
    headers: req.headers as Record<string, string | string[] | undefined>,
    url: req.url,
  });
  if (!verifyMonitorSecret(secret)) {
    unauthorized(res);
    return false;
  }
  return true;
}

/** Returns true if the request was handled. */
export async function handleMonitorRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url || '/';
  const path = url.split('?')[0];
  const method = req.method || 'GET';

  if (method !== 'GET') return false;

  if (path === '/api/system') {
    json(res, 200, buildSystemManifest());
    return true;
  }

  if (path === '/api/system/ping') {
    if (!requireMonitorAuth(req, res)) return true;
    try {
      const ping = await buildSystemPing();
      json(res, 200, ping);
    } catch (err: any) {
      json(res, 500, { error: err.message || 'Ping failed' });
    }
    return true;
  }

  if (path === '/api/system/snapshot') {
    if (!requireMonitorAuth(req, res)) return true;
    try {
      const snapshot = await buildSystemSnapshot();
      json(res, 200, snapshot);
    } catch (err: any) {
      console.error('[Monitor] Snapshot error:', err);
      json(res, 500, { error: err.message || 'Snapshot failed' });
    }
    return true;
  }

  return false;
}