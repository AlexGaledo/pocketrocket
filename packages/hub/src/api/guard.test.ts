import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHub, type Hub } from '../hub.js';

const TOKEN = 'test-token-123';
let hub: Hub;
let port: number;

beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
});

/** Raw request so we can forge Host / Origin (fetch refuses to set Host). */
function req(
  path: string,
  headers: Record<string, string> = {},
  opts: { method?: string; body?: string | Buffer } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: '127.0.0.1:' + port, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

function upgrade(path: string, headers: Record<string, string> = {}): Promise<'open' | 'closed'> {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: {
        host: '127.0.0.1:' + port, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers,
      },
    });
    r.on('upgrade', (_res, socket) => { socket.destroy(); resolve('open'); });
    r.on('response', () => resolve('closed'));
    r.on('error', () => resolve('closed'));
    r.end();
  });
}

describe('hub hardening', () => {
  it('serves health without a token', async () => {
    const r = await req('/api/health');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { provider: string; version: string };
    expect(body.provider).toBe('claude');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    expect((await req('/api/health', { host: 'evil.example.com' })).status).toBe(403);
    expect((await req('/api/health', { host: 'evil.example.com:' + port })).status).toBe(403);
  });

  it('accepts loopback Host names', async () => {
    expect((await req('/api/health', { host: 'localhost:' + port })).status).toBe(200);
    expect((await req('/api/health', { host: '[::1]:' + port })).status).toBe(200);
  });

  it('rejects a cross-site Origin', async () => {
    expect((await req('/api/health', { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await req('/api/health', { origin: 'http://127.0.0.1:' + port })).status).toBe(200);
    expect((await req('/api/health', { origin: 'http://localhost:' + port })).status).toBe(200);
  });

  it('requires the bearer token on /api/* but not on GET /api/health', async () => {
    expect((await req('/api/bots')).status).toBe(401);
    expect((await req('/api/bots', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await req('/api/bots', { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
    expect((await req('/api/settings', { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
  });

  it('requires ?token= on the websocket upgrade', async () => {
    expect(await upgrade('/ws')).toBe('closed');
    expect(await upgrade('/ws?token=wrong')).toBe('closed');
    expect(await upgrade('/ws?token=' + TOKEN)).toBe('open');
    expect(await upgrade('/ws?token=' + TOKEN, { origin: 'https://evil.example.com' })).toBe('closed');
    expect(await upgrade('/ws?token=' + TOKEN, { host: 'evil.example.com' })).toBe('closed');
  });
  // ---- audit 2026-09-09, B1: Origin: null is a foreign origin ----
  it('rejects Origin: null (sandboxed iframe / opaque origin)', async () => {
    expect((await req('/api/health', { origin: 'null' })).status).toBe(403);
    expect((await req('/api/bots', { origin: 'null', authorization: 'Bearer ' + TOKEN })).status).toBe(403);
    const r = await req('/api/health', { origin: 'null' });
    expect(r.body).toContain('Opaque origin');
  });

  it('requires application/json on mutating /api/* routes', async () => {
    const auth = { authorization: 'Bearer ' + TOKEN };
    // The three content types a cross-site <form> can send without a preflight.
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const r = await req('/api/bots', { ...auth, 'content-type': ct }, { method: 'POST', body: '{}' });
      expect(r.status, ct).toBe(415);
    }
    expect((await req('/api/bots', auth, { method: 'POST', body: '{}' })).status).toBe(415);
    // With the right content type it reaches the handler (400 = schema rejection, not a guard rejection).
    const ok = await req('/api/bots', { ...auth, 'content-type': 'application/json' }, { method: 'POST', body: '{}' });
    expect(ok.status).toBe(400);
    // GETs are unaffected.
    expect((await req('/api/bots', auth)).status).toBe(200);
  });

  // ---- audit 2026-09-09, B2: allowlist, not deny-list ----
  it('requires the token on /screen/* over HTTP and on the websocket upgrade', async () => {
    // 401 rather than a 502 from the noVNC proxy: the guard answered before the proxy was reached.
    expect((await req('/screen/vnc.html')).status).toBe(401);
    expect((await req('/screen/websockify')).status).toBe(401);
    expect(await upgrade('/screen/websockify')).toBe('closed');
    expect(await upgrade('/screen/websockify?token=wrong')).toBe('closed');
  });

  it('requires the token on every other unknown path too', async () => {
    expect((await req('/anything')).status).toBe(401);
    expect((await req('/api/usage')).status).toBe(401);
    // `/` stays public: it is the shell that then asks the human for the token.
    expect((await req('/')).status).toBe(200);
  });

  // ---- audit 2026-09-09, B15 ----
  it('rejects an oversize request body with 413', async () => {
    const big = 'x'.repeat(1024 * 1024 + 4096);
    const r = await req(
      '/api/rooms/none/messages',
      { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      { method: 'POST', body: JSON.stringify({ text: big }) },
    );
    expect(r.status).toBe(413);
  });
});

// A hub of its own: the rate limiter is per process and would otherwise lock the suite above out.
describe('failed-auth rate limiting (audit B15)', () => {
  let rlHub: Hub;
  let rlPort: number;
  beforeAll(async () => {
    rlHub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
    rlPort = await rlHub.listen();
  });
  afterAll(async () => {
    await rlHub.shutdown();
  });

  const hit = (headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: rlPort, path: '/api/bots', method: 'GET', headers: { host: '127.0.0.1:' + rlPort, ...headers } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end();
    });

  it('locks an IP out with 429 after 10 failures in a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push(await hit({ authorization: 'Bearer wrong' }));
    expect(codes.slice(0, 9).every((c) => c === 401)).toBe(true);
    expect(codes[codes.length - 1]).toBe(429);
    // Even the correct token is refused while the block stands: brute force costs a minute per 10 guesses.
    expect(await hit({ authorization: 'Bearer ' + TOKEN })).toBe(429);
  });
});
