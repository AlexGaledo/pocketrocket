import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { Bot, Room } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess, runnerMayAccess } from './guard.js';
import { runOnPcTool, type ToolCtx } from '../agent/botTools.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { MAX_PC_OUTPUT, PC_EXPIRED_MESSAGE, PC_OFF_MESSAGE } from '../services/PcRunner.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { events } from '../events.js';
import { listAudit } from '../services/AuditLog.js';
import type { ToolOutput } from '../providers/types.js';

const TOKEN = 'pc-runner-test-hub-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pcrunner-'));
const runnerFile = path.join(tmp, 'pc-runner.json');
let clock = 1_000_000;

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    dmFilesDir: (id) => path.join(tmp, 'bots', id, 'files'),
    pcRunner: { file: runnerFile, now: () => clock, pollMs: 5, waitMs: 60 * 60_000 },
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json', ...opts.headers };
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
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

async function pair(folders = ['site', 'notes']): Promise<string> {
  const r = await request('POST', '/api/pc-runner/token', { body: {} });
  expect(r.status).toBe(200);
  const t = r.json.token as string;
  expect((await request('POST', '/api/pc-runner/heartbeat', { token: t, body: { folders } })).status).toBe(200);
  return t;
}

let n = 0;
function botAndRoom(): { bot: Bot; room: Room } {
  const bot = hub.repos.createBot({ name: 'PC' + n, handle: 'pc-bot-' + n++, title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const room = hub.repos.createRoom({ kind: 'dm', name: 'PC chat', memberIds: [bot.id], coordinatorBotId: null });
  return { bot, room };
}

type Confirm = NonNullable<ToolCtx['confirmFleetChange']>;
function tool(o: { confirm?: Confirm; signal?: AbortSignal } = {}) {
  const { bot, room } = botAndRoom();
  const cards: Parameters<Confirm>[0][] = [];
  const confirm: Confirm = o.confirm ?? (async () => ({ allowed: true, message: 'ok' }));
  const ctx: ToolCtx = {
    bot, room, members: [bot], turnId: 't', hop: 0, causeId: 'c', repos: hub.repos,
    memory: new MemoryService(), skills: new SkillService(hub.repos), dispatchFromBot: () => [], setState: () => undefined, models: [],
    confirmFleetChange: async (a) => { cards.push(a); return confirm(a); },
    pcRunner: hub.pcRunner, signal: o.signal,
  };
  const t = runOnPcTool(ctx, hub.pcRunner);
  return { run: (input: unknown) => t.handler(input as Record<string, unknown>) as Promise<ToolOutput>, cards, bot, room };
}
const textOf = (o: ToolOutput) => o.content.map((c) => ('text' in c ? c.text : '')).join('');

/** Waits until the PC side sees an approved job, as the helper would by polling. */
async function claim(t: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const r = await request('GET', '/api/pc-runner/jobs/next', { token: t });
    if (r.status === 200) return r.json;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('no job served');
}

beforeEach(async () => {
  // Every test starts unpaired with no open jobs.
  await request('DELETE', '/api/pc-runner');
});

describe('pairing', () => {
  it('mints a token shown once; pc-runner.json holds only its sha256', async () => {
    expect((await request('GET', '/api/pc-runner')).json).toEqual({ paired: false, folders: [], lastSeenAt: null, online: false });
    const t = await pair(['site']);
    expect(t.length).toBeGreaterThanOrEqual(43);
    const raw = fs.readFileSync(runnerFile, 'utf8');
    expect(raw).not.toContain(t);
    const f = JSON.parse(raw);
    expect(Object.keys(f).sort()).toEqual(['createdAt', 'folders', 'lastSeenAt', 'tokenSha256']);
    expect(f.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(fs.statSync(runnerFile).mode & 0o777).toBe(0o600);
    const s = await request('GET', '/api/pc-runner');
    expect(s.json).toMatchObject({ paired: true, folders: ['site'], online: true });
    clock += 31_000;
    expect((await request('GET', '/api/pc-runner')).json.online).toBe(false);
    expect(listAudit(hub.repos.db).some((e) => e.action === 'pc-runner.token.minted')).toBe(true);
  });

  it('a stolen copy of pc-runner.json is not a token: the hash is refused', async () => {
    await pair();
    const { tokenSha256 } = JSON.parse(fs.readFileSync(runnerFile, 'utf8'));
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: tokenSha256 })).status).toBe(401);
  });

  it('rotation: the old token stops working at once', async () => {
    const old = await pair();
    const fresh = await pair();
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: old })).status).toBe(401);
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: fresh })).status).toBe(204);
  });

  it('rejects folder names that are not plain names', async () => {
    const t = await pair();
    for (const bad of ['../x', 'C:\\work', 'Site', '', 'a'.repeat(42), 'a b']) {
      expect((await request('POST', '/api/pc-runner/heartbeat', { token: t, body: { folders: [bad] } })).status).toBe(400);
    }
  });
});

