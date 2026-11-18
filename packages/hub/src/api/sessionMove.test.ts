import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Bot, ModelInfo, ProviderCheck, ProviderId, Room } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { createHubTools, type ToolCtx } from '../agent/botTools.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { settings } from '../services/SettingsStore.js';
import { sessionFilePath } from '../services/SessionFile.js';
import { runnerMayAccess } from './guard.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink, type ToolOutput } from '../providers/types.js';
import { OFFLOAD_PUSH_DENIED, pushesToRemote } from '../agent/BotRunner.js';

/**
 * Bridge P6 (hub half): move a PC session to the VPS, run its turns there, pull it back. Git runs against temp repos and a
 * temp project folder; the Claude CLI is a stubbed provider; the CLI's session folder is a temp dir. Nothing real is touched.
 */

vi.setConfig({ testTimeout: 90_000 });

const TOKEN = 'session-move-test-hub-token';
const PASSWORD = 'session move owner password';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-'));
const CFG = path.join(tmp, 'claude-cfg');
const realGet = settings.get.bind(settings);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const J = (o: unknown) => JSON.stringify(o);

/** A stand-in for the Claude provider: records what a turn was given, appends lines to the session file the way the CLI does. */
class StubClaude implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Stub';
  readonly info = { id: 'claude' as ProviderId, label: 'Stub', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  /** When set, the turn waits for it before it finishes. */
  gate: Promise<void> | null = null;
  fail: string | null = null;
  switchBranch = false;
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    sink.onSession(ctx.resumeToken ?? 'fresh');
    const file = sessionFilePath(ctx.workspaceDir, ctx.resumeToken!, CFG);
    const t = new Date().toISOString();
    fs.appendFileSync(file,
      J({ type: 'user', uuid: 'vps-u1', parentUuid: 'pc-a2', sessionId: ctx.resumeToken, cwd: ctx.workspaceDir, timestamp: t, message: { role: 'user', content: ctx.input } }) + '\n' +
      J({ type: 'assistant', uuid: 'vps-a1', parentUuid: 'vps-u1', sessionId: ctx.resumeToken, cwd: ctx.workspaceDir, timestamp: t, message: { role: 'assistant', model: ctx.model, usage: { input_tokens: 10, cache_read_input_tokens: 5000 }, content: [
        { type: 'text', text: 'Editing now' },
        { type: 'tool_use', id: 'vps-t1', name: 'Write', input: { file_path: path.join(ctx.workspaceDir, 'made-on-vps.txt'), content: 'x' } },
      ] } }) + '\n' +
      J({ type: 'user', uuid: 'vps-u2', parentUuid: 'vps-a1', sessionId: ctx.resumeToken, cwd: ctx.workspaceDir, timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'vps-t1', content: 'ok' }] } }) + '\n');
    fs.writeFileSync(path.join(ctx.workspaceDir, 'made-on-vps.txt'), 'hello from the vps\n');
    if (this.switchBranch) git(ctx.workspaceDir, 'checkout', '-q', '-b', 'sneaky');
    sink.onText('All done on the VPS.');
    if (this.gate) await this.gate;
    return { ok: !this.fail, error: this.fail ?? undefined, costUsd: 0.01, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}
const stub = new StubClaude();

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    dmFilesDir: (id) => path.join(tmp, 'bots', id, 'files'),
    pcRunner: { file: path.join(tmp, 'pc-runner.json'), pollMs: 5 },
    sessionMoves: { dir: path.join(tmp, 'pc-moves'), configDir: () => CFG, feedEveryMs: 20, uploadMaxBytes: 8192 },
  });
  (hub.runner as unknown as { providers: unknown }).providers = { get: () => stub, active: () => stub };
  port = await hub.listen();
  vi.spyOn(settings, 'get').mockImplementation(() => ({ ...realGet(), personaBotId: '' }));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  stub.gate = null;
  stub.fail = null;
  stub.switchBranch = false;
  await request('DELETE', '/api/pc-runner');
});

