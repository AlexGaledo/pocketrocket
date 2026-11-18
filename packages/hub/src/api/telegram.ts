import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import { IntegrationError } from '../integrations/http.js';
import { VaultError } from '../services/IntegrationVault.js';
import type { TelegramService } from '../services/TelegramService.js';
import { logError } from '../providers/redact.js';

const TokenBody = z.object({ token: z.string().trim().min(1).max(200) });
const NotifyBody = z.object({ notify: z.boolean() });

/**
 * `/api/telegram/*`: Telegram notifications (spec 03 Phase A). Owner only: the hub token or a signed-in browser.
 * A paired phone is refused twice (guard.ts leaves these routes off the device allowlist, and this checks the
 * principal again), the PC runner has its own allowlist, and no bot tool reaches REST at all.
 *
 * Telegram's own words come back as a 400, never a 401 (the web client reads 401 as "wrong hub token").
 */
export function createTelegramApi(deps: { telegram: TelegramService }) {
  const svc = deps.telegram;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== '/api/telegram' && !path.startsWith('/api/telegram/')) return false;
    if (principalOf(req)?.kind !== 'hub') return send(res, 403, { error: 'Only the desktop app can do this' });
    const method = req.method ?? 'GET';

    let body: unknown;
    if (method !== 'GET' && method !== 'DELETE') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      const raw = buf.toString('utf8');
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }

    try {
      if (method === 'GET' && path === '/api/telegram') return send(res, 200, svc.state());
      if (method === 'PUT' && path === '/api/telegram/token') return send(res, 200, await svc.setToken(parse(TokenBody, body).token));
      if (method === 'DELETE' && path === '/api/telegram/token') return send(res, 200, svc.removeToken());
      if (method === 'POST' && path === '/api/telegram/link') return send(res, 200, await svc.link());
      if (method === 'POST' && path === '/api/telegram/unlink') return send(res, 200, svc.unlink());
      if (method === 'PUT' && path === '/api/telegram/notify') return send(res, 200, svc.setNotify(parse(NotifyBody, body).notify));
      if (method === 'POST' && path === '/api/telegram/test') { await svc.sendTest(); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof BadBody) return send(res, 400, { error: e.message });
      if (e instanceof IntegrationError) {
        const status = e.status === 409 || e.status === 429 || e.status === 404 ? e.status : e.status >= 400 && e.status < 500 ? 400 : 502;
        return send(res, status, { error: e.message });
      }
      if (e instanceof VaultError) return send(res, 500, { error: e.message });
      logError('[telegram api]', e);
      return send(res, 500, { error: 'Telegram request failed' });
    }
  };
}

class BadBody extends Error {}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadBody(r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
