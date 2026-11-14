import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHub, type Hub } from '../hub.js';
import { outsideMcpFor } from '../services/outsideMcp.js';
import { McpServerStore, maskArgs } from '../services/outsideMcpStore.js';
import { redact } from '../providers/redact.js';
import { listAudit } from '../services/AuditLog.js';

// Password hashing is slow on purpose.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'mcp-servers-test-hub-token';
const PASSWORD = 'mcp servers owner password';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mcpsrv-'));
const FILE = path.join(tmp, 'mcp-servers.json');
const ABS_CMD = process.execPath;

const fetchCalls: { url: string; init: RequestInit }[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () => new Response('{}', { status: 200 });

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN,
    projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    mcpServers: { file: FILE, fetch: ((u: string, i: RequestInit) => { fetchCalls.push({ url: u, init: i }); return fetchImpl(u, i); }) as typeof fetch },
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
const reset = () => fs.rmSync(FILE, { force: true });
const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

const remote = { name: 'wika', url: 'https://dashboard.example.com/api/mcp', token: 'tok-SECRET-123456', bots: ['wika-backend'] };
const stdio = { name: 'firecrawl', command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: 'fc-SECRET-987654' }, bots: ['researcher'] };

describe('GET/POST validation', () => {
  it('lists nothing for a missing file', async () => {
    reset();
    expect((await request('GET', '/api/mcp-servers')).json).toEqual({ servers: [] });
  });

  it('adds a remote server with the hub token and the loader then mounts it', async () => {
    reset();
    const r = await request('POST', '/api/mcp-servers', { body: remote });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: 'wika', kind: 'http', status: 'configured', tokenSet: true, approve: 'none' });
    expect(outsideMcpFor('wika-backend', null, FILE)).toMatchObject([{ name: 'wika', kind: 'http', token: remote.token }]);
    expect(listAudit(hub.repos.db, { limit: 5 }).some((a) => a.action === 'mcp_server.added' && a.target === 'wika')).toBe(true);
  });

  it.each([
    ['plain http to a remote host', { ...remote, name: 'a', url: 'http://dashboard.example.com/mcp' }],
    ['a reserved name', { ...remote, name: 'pocketrocket' }],
    ['a double underscore name', { ...remote, name: 'a__b' }],
    ['an upper-case name', { ...remote, name: 'Wika' }],
    ['url and command together', { ...remote, command: 'npx' }],
    ['neither url nor command', { name: 'x', bots: ['b'] }],
    ['no rooms or bots', { name: 'x', url: remote.url }],
    ['a token on a command server', { ...stdio, token: 'x' }],
    ['a relative command', { ...stdio, command: './run.sh' }],
    ['a bad env name', { ...stdio, env: { 'A-B': 'x' } }],
    ['an unknown key', { ...remote, extra: 1 }],
    ['a bad approve value', { ...remote, approve: 'sometimes' }],
  ])('rejects %s with 400', async (_what, body) => {
    reset();
    const r = await request('POST', '/api/mcp-servers', { body });
    expect(r.status).toBe(400);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('allows http to loopback and 409s on a duplicate name', async () => {
    reset();
    expect((await request('POST', '/api/mcp-servers', { body: { name: 'local', url: 'http://127.0.0.1:9000/mcp', bots: ['b'] } })).status).toBe(201);
    expect((await request('POST', '/api/mcp-servers', { body: { name: 'local', url: 'https://x.example.com', bots: ['b'] } })).status).toBe(409);
  });

  it('refuses malformed JSON bodies', async () => {
    const r = await new Promise<number>((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/mcp-servers', headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      q.end('{nope');
    });
    expect(r).toBe(400);
  });
});

describe('secrets are write-only', () => {
  it('never returns a token, an env value, or a secret-looking arg', async () => {
    reset();
    const c = await signIn();
    expect((await request('POST', '/api/mcp-servers', { body: remote })).status).toBe(201);
    const withArgs = { ...stdio, args: ['-y', 'srv', '--api-key=sk-live-abcdef0123456789', '--token', 'plain-secret-value'] };
    const add = await request('POST', '/api/mcp-servers', { body: withArgs, cookie: c, token: null });
    expect(add.status).toBe(201);
    const list = await request('GET', '/api/mcp-servers');
    for (const raw of [list.raw, add.raw]) {
      expect(raw).not.toContain('tok-SECRET-123456');
      expect(raw).not.toContain('fc-SECRET-987654');
      expect(raw).not.toContain('sk-live-abcdef0123456789');
      expect(raw).not.toContain('plain-secret-value');
    }
    const fc = list.json.servers.find((s: any) => s.name === 'firecrawl');
    expect(fc).toMatchObject({ kind: 'stdio', envKeys: ['FIRECRAWL_API_KEY'], argsMasked: true });
    expect(fc.args).toEqual(['-y', 'srv', '--api-key=***', '--token', '***']);
    expect(list.json.servers.find((s: any) => s.name === 'wika')).toMatchObject({ tokenSet: true });
  });

  it('strips the query from a shown url', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: { name: 'q', url: 'https://h.example.com/mcp?key=abc#frag', bots: ['b'] } });
    const s = (await request('GET', '/api/mcp-servers')).json.servers[0];
    expect(s.url).toBe('https://h.example.com/mcp');
    expect(s.urlHasQuery).toBe(true);
  });

  it('scrubs a newly saved key from output at once', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: { ...remote, token: 'fresh-token-for-redaction-9' } });
    expect(redact('echo fresh-token-for-redaction-9')).not.toContain('fresh-token-for-redaction-9');
  });

  it('maskArgs leaves ordinary args alone', () => {
    expect(maskArgs(['-y', 'firecrawl-mcp', '--port=80'])).toEqual({ args: ['-y', 'firecrawl-mcp', '--port=80'], masked: false });
  });
});

