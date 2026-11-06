import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import { actorOf, listAudit, recordAudit, type AuditActor } from '../services/AuditLog.js';
import { AuthError, SESSION_TTL_MS, checkNewPassword, type AuthService } from '../services/AuthService.js';
import { logError } from '../providers/redact.js';
import { readBody } from './body.js';
import { clientIp, cookieValue, forwardedHttps, principalOf, type AuthRateLimiter } from './guard.js';

export const AUTH_LOGIN_PATH = '/api/auth/login';
export const AUTH_STATUS_PATH = '/api/auth/status';

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): boolean {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
  return true;
}

async function jsonBody(req: IncomingMessage): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const buf = await readBody(req);
  if (buf === null) return { ok: false, status: 413, error: 'Request body too large' };
  try {
    const parsed: unknown = buf.length ? JSON.parse(buf.toString('utf8')) : {};
    return { ok: true, body: (parsed ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }
}

/** httpOnly so page scripts cannot read it. Secure when the hub is reached over https, which a plain SSH tunnel is not. */
function sessionCookie(req: IncomingMessage, name: string, value: string, maxAgeMs: number): string {
  return name + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(maxAgeMs / 1000) + (forwardedHttps(req) ? '; Secure' : '');
}

/**
 * Counts the try before the slow hash, so guesses sent in parallel cannot all pass the limiter while the first is
 * still hashing. Only the right password clears the count.
 */
async function checkPassword(deps: AuthApiDeps, ip: string, userId: string, password: unknown): Promise<'ok' | 'wrong' | 'blocked'> {
  if (deps.limiter.blocked(ip)) return 'blocked';
  deps.limiter.fail(ip);
  if (!(await deps.auth.verifyPassword(userId, password))) return 'wrong';
  deps.limiter.succeed(ip);
  return 'ok';
}

const TOO_MANY = { error: 'Too many failed authentication attempts; try again in a minute' };

export interface AuthApiDeps {
  db: Db;
  repos: Repos;
  auth: AuthService;
  limiter: AuthRateLimiter;
  /** This hub's session cookie name. */
  cookieName: () => string;
}

/** Token-exempt: the sign-in screen asks this before it holds any credential. It reveals only these two flags. */
export function handleAuthStatus(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps): void {
  send(res, 200, {
    passwordSet: deps.auth.hasPassword(deps.repos.owner().id),
    signedIn: !!deps.auth.authenticate(cookieValue(req, deps.cookieName())),
  });
}

/** Token-exempt, so every miss feeds the failed-auth limiter (10 a minute per IP). */
export async function handleLogin(req: IncomingMessage, res: ServerResponse, deps: AuthApiDeps): Promise<void> {
  const ip = clientIp(req);
  const parsed = await jsonBody(req);
  if (!parsed.ok) { send(res, parsed.status, { error: parsed.error }); return; }
  const owner = deps.repos.owner();
  const actor: AuditActor = { kind: 'session', id: owner.id, ip };
  const result = await checkPassword(deps, ip, owner.id, parsed.body.password);
  if (result === 'blocked') { send(res, 429, TOO_MANY, { 'retry-after': '60' }); return; }
  if (result === 'wrong') {
    recordAudit(deps.db, { kind: 'anonymous', id: null, ip }, 'auth.sign_in_failed');
    // 403, not 401: a 401 tells the web client that the credential it already holds is wrong.
    send(res, 403, { error: 'Wrong password.' });
    return;
  }
  const { token, id } = deps.auth.createSession(owner.id, { userAgent: req.headers['user-agent'], ip });
  recordAudit(deps.db, actor, 'auth.signed_in', id);
  send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, deps.cookieName(), token, SESSION_TTL_MS) });
}

/** Everything under `/api/auth/*` that needs a credential, and `/api/audit`. A paired phone reaches none of it (guard.ts). */
export function createAuthApi(deps: AuthApiDeps) {
  const { db, repos, auth } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p !== '/api/audit' && !p.startsWith('/api/auth/')) return false;
    const method = req.method ?? 'GET';
    const principal = principalOf(req);
    const actor = actorOf(req);
    if (!principal || principal.kind !== 'hub' || !actor) return send(res, 403, { error: 'Not available from a paired device' });
    const owner = repos.owner();
    const current = principal.sessionId ?? null;
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      const parsed = await jsonBody(req);
      if (!parsed.ok) return send(res, parsed.status, { error: parsed.error });
      body = parsed.body;
    }
    try {
      if (method === 'GET' && p === '/api/audit') {
        const before = Number(url.searchParams.get('before')) || undefined;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        return send(res, 200, { entries: listAudit(db, { before, limit }) });
      }
      if (method === 'GET' && p === '/api/auth/sessions') {
        return send(res, 200, { sessions: auth.list(owner.id, current), current, passwordSet: auth.hasPassword(owner.id) });
      }
      if (method === 'POST' && p === '/api/auth/logout') {
        if (current) {
          auth.revoke(owner.id, current);
          recordAudit(db, actor, 'auth.signed_out', current);
        }
        return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, deps.cookieName(), '', 0) });
      }
      if (method === 'POST' && p === '/api/auth/password') {
        const had = auth.hasPassword(owner.id);
        // Changing a password always needs the current one, from the hub token too. A password is what a signed-in
        // browser proves, and only a signed-in browser may approve a job on the PC (PermissionBroker SIGN_IN_TOOLS);
        // if the token could reset it, a bot that read the token could sign itself in and answer its own card.
        // A forgotten password is cleared by starting the hub with POCKETROCKET_RESET_PASSWORD=1.
        if (had) {
          const result = await checkPassword(deps, clientIp(req), owner.id, body.currentPassword);
          if (result === 'blocked') return send(res, 429, TOO_MANY, { 'retry-after': '60' });
          if (result === 'wrong') {
            recordAudit(db, actor, 'auth.password_change_failed');
            return send(res, 403, { error: 'Current password is wrong.' });
          }
        }
        await auth.setPassword(owner.id, checkNewPassword(body.password));
        // A password change is often a reaction to a leak, so every other browser has to sign in again.
        const ended = auth.revokeAll(owner.id, current);
        recordAudit(db, actor, had ? 'auth.password_changed' : 'auth.password_set', null, ended ? ended + ' other sessions signed out' : null);
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && p === '/api/auth/sessions/revoke-others') {
        const ended = auth.revokeAll(owner.id, current);
        recordAudit(db, actor, 'auth.sessions_revoked', null, String(ended));
        return send(res, 200, { ended });
      }
      const one = /^\/api\/auth\/sessions\/([^/]+)$/.exec(p);
      if (method === 'DELETE' && one) {
        const id = decodeURIComponent(one[1]);
        if (!auth.revoke(owner.id, id)) return send(res, 404, { error: 'Session not found' });
        recordAudit(db, actor, 'auth.session_revoked', id);
        return send(res, 200, { ok: true });
      }
      return false;
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 500;
      if (status === 500) logError('[auth api]', e);
      return send(res, status, { error: status === 500 ? 'error' : (e as Error).message });
    }
  };
}
