import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './body.js';
import { DEVICE_PAIR_PATH, deviceIdOf, principalOf, type AuthRateLimiter } from './guard.js';
import { clientIp } from './guard.js';
import { PairingError, PAIRING_TTL_MS, type DeviceService } from '../services/DeviceService.js';
import { PushError, type PushService } from '../services/PushService.js';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Ctx = { params: Record<string, string>; body: unknown; req: IncomingMessage };
interface Route { method: string; pattern: RegExp; keys: string[]; handler: (c: Ctx) => unknown | Promise<unknown> }

export interface DevicesApiDeps {
  devices: DeviceService;
  push: PushService;
  /** Extra hostnames from POCKETROCKET_ALLOWED_HOSTS: where a phone can reach this hub (the QR's URL). */
  allowedHosts: readonly string[];
}

/**
 * `/api/devices/*` and `/api/push/*` (P9). The capability split lives in guard.ts (`deviceMayAccess`); the
 * handlers here add the per-object rules: a device may only see that it is itself, unpair itself and manage
 * its own push subscription. Minting a pairing code and renaming need the hub token.
 */
export function createDevicesApi(deps: DevicesApiDeps) {
  const { devices, push } = deps;
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Route['handler']) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, pattern, keys, handler });
  };
  const hubOnly = (req: IncomingMessage) => {
    if (principalOf(req)?.kind !== 'hub') throw new HttpError(403, 'Only the desktop app (hub token) can do this');
  };

  add('GET', '/api/devices', ({ req }) => {
    const me = deviceIdOf(req);
    // A phone learns about itself only; the desktop sees the whole list.
    const list = me ? devices.list().filter((d) => d.id === me) : devices.list();
    return { devices: list, current: me };
  });
  add('POST', '/api/devices/pairing', ({ req }) => {
    hubOnly(req);
    const { code, expiresAt } = devices.mintPairingCode();
    // The QR carries the hub's URL and this code, never the hub token. Without an allowed host the desktop
    // UI falls back to asking where the phone reaches the hub.
    return { code, expiresAt, ttlMs: PAIRING_TTL_MS, hosts: deps.allowedHosts };
  });
  add('PATCH', '/api/devices/:id', ({ req, params, body }) => {
    hubOnly(req);
    const name = (body as { name?: unknown })?.name;
    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name: required');
    const d = devices.rename(params.id, name);
    if (!d) throw new HttpError(404, 'Device not found');
    return d;
  });
  add('DELETE', '/api/devices/:id', ({ req, params }) => {
    const me = deviceIdOf(req);
    if (me && me !== params.id) throw new HttpError(403, 'A device can only unpair itself');
    if (!devices.get(params.id)) throw new HttpError(404, 'Device not found');
    devices.revoke(params.id);
    return { ok: true };
  });

  add('GET', '/api/push', ({ req }) => push.status(deviceIdOf(req)));
  add('POST', '/api/push/subscribe', ({ req, body }) => push.subscribe(deviceIdOf(req), body));
  add('POST', '/api/push/unsubscribe', ({ req, body }) => push.unsubscribe(deviceIdOf(req), body));
  // Only this principal's own subscriptions, and only the fixed test kind: the payload is `{"kind":"test"}`.
  add('POST', '/api/push/test', ({ req }) => push.send('test', { deviceId: deviceIdOf(req) }));

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/devices') && !url.pathname.startsWith('/api/push')) return false;
    const method = req.method ?? 'GET';
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: unknown;
      if (method !== 'GET' && method !== 'DELETE') {
        const parsed = await jsonBody(req);
        if (parsed === TOO_BIG) return send(res, 413, { error: 'Request body too large' });
        if (parsed === BAD_JSON) return send(res, 400, { error: 'Invalid JSON' });
        body = parsed;
      }
      try {
        return send(res, 200, (await r.handler({ params, body, req })) ?? { ok: true });
      } catch (e) {
        const status = e instanceof HttpError || e instanceof PushError ? e.status : 500;
        if (status === 500) console.error(e);
        return send(res, status, { error: (e as Error).message ?? String(e) });
      }
    }
    return false;
  };
}

/**
 * `POST /api/devices/pair`, token-exempt: the phone has nothing yet but the code from the QR. Every miss
 * feeds the failed-auth limiter (10 a minute per IP), so the 8-character code cannot be walked.
 */
export async function handleDevicePair(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { devices: DeviceService; limiter: AuthRateLimiter },
): Promise<void> {
  const ip = clientIp(req);
  const body = await jsonBody(req);
  if (body === TOO_BIG) { send(res, 413, { error: 'Request body too large' }); return; }
  if (body === BAD_JSON) { deps.limiter.fail(ip); send(res, 400, { error: 'Invalid JSON' }); return; }
  try {
    const b = (body ?? {}) as { code?: unknown; name?: unknown };
    const { token, device } = deps.devices.redeem(b.code, b.name);
    deps.limiter.succeed(ip);
    // no-store: the device token is in this body and nowhere else, ever.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ token, device }));
  } catch (e) {
    deps.limiter.fail(ip);
    // 403, not 401: a 401 tells the web client "the token you hold is wrong", and the phone holds none yet.
    if (e instanceof PairingError) { send(res, 403, { error: e.message }); return; }
    console.error(e);
    send(res, 500, { error: 'error' });
  }
}
export { DEVICE_PAIR_PATH };

const TOO_BIG = Symbol('too big');
const BAD_JSON = Symbol('bad json');
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf === null) return TOO_BIG;
  const raw = buf.toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return BAD_JSON; }
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