describe('who may reach what', () => {
  it('the runner token gets 403 everywhere but its own routes', async () => {
    const t = await pair();
    for (const [m, p, body] of [
      ['GET', '/api/bots'], ['POST', '/api/bots', {}], ['GET', '/api/settings'], ['PUT', '/api/settings', { approvals: 'bypass' }],
      ['GET', '/api/rooms'], ['POST', '/api/rooms', {}], ['GET', '/api/approval-policies'], ['POST', '/api/approval-policies', {}],
      ['GET', '/api/approvals/parked'], ['GET', '/api/secrets'], ['GET', '/api/debug/last-init'], ['GET', '/api/devices'],
      ['POST', '/api/pc-runner/token', {}], ['GET', '/api/pc-runner'], ['DELETE', '/api/pc-runner'], ['GET', '/'],
    ] as [string, string, unknown?][]) {
      expect([m, p, (await request(m, p, { token: t, body })).status]).toEqual([m, p, 403]);
    }
    expect(hub.pcRunner.isPaired()).toBe(true);
  });

  it('the runner token is not accepted in the query string or on /ws', async () => {
    const t = await pair();
    expect((await request('GET', '/api/pc-runner/jobs/next?token=' + encodeURIComponent(t), { token: null })).status).toBe(401);
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { authorization: 'Bearer ' + t, host: '127.0.0.1:' + port } });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(opened).toBe(false);
  });

  it('the hub token and a paired device get 403 on the runner routes', async () => {
    await pair();
    const { code } = hub.devices.mintPairingCode();
    const device = hub.devices.redeem(code, 'phone').token;
    for (const tok of [TOKEN, device]) {
      expect((await request('POST', '/api/pc-runner/heartbeat', { token: tok, body: { folders: ['x'] } })).status).toBe(403);
      expect((await request('GET', '/api/pc-runner/jobs/next', { token: tok })).status).toBe(403);
      expect((await request('POST', '/api/pc-runner/jobs/abc/start', { token: tok, body: {} })).status).toBe(403);
      expect((await request('POST', '/api/pc-runner/jobs/abc/result', { token: tok, body: { ok: true, output: '' } })).status).toBe(403);
    }
    // A phone cannot pair, read or turn off the runner either.
    expect((await request('POST', '/api/pc-runner/token', { token: device, body: {} })).status).toBe(403);
    expect((await request('DELETE', '/api/pc-runner', { token: device })).status).toBe(403);
    expect(hub.pcRunner.folders()).toEqual(['site', 'notes']);
  });

  it('the allowlists', () => {
    expect(runnerMayAccess('POST', '/api/pc-runner/heartbeat')).toBe(true);
    expect(runnerMayAccess('GET', '/api/pc-runner/jobs/next')).toBe(true);
    expect(runnerMayAccess('POST', '/api/pc-runner/jobs/abc_1-2/result')).toBe(true);
    expect(runnerMayAccess('GET', '/api/pc-runner')).toBe(false);
    expect(runnerMayAccess('POST', '/api/pc-runner/token')).toBe(false);
    expect(runnerMayAccess('GET', '/api/bots')).toBe(false);
    expect(deviceMayAccess('GET', '/api/pc-runner')).toBe(false);
    expect(deviceMayAccess('GET', '/api/pc-runner/jobs/next')).toBe(false);
  });
});

