import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub, type Hub } from '../hub.js';
import { SCREEN_COOKIE, SCREEN_VIEWER_PATH, screenCookieName, screenViewerPath } from './screenSession.js';
import { ComputersRepo } from '../db/computers.js';
import { ComputerManager, type Systemctl } from '../services/ComputerManager.js';

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
    // P2: nobody has taken the screen over, so the viewer lands view-only.
    expect(r.headers.location).toBe(SCREEN_VIEWER_PATH + '&view_only=1');
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

// ---------------------------------------------------------------------------------------------------
// P1 (task 1.4): per-bot computers at /screen/<botId>/*, with tickets scoped to one bot.
describe('per-bot screens', () => {
  const T2 = 'screen-token-p1';
  let hub2: Hub;
  let port2: number;
  let dir: string;
  const active = new Set<string>();
  const fakeSystemctl: Systemctl = {
    start: async (u) => { active.add(u); },
    stop: async (u) => { active.delete(u); },
    isActive: async (u) => active.has(u),
  };

  const r2 = (p: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown): Promise<Res> =>
    new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: port2, path: p, method, headers: { host: '127.0.0.1:' + port2, ...headers } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
      });
      rq.on('error', reject);
      rq.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const up2 = (p: string, headers: Record<string, string> = {}): Promise<'open' | 'closed'> =>
    new Promise((resolve) => {
      const rq = http.request({
        host: '127.0.0.1', port: port2, path: p, method: 'GET',
        headers: {
          host: '127.0.0.1:' + port2, connection: 'Upgrade', upgrade: 'websocket',
          'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers,
        },
      });
      rq.on('upgrade', (_res, socket) => { socket.destroy(); resolve('open'); });
      rq.on('response', () => resolve('closed'));
      rq.on('error', () => resolve('closed'));
      rq.end();
    });
  const auth2 = { authorization: 'Bearer ' + T2, 'content-type': 'application/json' };
  const newBot = async (handle: string) =>
    JSON.parse((await r2('/api/bots', auth2, 'POST', { name: handle, handle, allowedTools: ['Browser'] })).body) as { id: string };
  const ticketFor = async (botId?: string) => {
    const r = await r2('/api/screen/ticket', auth2, 'POST', botId ? { botId } : {});
    expect(r.status).toBe(200);
    return (JSON.parse(r.body) as { url: string }).url;
  };
  const cookieOf = (r: Res) => r.headers['set-cookie']![0].split(';')[0];
  let A: string;
  let B: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-screen-'));
    hub2 = createHub({
      port: 0, dbFile: ':memory:', skipBootstrap: true, token: T2,
      computers: (db) => new ComputerManager(new ComputersRepo(db), {
        enabled: true, dir, dataDir: dir, systemctl: fakeSystemctl, probe: async () => true, startTimeoutMs: 20, pollMs: 1,
      }),
    });
    port2 = await hub2.listen();
    A = (await newBot('alpha')).id;
    B = (await newBot('beta')).id;
    for (const id of [A, B]) expect((await r2('/api/computers/' + id + '/wake', auth2, 'POST', {})).status).toBe(200);
  });
  afterAll(async () => {
    await hub2.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    expect((await r2('/api/bots', auth2)).status).toBe(200);
  });

  it('redeems a bot ticket for a cookie named and pathed for that bot only, landing on its viewer', async () => {
    const r = await r2(await ticketFor(A));
    expect(r.status).toBe(302);
    // P2: the bot has control, so the viewer lands view-only.
    expect(r.headers.location).toBe(screenViewerPath(A, true));
    expect(r.headers.location).toContain('path=screen%2F' + A + '%2Fwebsockify');
    const set = r.headers['set-cookie']![0];
    expect(set.startsWith(screenCookieName(A) + '=')).toBe(true);
    expect(set).toContain('Path=/screen/' + A + ';');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
  });

  it('refuses a ticket for bot A on the screen of bot B, however the cookie is presented', async () => {
    const cookieA = cookieOf(await r2(await ticketFor(A)));
    const valueA = cookieA.split('=')[1];
    // On A's own screen it gets through the guard (the proxy then answers 502: no noVNC in the suite).
    expect((await r2('/screen/' + A + '/vnc.html', { cookie: cookieA })).status).not.toBe(401);
    expect((await r2('/screen/' + B + '/vnc.html', { cookie: cookieA })).status).toBe(401);
    expect((await r2('/screen/' + B + '/vnc.html', { cookie: screenCookieName(B) + '=' + valueA })).status).toBe(401);
    expect(await up2('/screen/' + B + '/websockify', { cookie: cookieA })).toBe('closed');
    expect(await up2('/screen/' + B + '/websockify', { cookie: screenCookieName(B) + '=' + valueA })).toBe('closed');
    // Nor does it open the shared screen.
    expect((await r2('/screen/vnc.html', { cookie: 'pr_screen=' + valueA })).status).toBe(401);
  });

  it('refuses a shared-screen ticket on the screen of a bot', async () => {
    const shared = cookieOf(await r2(await ticketFor()));
    expect(shared.startsWith('pr_screen=')).toBe(true);
    expect((await r2('/screen/' + A + '/vnc.html', { cookie: shared })).status).toBe(401);
    expect((await r2('/screen/' + A + '/vnc.html', { cookie: screenCookieName(A) + '=' + shared.split('=')[1] })).status).toBe(401);
  });

  it('still refuses /screen/<botId>/* with nothing, and with ?token=', async () => {
    expect((await r2('/screen/' + A + '/vnc.html')).status).toBe(401);
    expect((await r2('/screen/' + A + '/vnc.html?token=' + T2)).status).toBe(401);
    expect(await up2('/screen/' + A + '/websockify')).toBe('closed');
  });

  it('mints bot tickets only for a bot that exists and has a computer', async () => {
    expect((await r2('/api/screen/ticket', auth2, 'POST', { botId: 'nope' })).status).toBe(404);
    const fresh = await newBot('gamma');
    expect((await r2('/api/screen/ticket', auth2, 'POST', { botId: fresh.id })).status).toBe(409);
    expect((await r2('/api/screen/ticket', { 'content-type': 'application/json' }, 'POST', { botId: A })).status).toBe(401);
  });

  it('reports the computer of the bot, and Keep awake round-trips', async () => {
    const s = JSON.parse((await r2('/api/screen?botId=' + A, auth2)).body) as { url: string; computer: { state: string; slot: number; perBot: boolean } };
    expect(s.url).toBe(screenViewerPath(A, true));
    expect(s.computer).toMatchObject({ perBot: true, state: 'live', slot: 1 });
    const k = await r2('/api/computers/' + A + '/keep-awake', auth2, 'PUT', { on: true });
    expect(JSON.parse(k.body)).toMatchObject({ keepAwake: true });
    expect(JSON.parse((await r2('/api/computers/' + A, auth2)).body)).toMatchObject({ keepAwake: true });
  });

  it('warm start answers at once; Always on past the limit is a 409 with the reason', async () => {
    const warm = await r2('/api/computers/warm', auth2, 'POST', { botId: B });
    expect(warm.status).toBe(200);
    expect(JSON.parse(warm.body)).toEqual({ ok: true });
    expect((await r2('/api/computers/warm', { 'content-type': 'application/json' }, 'POST', {})).status).toBe(401);
    expect((await r2('/api/computers/' + B + '/keep-awake', auth2, 'PUT', { on: true })).status).toBe(200);
    const c = await newBot('epsilon');
    const r = await r2('/api/computers/' + c.id + '/keep-awake', auth2, 'PUT', { on: true });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).error).toContain('Only 2 can be Always on');
    await r2('/api/computers/' + B + '/keep-awake', auth2, 'PUT', { on: false });
    await r2('/api/bots/' + c.id, auth2, 'DELETE');
  });

  it('erases the computer of a deleted bot', async () => {
    const c = await newBot('delta');
    await r2('/api/computers/' + c.id + '/wake', auth2, 'POST', {});
    expect(hub2.computers.status(c.id).slot).not.toBeNull();
    expect((await r2('/api/bots/' + c.id, auth2, 'DELETE')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(hub2.computers.existingEndpoint(c.id)).toBeNull();
  });
});
