import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { TriggerInputSchema, TriggerPatchSchema, TriggerTestSchema } from '@pocketrocket/shared';
import { readBody } from './body.js';
import type { TriggerService } from '../services/TriggerService.js';
import { IntegrationError } from '../integrations/http.js';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Ctx = { params: Record<string, string>; body: unknown };
interface Route { method: string; pattern: RegExp; keys: string[]; handler: (c: Ctx) => unknown | Promise<unknown> }

/**
 * `/api/triggers/*` (P5). Human-only like the rest of `/api` (hub token; no bot tool reaches it), so a bot
 * can never create, widen or enable a trigger. Kept out of rest.ts so the phases merge cleanly.
 *
 *   GET    /api/triggers              TriggersState (triggers, connected sources, poll health, 24 h stats)
 *   POST   /api/triggers              create
 *   PATCH  /api/triggers/:id          update (partial)
 *   DELETE /api/triggers/:id
 *   GET    /api/triggers/:id/fires    recent fires, newest first
 *   POST   /api/triggers/:id/test     fire once with a sample event ({ event?: {...} })
 */
export function createTriggersApi(deps: { triggers: TriggerService }) {
  const svc = deps.triggers;
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
  const found = <T>(v: T | undefined): T => {
    if (v === undefined) throw new HttpError(404, 'Trigger not found');
    return v;
  };

  add('GET', '/api/triggers', () => svc.state());
  add('POST', '/api/triggers', ({ body }) => svc.create(parse(TriggerInputSchema, body)));
  add('PATCH', '/api/triggers/:id', ({ params, body }) => found(svc.update(params.id, parse(TriggerPatchSchema, body))));
  add('DELETE', '/api/triggers/:id', ({ params }) => { found(svc.repo.get(params.id)); svc.delete(params.id); return { ok: true }; });
  add('GET', '/api/triggers/:id/fires', ({ params }) => { found(svc.repo.get(params.id)); return svc.repo.listFires(params.id); });
  add('POST', '/api/triggers/:id/test', ({ params, body }) => found(svc.testFire(params.id, parse(TriggerTestSchema, body ?? {}))));

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/triggers' && !url.pathname.startsWith('/api/triggers/')) return false;
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
        return send(res, 200, (await r.handler({ params, body })) ?? { ok: true });
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        if (e instanceof IntegrationError) return send(res, e.status >= 400 && e.status < 500 ? 400 : 502, { error: e.message });
        console.error('[triggers api]', e);
        return send(res, 500, { error: 'Internal error' });
      }
    }
    return send(res, 404, { error: 'Not found' });
  };
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