describe('jobs', () => {
  it('a job without approval is never served', async () => {
    const t = await pair();
    const { bot, room } = botAndRoom();
    hub.pcRunner.create({ botId: bot.id, roomId: room.id, folder: 'site', prompt: 'hi' });
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: t })).status).toBe(204);
  });

  it('a denied card never queues the job', async () => {
    const t = await pair();
    const tl = tool({ confirm: async () => ({ allowed: false, message: 'The user declined this change.' }) });
    const out = await tl.run({ folder: 'site', prompt: 'build it' });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('declined');
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: t })).status).toBe(204);
    expect(hub.pcRunner.openCount()).toBe(0);
  });

  it('refuses a folder the PC did not allowlist, and an unpaired PC, before any card', async () => {
    await pair(['site']);
    const tl = tool();
    const out = await tl.run({ folder: 'secrets', prompt: 'cat everything' });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('not a folder the PC allows');
    expect((await tl.run({ folder: '../site', prompt: 'x' })).isError).toBe(true);
    expect((await tl.run({ folder: 'site', prompt: 'x'.repeat(8 * 1024 + 1) })).isError).toBe(true);
    await request('DELETE', '/api/pc-runner');
    expect(textOf(await tl.run({ folder: 'site', prompt: 'x' }))).toContain('No PC is paired');
    expect(tl.cards).toEqual([]);
  });

  it('the card shows folder and prompt, under bypass too; the PC gets the job and the bot gets the redacted, capped output', async () => {
    const t = await pair();
    const tl = tool();
    const pending = tl.run({ folder: 'notes', prompt: 'Summarise README.md' });
    const job = await claim(t);
    expect(tl.cards).toEqual([expect.objectContaining({ tool: 'run_on_pc', evenUnderBypass: true, input: { folder: 'notes', prompt: 'Summarise README.md' } })]);
    expect(job).toEqual({ id: expect.any(String), bot: { handle: tl.bot.handle }, room: { id: tl.room.id, name: 'PC chat' }, folder: 'notes', prompt: 'Summarise README.md', createdAt: expect.any(Number) });
    expect((await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: t, body: {} })).status).toBe(200);
    const output = 'leaked ' + TOKEN + ' ' + 'y'.repeat(30_000);
    const r = await request('POST', '/api/pc-runner/jobs/' + job.id + '/result', { token: t, body: { ok: true, output, costUsd: 0.12, durationMs: 4000 } });
    expect(r.json).toEqual({ ok: true, status: 'done' });
    const out = await pending;
    const txt = textOf(out);
    expect(out.isError).toBeFalsy();
    expect(txt).not.toContain(TOKEN);
    expect(txt.length).toBeLessThan(MAX_PC_OUTPUT + 400);
    expect(txt).toContain('cut at 20 KB');
    expect(hub.pcRunner.get(job.id)!.result).not.toContain(TOKEN);
    // A second result for a finished job is refused.
    expect((await request('POST', '/api/pc-runner/jobs/' + job.id + '/result', { token: t, body: { ok: false, output: 'x' } })).status).toBe(409);
    const actions = listAudit(hub.repos.db).filter((e) => e.target === job.id).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['pc-runner.job.approved', 'pc-runner.job.done']));
  });

  it('a job the PC owner refused locally comes back as refused', async () => {
    const t = await pair();
    const tl = tool();
    const pending = tl.run({ folder: 'site', prompt: 'deploy' });
    const job = await claim(t);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/result', { token: t, body: { ok: false, refusedLocally: true, output: '' } });
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('declined the job on the PC');
  });

  it('one at a time: the next job waits while one is claimed or running', async () => {
    const t = await pair();
    const a = tool().run({ folder: 'site', prompt: 'one' });
    const first = await claim(t);
    const b = tool().run({ folder: 'site', prompt: 'two' });
    await new Promise((r) => setTimeout(r, 30));
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: t })).status).toBe(204);
    await request('POST', '/api/pc-runner/jobs/' + first.id + '/start', { token: t, body: {} });
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: t })).status).toBe(204);
    await request('POST', '/api/pc-runner/jobs/' + first.id + '/result', { token: t, body: { ok: true, output: 'done one' } });
    const second = await claim(t);
    expect(second.prompt).toBe('two');
    await request('POST', '/api/pc-runner/jobs/' + second.id + '/result', { token: t, body: { ok: true, output: 'done two' } });
    expect(textOf(await a)).toContain('done one');
    expect(textOf(await b)).toContain('done two');
  });

  it('at most five open jobs', async () => {
    await pair();
    const { bot, room } = botAndRoom();
    for (let i = 0; i < 5; i++) hub.pcRunner.create({ botId: bot.id, roomId: room.id, folder: 'site', prompt: 'p' + i });
    const out = await tool().run({ folder: 'site', prompt: 'sixth' });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('5 jobs');
  });

  it('a queued job nobody claims expires after 30 minutes', async () => {
    await pair();
    const pending = tool().run({ folder: 'site', prompt: 'later' });
    await new Promise((r) => setTimeout(r, 20));
    clock += 30 * 60_000 + 1;
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(PC_EXPIRED_MESSAGE);
  });

  it('the kill switch cancels queued and running jobs and forgets the token', async () => {
    const t = await pair();
    const running = tool().run({ folder: 'site', prompt: 'long job' });
    const job = await claim(t);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: t, body: {} });
    const queued = tool().run({ folder: 'notes', prompt: 'queued job' });
    await new Promise((r) => setTimeout(r, 20));
    const off = await request('DELETE', '/api/pc-runner');
    expect(off.json).toEqual({ ok: true, cancelled: 2 });
    expect(fs.existsSync(runnerFile)).toBe(false);
    for (const p of [running, queued]) expect(textOf(await p)).toContain(PC_OFF_MESSAGE);
    expect((await request('GET', '/api/pc-runner/jobs/next', { token: t })).status).toBe(401);
    expect((await request('POST', '/api/pc-runner/jobs/' + job.id + '/result', { token: t, body: { ok: true, output: 'late' } })).status).toBe(401);
    expect(listAudit(hub.repos.db).some((e) => e.action === 'pc-runner.turned-off')).toBe(true);
  });

  it('stopping the turn cancels its job', async () => {
    const t = await pair();
    const ac = new AbortController();
    const pending = tool({ signal: ac.signal }).run({ folder: 'site', prompt: 'stop me' });
    const job = await claim(t);
    ac.abort();
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(hub.pcRunner.get(job.id)!.status).toBe('cancelled');
    expect((await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: t, body: {} })).status).toBe(409);
  });
});