describe('stdio gating', () => {
  it('refuses to add a command server with only the hub token, and writes nothing', async () => {
    reset();
    const r = await request('POST', '/api/mcp-servers', { body: stdio });
    expect(r.status).toBe(403);
    expect(r.json.signInRequired).toBe(true);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('adds one from a signed-in browser, whose cookie alone (no hub token) is enough', async () => {
    reset();
    const c = await signIn();
    const r = await request('POST', '/api/mcp-servers', { body: stdio, token: null, cookie: c });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: 'stdio', approve: 'every-call' });
    expect(outsideMcpFor('researcher', null, FILE)[0]).toMatchObject({ kind: 'stdio', command: 'npx', env: { FIRECRAWL_API_KEY: 'fc-SECRET-987654' } });
  });

  it('accepts an absolute command path', async () => {
    reset();
    const r = await request('POST', '/api/mcp-servers', { body: { ...stdio, name: 'abs', command: ABS_CMD }, cookie: await signIn(), token: null });
    expect(r.status).toBe(201);
  });

  it('refuses to change a command server with the hub token alone, even for approve or bots', async () => {
    reset();
    const c = await signIn();
    await request('POST', '/api/mcp-servers', { body: stdio, cookie: c, token: null });
    const before = fs.readFileSync(FILE, 'utf8');
    for (const patch of [{ approve: 'none' }, { bots: ['everyone'] }, { command: 'node' }]) {
      expect((await request('PATCH', '/api/mcp-servers/firecrawl', { body: patch })).status).toBe(403);
    }
    expect(fs.readFileSync(FILE, 'utf8')).toBe(before);
    expect((await request('PATCH', '/api/mcp-servers/firecrawl', { body: { approve: 'writes', readTools: ['firecrawl_search'] }, cookie: c, token: null })).status).toBe(200);
    expect(onDisk().firecrawl).toMatchObject({ approve: 'writes', readTools: ['firecrawl_search'] });
  });
});

