import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { createHub, type Hub } from '../hub.js';
import { auditAction } from '../services/AuditLog.js';
import { AuthService, hashPassword, passwordMatches } from '../services/AuthService.js';
import { recordAudit } from '../services/AuditLog.js';

// Password hashing is slow on purpose, and a busy machine makes it slower.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'auth-hub-token';
const PASSWORD = 'correct horse battery';

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
});
beforeEach(() => {
  hub.repos.db.run('DELETE FROM user_credentials');
  hub.repos.db.run('DELETE FROM user_sessions');
  hub.repos.db.run('DELETE FROM audit_log');
});

type Res = { status: number; json: any; cookie: string | null; rawCookie: string };
function req(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    if (opts.cookie) headers.cookie = opts.cookie;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined || method === 'POST' || method === 'PUT' || method === 'PATCH') headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(data); } catch { json = data; }
        const raw = res.headers['set-cookie']?.[0] ?? '';
        resolve({ status: res.statusCode ?? 0, json, cookie: raw ? raw.split(';')[0] : null, rawCookie: raw });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const setPassword = () => req('POST', '/api/auth/password', { token: TOKEN, body: { password: PASSWORD } });
async function signIn(): Promise<string> {
  const r = await req('POST', '/api/auth/login', { body: { password: PASSWORD } });
  expect(r.status).toBe(200);
  return r.cookie!;
}
const actions = async () => (await req('GET', '/api/audit', { token: TOKEN })).json.entries.map((e: { action: string }) => e.action) as string[];

describe('password', () => {
  it('stores a salted hash that verifies only the right password', async () => {
    const a = await hashPassword(PASSWORD);
    expect(a).not.toContain(PASSWORD);
    expect(await hashPassword(PASSWORD)).not.toBe(a);
    expect(await passwordMatches(PASSWORD, a)).toBe(true);
    expect(await passwordMatches('wrong one here', a)).toBe(false);
  });

  it('refuses a short password', async () => {
    expect((await req('POST', '/api/auth/password', { token: TOKEN, body: { password: 'short' } })).status).toBe(400);
  });

  it('cannot be set without a credential', async () => {
    expect((await req('POST', '/api/auth/password', { body: { password: PASSWORD } })).status).toBe(401);
  });
});

