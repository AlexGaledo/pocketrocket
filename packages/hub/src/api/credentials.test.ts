import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub, type Hub } from '../hub.js';
import { listAudit } from '../services/AuditLog.js';
import { redact } from '../providers/redact.js';

vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'credentials-test-hub-token';
const PASSWORD = 'credentials owner password';
const SECRET = 'hunter2-SECRET-passw0rd!';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cred-'));
const FILE = path.join(tmp, 'credentials.json');
const KEY = path.join(tmp, 'vault.key');

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN,
    projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    credentials: { file: FILE, keyFile: KEY },
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null; cookie?: string } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Promise<{ status: number; json: any; raw: string; cookie: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, raw, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] });
      });
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

let cookie = '';
async function signIn(): Promise<string> {
  if (cookie) return cookie;
  if (!(await request('GET', '/api/auth/status', { token: null })).json.passwordSet) {
    expect((await request('POST', '/api/auth/password', { body: { password: PASSWORD } })).status).toBe(200);
  }
  const r = await request('POST', '/api/auth/login', { token: null, body: { password: PASSWORD } });
  expect(r.status).toBe(200);
  cookie = r.cookie;
  return cookie;
}

const login = { name: 'GitHub work', origin: 'https://GitHub.com/login?x=1', username: 'alex', secret: SECRET };
const allBodies: string[] = [];
const track = <T extends { raw: string }>(r: T): T => { allBodies.push(r.raw); return r; };

describe('/api/credentials', () => {
  it('needs the hub token, and changes need a signed-in browser', async () => {
    expect((await request('GET', '/api/credentials', { token: null })).status).toBeGreaterThanOrEqual(401);
    const r = track(await request('POST', '/api/credentials', { body: login }));
    expect(r.status).toBe(403);
    expect(r.json.signInRequired).toBe(true);
    expect((await request('GET', '/api/credentials')).json).toEqual({ credentials: [] });
  });

  it('adds a login, normalises the origin and never returns the secret', async () => {
    const c = await signIn();
    const r = track(await request('POST', '/api/credentials', { body: login, cookie: c, token: null }));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: 'GitHub work', origin: 'https://github.com', username: 'alex' });
    expect(r.json).not.toHaveProperty('secret');
    const list = track(await request('GET', '/api/credentials'));
    expect(list.json.credentials).toHaveLength(1);
    expect(list.raw).not.toContain(SECRET);
  });

  it('rejects bad input without echoing the secret', async () => {
    const c = await signIn();
    for (const body of [
      { ...login, name: 'dup', origin: 'http://example.com' },
      { ...login, name: 'dup', origin: 'https://user:pw@example.com' },
      { ...login, name: 'bad/name' },
      { ...login, name: 'github WORK' },
      { ...login, name: 'x', extra: SECRET },
    ]) {
      const r = track(await request('POST', '/api/credentials', { body, cookie: c, token: null }));
      expect([400, 409]).toContain(r.status);
    }
    const r = track(await request('POST', '/api/credentials', { body: { ...login, name: 'local', origin: 'http://localhost:3000' }, cookie: c, token: null }));
    expect(r.status).toBe(400);
    const r2 = track(await request('POST', '/api/credentials', { body: { ...login, name: 'local2', origin: 'https://127.0.0.1' }, cookie: c, token: null }));
    expect(r2.status).toBe(400);
  });

  it('edits without the secret keeping it, deletes, and audits without the secret', async () => {
    const c = await signIn();
    const id = (await request('GET', '/api/credentials')).json.credentials.find((x: any) => x.name === 'GitHub work').id;
    const NEW = 'brand-new-SECRET-value-42';
    const p = track(await request('PATCH', '/api/credentials/' + id, { body: { username: 'alex2' }, cookie: c, token: null }));
    expect(p.json.username).toBe('alex2');
    track(await request('PATCH', '/api/credentials/' + id, { body: { secret: NEW }, cookie: c, token: null }));
    const store = (hub as any).runner.credentials;
    expect(store.readSecret(id)).toBe(NEW);
    expect((await request('DELETE', '/api/credentials/' + id, { cookie: c, token: null })).status).toBe(200);
    expect(store.readSecret(id)).toBeNull();
    expect((await request('DELETE', '/api/credentials/' + id, { cookie: c, token: null })).status).toBe(404);
    const audit = JSON.stringify(listAudit(hub.repos.db, { limit: 50 }));
    expect(audit).toContain('credential.added');
    for (const s of [SECRET, NEW]) expect(audit).not.toContain(s);
  });

  it('keeps every secret out of every response, the database, the vault file and redacted logs', () => {
    for (const body of allBodies) expect(body).not.toContain(SECRET);
    expect(fs.readFileSync(FILE, 'utf8')).not.toContain(SECRET);
    expect(JSON.stringify(hub.repos.db.all('SELECT * FROM credentials'))).not.toContain(SECRET);
    expect(redact('typed ' + SECRET)).not.toContain(SECRET);
    if (process.platform !== 'win32') expect(fs.statSync(FILE).mode & 0o077).toBe(0);
  });
});