describe('PATCH / DELETE', () => {
  it('keeps unset fields, clears a token on null, merges env, and keeps unknown keys of the entry', async () => {
    reset();
    const c = await signIn();
    fs.writeFileSync(FILE, JSON.stringify({ wika: { ...remote, name: undefined, note: 'hand written' }, fc: { ...stdio, name: undefined } }), { mode: 0o600 });
    expect((await request('PATCH', '/api/mcp-servers/wika', { body: { rooms: ['Wika'] } })).status).toBe(200);
    expect(onDisk().wika).toMatchObject({ token: remote.token, rooms: ['Wika'], bots: ['wika-backend'], note: 'hand written' });
    expect((await request('PATCH', '/api/mcp-servers/wika', { body: { token: null } })).json.tokenSet).toBe(false);
    expect(onDisk().wika.token).toBeUndefined();
    await request('PATCH', '/api/mcp-servers/fc', { body: { env: { OTHER: 'v', FIRECRAWL_API_KEY: null } }, cookie: c, token: null });
    expect(onDisk().fc.env).toEqual({ OTHER: 'v' });
  });

  it('cannot turn a url server into a command server, or send masked args back', async () => {
    reset();
    const c = await signIn();
    await request('POST', '/api/mcp-servers', { body: remote });
    expect((await request('PATCH', '/api/mcp-servers/wika', { body: { command: 'npx' }, cookie: c, token: null })).status).toBe(400);
    await request('POST', '/api/mcp-servers', { body: stdio, cookie: c, token: null });
    expect((await request('PATCH', '/api/mcp-servers/firecrawl', { body: { args: ['--api-key=***'] }, cookie: c, token: null })).status).toBe(400);
    expect((await request('PATCH', '/api/mcp-servers/firecrawl', { body: { bots: [], rooms: [] }, cookie: c, token: null })).status).toBe(400);
  });

  it('404s unknown names and deletes with the hub token (also a command server)', async () => {
    reset();
    const c = await signIn();
    expect((await request('PATCH', '/api/mcp-servers/nope', { body: { bots: ['b'] } })).status).toBe(404);
    expect((await request('DELETE', '/api/mcp-servers/nope')).status).toBe(404);
    await request('POST', '/api/mcp-servers', { body: stdio, cookie: c, token: null });
    expect((await request('DELETE', '/api/mcp-servers/firecrawl')).status).toBe(200);
    expect(onDisk()).toEqual({});
  });

  it('leaves entries it does not touch byte-for-byte equivalent, even broken ones', async () => {
    reset();
    const broken = { command: 'rm', bots: ['x'], weird: true };
    fs.writeFileSync(FILE, JSON.stringify({ broken }), { mode: 0o600 });
    const list = (await request('GET', '/api/mcp-servers')).json.servers[0];
    expect(list).toMatchObject({ name: 'broken', status: 'invalid' });
    await request('POST', '/api/mcp-servers', { body: remote });
    expect(onDisk().broken).toEqual(broken);
  });

  it('never overwrites a file that is not valid JSON', async () => {
    fs.writeFileSync(FILE, '{ hand edited, unfinished');
    expect((await request('GET', '/api/mcp-servers')).status).toBe(409);
    expect((await request('POST', '/api/mcp-servers', { body: remote })).status).toBe(409);
    expect(fs.readFileSync(FILE, 'utf8')).toBe('{ hand edited, unfinished');
  });
});

