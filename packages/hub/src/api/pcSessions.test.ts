import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Bot } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess, runnerMayAccess } from './guard.js';
import { events } from '../events.js';
import { listAudit } from '../services/AuditLog.js';
import { addSecret, removeSecret } from '../providers/redact.js';
import { searchHistory } from '../db/historyIndex.js';
import { createHubTools, type ToolCtx } from '../agent/botTools.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { botHome } from '../config.js';

const TOKEN = 'pc-sessions-test-hub-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pcsess-'));
const clock = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

let hub: Hub;
let port: number;
let runnerToken: string;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    dmFilesDir: (id) => path.join(tmp, 'bots', id, 'files'),
    pcRunner: { file: path.join(tmp, 'pc-runner.json') },
    pcSessions: { now: () => clock },
  });
  port = await hub.listen();
  runnerToken = (await request('POST', '/api/pc-runner/token', { body: {} })).json.token;
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; raw?: string; token?: string | null } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)));
  });
}
const asRunner = (method: string, p: string, body?: unknown) => request(method, p, { token: runnerToken, body });
const asOwner = (method: string, p: string, body?: unknown) => request(method, p, { body });

const meta = (o: Record<string, unknown> = {}) => ({
  machine: 'pc', projectDir: 'C--code-wika', cwd: 'C:\\code\\wika', repo: { name: 'wika-saas', remote: 'git@github.com:a/wika-saas.git', branch: 'main', head: 'abc123' },
  title: 'Fix login', firstAt: clock - 5000, lastAt: clock - 1000, ...o,
});
let n = 0;
const ent = (o: Record<string, unknown> = {}) => ({ uuid: 'e-' + n++, at: clock - 2000, kind: 'user', text: 'hi', ...o });
let sid = 0;
const newId = () => 'sess-' + sid++;
async function mk(o: Record<string, unknown> = {}, id = newId()) {
  expect((await asRunner('PUT', '/api/pc-sessions/' + id, meta(o))).status).toBe(200);
  return id;
}
const enc = encodeURIComponent;

describe('principals', () => {
  it('401 with no token, 403 for the wrong principal on every route', async () => {
    for (const [m, p] of [['GET', '/api/pc-sessions'], ['GET', '/api/pc-sessions/sync'], ['PUT', '/api/pc-sessions/x'], ['POST', '/api/pc-sessions/x/entries']] as const) {
      expect((await request(m, p, { token: null })).status).toBe(401);
    }
    const id = await mk();
    // the hub token (owner) cannot use the runner routes
    expect((await asOwner('GET', '/api/pc-sessions/sync')).status).toBe(403);
    expect((await asOwner('PUT', '/api/pc-sessions/' + id, meta())).status).toBe(403);
    expect((await asOwner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 1, entries: [] })).status).toBe(403);
    // the runner cannot read or delete
    for (const [m, p] of [['GET', '/api/pc-sessions'], ['GET', '/api/pc-sessions/' + id], ['GET', '/api/pc-sessions/' + id + '/entries'], ['DELETE', '/api/pc-sessions/' + id]] as const) {
      expect((await asRunner(m, p)).status).toBe(403);
    }
  });

  it('guard: the runner allowlist has the three write routes only; a paired phone has none', () => {
    expect(runnerMayAccess('GET', '/api/pc-sessions/sync')).toBe(true);
    expect(runnerMayAccess('PUT', '/api/pc-sessions/abc:def.1')).toBe(true);
    expect(runnerMayAccess('POST', '/api/pc-sessions/abc/entries')).toBe(true);
    expect(runnerMayAccess('GET', '/api/pc-sessions')).toBe(false);
    expect(runnerMayAccess('GET', '/api/pc-sessions/abc')).toBe(false);
    expect(runnerMayAccess('GET', '/api/pc-sessions/abc/entries')).toBe(false);
    expect(runnerMayAccess('DELETE', '/api/pc-sessions/abc')).toBe(false);
    expect(runnerMayAccess('PUT', '/api/pc-sessions/a/b')).toBe(false);
    for (const [m, p] of [['GET', '/api/pc-sessions'], ['GET', '/api/pc-sessions/a'], ['GET', '/api/pc-sessions/a/entries'], ['DELETE', '/api/pc-sessions/a']] as const) {
      expect(deviceMayAccess(m, p)).toBe(false);
    }
  });
});

