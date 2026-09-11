import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHub, type Hub } from '../hub.js';
import { SCREEN_COOKIE, SCREEN_VIEWER_PATH } from './screenSession.js';

const TOKEN = 'screen-token-123';
let hub: Hub;
let port: number;

beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
});

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Raw request so we can forge Host / Cookie and read Set-Cookie back verbatim. */
function req(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1:' + port, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
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

const auth = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
const mint = async (): Promise<string> => {
  const r = await req('/api/screen/ticket', auth, 'POST');
  expect(r.status).toBe(200);
  return (JSON.parse(r.body) as { url: string }).url;
};
const cookieFrom = (r: Res): string => {
  const set = r.headers['set-cookie'];
  expect(set).toHaveLength(1);
  return set![0].split(';')[0];
};

// A successful auth clears this hub's rate limiter, so each test starts from a clean slate and cannot be
// tipped over the 10-failure block by whatever ran before it.
beforeEach(async () => {
  expect((await req('/api/health')).status).toBe(200);
});

describe('screen ticket handshake', () => {
  it('mints a ticket only for a caller that already holds the hub token', async () => {
    expect((await req('/api/screen/ticket', { 'content-type': 'application/json' }, 'POST')).status).toBe(401);
    const url = await mint();
    expect(url).toMatch(/^\/screen\/session\?ticket=[A-Za-z0-9_-]{43}$/);
  });

  it('redeems a ticket for an httpOnly cookie scoped to /screen and redirects to the viewer', async () => {
    const r = await req(await mint());
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(SCREEN_VIEWER_PATH);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    const set = r.headers['set-cookie']![0];
    expect(set.startsWith(SCREEN_COOKIE + '=')).toBe(true);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/screen');
    expect(set).toMatch(/Max-Age=\d+/);
    // Deliberately not Secure: the hub is plain http on loopback, so the browser would drop the cookie.
    expect(set).not.toContain('Secure');
  });

  it('burns the ticket on first use', async () => {
    const url = await mint();
    expect((await req(url)).status).toBe(302);
    expect((await req(url)).status).toBe(401);
  });

  it('rejects a forged or missing ticket like any other failed auth', async () => {
    expect((await req('/screen/session?ticket=nope')).status).toBe(401);
    expect((await req('/screen/session')).status).toBe(401);
  });

  it('refuses /screen/* with no cookie and no bearer, over HTTP and on the upgrade', async () => {
    // 401 rather than the proxy's 502: the guard answered before noVNC was reached.
    expect((await req('/screen/vnc.html')).status).toBe(401);
    expect((await req('/screen/websockify')).status).toBe(401);
    expect(await upgrade('/screen/websockify')).toBe('closed');
  });

  it('no longer accepts ?token= on /screen/*, so the hub token cannot ride a URL', async () => {
    expect((await req('/screen/vnc.html?token=' + TOKEN)).status).toBe(401);
    expect(await upgrade('/screen/websockify?token=' + TOKEN)).toBe('closed');
  });

  it('lets the cookie and a bearer header through to the proxy', async () => {
    const cookie = cookieFrom(await req(await mint()));
    // noVNC is not running in the suite, so reaching it means a 502 from the proxy — anything but a 401.
    expect((await req('/screen/vnc.html', { cookie })).status).not.toBe(401);
    expect((await req('/screen/vnc.html', { authorization: 'Bearer ' + TOKEN })).status).not.toBe(401);
    // A stale or invented cookie is still refused.
    expect((await req('/screen/vnc.html', { cookie: SCREEN_COOKIE + '=made-up' })).status).toBe(401);
  });

  it('scopes the cookie to /screen: it authenticates nothing else', async () => {
    const cookie = cookieFrom(await req(await mint()));
    expect((await req('/api/bots', { cookie })).status).toBe(401);
    expect(await upgrade('/ws', { cookie })).toBe('closed');
  });

  it('leaves /api/* and /ws exactly as they were', async () => {
    expect((await req('/api/health')).status).toBe(200);
    expect((await req('/api/bots')).status).toBe(401);
    expect((await req('/api/bots', { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
    // /api/* still takes the token in the query string; only /screen/* lost that.
    expect((await req('/api/bots?token=' + TOKEN)).status).toBe(200);
    expect(await upgrade('/ws?token=' + TOKEN)).toBe('open');
    expect(await upgrade('/ws')).toBe('closed');
  });
});