describe('sign in', () => {
  it('reports status without a credential and reveals nothing else', async () => {
    expect((await req('GET', '/api/auth/status')).json).toEqual({ passwordSet: false, signedIn: false });
    await setPassword();
    expect((await req('GET', '/api/auth/status')).json).toEqual({ passwordSet: true, signedIn: false });
  });

  it('refuses when no password was ever set', async () => {
    expect((await req('POST', '/api/auth/login', { body: { password: PASSWORD } })).status).toBe(403);
  });

  it('gives a cookie that scripts cannot read and that opens the API', async () => {
    await setPassword();
    const r = await req('POST', '/api/auth/login', { body: { password: PASSWORD } });
    expect(r.rawCookie).toMatch(/HttpOnly/);
    expect(r.rawCookie).toMatch(/SameSite=Strict/);
    expect((await req('GET', '/api/settings')).status).toBe(401);
    expect((await req('GET', '/api/settings', { cookie: r.cookie! })).status).toBe(200);
  });

  it('keeps only a hash of the session token', async () => {
    await setPassword();
    const cookie = await signIn();
    const value = cookie.split('=')[1];
    const row = hub.repos.db.get('SELECT token_hash FROM user_sessions');
    expect(row?.token_hash).not.toBe(value);
  });

  it('opens the websocket with the cookie and hangs up when the session is revoked', async () => {
    await setPassword();
    const cookie = await signIn();
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { cookie } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    const list = (await req('GET', '/api/auth/sessions', { token: TOKEN })).json.sessions;
    expect((await req('DELETE', '/api/auth/sessions/' + list[0].id, { token: TOKEN })).status).toBe(200);
    expect(await closed).toBe(4001);
    expect((await req('GET', '/api/settings', { cookie })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('signs out this browser', async () => {
    await setPassword();
    const cookie = await signIn();
    const out = await req('POST', '/api/auth/logout', { cookie, body: {} });
    expect(out.rawCookie).toMatch(/Max-Age=0/);
    expect((await req('GET', '/api/settings', { cookie })).status).toBe(401);
  });

  it('ends a Screen opened from a session when that session is revoked', async () => {
    await setPassword();
    const cookie = await signIn();
    const minted = await req('POST', '/api/screen/ticket', { cookie, body: {} });
    const redeemed = await req('GET', minted.json.url);
    const screen = redeemed.cookie!;
    // No screen is running here, so 502 means it got past the check.
    expect((await req('GET', '/screen/vnc.html', { cookie: screen })).status).toBe(502);
    await req('POST', '/api/auth/logout', { cookie, body: {} });
    expect((await req('GET', '/screen/vnc.html', { cookie: screen })).status).toBe(401);
  });

  it('expires sessions and tells the hub, once', () => {
    let t = 1000;
    const auth = new AuthService(hub.repos.db, () => t);
    const owner = hub.repos.owner().id;
    const ended: string[] = [];
    const off = auth.onRevoke((id) => ended.push(id));
    const { id, token } = auth.createSession(owner);
    auth.expireDue();
    expect(ended).toEqual([]);
    t += 31 * 24 * 60 * 60 * 1000;
    auth.expireDue();
    auth.expireDue();
    expect(ended).toEqual([id]);
    expect(auth.authenticate(token)).toBeNull();
    off();
  });

  it('marks the current session and signs out the others', async () => {
    await setPassword();
    const a = await signIn();
    const b = await signIn();
    const seen = (await req('GET', '/api/auth/sessions', { cookie: a })).json;
    expect(seen.sessions).toHaveLength(2);
    expect(seen.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(a.split('=')[1]);
    expect((await req('POST', '/api/auth/sessions/revoke-others', { cookie: a, body: {} })).json.ended).toBe(1);
    expect((await req('GET', '/api/settings', { cookie: b })).status).toBe(401);
    expect((await req('GET', '/api/settings', { cookie: a })).status).toBe(200);
  });

  it('needs the current password from a browser, and ends other sessions on change', async () => {
    await setPassword();
    const a = await signIn();
    const b = await signIn();
    const next = 'a different long password';
    expect((await req('POST', '/api/auth/password', { cookie: a, body: { password: next } })).status).toBe(403);
    expect((await req('POST', '/api/auth/password', { cookie: a, body: { password: next, currentPassword: PASSWORD } })).status).toBe(200);
    expect((await req('GET', '/api/settings', { cookie: b })).status).toBe(401);
    expect((await req('GET', '/api/settings', { cookie: a })).status).toBe(200);
    expect((await req('POST', '/api/auth/login', { body: { password: PASSWORD } })).status).toBe(403);
    expect((await req('POST', '/api/auth/login', { body: { password: next } })).status).toBe(200);
  });

  it('lets the hub token reset a forgotten password', async () => {
    await setPassword();
    const next = 'recovered long password';
    expect((await req('POST', '/api/auth/password', { token: TOKEN, body: { password: next } })).status).toBe(200);
    expect((await req('POST', '/api/auth/login', { body: { password: next } })).status).toBe(200);
  });

  it('keeps a paired device out of sign-in management', async () => {
    const minted = await req('POST', '/api/devices/pairing', { token: TOKEN, body: {} });
    const paired = await req('POST', '/api/devices/pair', { body: { code: minted.json.code, name: 'phone' } });
    for (const [m, p] of [['GET', '/api/audit'], ['GET', '/api/auth/sessions'], ['POST', '/api/auth/password']] as const) {
      expect((await req(m, p, { token: paired.json.token, body: m === 'POST' ? { password: PASSWORD } : undefined })).status).toBe(403);
    }
  });
});

describe('audit log', () => {
  // Last in the file on its own hub: the lockout would refuse every later test in this one.
  it('refuses a wrong password and locks the IP after repeated tries', async () => {
    const own = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
    const ownPort = await own.listen();
    const post = () => new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: ownPort, path: '/api/auth/login', method: 'POST', headers: { host: '127.0.0.1:' + ownPort, 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end(JSON.stringify({ password: 'not the password' }));
    });
    try {
      expect(await post()).toBe(403);
      let last = 0;
      for (let i = 0; i < 12; i++) last = await post();
      expect(last).toBe(429);
    } finally {
      await own.shutdown();
    }
  });

  it('counts parallel guesses before hashing, so they cannot outrun the lockout', async () => {
    const own = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
    const ownPort = await own.listen();
    const post = () => new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: ownPort, path: '/api/auth/login', method: 'POST', headers: { host: '127.0.0.1:' + ownPort, 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end(JSON.stringify({ password: 'not the password' }));
    });
    try {
      const all = await Promise.all(Array.from({ length: 40 }, post));
      expect(all.filter((s) => s === 403).length).toBeLessThanOrEqual(10);
      expect(all.filter((s) => s === 429).length).toBeGreaterThanOrEqual(30);
    } finally {
      await own.shutdown();
    }
  });

  it('does not let a held session wipe failed password tries', async () => {
    const own = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
    const ownPort = await own.listen();
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: ownPort, path, method, headers: { host: '127.0.0.1:' + ownPort, 'content-type': 'application/json', ...headers } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0] }));
      });
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
      await call('POST', '/api/auth/password', { authorization: 'Bearer ' + TOKEN }, { password: PASSWORD });
      const cookie = (await call('POST', '/api/auth/login', {}, { password: PASSWORD })).cookie;
      let last = 0;
      for (let i = 0; i < 12 && last !== 429; i++) {
        last = (await call('POST', '/api/auth/password', { cookie }, { currentPassword: 'not the password', password: 'another long password' })).status;
        // The app keeps polling between guesses.
        if (last !== 429) await call('GET', '/api/settings', { cookie });
      }
      expect(last).toBe(429);
    } finally {
      await own.shutdown();
    }
  });

  it('does not fail the caller when the log cannot be written', () => {
    const broken = { run: () => { throw new Error('disk full'); } } as unknown as Parameters<typeof recordAudit>[0];
    expect(() => recordAudit(broken, { kind: 'bot', id: 'b' }, 'x')).not.toThrow();
  });

  it('records sign-ins, failures and sign-outs, with no password in it', async () => {
    await setPassword();
    const cookie = await signIn();
    await req('POST', '/api/auth/login', { body: { password: 'not the password' } });
    await req('POST', '/api/auth/logout', { cookie, body: {} });
    const list = await actions();
    expect(list).toEqual(expect.arrayContaining(['auth.password_set', 'auth.signed_in', 'auth.sign_in_failed', 'auth.signed_out']));
    expect(JSON.stringify((await req('GET', '/api/audit', { token: TOKEN })).json)).not.toContain(PASSWORD);
  });

  it('records a permission change with both levels, and who did it', async () => {
    await req('PUT', '/api/settings', { token: TOKEN, body: { approvals: 'read-only' } });
    const row = (await req('GET', '/api/audit', { token: TOKEN })).json.entries[0];
    expect(row).toMatchObject({ action: 'permissions.changed', actorKind: 'hub-token', actorId: hub.repos.owner().id });
    expect(row.detail).toContain('to read-only');
    await req('PUT', '/api/settings', { token: TOKEN, body: { approvals: 'ask' } });
  });

  it('records settings key names but not their values', async () => {
    await req('PUT', '/api/settings', { token: TOKEN, body: { userName: 'SecretNameValue' } });
    const row = (await req('GET', '/api/audit', { token: TOKEN })).json.entries[0];
    expect(row).toMatchObject({ action: 'settings.updated', detail: 'userName' });
    expect(JSON.stringify(row)).not.toContain('SecretNameValue');
  });

  it('records changes to the fleet, and skips reads, chat and failures', async () => {
    const bot = (await req('POST', '/api/bots', { token: TOKEN, body: { name: 'Audit Bot', handle: 'audit-bot', description: 'x' } })).json;
    await req('GET', '/api/bots', { token: TOKEN });
    await req('DELETE', '/api/bots/no-such-bot', { token: TOKEN });
    await req('DELETE', '/api/bots/' + bot.id, { token: TOKEN });
    await new Promise((r) => setTimeout(r, 20));
    expect((await actions()).sort()).toEqual(['bot.created', 'bot.deleted']);
  });

  it('leaves out what the app sends by itself', async () => {
    await req('POST', '/api/computers/warm', { token: TOKEN, body: { botId: null } });
    await new Promise((r) => setTimeout(r, 20));
    expect(await actions()).toEqual([]);
  });

  it('leaves ids out of action names', () => {
    expect(auditAction('DELETE', '/api/bots/abc/skills/Xy3_kQ9').action).toBe('bot.skills.deleted');
  });

  it('names actions from the route', () => {
    expect(auditAction('PATCH', '/api/bots/abc')).toEqual({ action: 'bot.updated', target: 'abc' });
    expect(auditAction('PUT', '/api/bots/abc/memory')).toEqual({ action: 'bot.memory.updated', target: 'abc' });
    expect(auditAction('POST', '/api/rooms')).toEqual({ action: 'room.created', target: null });
  });
});