describe('runner routes', () => {
  it('PUT creates at offset 0, repeats return the stored offset; sync lists offsets', async () => {
    const id = newId();
    expect((await asRunner('PUT', '/api/pc-sessions/' + id, meta())).json).toEqual({ ok: true, offset: 0, onVps: false });
    expect((await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 100, entries: [ent()] })).status).toBe(200);
    expect((await asRunner('PUT', '/api/pc-sessions/' + id, meta({ title: 'renamed' }))).json).toEqual({ ok: true, offset: 100, onVps: false });
    expect((await asRunner('GET', '/api/pc-sessions/sync')).json.sessions[id]).toEqual({ offset: 100, onVps: false });
    expect((await asOwner('GET', '/api/pc-sessions/' + id)).json.title).toBe('renamed');
  });

  it('validates: bad id, bad body, to < from, subagent id with a colon', async () => {
    expect((await asRunner('PUT', '/api/pc-sessions/' + enc('../x'), meta())).status).toBe(400);
    expect((await asRunner('PUT', '/api/pc-sessions/sync', meta())).status).toBe(400);
    expect((await asRunner('PUT', '/api/pc-sessions/' + newId(), { machine: 'pc' })).status).toBe(400);
    const id = await mk();
    expect((await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 5, to: 1, entries: [] })).status).toBe(400);
    expect((await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 1, entries: [{ uuid: 'x', at: 1, kind: 'nope', text: '' }] })).status).toBe(400);
    expect((await asRunner('PUT', '/api/pc-sessions/' + enc(id + ':agent-a1'), meta({ parentId: id }))).status).toBe(200);
  });

  it('entries for an unknown session: 404', async () => {
    expect((await asRunner('POST', '/api/pc-sessions/nope/entries', { from: 0, to: 1, entries: [] })).status).toBe(404);
  });

  it('409 with the stored offset on a mismatch, then resume from it', async () => {
    const id = await mk();
    const a = ent(), b = ent(), c = ent();
    expect((await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 50, entries: [a, b] })).json).toMatchObject({ ok: true, offset: 50, stored: 2 });
    const stale = await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 20, to: 80, entries: [c] });
    expect(stale.status).toBe(409);
    expect(stale.json.offset).toBe(50);
    expect(stale.json.error).toBeTruthy();
    expect((await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 70, to: 90, entries: [c] })).status).toBe(409);
    expect((await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: stale.json.offset, to: 80, entries: [c] })).json).toMatchObject({ ok: true, offset: 80, stored: 1 });
    expect((await asOwner('GET', '/api/pc-sessions/' + id + '/entries')).json.entries.map((e: any) => e.uuid)).toEqual([a.uuid, b.uuid, c.uuid]);
  });

  it('a resent batch does not duplicate (unique on uuid) and the offset still advances', async () => {
    const id = await mk();
    const a = ent(), b = ent();
    await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 10, entries: [a, b] });
    const r = await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 10, to: 20, entries: [a, b, ent()] });
    expect(r.json).toMatchObject({ ok: true, offset: 20, stored: 1 });
    expect((await asOwner('GET', '/api/pc-sessions/' + id)).json.entryCount).toBe(3);
  });

  it('enforces the per-kind text caps again, whatever the runner sent', async () => {
    const id = await mk();
    await asRunner('POST', '/api/pc-sessions/' + id + '/entries', {
      from: 0, to: 1,
      entries: [
        ent({ kind: 'user', text: 'u'.repeat(9000) }),
        ent({ kind: 'tool_use', tool: 'Bash', text: 't'.repeat(900) }),
        ent({ kind: 'tool_result', tool: 'Bash', text: 'r'.repeat(5000), isError: true }),
        ent({ kind: 'summary', text: 's'.repeat(3000) }),
        ent({ kind: 'assistant', text: 'a'.repeat(7990) + ' …[cut 123 chars]' }), // already cut by the runner: kept as is
      ],
    });
    const es = (await asOwner('GET', '/api/pc-sessions/' + id + '/entries')).json.entries;
    expect(es[0].text).toBe('u'.repeat(8000) + ' …[cut 1000 chars]');
    expect(es[1].text).toBe('t'.repeat(400) + ' …[cut 500 chars]');
    expect(es[2].text).toBe('r'.repeat(1000) + ' …[cut 4000 chars]');
    expect(es[2]).toMatchObject({ tool: 'Bash', isError: true });
    expect(es[3].text).toBe('s'.repeat(2000) + ' …[cut 1000 chars]');
    expect(es[4].text.endsWith('…[cut 123 chars]')).toBe(true);
  });

  it('drops entries past 5 MB of text per session and flags the session truncated', async () => {
    const id = await mk();
    let last: any;
    // 8000 chars per entry, 40 per batch (~320 KB per request); 5 MB holds 655 of them
    for (let b = 0; b < 18; b++) {
      last = await asRunner('POST', '/api/pc-sessions/' + id + '/entries', {
        from: b, to: b + 1, entries: Array.from({ length: 40 }, () => ent({ text: 'z'.repeat(8000) })),
      });
      expect(last.status).toBe(200);
    }
    expect(last.json.truncated).toBe(true);
    const s = (await asOwner('GET', '/api/pc-sessions/' + id)).json;
    expect(s.truncated).toBe(true);
    expect(s.bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(s.bytes).toBeGreaterThan(5 * 1024 * 1024 - 8100);
    expect(s.entryCount).toBe(Math.floor((5 * 1024 * 1024) / 8000));
  }, 30_000);

  it('rejects a batch over 500 entries and a body over 1 MB', async () => {
    const id = await mk();
    expect((await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 1, entries: Array.from({ length: 501 }, () => ent()) })).status).toBe(400);
    const big = await request('POST', '/api/pc-sessions/' + id + '/entries', { token: runnerToken, raw: JSON.stringify({ from: 0, to: 1, entries: [ent({ text: 'x'.repeat(1_100_000) })] }) });
    expect(big.status).toBe(413);
  });
});