describe('the approval card', () => {
  it('asks on every call under bypass: neither "always" nor an allow rule pre-approves run_on_pc', async () => {
    const { bot, room } = botAndRoom();
    const broker = new PermissionBroker(hub.repos, { bypass: () => true, store: hub.approvals });
    hub.approvals.addPolicy({ botId: bot.id, tool: 'run_on_pc', pattern: '*', decision: 'allow', scope: 'always' });
    expect(broker.matchPolicy(bot.id, 'run_on_pc', '*')).toBeNull();
    const seen: unknown[] = [];
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request' && ev.botId === bot.id) {
        seen.push(ev.approval.toolInput);
        setTimeout(() => broker.resolve(ev.approval.approvalId, 'always', { signedIn: true }), 0);
      }
    });
    const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
    const input = { folder: 'site', prompt: 'p' };
    for (let i = 0; i < 2; i++) {
      const r = await broker.askFleetChange(ctx, 'run_on_pc', input, 'Run Claude Code on your PC', new AbortController().signal, { evenUnderBypass: true });
      expect(r.allowed).toBe(true);
    }
    off();
    expect(seen).toEqual([input, input]);
    // A deny rule still refuses.
    hub.approvals.addPolicy({ botId: bot.id, tool: 'run_on_pc', pattern: '*', decision: 'deny', scope: 'always' });
    expect((await broker.askFleetChange(ctx, 'run_on_pc', input, 'r', new AbortController().signal, { evenUnderBypass: true })).allowed).toBe(false);
  });
});
