import { randomBytes } from 'node:crypto';
import { tokenMatches } from './guard.js';

/**
 * The noVNC page the Screen tab actually loads. It lives here because two places have to agree on it:
 * `GET /api/screen`, which tells the web client the screen is up, and the ticket redirect, which is where
 * the browser lands once it holds the cookie.
 */
export const SCREEN_VIEWER_PATH = '/screen/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=screen%2Fwebsockify';

/** Name of the httpOnly cookie that authenticates `/screen/*`. */
export const SCREEN_COOKIE = 'pr_screen';

/** Long enough for a redirect, short enough that a ticket left in a log or a history entry is already dead. */
const TICKET_TTL_MS = 60_000;
/** One sitting in front of the desktop. Reloading the Screen tab mints a fresh one, so this is not a cliff. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
// Loopback with one human at the keyboard: a handful of live viewers is already generous. The caps are what
// keep these lists from growing without bound if something hammers the mint route.
const MAX_TICKETS = 64;
const MAX_SESSIONS = 32;

interface Entry { value: string; expires: number }

/**
 * Why a ticket at all: an `<iframe>` cannot send an Authorization header, so the only way the hub token could
 * reach the noVNC proxy was the iframe's own URL — where it then sits in the DOM, in the parent document's
 * history and in anything that later reads `location`. Instead the app spends the token once, over a normal
 * authenticated POST, on a single-use ticket; the browser trades that ticket for an httpOnly cookie it can
 * never read back, and the hub token never appears in a URL at all.
 */
export class ScreenSessions {
  private tickets: Entry[] = [];
  private sessions: Entry[] = [];
  constructor(private now: () => number = Date.now) {}

  /** Mint a one-shot ticket and the URL that redeems it. */
  mintTicket(): { ticket: string; url: string } {
    this.sweep();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.push({ value: ticket, expires: this.now() + TICKET_TTL_MS });
    if (this.tickets.length > MAX_TICKETS) this.tickets.splice(0, this.tickets.length - MAX_TICKETS);
    return { ticket, url: '/screen/session?ticket=' + encodeURIComponent(ticket) };
  }

  /**
   * Spend a ticket. Returns the `Set-Cookie` header for the session it opens, or null when the ticket is
   * unknown, already spent or stale — the caller treats that exactly like any other failed authentication.
   */
  redeem(ticket: string | null): string | null {
    this.sweep();
    const i = this.find(this.tickets, ticket);
    if (i < 0) return null;
    // Single use: the ticket is burnt here, whether or not the browser ever follows the redirect.
    this.tickets.splice(i, 1);
    const value = randomBytes(32).toString('base64url');
    this.sessions.push({ value, expires: this.now() + SESSION_TTL_MS });
    if (this.sessions.length > MAX_SESSIONS) this.sessions.splice(0, this.sessions.length - MAX_SESSIONS);
    return cookieHeader(value, Math.floor(SESSION_TTL_MS / 1000));
  }

  /** True when this cookie value names a session that is still open. */
  valid(cookie: string | null): boolean {
    this.sweep();
    return this.find(this.sessions, cookie) >= 0;
  }

  /** Deliberately no early exit: a near miss must not be measurably faster than a wild guess. */
  private find(list: Entry[], supplied: string | null): number {
    if (supplied === null) return -1;
    let found = -1;
    for (let i = 0; i < list.length; i++) if (tokenMatches(supplied, list[i].value)) found = i;
    return found;
  }

  /** Called on every mint, redeem and check, so expired entries can never pile up between requests. */
  private sweep(): void {
    const t = this.now();
    this.tickets = this.tickets.filter((e) => e.expires > t);
    this.sessions = this.sessions.filter((e) => e.expires > t);
  }
}

/**
 * `Secure` is deliberately absent: the hub speaks plain http on 127.0.0.1 (remote access is an SSH tunnel or
 * Tailscale, which terminate as loopback), so a Secure cookie would simply never be stored and the Screen tab
 * would never load. `Path=/screen` keeps it off `/api` and `/ws`, and `SameSite=Strict` keeps any other site
 * from riding it — including through a top-level navigation, which is where Lax would still send it.
 */
function cookieHeader(value: string, maxAgeSeconds: number): string {
  return SCREEN_COOKIE + '=' + value + '; HttpOnly; SameSite=Strict; Path=/screen; Max-Age=' + maxAgeSeconds;
}