describe('owner routes', () => {
  it('lists newest lastAt first and filters by repo, q and before', async () => {
    const a = await mk({ title: 'Alpha work', lastAt: clock - 3000, repo: { name: 'alpha-repo', remote: null, branch: null, head: null }, cwd: 'C:\\x\\alpha' });
    const b = await mk({ title: 'Beta work', lastAt: clock - 2000, repo: { name: 'beta-repo', remote: null, branch: null, head: null }, cwd: 'C:\\x\\beta' });
    const c = await mk({ title: 'Gamma 100%_odd', lastAt: clock - 1000, repo: null, cwd: 'C:\\x\\gamma' });
    const ids = (r: any) => r.json.sessions.map((s: any) => s.id);
    const all = ids(await asOwner('GET', '/api/pc-sessions?limit=200'));
    expect(all.indexOf(c)).toBeLessThan(all.indexOf(b));
    expect(all.indexOf(b)).toBeLessThan(all.indexOf(a));
    expect(ids(await asOwner('GET', '/api/pc-sessions?repo=BETA-repo'))).toEqual([b]);
    expect(ids(await asOwner('GET', '/api/pc-sessions?q=alpha'))).toEqual([a]);
    expect(ids(await asOwner('GET', '/api/pc-sessions?q=' + enc('beta-repo')))).toEqual([b]);
    expect(ids(await asOwner('GET', '/api/pc-sessions?q=' + enc('x\\gamma')))).toEqual([c]);
    expect(ids(await asOwner('GET', '/api/pc-sessions?q=' + enc('100%_')))).toEqual([c]);
    expect(ids(await asOwner('GET', '/api/pc-sessions?q=' + enc('%')))).toEqual([c]); // a literal %, not a wildcard
    expect(ids(await asOwner('GET', '/api/pc-sessions?q=work&before=' + (clock - 2000)))).toEqual([a]);
    expect(ids(await asOwner('GET', '/api/pc-sessions?q=work&limit=1'))).toEqual([b]);
  });

  it('status is live inside 10 minutes of lastAt, ended after (computed at read)', async () => {
    const live = await mk({ lastAt: clock - 5 * 60_000 });
    const ended = await mk({ lastAt: clock - 11 * 60_000 });
    expect((await asOwner('GET', '/api/pc-sessions/' + live)).json.status).toBe('live');
    expect((await asOwner('GET', '/api/pc-sessions/' + ended)).json.status).toBe('ended');
  });

  it('get returns children; the list shows only top-level sessions; the child has the parent id', async () => {
    const p = await mk({ title: 'Parent session' });
    const sub = p + ':agent-1';
    await asRunner('PUT', '/api/pc-sessions/' + enc(sub), meta({ parentId: p, title: 'Subagent' }));
    const g = (await asOwner('GET', '/api/pc-sessions/' + p)).json;
    expect(g.parentId).toBeNull();
    expect(g.children.map((c: any) => c.id)).toEqual([sub]);
    expect(g.children[0].parentId).toBe(p);
    const list = (await asOwner('GET', '/api/pc-sessions?limit=200')).json.sessions.map((s: any) => s.id);
    expect(list).toContain(p);
    expect(list).not.toContain(sub);
    expect((await asOwner('GET', '/api/pc-sessions/' + enc(sub))).json.id).toBe(sub);
    expect((await asOwner('GET', '/api/pc-sessions/missing')).status).toBe(404);
  });

  it('pages entries by seq', async () => {
    const id = await mk();
    await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 1, entries: Array.from({ length: 5 }, (_, i) => ent({ text: 'm' + i })) });
    const p1 = (await asOwner('GET', '/api/pc-sessions/' + id + '/entries?limit=2')).json;
    expect(p1.entries.map((e: any) => [e.seq, e.text])).toEqual([[1, 'm0'], [2, 'm1']]);
    expect(p1.more).toBe(true);
    const p2 = (await asOwner('GET', '/api/pc-sessions/' + id + '/entries?after=2&limit=200')).json;
    expect(p2.entries.map((e: any) => e.seq)).toEqual([3, 4, 5]);
    expect(p2.more).toBe(false);
    expect((await asOwner('GET', '/api/pc-sessions/missing/entries')).status).toBe(404);
  });

  it('DELETE removes the session, its entries and its children, and is audited', async () => {
    const p = await mk();
    const sub = p + ':agent-9';
    await asRunner('PUT', '/api/pc-sessions/' + enc(sub), meta({ parentId: p }));
    await asRunner('POST', '/api/pc-sessions/' + p + '/entries', { from: 0, to: 1, entries: [ent()] });
    await asRunner('POST', '/api/pc-sessions/' + enc(sub) + '/entries', { from: 0, to: 1, entries: [ent()] });
    expect((await asOwner('DELETE', '/api/pc-sessions/' + p)).json).toEqual({ ok: true });
    expect((await asOwner('GET', '/api/pc-sessions/' + p)).status).toBe(404);
    expect((await asOwner('GET', '/api/pc-sessions/' + enc(sub))).status).toBe(404);
    for (const id of [p, sub]) expect(hub.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pc_session_entries WHERE session_id = ?', id)!.n).toBe(0);
    expect((await asOwner('DELETE', '/api/pc-sessions/' + p)).status).toBe(404);
    expect(listAudit(hub.repos.db).some((e) => e.action === 'pc-session.deleted' && e.target === p)).toBe(true);
  });

  it('prune through the hub: 90-day retention by lastAt', async () => {
    const old = await mk({ lastAt: clock - 91 * DAY });
    const fresh = await mk({ lastAt: clock - 89 * DAY });
    expect(hub.pcSessions.prune().removed).toBeGreaterThanOrEqual(1);
    expect((await asOwner('GET', '/api/pc-sessions/' + old)).status).toBe(404);
    expect((await asOwner('GET', '/api/pc-sessions/' + fresh)).status).toBe(200);
  });

  it('a burst of stored batches emits pc_session_updated once', async () => {
    const id = await mk();
    const seen: string[] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'pc_session_updated' && ev.id === id) seen.push(ev.id); });
    try {
      for (let i = 0; i < 4; i++) await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: i, to: i + 1, entries: [ent()] });
      expect(seen).toHaveLength(1);
    } finally {
      off();
    }
  });
});