function request(method: string, p: string, opts: { body?: unknown; raw?: Buffer; token?: string | null; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, ...(opts.raw ? {} : { 'content-type': 'application/json' }), ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.cookie) headers.cookie = opts.cookie;
  const payload = opts.raw ?? (opts.body === undefined ? undefined : Buffer.from(J(opts.body)));
  if (payload) headers['content-length'] = String(payload.length);
  return new Promise<{ status: number; json: any; raw: Buffer; headers: http.IncomingHttpHeaders; cookie: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json: unknown = null;
        try { json = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, raw, headers: res.headers, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function sessionCookie(): Promise<string> {
  if (!(await request('GET', '/api/auth/status', { token: null })).json.passwordSet) {
    expect((await request('POST', '/api/auth/password', { body: { password: PASSWORD } })).status).toBe(200);
  }
  const r = await request('POST', '/api/auth/login', { token: null, body: { password: PASSWORD } });
  expect(r.status).toBe(200);
  return r.cookie;
}
async function pair(): Promise<string> {
  const r = await request('POST', '/api/pc-runner/token', { body: {} });
  const t = r.json.token as string;
  expect((await request('POST', '/api/pc-runner/heartbeat', { token: t, body: { folders: ['site'] } })).status).toBe(200);
  return t;
}
async function claim(t: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const r = await request('GET', '/api/pc-runner/jobs/next', { token: t });
    if (r.status === 200) return r.json;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('no job served');
}

let n = 0;
const REMOTE_APP = 'git@github.com:acme/app.git';
const PC_ROOT = 'C:\\Work\\lib';
const sid = () => 'abcd' + String(1000 + n++) + '-1111-2222-3333-444455556666';
const SID8 = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();

interface World { remote: string; slug: string; room: Room; bot: Bot; sid: string; runner: string; cookie: string; vps: string; wt: string; branch: string }

/** A project with a bundle-sync repo and a room, a mirrored session in it, a paired runner and a signed-in owner. */
async function world(o: { sync?: 'bundle' | 'wip-branch'; client?: boolean; link?: boolean; extra?: (remote: string) => unknown[] } = {}): Promise<World> {
  const bot = hub.repos.createBot({ name: 'Mover' + n, handle: 'mover-' + n, title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read', 'Write', 'Bash'], maxBudgetUsd: 1 });
  const made = hub.projects.create({ name: 'Move Proj ' + n++, memberIds: [bot.id] });
  const room = hub.repos.createRoom({ kind: 'group', name: 'move room ' + n, memberIds: [bot.id], coordinatorBotId: null }) as Room;
  hub.projects.setRoom(made.project.slug, room.id);
  const cookie = await sessionCookie();
  const remote = 'https://github.com/acme/lib' + n++;
  const put = await request('PUT', '/api/projects/' + made.project.slug + '/repos', {
    body: { repos: [{ name: 'lib', remote: o.link === false ? REMOTE_APP + n++ : remote, sync: o.sync ?? 'bundle', client: o.client ?? false }, ...(o.extra?.(remote) ?? [])] },
  });
  expect(put.status).toBe(200);
  const id = sid();
  hub.pcSessions.upsert(id, { machine: 'pc', projectDir: 'C--Work-lib', cwd: PC_ROOT + '\\packages\\hub', title: 'Fix the thing', repo: { name: 'lib', remote, branch: 'feature', head: null }, firstAt: 1000, lastAt: Date.now() });
  const runner = await pair();
  const vps = path.join(hub.projects.dirOf(made.project.slug), 'repos', 'lib');
  const branch = 'wip/pc/' + SID8(id);
  return { remote, slug: made.project.slug, room, bot, sid: id, runner, cookie, vps, wt: vps + '-wt' + path.sep + SID8(id), branch };
}

/** The PC's session file: lines as the CLI writes them. */
function pcSessionFile(w: World): Buffer {
  const lines = [
    J({ type: 'user', uuid: 'pc-u1', sessionId: w.sid, cwd: PC_ROOT + '\\packages\\hub', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'fix ' + PC_ROOT + '\\a.txt' } }),
    J({ type: 'assistant', uuid: 'pc-a1', parentUuid: 'pc-u1', sessionId: w.sid, cwd: PC_ROOT, timestamp: '2026-11-01T10:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet-5', content: [
      { type: 'text', text: 'Reading it' }, { type: 'tool_use', id: 'pc-t1', name: 'Read', input: { file_path: PC_ROOT + '\\a.txt' } },
    ] } }),
    J({ type: 'user', uuid: 'pc-u2', parentUuid: 'pc-a1', sessionId: w.sid, cwd: PC_ROOT, timestamp: '2026-11-01T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pc-t1', content: 'hello' }] } }),
    J({ type: 'assistant', uuid: 'pc-a2', parentUuid: 'pc-u2', sessionId: w.sid, cwd: PC_ROOT, timestamp: '2026-11-01T10:00:03.000Z', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 3, cache_read_input_tokens: 2000 }, content: [{ type: 'text', text: 'Done reading' }] } }),
  ];
  return Buffer.from(lines.join('\n') + '\n');
}

/** A one-commit "PC" repo, as a bundle of HEAD. */
function makeBundle(files: Record<string, string> = { 'a.txt': 'hello\n' }) {
  const src = fs.mkdtempSync(path.join(tmp, 'src-'));
  git(src, 'init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), c);
  }
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'wip: snapshot');
  const out = path.join(src, '..', path.basename(src) + '.bundle');
  git(src, 'bundle', 'create', out, 'HEAD');
  const buf = fs.readFileSync(out);
  return { buf, commit: git(src, 'rev-parse', 'HEAD') };
}

const startJob = (w: World, body: Record<string, unknown>, opts: { cookie?: string | null; token?: string | null } = {}) =>
  request('POST', '/api/pc-runner/jobs', { token: opts.token === undefined ? null : opts.token, cookie: opts.cookie === undefined ? w.cookie : opts.cookie ?? undefined, body });
const upBundle = (w: World, jobId: string, buf: Buffer, repo: string | null = 'lib', o: { sha?: string; token?: string | null } = {}) =>
  request('POST', '/api/pc-runner/jobs/' + jobId + '/bundle' + (repo ? '?repo=' + repo : ''), {
    raw: buf, token: o.token === undefined ? w.runner : o.token,
    headers: { 'content-type': 'application/octet-stream', 'x-bundle-sha256': o.sha ?? sha(buf) },
  });
const upSession = (w: World, jobId: string, buf: Buffer, o: { sha?: string; token?: string | null } = {}) =>
  request('POST', '/api/pc-runner/jobs/' + jobId + '/session', {
    raw: buf, token: o.token === undefined ? w.runner : o.token,
    headers: { 'content-type': 'application/octet-stream', 'x-session-sha256': o.sha ?? sha(buf) },
  });
const result = (w: World, jobId: string, body: unknown) => request('POST', '/api/pc-runner/jobs/' + jobId + '/result', { token: w.runner, body });
const summary = async (w: World) => (await request('GET', '/api/pc-sessions/' + w.sid)).json;
const mirrorOffset = (w: World) => hub.pcSessions.syncState()[w.sid]?.offset;

/** Everything the PC does for a move, up to (not including) the result. */
async function pcMovesUp(w: World, file = pcSessionFile(w)) {
  const made = await startJob(w, { mode: 'move', sessionId: w.sid });
  expect(made.status).toBe(200);
  const next = await claim(w.runner);
  expect(next.id).toBe(made.json.id);
  await request('POST', '/api/pc-runner/jobs/' + next.id + '/start', { token: w.runner, body: {} });
  const b = makeBundle();
  expect((await upBundle(w, next.id, b.buf)).status).toBe(200);
  expect((await upSession(w, next.id, file)).status).toBe(200);
  return { job: next, bundle: b, file };
}
const moveResult = (w: World, b: { commit: string }, file: Buffer, over: Record<string, unknown> = {}) => ({
  ok: true, output: 'moved', move: { repos: [{ repo: 'lib', commit: b.commit, branch: w.branch, toplevel: PC_ROOT }], sessionBytes: file.length, ...over },
});
async function moved(w: World) {
  const up = await pcMovesUp(w);
  const r = await result(w, up.job.id, moveResult(w, up.bundle, up.file));
  expect(r.status).toBe(200);
  return up;
}
const textOf = (o: ToolOutput) => o.content.map((c) => ('text' in c ? c.text : '')).join('');

