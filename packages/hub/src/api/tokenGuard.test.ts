import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { AuthRateLimiter, checkContentType, checkRequestOrigin, checkToken, tokenMatches } from './guard.js';

const PORT = 7788;
function req(over: Partial<IncomingMessage> & { headers?: Record<string, string> } = {}): IncomingMessage {
  return { method: 'GET', headers: { host: '127.0.0.1:' + PORT }, ...over } as IncomingMessage;
}
const url = (p: string) => new URL(p, 'http://localhost');

describe('checkRequestOrigin', () => {
  it('treats Origin: null as foreign (audit B1)', () => {
    const r = checkRequestOrigin(req({ headers: { host: '127.0.0.1:' + PORT, origin: 'null' } }), PORT);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(403);
  });
  it('still accepts a same-origin loopback page and no Origin at all', () => {
    expect(checkRequestOrigin(req({ headers: { host: '127.0.0.1:' + PORT, origin: 'http://127.0.0.1:' + PORT } }), PORT).ok).toBe(true);
    expect(checkRequestOrigin(req(), PORT).ok).toBe(true);
  });
});

describe('checkContentType', () => {
  it('demands application/json on mutating /api/* only (audit B1)', () => {
    for (const m of ['POST', 'PUT', 'PATCH']) {
      expect(checkContentType(req({ method: m }), url('/api/bots')).ok, m).toBe(false);
      expect(checkContentType(req({ method: m, headers: { 'content-type': 'text/plain' } }), url('/api/bots')).ok, m).toBe(false);
      expect(checkContentType(req({ method: m, headers: { 'content-type': 'application/json' } }), url('/api/bots')).ok, m).toBe(true);
      expect(checkContentType(req({ method: m, headers: { 'content-type': 'application/json; charset=utf-8' } }), url('/api/bots')).ok, m).toBe(true);
    }
    expect(checkContentType(req({ method: 'GET' }), url('/api/bots')).ok).toBe(true);
    expect(checkContentType(req({ method: 'DELETE' }), url('/api/bots/x')).ok).toBe(true);
    // /mcp negotiates its own content types.
    expect(checkContentType(req({ method: 'POST' }), url('/mcp')).ok).toBe(true);
  });
});

describe('checkToken as an allowlist (audit B2)', () => {
  const T = 'tok';
  const asset = (p: string) => p === '/assets/app.js' || p === '/index.html';

  it('lets nothing through without a token except health, / and real static assets', () => {
    expect(checkToken(req(), url('/api/health'), T)).toBe(true);
    expect(checkToken(req({ method: 'POST' }), url('/api/health'), T)).toBe(false);
    expect(checkToken(req(), url('/'), T)).toBe(true);
    expect(checkToken(req(), url('/assets/app.js'), T, { isPublicAsset: asset })).toBe(true);
    expect(checkToken(req(), url('/screen/vnc.html'), T, { isPublicAsset: asset })).toBe(false);
    expect(checkToken(req(), url('/screen/websockify'), T, { isPublicAsset: asset })).toBe(false);
    expect(checkToken(req(), url('/ws'), T)).toBe(false);
    expect(checkToken(req(), url('/anything-else'), T)).toBe(false);
    expect(checkToken(req(), url('/api/bots'), T)).toBe(false);
  });

  it('keeps /mcp on its own per-turn token', () => {
    expect(checkToken(req({ method: 'POST' }), url('/mcp'), T)).toBe(true);
  });

  it('accepts the token as a bearer header or a ?token= query parameter', () => {
    expect(checkToken(req({ headers: { host: '127.0.0.1', authorization: 'Bearer tok' } }), url('/api/bots'), T)).toBe(true);
    expect(checkToken(req(), url('/ws?token=tok'), T)).toBe(true);
    expect(checkToken(req(), url('/ws?token=nope'), T)).toBe(false);
  });

  it('is a no-op when no token is configured', () => {
    expect(checkToken(req(), url('/api/bots'), null)).toBe(true);
  });
});

describe('tokenMatches (audit B16)', () => {
  it('compares in constant time and rejects wrong lengths and null', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc124', 'abc123')).toBe(false);
    expect(tokenMatches('abc', 'abc123')).toBe(false);
    expect(tokenMatches('abc12345', 'abc123')).toBe(false);
    expect(tokenMatches(null, 'abc123')).toBe(false);
    expect(tokenMatches('', '')).toBe(true);
    // Multi-byte input must not throw on the Buffer length guard.
    expect(tokenMatches('é', 'e')).toBe(false);
  });
});

describe('AuthRateLimiter (audit B15)', () => {
  it('blocks after 10 failures in the window and forgets on success', () => {
    let now = 1000;
    const rl = new AuthRateLimiter(10, 60_000, 60_000, () => now);
    for (let i = 0; i < 9; i++) expect(rl.fail('a')).toBe(false);
    expect(rl.blocked('a')).toBe(false);
    expect(rl.fail('a')).toBe(true);
    expect(rl.blocked('a')).toBe(true);
    // Another IP is unaffected.
    expect(rl.blocked('b')).toBe(false);
    // The block expires after a minute.
    now += 60_001;
    expect(rl.blocked('a')).toBe(false);
    // A success clears the counter.
    for (let i = 0; i < 5; i++) rl.fail('c');
    rl.succeed('c');
    for (let i = 0; i < 9; i++) expect(rl.fail('c')).toBe(false);
  });

  it('restarts the count once the window has passed', () => {
    let now = 0;
    const rl = new AuthRateLimiter(10, 60_000, 60_000, () => now);
    for (let i = 0; i < 9; i++) rl.fail('a');
    now += 60_001;
    for (let i = 0; i < 9; i++) expect(rl.fail('a')).toBe(false);
    expect(rl.blocked('a')).toBe(false);
  });
});