describe('redaction and visibility (spec 6.4 layer 1, section 9 P3)', () => {
  const CANARY = 'canary-sess-ZXQ9417-unique';
  const KEY = 'sk-ant-api03-' + 'AbCdEf0123456789'.repeat(4);
  const KNOWN = 'hunter2-known-secret-value-42';

  it('a fake key and a registered secret never land in the database as plain text', async () => {
    addSecret(KNOWN);
    try {
      const id = newId();
      await asRunner('PUT', '/api/pc-sessions/' + id, meta({
        title: 'Deploy with ' + KEY, cwd: 'C:\\' + KNOWN,
        repo: { name: 'r', remote: 'https://user:' + KNOWN + '@github.com/a/r.git', branch: null, head: null },
      }));
      await asRunner('POST', '/api/pc-sessions/' + id + '/entries', {
        from: 0, to: 1,
        entries: [
          ent({ text: 'export ANTHROPIC_API_KEY=' + KEY + ' and ' + KNOWN }),
          ent({ kind: 'tool_use', tool: 'Bash', text: 'curl -H "Authorization: Bearer ' + KEY + '" ' + CANARY }),
          ent({ kind: 'tool_result', tool: 'Bash', text: KNOWN + KNOWN }),
        ],
      });
      for (const table of ['pc_sessions', 'pc_session_entries']) {
        for (const r of hub.repos.db.all<Record<string, unknown>>('SELECT * FROM ' + table)) {
          const row = JSON.stringify(r);
          expect(row).not.toContain(KEY);
          expect(row).not.toContain('AbCdEf0123456789');
          expect(row).not.toContain(KNOWN);
        }
      }
      const e = (await asOwner('GET', '/api/pc-sessions/' + id + '/entries')).json.entries;
      expect(e[0].text).toContain('[redacted]');
      expect(e[1].text).toContain(CANARY); // ordinary text is kept
      expect((await asOwner('GET', '/api/pc-sessions/' + id)).json.title).not.toContain('AbCdEf');
    } finally {
      removeSecret(KNOWN);
    }
  });

  it('no bot-facing path reads mirrored text: history index, search_history, recall_memory, read_room, the cc API', async () => {
    const id = await mk({ title: 'Title ' + CANARY });
    await asRunner('POST', '/api/pc-sessions/' + id + '/entries', { from: 0, to: 1, entries: [ent({ text: 'the word ' + CANARY + ' appears here' })] });
    // the owner can read it
    expect(JSON.stringify((await asOwner('GET', '/api/pc-sessions/' + id + '/entries')).json)).toContain(CANARY);

    const bot = hub.repos.createBot({ name: 'Vis', handle: 'vis-bot', title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
    const room = hub.repos.createRoom({ kind: 'group', name: 'Vis room', memberIds: [bot.id], coordinatorBotId: bot.id });
    const ctx: ToolCtx = {
      bot, room, members: [bot as Bot], turnId: 't', hop: 0, causeId: 'c', repos: hub.repos, memory: new MemoryService(), skills: new SkillService(hub.repos),
      dispatchFromBot: () => [], setState: () => undefined, models: ['claude-sonnet-5'],
    };
    const tools = createHubTools(ctx);
    const call = async (name: string, input: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name);
      if (!t) return '';
      const out = await t.handler(input);
      return out.content.map((c) => ('text' in c ? c.text : '')).join('');
    };
    try {
      // the FTS index behind search_history, and the tools themselves
      expect(searchHistory(hub.repos.db, { query: CANARY, roomIds: hub.repos.listRooms().map((r) => r.id), limit: 20 })).toEqual([]);
      expect(await call('search_history', { query: CANARY })).toMatch(/^No messages match/);
      expect(await call('recall_memory', { query: CANARY })).not.toContain('appears here');
      expect(await call('read_room', { room: room.id })).not.toContain(CANARY);
      expect(await call('list_rooms', {})).not.toContain(CANARY);
      expect(JSON.stringify(hub.repos.listMessages(room.id, { limit: 200 }))).not.toContain(CANARY);
      // no table other than the two mirror tables holds the canary
      const tables = hub.repos.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(['pc_sessions', 'pc_session_entries']));
      for (const t of tables.filter((x) => !x.startsWith('pc_session'))) {
        for (const r of hub.repos.db.all('SELECT * FROM "' + t + '"')) expect(JSON.stringify(r)).not.toContain(CANARY);
      }
      // the cc API (the runner's MCP route into rooms) cannot reach it
      expect(JSON.stringify((await request('GET', '/api/cc/rooms', { token: runnerToken })).json)).not.toContain(CANARY);
      expect(JSON.stringify((await request('GET', '/api/cc/rooms/' + room.id + '/messages', { token: runnerToken })).json)).not.toContain(CANARY);
      expect((await request('GET', '/api/cc/pc-sessions', { token: runnerToken })).status).not.toBe(200);
      // and the runner token cannot read the mirror back
      expect((await asRunner('GET', '/api/pc-sessions/' + id + '/entries')).status).toBe(403);
    } finally {
      fs.rmSync(botHome(bot.id), { recursive: true, force: true });
    }
  });

  it('only the mirror service and the migration name the pc_session tables in hub source (the persona tools go through the service)', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.ts$/.test(f.name) && !/\.test\.ts$/.test(f.name) && /(?<![a-z_])pc_session(s|_entries|_tombstones)\b/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p).replace(/\\/g, '/'));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['db/migrations.ts', 'services/PcSessions.ts']);
  });
});

describe('deleted sessions stay deleted', () => {
  it('answers 410 to a PUT for a session the owner deleted', async () => {
    const id = await mk();
    expect((await asOwner('DELETE', '/api/pc-sessions/' + enc(id))).status).toBe(200);
    const r = await asRunner('PUT', '/api/pc-sessions/' + enc(id), meta({ lastAt: clock + 60_000 }));
    expect(r.status).toBe(410);
    expect((await asRunner('GET', '/api/pc-sessions/sync')).json.sessions[id]).toBeUndefined();
  });
});