// ---------------------------------------------------------------------------------------------------
describe('starting a move', () => {
  it('queues a move job that names the room and every repo, and marks the session moving', async () => {
    const w = await world();
    const made = await startJob(w, { mode: 'move', sessionId: w.sid });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ mode: 'move', sessionId: w.sid, status: 'queued', move: { room: w.room.id, title: 'Fix the thing', repos: [{ project: w.slug, repo: 'lib', mode: 'bundle', remote: w.remote }] } });
    expect((await summary(w)).move).toMatchObject({ state: 'moving', room: w.room.id, project: w.slug, turnRunning: false, repos: [{ repo: 'lib', branch: w.branch }] });
    const next = await claim(w.runner);
    expect(next).toMatchObject({ mode: 'move', move: { room: w.room.id, repos: [{ repo: 'lib' }] } });
  });

  it('is refused with the hub token and the runner token, and a second move is a 409', async () => {
    const w = await world();
    const hubTok = await startJob(w, { mode: 'move', sessionId: w.sid }, { cookie: null, token: TOKEN });
    expect(hubTok.status).toBe(403);
    expect(hubTok.json.signInRequired).toBe(true);
    expect((await startJob(w, { mode: 'move', sessionId: w.sid }, { cookie: null, token: w.runner })).status).toBe(403);
    expect(hub.sessionMoves.get(w.sid)).toBeNull();
    expect((await startJob(w, { mode: 'move', sessionId: w.sid })).status).toBe(200);
    const again = await startJob(w, { mode: 'move', sessionId: w.sid });
    expect(again.status).toBe(409);
  });

  it('refuses a client repo, a repo that is not bundle sync, a session with no linked repo and an unknown session', async () => {
    const client = await world({ client: true });
    const c = await startJob(client, { mode: 'move', sessionId: client.sid });
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/client repo/);

    const wip = await world({ sync: 'wip-branch' });
    const wr = await startJob(wip, { mode: 'move', sessionId: wip.sid });
    expect(wr.status).toBe(400);
    expect(wr.json.error).toMatch(/bundle/);

    const unlinked = await world({ link: false });
    const u = await startJob(unlinked, { mode: 'move', sessionId: unlinked.sid });
    expect(u.status).toBe(400);
    expect(u.json.error).toMatch(/not linked to any project repo/);

    const w = await world();
    expect((await startJob(w, { mode: 'move', sessionId: 'no-such-session' })).status).toBe(400);
    // One bad repo among good ones refuses the whole move.
    const mixed = await world({ extra: (r) => [{ name: 'lib2', remote: r, sync: 'wip-branch' }] });
    const mx = await startJob(mixed, { mode: 'move', sessionId: mixed.sid });
    expect(mx.status).toBe(400);
    expect(mx.json.error).toMatch(/lib2.*bundle/);
    expect(hub.sessionMoves.get(mixed.sid)).toBeNull();
    for (const x of [client, wip, unlinked]) expect(hub.sessionMoves.get(x.sid)).toBeNull();
  });

  it('takes a room only from the project\'s own room or a group chat with all its bots', async () => {
    const w = await world();
    const stranger = hub.repos.createRoom({ kind: 'group', name: 'strangers', memberIds: [], coordinatorBotId: null }) as Room;
    const bad = await startJob(w, { mode: 'move', sessionId: w.sid, room: stranger.id });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/not one of the project/);
    const other = hub.repos.createBot({ name: 'Other', handle: 'other-' + n++, title: '', description: '', avatar: '', model: 'm', allowedTools: ['Read'], maxBudgetUsd: 1 });
    const wide = hub.repos.createRoom({ kind: 'group', name: 'wide', memberIds: [w.bot.id, other.id], coordinatorBotId: null }) as Room;
    const ok = await startJob(w, { mode: 'move', sessionId: w.sid, room: wide.id });
    expect(ok.status).toBe(200);
    expect(ok.json.move.room).toBe(wide.id);
    const dm = hub.repos.createRoom({ kind: 'dm', name: 'dm', memberIds: [w.bot.id], coordinatorBotId: null }) as Room;
    const w2 = await world();
    expect((await startJob(w2, { mode: 'move', sessionId: w2.sid, room: dm.id })).status).toBe(400);
  });

  it('a project without a room cannot take a move', async () => {
    const w = await world();
    hub.projects.setRoom(w.slug, null);
    hub.projects.setMembers(w.slug, []);
    const r = await startJob(w, { mode: 'move', sessionId: w.sid });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/no room/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the uploads of a move', () => {
  it('refuses a bundle without ?repo=, for another repo, a wrong hash, from a non-runner, and twice', async () => {
    const w = await world();
    const made = await startJob(w, { mode: 'move', sessionId: w.sid });
    const job = await claim(w.runner);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: w.runner, body: {} });
    const b = makeBundle();
    expect((await upBundle(w, job.id, b.buf, null)).status).toBe(400);
    expect((await upBundle(w, job.id, b.buf, 'nope')).status).toBe(400);
    expect((await upBundle(w, job.id, b.buf, 'lib', { sha: '0'.repeat(64) })).status).toBe(400);
    expect((await upBundle(w, job.id, b.buf, 'lib', { token: TOKEN })).status).toBe(403);
    expect((await upBundle(w, job.id, b.buf, 'lib', { token: null })).status).toBe(401);
    expect(fs.existsSync(path.join(w.vps, '.git'))).toBe(false);
    expect((await upBundle(w, job.id, b.buf)).status).toBe(200);
    expect(git(w.vps, 'rev-parse', w.branch)).toBe(b.commit);
    expect((await upBundle(w, job.id, b.buf)).status).toBe(409);
    expect(made.status).toBe(200);
  });

  it('keeps the P5 sync upload working without ?repo=', () => {
    expect(runnerMayAccess('POST', '/api/pc-runner/jobs/abc/bundle')).toBe(true);
    expect(runnerMayAccess('POST', '/api/pc-runner/jobs/abc/session')).toBe(true);
    expect(runnerMayAccess('GET', '/api/pc-runner/jobs/abc/session')).toBe(true);
    expect(runnerMayAccess('GET', '/api/pc-runner/jobs/abc/bundle')).toBe(true);
    expect(runnerMayAccess('GET', '/api/cc/session-state')).toBe(true);
    expect(runnerMayAccess('PUT', '/api/pc-runner/jobs/abc/session')).toBe(false);
    expect(runnerMayAccess('DELETE', '/api/pc-runner/jobs/abc/session')).toBe(false);
  });

  it('refuses the session file before the bundles, with a wrong hash, over the cap, for another session, from a non-runner, and twice', async () => {
    const w = await world();
    const made = await startJob(w, { mode: 'move', sessionId: w.sid });
    const job = await claim(w.runner);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: w.runner, body: {} });
    const file = pcSessionFile(w);
    expect((await upSession(w, job.id, file)).status).toBe(409);
    expect((await upBundle(w, job.id, makeBundle().buf)).status).toBe(200);
    const wrong = await upSession(w, job.id, file, { sha: '0'.repeat(64) });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toMatch(/x-session-sha256/);
    expect((await upSession(w, job.id, file, { token: TOKEN })).status).toBe(403);
    expect((await upSession(w, job.id, file, { token: null })).status).toBe(401);
    expect((await upSession(w, job.id, Buffer.alloc(8192 + 904, 65))).status).toBe(413);
    // Another session's file.
    const foreign = Buffer.from(J({ type: 'user', sessionId: 'ffffffff-0000-0000-0000-000000000000', cwd: PC_ROOT, message: { content: 'x' } }) + '\n');
    const f = await upSession(w, job.id, foreign);
    expect(f.status).toBe(400);
    expect(f.json.error).toMatch(/another session/);
    expect((await upSession(w, job.id, Buffer.from('{"sessionId": oops\n'))).status).toBe(400);
    expect(fs.existsSync(hub.sessionMoves.uploadPath(job.id))).toBe(false);
    expect((await upSession(w, job.id, file)).status).toBe(200);
    expect((await upSession(w, job.id, file)).status).toBe(409);
    expect(made.status).toBe(200);
  });

  it('refuses an upload for a job that is not a move, or one that is finished', async () => {
    const w = await world();
    const sync = await request('POST', '/api/pc-runner/jobs', { token: null, cookie: w.cookie, body: { mode: 'sync', sessionId: w.sid, project: w.slug, repo: 'lib' } });
    expect(sync.status).toBe(200);
    const sj = await claim(w.runner);
    await request('POST', '/api/pc-runner/jobs/' + sj.id + '/start', { token: w.runner, body: {} });
    expect((await upSession(w, sj.id, pcSessionFile(w))).status).toBe(409);
    await result(w, sj.id, { ok: false, output: 'x' });
    expect((await upSession(w, 'nosuchjob', pcSessionFile(w))).status).toBe(404);
    const w2 = await world();
    await startJob(w2, { mode: 'move', sessionId: w2.sid });
    const mj = await claim(w2.runner);
    await request('POST', '/api/pc-runner/jobs/' + mj.id + '/start', { token: w2.runner, body: {} });
    await result(w2, mj.id, { ok: false, output: 'gave up' });
    expect((await upBundle(w2, mj.id, makeBundle().buf)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the move itself', () => {
  it('imports the bundle, builds the worktree, rewrites the session and files it where the VPS CLI looks; state moving -> on-vps', async () => {
    const w = await world();
    expect(fs.existsSync(path.join(w.vps, '.git'))).toBe(false);
    const up = await pcMovesUp(w);
    expect((await summary(w)).move.state).toBe('moving');
    const r = await result(w, up.job.id, moveResult(w, up.bundle, up.file));
    expect(r.status).toBe(200);
    expect((await request('GET', '/api/pc-runner/jobs/' + up.job.id)).json).toMatchObject({ status: 'done', moveResult: { repos: [{ repo: 'lib', commit: up.bundle.commit, branch: w.branch }] } });

    const s = await summary(w);
    expect(s.move).toMatchObject({ state: 'on-vps', room: w.room.id, worktree: SID8(w.sid), turnRunning: false });
    expect(JSON.stringify(s.move)).not.toContain(tmp.replace(/\\/g, '\\\\'));
    // The worktree is the wip branch, checked out, in <vps>-wt/<sid8>.
    expect(git(w.wt, 'symbolic-ref', 'HEAD')).toBe('refs/heads/' + w.branch);
    expect(fs.readFileSync(path.join(w.wt, 'a.txt'), 'utf8')).toBe('hello\n');
    // The file is where the CLI looks for that cwd, with the PC root swapped for the worktree and nothing else changed.
    const target = sessionFilePath(w.wt, w.sid, CFG);
    const text = fs.readFileSync(target, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].cwd).toBe(w.wt + '\\packages\\hub'.replace(/\\/g, path.sep));
    expect(lines[1].message.content[1].input.file_path).toBe(path.join(w.wt, 'a.txt'));
    expect(lines[0].message.content).toBe('fix ' + PC_ROOT + '\\a.txt');
    expect(lines[2].message.content[0].content).toBe('hello');
    // The mirror carries on from the file the PC had, and the move left no upload behind.
    expect(mirrorOffset(w)).toBe(up.file.length);
    expect(fs.existsSync(hub.sessionMoves.uploadPath(up.job.id))).toBe(false);
    // The room was told.
    expect(hub.repos.listMessages(w.room.id, { limit: 20 }).some((m) => m.kind === 'system' && /moved to the VPS/.test(m.text ?? ''))).toBe(true);
    // The PC's own appends are dropped while it is there.
    const drop = await request('POST', '/api/pc-sessions/' + w.sid + '/entries', {
      token: w.runner, body: { from: up.file.length, to: up.file.length + 50, entries: [{ uuid: 'late-pc', at: 5, kind: 'user', text: 'typed on the pc' }] },
    });
    expect(drop.json).toMatchObject({ ok: true, stored: 0, onVps: true, offset: up.file.length + 50 });
    expect(hub.pcSessions.entries(w.sid)!.entries.some((e) => e.uuid === 'late-pc')).toBe(false);
  });

  it('fails the job, and leaves the session where it was, when the PC reports a result that does not match', async () => {
    const w = await world();
    const up = await pcMovesUp(w);
    const bad = await result(w, up.job.id, moveResult(w, up.bundle, up.file, { repos: [{ repo: 'other', commit: up.bundle.commit, branch: w.branch }] }));
    expect(bad.status).toBe(200);
    const j = (await request('GET', '/api/pc-runner/jobs/' + up.job.id)).json;
    expect(j.status).toBe('failed');
    expect(j.output).toMatch(/could not finish the move/);
    expect(hub.sessionMoves.get(w.sid)).toBeNull();
    expect(fs.existsSync(w.wt)).toBe(false);
    expect((await summary(w)).move).toBeNull();
    // Free to try again.
    expect((await startJob(w, { mode: 'move', sessionId: w.sid })).status).toBe(200);
  });

  it('drops the move when the PC refuses it locally', async () => {
    const w = await world();
    await startJob(w, { mode: 'move', sessionId: w.sid });
    const job = await claim(w.runner);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: w.runner, body: {} });
    await result(w, job.id, { ok: false, refusedLocally: true, output: 'owner said no' });
    expect((await request('GET', '/api/pc-runner/jobs/' + job.id)).json.status).toBe('refused');
    expect(hub.sessionMoves.get(w.sid)).toBeNull();
  });

  it('needs a move object for a successful move', async () => {
    const w = await world();
    const up = await pcMovesUp(w);
    expect((await result(w, up.job.id, { ok: true, output: 'x' })).status).toBe(400);
    expect((await result(w, up.job.id, { ok: true, output: 'x', move: { repos: [], sessionBytes: 1 } })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the lock', () => {
  it('refuses resume and sync jobs for a session that is moving or on the VPS, and runner resume jobs say onVps', async () => {
    const w = await world();
    await startJob(w, { mode: 'move', sessionId: w.sid });
    const resume = await startJob(w, { mode: 'resume', sessionId: w.sid, prompt: 'go on' });
    expect(resume.status).toBe(409);
    expect(resume.json.onVps).toBe(true);
    expect((await startJob(w, { mode: 'sync', sessionId: w.sid, project: w.slug, repo: 'lib' })).status).toBe(409);
    expect(hub.pcRunner.list(50).filter((j) => j.sessionId === w.sid && (j.mode === 'resume' || j.mode === 'sync'))).toEqual([]);
    // A resume that was already queued when the session moved still reaches the runner marked onVps, so it refuses it.
    for (const j of hub.pcRunner.list(50)) hub.pcRunner.cancel(j.id, 'test');
    const other = await world();
    hub.repos.db.run("INSERT INTO pc_session_moves (session_id, state, repos_json, moved_at) VALUES (?, 'on-vps', '[]', 1)", other.sid);
    const q = hub.pcRunner.create({ mode: 'resume', sessionId: other.sid, origin: 'owner', prompt: 'go on', folder: null });
    hub.pcRunner.approve(q.id);
    const served = await claim(other.runner);
    expect(served).toMatchObject({ mode: 'resume', onVps: true });
    const free = await world();
    const q2 = hub.pcRunner.create({ mode: 'resume', sessionId: free.sid, origin: 'owner', prompt: 'again', folder: null });
    hub.pcRunner.approve(q2.id);
    hub.pcRunner.cancel(q.id, 'test');
    expect((await claim(free.runner)).onVps).toBeUndefined();
  });

  it('refuses a resume from a bot too, and tells the MCP server through /api/cc', async () => {
    const w = await world();
    await moved(w);
    expect(hub.sessionMoves.locked(w.sid)).toBe(true);
    const st = await request('GET', '/api/cc/session-state?sessionId=' + w.sid, { token: w.runner });
    expect(st.json).toEqual({ state: 'on-vps' });
    expect((await request('GET', '/api/cc/session-state?sessionId=ffffffff-0000', { token: w.runner })).json).toEqual({ state: 'local' });
    expect((await request('GET', '/api/cc/session-state?sessionId=' + w.sid)).status).toBe(403);
    const hdr = await request('GET', '/api/cc/rooms', { token: w.runner, headers: { 'x-cc-session': w.sid } });
    expect(hdr.headers['x-cc-session-state']).toBe('on-vps');
    expect((await request('GET', '/api/cc/rooms', { token: w.runner })).headers['x-cc-session-state']).toBeUndefined();
    expect((await request('GET', '/api/cc/session', { token: w.runner, headers: { 'x-cc-session': w.sid } })).json).toEqual({ session: { state: 'on-vps' } });
    const sync = await request('GET', '/api/pc-sessions/sync', { token: w.runner });
    expect(sync.json.sessions[w.sid].onVps).toBe(true);
    const put = await request('PUT', '/api/pc-sessions/' + w.sid, { token: w.runner, body: { machine: 'pc', projectDir: 'x', cwd: PC_ROOT, repo: { name: 'lib', remote: w.remote, branch: null, head: null }, title: null, firstAt: 1, lastAt: 2 } });
    expect(put.json.onVps).toBe(true);
    const ctx: ToolCtx = {
      bot: w.bot, room: w.room, members: [w.bot], turnId: 't', hop: 0, causeId: 'c', repos: hub.repos, memory: new MemoryService(), skills: new SkillService(hub.repos),
      dispatchFromBot: () => [], setState: () => undefined, models: [], pcRunner: hub.pcRunner, pcSessions: hub.pcSessions, projects: hub.projects, sessionMoves: hub.sessionMoves,
      confirmFleetChange: async () => ({ allowed: true, message: 'ok' }),
    };
    const out = (await createHubTools(ctx).find((t) => t.name === 'run_on_pc')!.handler({ mode: 'resume', session_id: w.sid, prompt: 'go on' })) as ToolOutput;
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/on the VPS/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('a turn on the VPS', () => {
  const cont = (w: World, prompt = 'carry on', o: { cookie?: string | null; token?: string | null } = {}) =>
    request('POST', '/api/pc-sessions/' + w.sid + '/continue', { token: o.token === undefined ? null : o.token, cookie: o.cookie === undefined ? w.cookie : o.cookie ?? undefined, body: { prompt } });

  it('resumes the right session in the worktree on the offload model, feeds new lines to the mirror as vps, commits to the wip branch only, and posts to the room', async () => {
    const w = await world();
    await moved(w);
    const mainBefore = git(w.vps, 'for-each-ref', '--format=%(refname)=%(objectname)', 'refs/heads');
    stub.seen = [];
    const before = hub.pcSessions.entries(w.sid)!.entries.length;
    const r = await cont(w, 'finish the thing');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
    await hub.sessionMoves.idle(w.sid);

    expect(stub.seen).toHaveLength(1);
    const ctx = stub.seen[0];
    expect(ctx.resumeToken).toBe(w.sid);
    expect(ctx.workspaceDir).toBe(w.wt);
    expect(ctx.model).toBe('claude-sonnet-5-5');
    expect(ctx.input).toBe('finish the thing');
    expect(ctx.bot.id).toBe(w.bot.id);
    expect(ctx.room.id).toBe(w.room.id);
    expect(ctx.tools.map((t) => t.name)).not.toContain('run_on_pc');
    // git push is refused in that turn, with approvals bypassed or not.
    expect(ctx.shipGuard!('git push origin main', w.wt)).toBe(OFFLOAD_PUSH_DENIED);
    expect(ctx.shipGuard!('cd x && git -C y push', w.wt)).toBe(OFFLOAD_PUSH_DENIED);
    expect(ctx.shipGuard!('git status', w.wt)).toBeNull();

    // New lines are in the mirror as the VPS, in the same conversation, once each.
    const entries = hub.pcSessions.entries(w.sid)!.entries;
    const fresh = entries.slice(before);
    expect(fresh.map((e) => e.uuid)).toEqual(['vps-u1', 'vps-a1', 'vps-a1:1', 'vps-u2']);
    expect(fresh.every((e) => e.machine === 'vps')).toBe(true);
    expect(fresh.find((e) => e.kind === 'tool_result')).toMatchObject({ tool: 'Write', text: 'ok' });
    expect(entries.slice(0, before).every((e) => !e.machine)).toBe(true);
    await hub.sessionMoves.feed(w.sid);
    expect(hub.pcSessions.entries(w.sid)!.entries).toHaveLength(entries.length);

    // The change is committed on the wip branch, as the offload identity, and no other branch moved.
    expect(git(w.wt, 'log', '-1', '--format=%an|%s')).toMatch(/^PocketRocket offload mover-\d+\|VPS turn: finish the thing$/);
    expect(git(w.wt, 'show', 'HEAD:made-on-vps.txt')).toBe('hello from the vps');
    const after = git(w.vps, 'for-each-ref', '--format=%(refname)=%(objectname)', 'refs/heads').split('\n');
    const changed = after.filter((l) => !mainBefore.split('\n').includes(l));
    expect(changed).toHaveLength(1);
    expect(changed[0].startsWith('refs/heads/' + w.branch + '=')).toBe(true);
    expect(git(w.wt, 'status', '--porcelain')).toBe('');

    const posts = hub.repos.listMessages(w.room.id, { limit: 20 }).filter((m) => m.kind === 'system').map((m) => m.text ?? '');
    expect(posts.some((t) => t.startsWith('VPS turn finished: All done on the VPS.') && /committed to/.test(t))).toBe(true);
    expect((await summary(w)).move).toMatchObject({ state: 'on-vps', turnRunning: false });
  });

  it('allows one turn at a time (409), and refuses a pull while it runs', async () => {
    const w = await world();
    await moved(w);
    let release!: () => void;
    stub.gate = new Promise<void>((res) => { release = res; });
    expect((await cont(w)).status).toBe(200);
    expect((await summary(w)).move.turnRunning).toBe(true);
    const second = await cont(w, 'again');
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/One at a time/);
    const pull = await startJob(w, { mode: 'pull', sessionId: w.sid });
    expect(pull.status).toBe(409);
    expect(hub.sessionMoves.get(w.sid)!.state).toBe('on-vps');
    release();
    await hub.sessionMoves.idle(w.sid);
    expect((await summary(w)).move.turnRunning).toBe(false);
    expect((await cont(w, 'third')).status).toBe(200);
    await hub.sessionMoves.idle(w.sid);
  });

  it('needs a signed-in browser, a session that is on the VPS, and refuses past 120k tokens of context', async () => {
    const w = await world();
    expect((await cont(w)).status).toBe(409); // never moved
    await moved(w);
    const hubTok = await cont(w, 'x', { cookie: null, token: TOKEN });
    expect(hubTok.status).toBe(403);
    expect(hubTok.json.signInRequired).toBe(true);
    expect((await cont(w, 'x', { cookie: null, token: w.runner })).status).toBe(403);
    expect((await request('POST', '/api/pc-sessions/' + w.sid + '/continue', { token: null, cookie: w.cookie, body: { prompt: '' } })).status).toBe(400);
    expect(stub.seen.filter((c) => c.resumeToken === w.sid && c.input === 'x')).toEqual([]);
    // A big context.
    const file = sessionFilePath(w.wt, w.sid, CFG);
    fs.appendFileSync(file, J({ type: 'assistant', uuid: 'big', sessionId: w.sid, cwd: w.wt, message: { role: 'assistant', content: [{ type: 'text', text: 'big' }], usage: { input_tokens: 1000, cache_read_input_tokens: 130_000, cache_creation_input_tokens: 500 } } }) + '\n');
    const big = await cont(w, 'more');
    expect(big.status).toBe(409);
    expect(big.json.error).toMatch(/Pull it back to your PC, or start a fresh session/);
    expect(big.json.error).toMatch(/summary/);
  });

  it('reports a failed turn in the room and still commits what it changed', async () => {
    const w = await world();
    await moved(w);
    stub.fail = 'error_during_execution: boom';
    expect((await cont(w, 'break it')).status).toBe(200);
    await hub.sessionMoves.idle(w.sid);
    const posts = hub.repos.listMessages(w.room.id, { limit: 30 }).filter((m) => m.kind === 'system').map((m) => m.text ?? '');
    expect(posts.some((t) => t.startsWith('VPS turn failed: error_during_execution: boom'))).toBe(true);
    expect(git(w.wt, 'log', '-1', '--format=%s')).toMatch(/^VPS turn: break it/);
  });

  it('commits nothing when the turn left the wip branch, and says so', async () => {
    const w = await world();
    await moved(w);
    stub.switchBranch = true;
    const tipBefore = git(w.vps, 'rev-parse', w.branch);
    expect((await cont(w, 'switch')).status).toBe(200);
    await hub.sessionMoves.idle(w.sid);
    expect(git(w.vps, 'rev-parse', w.branch)).toBe(tipBefore);
    const posts = hub.repos.listMessages(w.room.id, { limit: 30 }).filter((m) => m.kind === 'system').map((m) => m.text ?? '');
    expect(posts.some((t) => /no longer on/.test(t))).toBe(true);
  });

  it('spots every spelling of git push and nothing else', () => {
    for (const c of ['git push', 'git push origin HEAD', 'git -C ../x push', 'git -c a=b push --force', 'cd a && git push', 'echo hi; git push', 'GIT_X=1 git push']) expect(pushesToRemote(c), c).toBe(true);
    for (const c of ['git status', 'git log --oneline', 'echo pushing', 'npm run push-docs', 'git commit -m "push it"']) expect(pushesToRemote(c), c).toBe(c === 'git commit -m "push it"');
  });
});

describe('VPS turns and the bot sandbox (P7)', () => {
  it('refuses a VPS turn while the sandbox is on, since its private config dir would hide the transcript', async () => {
    const w = await world();
    await moved(w);
    const spy = vi.spyOn(settings, 'get').mockImplementation(() => ({ ...realGet(), personaBotId: '', sandbox: 'on' }));
    try {
      const r = await request('POST', '/api/pc-sessions/' + w.sid + '/continue', { token: null, cookie: w.cookie, body: { prompt: 'x' } });
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/sandbox/);
    } finally {
      spy.mockImplementation(() => ({ ...realGet(), personaBotId: '' }));
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('pulling back', () => {
  it('walks moving -> on-vps -> pulling -> local, serves the inverse rewrite and a bundle of the wip branch, and ends with the offset at the pulled size', async () => {
    const w = await world();
    const up = await moved(w);
    expect((await summary(w)).move.state).toBe('on-vps');
    expect((await request('POST', '/api/pc-sessions/' + w.sid + '/continue', { token: null, cookie: w.cookie, body: { prompt: 'do it' } })).status).toBe(200);
    await hub.sessionMoves.idle(w.sid);
    const entriesBefore = hub.pcSessions.entries(w.sid)!.entries.map((e) => e.uuid);

    const made = await startJob(w, { mode: 'pull', sessionId: w.sid });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ mode: 'pull', status: 'queued', pull: { turns: 1, repos: [{ repo: 'lib', branch: w.branch, baseCommit: up.bundle.commit, mode: 'bundle' }] } });
    expect((await summary(w)).move.state).toBe('pulling');
    expect((await startJob(w, { mode: 'pull', sessionId: w.sid })).status).toBe(409);
    expect((await startJob(w, { mode: 'resume', sessionId: w.sid, prompt: 'x' })).status).toBe(409);
    expect((await request('POST', '/api/pc-sessions/' + w.sid + '/continue', { token: null, cookie: w.cookie, body: { prompt: 'x' } })).status).toBe(409);

    const next = await claim(w.runner);
    expect(next).toMatchObject({ id: made.json.id, mode: 'pull', sessionId: w.sid, pull: { turns: 1, repos: [{ repo: 'lib', branch: w.branch, baseCommit: up.bundle.commit }] } });
    await request('POST', '/api/pc-runner/jobs/' + next.id + '/start', { token: w.runner, body: {} });

    // The session comes back with the worktree swapped for the PC folder: the exact inverse of the move.
    const dl = await request('GET', '/api/pc-runner/jobs/' + next.id + '/session', { token: w.runner });
    expect(dl.status).toBe(200);
    expect(dl.headers['x-session-sha256']).toBe(sha(dl.raw));
    expect(dl.headers['content-length']).toBe(String(dl.raw.length));
    const lines = dl.raw.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(up.file.toString('utf8').trim().split('\n').length + 3);
    // The first four lines are byte-identical to what the PC uploaded.
    expect(dl.raw.subarray(0, up.file.length).equals(up.file)).toBe(true);
    const vpsLine = lines.find((l) => l.uuid === 'vps-a1');
    expect(vpsLine.cwd).toBe(PC_ROOT);
    expect(vpsLine.message.content[1].input.file_path).toBe(PC_ROOT + '\\made-on-vps.txt'.replace(/\\/g, '\\'));

    // And a bundle of the wip branch, with the VPS commit on it.
    const bundle = await request('GET', '/api/pc-runner/jobs/' + next.id + '/bundle?repo=lib', { token: w.runner });
    expect(bundle.status).toBe(200);
    expect(bundle.headers['x-bundle-sha256']).toBe(sha(bundle.raw));
    const bf = path.join(tmp, 'pulled.bundle');
    fs.writeFileSync(bf, bundle.raw);
    expect(git(w.vps, 'bundle', 'verify', bf)).toContain('complete history');
    expect(git(w.vps, 'bundle', 'list-heads', bf)).toContain('refs/heads/' + w.branch);
    expect(git(w.vps, 'bundle', 'list-heads', bf)).toContain(git(w.vps, 'rev-parse', w.branch));
    expect((await request('GET', '/api/pc-runner/jobs/' + next.id + '/bundle', { token: w.runner })).status).toBe(400);
    expect((await request('GET', '/api/pc-runner/jobs/' + next.id + '/bundle?repo=zzz', { token: w.runner })).status).toBe(400);
    // Nobody but the runner downloads.
    expect((await request('GET', '/api/pc-runner/jobs/' + next.id + '/session', { token: TOKEN })).status).toBe(403);
    expect((await request('GET', '/api/pc-runner/jobs/' + next.id + '/session', { token: null })).status).toBe(401);

    const done = await result(w, next.id, { ok: true, output: 'pulled', pull: { repos: [{ repo: 'lib', commit: git(w.vps, 'rev-parse', w.branch), applied: true }], sessionBytes: dl.raw.length } });
    expect(done.status).toBe(200);
    expect((await summary(w)).move).toMatchObject({ state: 'local', turnRunning: false });
    expect(hub.sessionMoves.get(w.sid)!.pulledAt).not.toBeNull();
    expect(hub.sessionMoves.locked(w.sid)).toBe(false);
    // The mirror continues from the end of the pulled file, and the VPS entries were not duplicated.
    expect(mirrorOffset(w)).toBe(dl.raw.length);
    expect(hub.pcSessions.entries(w.sid)!.entries.map((e) => e.uuid)).toEqual(entriesBefore);
    // The worktree and the VPS copy of the file are gone; the branch stays.
    expect(fs.existsSync(w.wt)).toBe(false);
    expect(fs.existsSync(sessionFilePath(w.wt, w.sid, CFG))).toBe(false);
    expect(git(w.vps, 'rev-parse', '--verify', w.branch)).toMatch(/^[0-9a-f]{40}$/);
    expect(git(w.vps, 'worktree', 'list')).not.toContain('-wt');
    expect(hub.repos.listMessages(w.room.id, { limit: 40 }).some((m) => /is back on your PC/.test(m.text ?? ''))).toBe(true);
    // Unlocked again: a resume is allowed, and so is another move.
    expect((await startJob(w, { mode: 'resume', sessionId: w.sid, prompt: 'carry on' })).status).toBe(200);
  });

  it('leaves the session on the VPS when the pull fails or is refused', async () => {
    const w = await world();
    await moved(w);
    await startJob(w, { mode: 'pull', sessionId: w.sid });
    const job = await claim(w.runner);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: w.runner, body: {} });
    await result(w, job.id, { ok: false, refusedLocally: true, output: 'not now' });
    expect(hub.sessionMoves.get(w.sid)!.state).toBe('on-vps');
    expect(fs.existsSync(w.wt)).toBe(true);
    // And a pull of a session that never moved is a 404.
    const other = await world();
    expect((await startJob(other, { mode: 'pull', sessionId: other.sid })).status).toBe(404);
  });

  it('commits what the VPS left uncommitted before the bundle is made', async () => {
    const w = await world();
    await moved(w);
    fs.writeFileSync(path.join(w.wt, 'left-over.txt'), 'uncommitted\n');
    await startJob(w, { mode: 'pull', sessionId: w.sid });
    expect(git(w.wt, 'show', 'HEAD:left-over.txt')).toBe('uncommitted');
    expect(git(w.wt, 'log', '-1', '--format=%s')).toBe('VPS work before pull-back');
  });

  it('refuses a pull result that does not list the job\'s repos, and lets the job fail', async () => {
    const w = await world();
    await moved(w);
    await startJob(w, { mode: 'pull', sessionId: w.sid });
    const job = await claim(w.runner);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: w.runner, body: {} });
    expect((await result(w, job.id, { ok: true, output: 'x' })).status).toBe(400);
    await result(w, job.id, { ok: true, output: 'x', pull: { repos: [{ repo: 'other', commit: 'abc1234', applied: false }], sessionBytes: 5 } });
    expect((await request('GET', '/api/pc-runner/jobs/' + job.id)).json.status).toBe('failed');
    expect(hub.sessionMoves.get(w.sid)!.state).toBe('on-vps');
  });

  it('refuses a pull download for a job that is not a pull', async () => {
    const w = await world();
    const made = await startJob(w, { mode: 'move', sessionId: w.sid });
    const job = await claim(w.runner);
    await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: w.runner, body: {} });
    expect((await request('GET', '/api/pc-runner/jobs/' + job.id + '/session', { token: w.runner })).status).toBe(409);
    expect(made.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('propose_move', () => {
  function ctxFor(w: World, answer: { allowed: boolean; message: string }) {
    const cards: any[] = [];
    const ctx: ToolCtx = {
      bot: w.bot, room: w.room, members: [w.bot], turnId: 't', hop: 0, causeId: 'c', repos: hub.repos, memory: new MemoryService(), skills: new SkillService(hub.repos),
      dispatchFromBot: () => [], setState: () => undefined, models: [], pcRunner: hub.pcRunner, pcSessions: hub.pcSessions, projects: hub.projects, sessionMoves: hub.sessionMoves,
      confirmFleetChange: async (a) => { cards.push(a); return answer; },
    };
    return { ctx, cards };
  }
  const call = async (ctx: ToolCtx, input: Record<string, unknown>) => (await createHubTools(ctx).find((t) => t.name === 'propose_move')!.handler(input)) as ToolOutput;

  it('raises a sign-in-only card and queues the move only when the owner says yes', async () => {
    const w = await world();
    const no = ctxFor(w, { allowed: false, message: 'declined in test' });
    const out = await call(no.ctx, { session_id: w.sid });
    expect(out.isError).toBe(true);
    expect(no.cards).toHaveLength(1);
    expect(no.cards[0]).toMatchObject({ tool: 'propose_move', evenUnderBypass: true, input: { action: 'move', session_id: w.sid, room: w.room.name } });
    expect(hub.sessionMoves.get(w.sid)).toBeNull();
    const yes = ctxFor(w, { allowed: true, message: 'ok' });
    const ok = await call(yes.ctx, { session_id: w.sid });
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toMatch(/queued/);
    expect(hub.sessionMoves.get(w.sid)!.state).toBe('moving');
    expect(hub.pcRunner.list(5).some((j) => j.mode === 'move' && j.sessionId === w.sid && j.origin === 'bot' && j.status === 'queued')).toBe(true);
  });

  it('applies the same refusals as the owner\'s button, before any card', async () => {
    const w = await world({ client: true });
    const c = ctxFor(w, { allowed: true, message: 'ok' });
    const out = await call(c.ctx, { session_id: w.sid });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/client repo/);
    expect(c.cards).toEqual([]);
    expect(hub.sessionMoves.get(w.sid)).toBeNull();
  });

  it('is not offered to a bot that is not on the project, and pulls only a session that is on the VPS', async () => {
    const w = await world();
    const stranger = hub.repos.createBot({ name: 'Str', handle: 'str-' + n++, title: '', description: '', avatar: '', model: 'm', allowedTools: ['Read'], maxBudgetUsd: 1 });
    const c = ctxFor({ ...w, bot: stranger }, { allowed: true, message: 'ok' });
    const out = await call(c.ctx, { session_id: w.sid });
    expect(out.isError).toBe(true);
    expect(c.cards).toEqual([]);
    const own = ctxFor(w, { allowed: true, message: 'ok' });
    const notThere = await call(own.ctx, { session_id: w.sid, action: 'pull' });
    expect(notThere.isError).toBe(true);
    expect(textOf(notThere)).toMatch(/not on the VPS/);
    await moved(w);
    const pulled = await call(own.ctx, { session_id: w.sid, action: 'pull' });
    expect(pulled.isError).toBeUndefined();
    expect(hub.sessionMoves.get(w.sid)!.state).toBe('pulling');
  });
});