describe('atomic write', () => {
  it('leaves no temp file, keeps the format, and sets 0600 where the OS has modes', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: remote });
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(onDisk().wika).toEqual({ url: remote.url, token: remote.token, tokenOrigin: 'https://dashboard.example.com', bots: remote.bots });
    if (process.platform !== 'win32') expect(fs.statSync(FILE).mode & 0o777).toBe(0o600);
  });

  it('keeps the old file whole and removes the temp when the swap fails', () => {
    reset();
    const store = new McpServerStore(FILE);
    store.add({ name: 'one', url: 'https://a.example.com', bots: ['b'] });
    const before = fs.readFileSync(FILE, 'utf8');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk full'); });
    try {
      expect(() => store.add({ name: 'two', url: 'https://b.example.com', bots: ['b'] })).toThrow('disk full');
    } finally { spy.mockRestore(); }
    expect(fs.readFileSync(FILE, 'utf8')).toBe(before);
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('check', () => {
  it('probes a url server with its bearer and reports a fixed word, never the remote text', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: remote });
    fetchCalls.length = 0;
    fetchImpl = async () => new Response('secret detail tok-SECRET-123456', { status: 401 });
    const r = await request('POST', '/api/mcp-servers/wika/check');
    expect(r.json).toMatchObject({ ok: false, result: 'auth-rejected' });
    expect(r.raw).not.toContain('SECRET');
    expect(fetchCalls[0].url).toBe(remote.url);
    expect((fetchCalls[0].init.headers as Record<string, string>).authorization).toBe('Bearer ' + remote.token);
    expect(fetchCalls[0].init.redirect).toBe('manual');
    fetchImpl = async () => new Response('{}', { status: 200 });
    expect((await request('POST', '/api/mcp-servers/wika/check')).json).toMatchObject({ ok: true, result: 'connected' });
    fetchImpl = async () => { throw new Error('connect ECONNREFUSED https://dashboard.example.com tok-SECRET-123456'); };
    const down = await request('POST', '/api/mcp-servers/wika/check');
    expect(down.json).toMatchObject({ ok: false, result: 'unreachable' });
    expect(down.raw).not.toContain('SECRET');
    expect((await request('GET', '/api/mcp-servers')).json.servers[0].lastCheck.result).toBe('unreachable');
  });

  it('only looks for a command server\'s program and never starts it', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: { ...stdio, name: 'gone', command: path.join(tmp, 'no-such-program') }, cookie: await signIn(), token: null });
    fetchCalls.length = 0;
    expect((await request('POST', '/api/mcp-servers/gone/check')).json).toMatchObject({ ok: false, result: 'command-missing' });
    await request('POST', '/api/mcp-servers', { body: { ...stdio, name: 'here', command: ABS_CMD }, cookie: await signIn(), token: null });
    expect((await request('POST', '/api/mcp-servers/here/check')).json).toMatchObject({ ok: true, result: 'command-found' });
    expect(fetchCalls).toEqual([]);
  });
});

