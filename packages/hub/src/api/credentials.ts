import type { IncomingMessage, ServerResponse } from 'node:http';
import { CredentialCreateSchema, CredentialPatchSchema } from '@pocketrocket/shared';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Db } from '../db/db.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import { CredentialError, type CredentialStore } from '../services/CredentialStore.js';
import { logError } from '../providers/redact.js';

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
};

export const CREDENTIAL_SIGN_IN_MESSAGE =
  'Saving, changing or deleting a login needs a browser signed in with your password; the server token is not enough. Set a password in Settings, sign in, then try again.';

/**
 * `/api/credentials`: the owner's saved logins for `fill_credential`. Human-only: the hub token or a signed-in
 * browser; a bot's per-turn bearer only opens /mcp and a paired device is refused. Changes need a signed-in browser,
 * the same bar as approving a fill. The secret is write-only: no route returns it, and errors never echo the body.
 *
 *   GET    /api/credentials        -> { credentials: CredentialInfo[] }
 *   POST   /api/credentials        { name, origin, username?, secret }
 *   PATCH  /api/credentials/:id    any of name, origin, username, secret (absent secret keeps the stored one)
 *   DELETE /api/credentials/:id
 */
export function createCredentialsApi(deps: { store: CredentialStore; db: Db }) {
  const { store, db } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/credentials' && !url.pathname.startsWith('/api/credentials/')) return false;
    const method = req.method ?? 'GET';
    const principal = principalOf(req);
    const actor = actorOf(req);
    if (!principal || principal.kind !== 'hub' || !actor) return send(res, 403, { error: 'Not available from a paired device' });
    const id = url.pathname.replace(/^\/api\/credentials\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)[0];
    const signedIn = !!principal.sessionId;

    try {
      if (method === 'GET' && id === undefined) return send(res, 200, { credentials: store.list() });
      if (method !== 'GET' && !signedIn) return send(res, 403, { error: CREDENTIAL_SIGN_IN_MESSAGE, signInRequired: true });

      if (method === 'POST' && id === undefined) {
        const body = await json(req, res);
        if (body === undefined) return true;
        const parsed = CredentialCreateSchema.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: issues(parsed.error) });
        const info = store.create(parsed.data);
        recordAudit(db, actor, 'credential.added', info.name, info.origin);
        return send(res, 201, info);
      }
      if (method === 'PATCH' && id !== undefined) {
        const body = await json(req, res);
        if (body === undefined) return true;
        const parsed = CredentialPatchSchema.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: issues(parsed.error) });
        const info = store.update(id, parsed.data);
        recordAudit(db, actor, 'credential.changed', info.name, Object.keys(parsed.data).join(','));
        return send(res, 200, info);
      }
      if (method === 'DELETE' && id !== undefined) {
        const cur = store.get(id);
        if (!cur) return send(res, 404, { error: 'No such saved login' });
        store.delete(id);
        recordAudit(db, actor, 'credential.removed', cur.name, cur.origin);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'No such route' });
    } catch (e) {
      if (e instanceof CredentialError) return send(res, e.status, { error: e.message });
      logError('[api/credentials]', e);
      return send(res, 500, { error: 'Could not update the saved logins' });
    }
  };
}

/** Field paths and rules only: zod issue messages here never quote the submitted value. */
const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  e.issues.map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ');

async function json(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const buf = await readBody(req);
  if (buf === null) { send(res, 413, { error: 'Request body too large (max 1 MB)' }); return undefined; }
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { send(res, 400, { error: 'Invalid JSON' }); return undefined; }
}
