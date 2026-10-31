import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  INTEGRATION_PROVIDERS, IntegrationGrantsSchema, OAuthAppInputSchema, TokenConnectSchema, type IntegrationProvider,
} from '@pocketrocket/shared';
import { readBody } from './body.js';
import type { Repos } from '../db/repos.js';
import type { IntegrationService } from '../services/IntegrationService.js';
import { IntegrationError } from '../integrations/http.js';
import { VaultError } from '../services/IntegrationVault.js';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Ctx = { params: Record<string, string>; body: unknown; req: IncomingMessage };
interface Route { method: string; pattern: RegExp; keys: string[]; handler: (c: Ctx) => unknown | Promise<unknown> }

/**
 * `/api/integrations/*` (P4). Human-only, like the rest of `/api`: it needs the hub token, and no bot tool
 * or MCP route reaches it. Kept out of rest.ts so the phases merge cleanly; hub.ts asks it before rest.
 *
 * Never answers 401: the web client reads a 401 as "wrong hub token". A provider refusing a credential is
 * a 400 with the provider's own words.
 */
export function createIntegrationsApi(deps: { integrations: IntegrationService; repos: Repos }) {
  const { integrations: svc, repos } = deps;
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Route['handler']) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, pattern, keys, handler });
  };
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
    return r.data;
  };
  const provider = (p: string): IntegrationProvider => {
    if (!(INTEGRATION_PROVIDERS as readonly string[]).includes(p)) throw new HttpError(404, 'Unknown provider');
    return p as IntegrationProvider;
  };

  add('GET', '/api/integrations', ({ req }) => svc.state(req.headers.host));
  add('PUT', '/api/integrations/apps/:provider', ({ params, body }) => svc.setApp(provider(params.provider), parse(OAuthAppInputSchema, body)));
  add('DELETE', '/api/integrations/apps/:provider', ({ params }) => svc.deleteApp(provider(params.provider)));
  add('POST', '/api/integrations/token/:provider', ({ params, body }) => svc.connectToken(provider(params.provider), parse(TokenConnectSchema, body)));
  add('POST', '/api/integrations/device/:provider', ({ params }) => svc.startDevice(provider(params.provider)));
  add('POST', '/api/integrations/cancel/:provider', ({ params }) => { svc.cancel(provider(params.provider)); return { ok: true }; });
  add('POST', '/api/integrations/:id/test', ({ params }) => svc.test(params.id));
  add('PUT', '/api/integrations/:id/grants', ({ params, body }) => {
    const { botIds } = parse(IntegrationGrantsSchema, body);
    const unknown = botIds.filter((id) => !repos.getBot(id));
    if (unknown.length) throw new HttpError(400, 'Unknown bot id(s): ' + unknown.join(', '));
    return svc.setGrants(params.id, botIds);
  });
  add('DELETE', '/api/integrations/:id', ({ params }) => { svc.disconnect(params.id); return { ok: true }; });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/integrations' && !url.pathname.startsWith('/api/integrations/')) return false;
    const method = req.method ?? 'GET';
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: unknown;
      if (method !== 'GET' && method !== 'DELETE') {
        const buf = await readBody(req);
        if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
        const raw = buf.toString('utf8');
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      }
      try {
        return send(res, 200, (await r.handler({ params, body, req })) ?? { ok: true });
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        if (e instanceof IntegrationError) return send(res, e.status === 404 ? 404 : e.status >= 400 && e.status < 500 ? 400 : 502, { error: e.message });
        if (e instanceof VaultError) return send(res, 500, { error: e.message });
        console.error(e);
        return send(res, 500, { error: 'Integration request failed' });
      }
    }
    return send(res, 404, { error: 'Not found' });
  };
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