describe('bots and other principals cannot reach it', () => {
  it('401s with no credential or a wrong one, such as a per-turn MCP bearer', async () => {
    reset();
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const p = method === 'GET' || method === 'POST' ? '/api/mcp-servers' : '/api/mcp-servers/wika';
      expect((await request(method, p, { token: null })).status).toBe(401);
      expect((await request(method, p, { token: 'a-per-turn-mcp-bearer' })).status).toBe(401);
    }
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('403s a paired phone for every route, and writes nothing', async () => {
    reset();
    const minted = await request('POST', '/api/devices/pairing', { body: {} });
    const paired = await request('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'phone' } });
    expect(paired.status).toBe(200);
    const device = paired.json.token as string;
    expect((await request('GET', '/api/mcp-servers', { token: device })).status).toBe(403);
    expect((await request('POST', '/api/mcp-servers', { token: device, body: remote })).status).toBe(403);
    expect((await request('PATCH', '/api/mcp-servers/wika', { token: device, body: { bots: ['x'] } })).status).toBe(403);
    expect((await request('DELETE', '/api/mcp-servers/wika', { token: device })).status).toBe(403);
    expect((await request('POST', '/api/mcp-servers/wika/check', { token: device })).status).toBe(403);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('rejects a cross-site browser origin', async () => {
    const r = await new Promise<number>((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/mcp-servers', headers: { host: '127.0.0.1:' + port, origin: 'https://evil.example.com', authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      q.end(JSON.stringify(remote));
    });
    expect(r).toBe(403);
  });
});

describe('a stored token stays with its origin', () => {
  const bearer = (i: number) => (fetchCalls[i].init.headers as Record<string, string>).authorization;

  it('rejects a url change to another origin that keeps the stored token', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: remote });
    const r = await request('PATCH', '/api/mcp-servers/wika', { body: { url: 'https://attacker.example.net/mcp' } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/new token|token: null/);
    expect(onDisk().wika.url).toBe(remote.url);
    expect(onDisk().wika.token).toBe(remote.token);
  });

  it('allows a new token with the new origin, clearing the token, and a same-origin path change', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: remote });
    expect((await request('PATCH', '/api/mcp-servers/wika', { body: { url: 'https://dashboard.example.com/v2/mcp' } })).status).toBe(200);
    expect((await request('PATCH', '/api/mcp-servers/wika', { body: { url: 'https://other.example.org/mcp', token: 'new-token-for-other-1' } })).status).toBe(200);
    expect(onDisk().wika).toMatchObject({ url: 'https://other.example.org/mcp', token: 'new-token-for-other-1', tokenOrigin: 'https://other.example.org' });
    expect((await request('PATCH', '/api/mcp-servers/wika', { body: { url: 'https://third.example.org/mcp', token: null } })).status).toBe(200);
    expect(onDisk().wika.token).toBeUndefined();
    expect(onDisk().wika.tokenOrigin).toBeUndefined();
  });

  it('refuses credentials in the url and non-http schemes', async () => {
    reset();
    for (const url of ['https://u:p@h.example.com/mcp', 'ftp://h.example.com/mcp', 'file:///etc/passwd']) {
      expect((await request('POST', '/api/mcp-servers', { body: { name: 'x', url, bots: ['b'] } })).status).toBe(400);
    }
  });

  it('the loader never mounts a token on an origin it was not saved for, and the check never sends it', async () => {
    reset();
    fs.writeFileSync(FILE, JSON.stringify({ wika: { url: 'https://attacker.example.net/mcp', token: 'tok-SECRET-123456', tokenOrigin: 'https://dashboard.example.com', bots: ['wika-backend'] } }), { mode: 0o600 });
    expect(outsideMcpFor('wika-backend', null, FILE)).toEqual([]);
    fetchCalls.length = 0;
    fetchImpl = async () => new Response('{}', { status: 200 });
    await request('POST', '/api/mcp-servers/wika/check');
    expect(bearer(0)).toBeUndefined();
    // A hand-written entry has no binding and is still honoured.
    fs.writeFileSync(FILE, JSON.stringify({ wika: { url: remote.url, token: remote.token, bots: ['wika-backend'] } }));
    expect(outsideMcpFor('wika-backend', null, FILE)[0]).toMatchObject({ token: remote.token });
  });

  it('a redirect to another origin does not carry the Authorization header, and no body is read past the status', async () => {
    reset();
    const seen: Record<string, string | undefined>[] = [];
    const target = http.createServer((q, r) => { seen.push({ auth: q.headers.authorization }); r.end('x'); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const tport = (target.address() as { port: number }).port;
    const redirector = http.createServer((q, r) => { r.writeHead(302, { location: 'http://127.0.0.1:' + tport + '/steal' }); r.end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const rport = (redirector.address() as { port: number }).port;
    try {
      await request('POST', '/api/mcp-servers', { body: { name: 'redir', url: 'http://127.0.0.1:' + rport + '/mcp', token: 'redir-token-abcdef', bots: ['b'] } });
      fetchImpl = (u, i) => fetch(u, i);
      const r = await request('POST', '/api/mcp-servers/redir/check');
      expect(r.json).toMatchObject({ ok: false, result: 'http-302' });
      expect(seen).toEqual([]);
    } finally {
      target.close(); redirector.close();
      fetchImpl = async () => new Response('{}', { status: 200 });
    }
  });

  it('GET never returns the token or its bound origin', async () => {
    reset();
    await request('POST', '/api/mcp-servers', { body: remote });
    const raw = (await request('GET', '/api/mcp-servers')).raw;
    expect(raw).not.toContain('tok-SECRET-123456');
    expect(raw).not.toContain('tokenOrigin');
  });
});
