import { describe, expect, it } from 'vitest';
import { SCREEN_COOKIE, ScreenSessions } from './screenSession.js';

/** Pull the cookie value out of a Set-Cookie header. */
const valueOf = (setCookie: string) => setCookie.slice(SCREEN_COOKIE.length + 1).split(';')[0];

describe('ScreenSessions', () => {
  it('mints a ticket with real entropy and a redemption URL', () => {
    const s = new ScreenSessions();
    const { ticket, url } = s.mintTicket();
    // 32 random bytes as base64url: comfortably past the 128-bit floor and URL-safe without escaping.
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url).toBe('/screen/session?ticket=' + ticket);
    expect(s.mintTicket().ticket).not.toBe(ticket);
  });

  it('redeems a ticket once and hands back a cookie the page cannot read', () => {
    const s = new ScreenSessions();
    const { ticket } = s.mintTicket();
    const cookie = s.redeem(ticket);
    expect(cookie).not.toBeNull();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/screen');
    expect(cookie).toMatch(/Max-Age=\d+/);
    // Plain http on loopback: a Secure cookie would never be stored and the Screen tab would never load.
    expect(cookie).not.toContain('Secure');
    expect(s.valid(valueOf(cookie!))).toBe(true);
  });

  it('refuses a replayed ticket', () => {
    const s = new ScreenSessions();
    const { ticket } = s.mintTicket();
    expect(s.redeem(ticket)).not.toBeNull();
    expect(s.redeem(ticket)).toBeNull();
  });

  it('refuses an expired ticket, and the session it would have opened outlives it', () => {
    let now = 1_000_000;
    const s = new ScreenSessions(() => now);
    const stale = s.mintTicket().ticket;
    const fresh = s.mintTicket().ticket;
    const cookie = s.redeem(fresh)!;
    now += 61_000;
    expect(s.redeem(stale)).toBeNull();
    // A minute later the viewer is still authenticated; only the handshake is short-lived.
    expect(s.valid(valueOf(cookie))).toBe(true);
  });

  it('expires a session once its lifetime is up', () => {
    let now = 0;
    const s = new ScreenSessions(() => now);
    const cookie = s.redeem(s.mintTicket().ticket)!;
    now += 4 * 60 * 60 * 1000 - 1;
    expect(s.valid(valueOf(cookie))).toBe(true);
    now += 2;
    expect(s.valid(valueOf(cookie))).toBe(false);
  });

  it('refuses unknown, empty and missing credentials', () => {
    const s = new ScreenSessions();
    s.mintTicket();
    expect(s.redeem(null)).toBeNull();
    expect(s.redeem('')).toBeNull();
    expect(s.redeem('not-a-ticket')).toBeNull();
    expect(s.valid(null)).toBe(false);
    expect(s.valid('')).toBe(false);
    expect(s.valid('not-a-session')).toBe(false);
  });

  it('caps both lists so hammering the mint route cannot grow memory without bound', () => {
    let now = 0;
    const s = new ScreenSessions(() => now);
    const first = s.mintTicket().ticket;
    for (let i = 0; i < 200; i++) s.mintTicket();
    // The oldest tickets were pushed out by the cap rather than kept around until their TTL.
    expect(s.redeem(first)).toBeNull();
    const last = s.mintTicket().ticket;
    expect(s.redeem(last)).not.toBeNull();

    const cookies = Array.from({ length: 100 }, () => s.redeem(s.mintTicket().ticket)!);
    expect(s.valid(valueOf(cookies[0]))).toBe(false);
    expect(s.valid(valueOf(cookies[cookies.length - 1]))).toBe(true);
  });
});
