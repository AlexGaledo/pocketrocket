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

/** P9 (decision Q9): opt-in extra hostnames, from POCKETROCKET_ALLOWED_HOSTS. Empty means loopback only. */
export interface OriginOptions {
  allowedHosts?: readonly string[];
}

/**
 * True when a proxy on this machine says the browser spoke HTTPS to it: `X-Forwarded-Proto: https` (first hop)
 * on a connection from loopback. Tailscale Serve terminates TLS for the tailnet name and connects to the hub
 * from 127.0.0.1. Nothing off the machine can reach the hub's socket (it binds loopback), and a web page
 * cannot add the header to a request without a preflight that the Origin check then fails.
 */
export function forwardedHttps(req: IncomingMessage): boolean {
  const raw = req.headers['x-forwarded-proto'];
  const proto = String(Array.isArray(raw) ? raw[0] : raw ?? '').split(',')[0].trim().toLowerCase();
  if (proto !== 'https') return false;
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
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
export function checkRequestOrigin(
  req: IncomingMessage,
  hubPort: number,
  opts: OriginOptions = {},
): { ok: true } | { ok: false; status: number; reason: string } {
  const host = req.headers.host;
  const hn = hostname(host);
  // P9: a listed tailnet name counts as ours, but only on a request that came in over HTTPS via a local proxy.
  const allowed = (name: string) => (opts.allowedHosts?.length ?? 0) > 0 && forwardedHttps(req) && opts.allowedHosts!.includes(name.toLowerCase());
  const hostOk = !!hn && (LOOPBACK.has(hn) || allowed(hn));
  if (!hostOk) return { ok: false, status: 403, reason: 'Bad Host header: ' + (host ?? '(none)') };

  const origin = req.headers.origin;
  if (origin) {
    if (origin === 'null') return { ok: false, status: 403, reason: 'Opaque origin rejected (Origin: null)' };
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return { ok: false, status: 403, reason: 'Bad Origin: ' + origin };
    }
    // P9: the page Tailscale Serve hands the phone is https://<allowed host>[:port]; any port, since Serve can
    // listen on 443, 8443 or 10000. Plain http:// on an allowed name is never same-origin with that page.
    const remoteOk = u.protocol === 'https:' && allowed(u.hostname);
    const okHost = LOOPBACK.has(u.hostname);
    const okPort = u.port === String(hubPort) || (port(host) !== null && u.port === port(host));
    if (!remoteOk && (!okHost || !okPort)) return { ok: false, status: 403, reason: 'Cross-origin request rejected: ' + origin };
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
  /** P9: true when `supplied` is a paired device's token that has not been revoked. */
  deviceToken?: (supplied: string) => boolean;
}

/**
 * Where the account email link (and an OAuth provider) sends the browser back to. A top-level navigation from
 * the user's default browser, so it can carry neither the hub token nor the UI's cookie.
 */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * P4: where a provider sends the browser back after an integration sign-in, `/oauth/callback/<provider>`.
 * Token-exempt for the same reason as AUTH_CALLBACK_PATH. It is safe because the handler accepts it only
 * for a `state` this hub minted moments ago (single use, 10 minutes) and exchanges the code together with
 * the PKCE verifier only this hub holds; anything else counts as a failed auth for the rate limiter.
 */
export const OAUTH_CALLBACK_PREFIX = '/oauth/callback/';

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
  if (url.pathname.startsWith(OAUTH_CALLBACK_PREFIX) && method === 'GET') return true;
  if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return true;
  if (url.pathname.startsWith('/screen/')) return opts.screenAuth?.(req) ?? false;
  if (method === 'GET' && (url.pathname === '/' || (opts.isPublicAsset?.(url.pathname) ?? false))) return true;
  // P9: the phone redeems its one-time pairing code here before it holds any credential; the handler feeds
  // the rate limiter on every miss, exactly like /auth/callback.
  if (url.pathname === DEVICE_PAIR_PATH && method === 'POST') return true;
  const supplied = bearerToken(req) ?? url.searchParams.get('token');
  if (tokenMatches(supplied, token)) return true;
  // P9: or a paired, non-revoked device. What it may then reach is narrower: see deviceMayAccess.
  return supplied !== null && (opts.deviceToken?.(supplied) ?? false);
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

// ---------------------------------------------------------------------------------------------------
// P9: devices. Who a request is, and what a paired phone may do.

/** Where a phone trades its one-time pairing code for a device token. Token-exempt; see checkToken. */
export const DEVICE_PAIR_PATH = '/api/devices/pair';

/**
 * Who authenticated a request: the hub token (the desktop app, scripts, the SSH tunnel) or one paired device.
 * Requests on token-exempt paths have no principal.
 */
export type Principal = { kind: 'hub' } | { kind: 'device'; deviceId: string };

const principals = new WeakMap<IncomingMessage, Principal>();
/** Set once per request by hub.ts, right after the token check. */
export function setPrincipal(req: IncomingMessage, p: Principal): void {
  principals.set(req, p);
}
export function principalOf(req: IncomingMessage): Principal | null {
  return principals.get(req) ?? null;
}
/** The device id behind a request, or null for the hub token / no principal. */
export function deviceIdOf(req: IncomingMessage): string | null {
  const p = principals.get(req);
  return p?.kind === 'device' ? p.deviceId : null;
}

/**
 * The capability split (P9). The hub token can do everything. A device token is an **allowlist**: what a phone
 * needs to follow the fleet (read bots, rooms, messages, routines, usage), chat, answer approval cards (once —
 * "always" is refused over the socket, see ws.ts), watch a Screen, and run Automations. Anything not listed —
 * and so every route a later phase adds until it is listed here — is refused with 403. In particular a device
 * can never:
 *   - mint a pairing code, rename or revoke another device (only itself),
 *   - read or write secrets, integrations or their OAuth apps (`/api/secrets`, `/api/integrations/*`, `/oauth/*`),
 *   - change settings at all (`PUT /api/settings` is where approvals/bypass live) or the account,
 *   - change the fleet (bots, rooms, memory, skills review/import) or spawn a provider CLI check,
 *   - reach `/api/debug/*` or open the workspace on the hub's machine.
 * 403, never 401: the web client reads 401 as "this token is wrong" and would drop a perfectly good pairing.
 */
const DEVICE_ALLOW: readonly [method: string, path: RegExp][] = [
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/settings$/],
  ['GET', /^\/api\/providers$/],
  ['GET', /^\/api\/account$/],
  ['GET', /^\/api\/config$/],
  ['GET', /^\/api\/bots$/],
  ['GET', /^\/api\/bots\/[^/]+\/(memory|skills|voice|notes)$/],
  ['GET', /^\/api\/rooms$/],
  ['GET', /^\/api\/rooms\/[^/]+\/messages$/],
  ['POST', /^\/api\/rooms\/[^/]+\/messages$/],
  ['GET', /^\/api\/skills$/],
  ['GET', /^\/api\/skills\/[^/]+$/],
  ['GET', /^\/api\/usage$/],
  ['GET', /^\/api\/knowledge$/],
  // Screen tab
  ['GET', /^\/api\/screen$/],
  ['POST', /^\/api\/screen\/ticket$/],
  ['GET', /^\/api\/computers\/[^/]+$/],
  ['POST', /^\/api\/computers\/[^/]+\/wake$/],
  ['PUT', /^\/api\/computers\/[^/]+\/keep-awake$/],
  // Automations (routine turns always go through approvals, decision Q6)
  ['GET', /^\/api\/routines$/],
  ['POST', /^\/api\/routines$/],
  ['PATCH', /^\/api\/routines\/[^/]+$/],
  ['DELETE', /^\/api\/routines\/[^/]+$/],
  ['POST', /^\/api\/routines\/[^/]+\/run$/],
  ['GET', /^\/api\/routines\/[^/]+\/runs$/],
  // Its own pairing (the handlers refuse anything but the device itself) and its own push subscription.
  ['GET', /^\/api\/devices$/],
  ['DELETE', /^\/api\/devices\/[^/]+$/],
  ['GET', /^\/api\/push$/],
  ['POST', /^\/api\/push\/(subscribe|unsubscribe|test)$/],
];

/**
 * True when a device token may make this request. Outside `/api/` a device gets plain GETs (the shell and its
 * assets; `/screen/*` has its own cookie check) and nothing under `/oauth/`, which starts integration sign-ins.
 */
export function deviceMayAccess(method: string, pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (!p.startsWith('/api/')) return method === 'GET' && !p.startsWith('/oauth/') && p !== '/mcp' && !p.startsWith('/mcp/');
  return DEVICE_ALLOW.some(([m, re]) => m === method && re.test(p));
}
