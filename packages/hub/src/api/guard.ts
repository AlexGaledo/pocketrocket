import type { IncomingMessage } from 'node:http';

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
 */
export function checkRequestOrigin(req: IncomingMessage, hubPort: number): { ok: true } | { ok: false; status: number; reason: string } {
  const host = req.headers.host;
  const hn = hostname(host);
  if (!hn || !LOOPBACK.has(hn)) return { ok: false, status: 403, reason: 'Bad Host header: ' + (host ?? '(none)') };

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
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

/** Bearer token in the Authorization header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * With POCKETROCKET_TOKEN set, every /api/* call except `GET /api/health` needs the bearer token and /ws
 * needs `?token=`. /mcp carries its own per-turn token and is checked by the MCP handler.
 */
export function checkToken(req: IncomingMessage, url: URL, token: string | null): boolean {
  if (!token) return true;
  if (url.pathname === '/api/health' && (req.method ?? 'GET') === 'GET') return true;
  if (url.pathname.startsWith('/mcp')) return true;
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/ws') return true;
  const supplied = bearerToken(req) ?? url.searchParams.get('token');
  return supplied === token;
}
