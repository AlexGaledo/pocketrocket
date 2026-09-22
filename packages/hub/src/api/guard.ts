import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i > 0 ? h.slice(0, i) : h;
}
function port(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  const i = h.lastIndexOf(':');
  return i > 0 && !h.endsWith(']') ? h.slice(i + 1) : null;
}

/**
 * Loopback-only hardening for a hub that binds 127.0.0.1:
 * - `Host` must name a loopback address (blocks DNS rebinding, where an attacker's domain resolves to 127.0.0.1).
 *   The port is not pinned so an SSH tunnel on a different local port still works.
 * - `Origin`, when present, must be a loopback origin on the hub's port or on the port the request came in on
 *   (i.e. same-origin as the page the hub itself served). Blocks CSRF from arbitrary web pages.
 *
 * `Origin: null` is treated as foreign (audit 2026-09-09, B1). It used to be whitelisted, but a sandboxed
 * iframe (`<iframe sandbox="allow-scripts">`) on any site sends exactly that, with `text/plain` and therefore
 * no preflight, which reached every mutating route.
 */
export function checkRequestOrigin(req: IncomingMessage, hubPort: number): { ok: true } | { ok: false; status: number; reason: string } {
  const host = req.headers.host;
  const hn = hostname(host);
  if (!hn || !LOOPBACK.has(hn)) return { ok: false, status: 403, reason: 'Bad Host header: ' + (host ?? '(none)') };

  const origin = req.headers.origin;
  if (origin) {
    if (origin === 'null') return { ok: false, status: 403, reason: 'Opaque origin rejected (Origin: null)' };
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return { ok: false, status: 403, reason: 'Bad Origin: ' + origin };
    }
    const okHost = LOOPBACK.has(u.hostname);
    const okPort = u.port === String(hubPort) || (port(host) !== null && u.port === port(host));
    if (!okHost || !okPort) return { ok: false, status: 403, reason: 'Cross-origin request rejected: ' + origin };
  }
  return { ok: true };
}

/** Methods that can change state and therefore carry a body. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Belt and braces against the no-preflight form post (audit 2026-09-09, B1): a cross-site `<form>` can only
 * send `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`, never `application/json`,
 * and asking for JSON forces a preflight that the Origin check then fails. Non-`/api/` paths are untouched
 * (`/mcp` negotiates its own content types).
 */
export function checkContentType(req: IncomingMessage, url: URL): { ok: true } | { ok: false; status: number; reason: string } {
  if (!url.pathname.startsWith('/api/')) return { ok: true };
  if (!MUTATING.has(req.method ?? 'GET')) return { ok: true };
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/json') return { ok: true };
  return { ok: false, status: 415, reason: 'Content-Type must be application/json (got ' + (ct || '(none)') + ')' };
}

/** Bearer token in the Authorization header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** A single cookie value out of the `Cookie` header, or null. Node hands us the raw header and nothing else. */
export function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Constant-time string compare, length-guarded (audit 2026-09-09, B16). */
export function tokenMatches(supplied: string | null, expected: string): boolean {
  if (supplied === null) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong-length guess is not measurably faster than a wrong-value one.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface TokenOptions {
  /** True when a GET of this pathname maps to a file the hub serves publicly out of WEB_DIST. */
  isPublicAsset?: (pathname: string) => boolean;
  /**
   * Credential check for `/screen/*`, which has its own scheme (see ScreenSessions). Left out, `/screen/*` is
   * refused outright — an unwired caller must not accidentally get the looser query-string rule back.
   */
  screenAuth?: (req: IncomingMessage) => boolean;
}

/**
 * Where the account email link (and an OAuth provider) sends the browser back to. A top-level navigation from
 * the user's default browser, so it can carry neither the hub token nor the UI's cookie.
 */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * Allowlist, not deny-list (audit 2026-09-09, B2). With a token configured EVERYTHING needs it except:
 * `GET /api/health` (the desktop app polls it before it has the token), `GET /` and the static web assets
 * under WEB_DIST (the shell that then asks for the token), `/mcp`, which carries its own per-turn bearer
 * and is checked by the MCP handler, and exactly `GET /auth/callback`: its `code` is only exchangeable with
 * the PKCE verifier this hub holds, and the handler refuses it when no sign-in is waiting. The Host check
 * still applies to it. `/screen/*` — HTTP and the websocket upgrade — is no longer exempt: it proxies
 * into a passwordless noVNC session that, in server mode, drives a root desktop.
 *
 * `/screen/*` is also the one place `?token=` is refused. A browser cannot put a header on an iframe or a
 * websocket, so the token used to ride the query string; it now presents a `/screen`-scoped httpOnly cookie
 * instead, and the branch sits above the public-asset check so no file layout under WEB_DIST can widen it.
 */
export function checkToken(req: IncomingMessage, url: URL, token: string | null, opts: TokenOptions = {}): boolean {
  if (!token) return true;
  const method = req.method ?? 'GET';
  if (url.pathname === '/api/health' && method === 'GET') return true;
  if (url.pathname === AUTH_CALLBACK_PATH && method === 'GET') return true;
  if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return true;
  // Linked hubs authenticate with the peer token inside handlePeer; the hub token is never shared with a peer.
  if (url.pathname.startsWith('/api/peer/')) return true;
  if (url.pathname.startsWith('/screen/')) return opts.screenAuth?.(req) ?? false;
  if (method === 'GET' && (url.pathname === '/' || (opts.isPublicAsset?.(url.pathname) ?? false))) return true;
  return tokenMatches(bearerToken(req) ?? url.searchParams.get('token'), token);
}

/**
 * Whether the request actually carried the hub token, as opposed to merely passing checkToken on a
 * token-exempt path (/api/health, /, static assets, /mcp). Only this may clear the rate limiter: otherwise
 * nine bad guesses, one GET /api/health, and nine more walks straight past the brake.
 */
export function presentsHubToken(req: IncomingMessage, url: URL, token: string | null): boolean {
  return token !== null && tokenMatches(bearerToken(req) ?? url.searchParams.get('token'), token);
}

/**
 * In-memory brute-force brake (audit 2026-09-09, B15): 10 failed auths from one IP inside a minute lock that
 * IP out for a minute. Per hub process, deliberately tiny — the hub is loopback-only, so the population of
 * "IPs" is 127.0.0.1 plus whatever a tunnel presents, and the point is to make walking a token byte by byte
 * (see B16) impractical rather than to be a real WAF.
 */
export class AuthRateLimiter {
  private hits = new Map<string, { count: number; first: number; blockedUntil: number }>();
  constructor(
    private max = 10,
    private windowMs = 60_000,
    private blockMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** True when this IP is currently locked out. */
  blocked(ip: string): boolean {
    const e = this.hits.get(ip);
    if (!e) return false;
    if (e.blockedUntil > this.now()) return true;
    if (e.blockedUntil) this.hits.delete(ip);
    return false;
  }

  /** Record a failed auth; returns true when this failure tripped the block. */
  fail(ip: string): boolean {
    const t = this.now();
    const e = this.hits.get(ip);
    if (!e || t - e.first > this.windowMs) {
      this.hits.set(ip, { count: 1, first: t, blockedUntil: 0 });
      return false;
    }
    e.count += 1;
    if (e.count >= this.max) {
      e.blockedUntil = t + this.blockMs;
      return true;
    }
    return false;
  }

  /** Forget an IP after a successful auth. */
  succeed(ip: string): void {
    this.hits.delete(ip);
  }
}

/** Remote address of a request, or '?' when the socket is already gone. */
export function clientIp(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? '?';
}
