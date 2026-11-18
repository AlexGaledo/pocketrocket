import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Bot, Room } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { createHubTools, runOnPcTool, type ToolCtx } from '../agent/botTools.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { settings } from '../services/SettingsStore.js';
import { listAudit } from '../services/AuditLog.js';
import { deviceMayAccess, runnerMayAccess } from './guard.js';
import type { ToolOutput } from '../providers/types.js';

/**
 * Bridge P5 (hub half): the owner's repos.json endpoints, sessions mapped to repos, bots on a repo-linked project chat,
 * sync jobs (owner endpoint, run_on_pc mode sync, jobs/next payload, result) and the bundle upload with its hardened import.
 * Git runs against temp repos and a temp project folder only.
 */

vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'project-repos-test-hub-token';
const PASSWORD = 'project repos owner password';
const BUNDLE_CAP = 4096;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-prepos-'));
const realGet = settings.get.bind(settings);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let hub: Hub;
let port: number;
let personaId: string | null = null;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    dmFilesDir: (id) => path.join(tmp, 'bots', id, 'files'),
    pcRunner: { file: path.join(tmp, 'pc-runner.json'), pollMs: 5 },
    pcBundleMaxBytes: BUNDLE_CAP,
  });
  port = await hub.listen();
  vi.spyOn(settings, 'get').mockImplementation(() => ({ ...realGet(), personaBotId: personaId ?? '' }));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  await request('DELETE', '/api/pc-runner');
});

function request(method: string, p: string, opts: { body?: unknown; raw?: Buffer; token?: string | null; cookie?: string; headers?: Record<string, string>; chunked?: boolean } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, ...(opts.raw ? {} : { 'content-type': 'application/json' }), ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.cookie) headers.cookie = opts.cookie;
  const payload = opts.raw ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body)));
  if (payload && !opts.chunked) headers['content-length'] = String(payload.length);
  return new Promise<{ status: number; json: any; cookie: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] });
      });
    });
    req.on('error', reject);
    if (opts.chunked && payload) { req.write(payload); req.end(); } else req.end(payload);
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

async function pair(folders = ['site']): Promise<string> {
  const r = await request('POST', '/api/pc-runner/token', { body: {} });
  const t = r.json.token as string;
  expect((await request('POST', '/api/pc-runner/heartbeat', { token: t, body: { folders } })).status).toBe(200);
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
function mkBot(name = 'RB'): Bot {
  return hub.repos.createBot({ name: name + n, handle: name.toLowerCase() + '-' + n++, title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
}
const textOf = (o: ToolOutput) => o.content.map((c) => ('text' in c ? c.text : '')).join('');

const REMOTE_APP = 'git@github.com:acme/app.git';
const REMOTE_LIB = 'https://github.com/acme/lib';
const SID_APP = 'aaaaaaaa-1111-2222-3333-444455556666';
const SID_LIB = 'bbbbbbbb-1111-2222-3333-444455556666';
const SID_OTHER = 'cccccccc-1111-2222-3333-444455556666';
const SID_FOREIGN = 'dddddddd-1111-2222-3333-444455556666';
const SID_NAMEONLY = 'eeeeeeee-1111-2222-3333-444455556666';

function seedSession(id: string, repo: { name: string; remote: string | null } | null, title = 'Session ' + id.slice(0, 4)) {
  hub.pcSessions.upsert(id, {
    machine: 'pc', projectDir: 'C--Work', cwd: 'C:\\Work\\' + (repo?.name ?? 'x'), title,
    repo: repo ? { name: repo.name, remote: repo.remote, branch: 'feature', head: null } : null, firstAt: 1000, lastAt: Date.now(),
  });
  hub.pcSessions.appendEntries(id, 0, 10, [{ uuid: 'u-' + id, at: 1000, kind: 'user', text: 'hello from ' + id.slice(0, 4) }]);
}

async function putRepos(slug: string, repos: unknown[], opts: { token?: string | null; cookie?: string } = {}) {
  return request('PUT', '/api/projects/' + slug + '/repos', { body: { repos }, ...opts });
}

// ---------------------------------------------------------------------------------------------------
describe('GET and PUT /api/projects/:slug/repos', () => {
  it('lets the owner save and read the list, with defaults, an atomic file and an audit line', async () => {
    const { project } = hub.projects.create({ name: 'Api Proj' });
    const ok = await putRepos(project.slug, [{ name: 'app', remote: REMOTE_APP, sync: 'wip-branch', protected: ['staging'] }]);
    expect(ok.status).toBe(200);
    expect(ok.json.repos[0]).toMatchObject({ name: 'app', remote: REMOTE_APP, sync: 'wip-branch', protected: ['staging'], client: false, vps: 'repos/app' });
    const file = path.join(hub.projects.dirOf(project.slug), 'repos.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(ok.json);
    expect(fs.readdirSync(hub.projects.dirOf(project.slug)).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect((await request('GET', '/api/projects/' + project.slug + '/repos')).json).toEqual(ok.json);
    expect(listAudit(hub.repos.db, { limit: 20 }).some((a) => a.action === 'project.repos.saved' && a.target === project.slug)).toBe(true);
    expect((await request('GET', '/api/projects/no-such/repos')).status).toBe(404);
    expect((await putRepos('no-such', [])).status).toBe(404);
  });

  it('answers 400 with every schema problem and keeps the old list', async () => {
    const { project } = hub.projects.create({ name: 'Bad Proj' });
    await putRepos(project.slug, [{ name: 'keep', remote: REMOTE_APP }]);
    const r = await putRepos(project.slug, [
      { name: 'Bad Name', remote: REMOTE_APP },
      { name: 'dup', remote: REMOTE_APP },
      { name: 'dup', remote: REMOTE_LIB },
      { name: 'abs', remote: REMOTE_APP, vps: '/etc' },
      { name: 'dots', remote: REMOTE_APP, vps: 'a/../b' },
    ]);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/repos\.0\.name/);
    expect(r.json.error).toMatch(/duplicate repo name "dup"/);
    expect(r.json.error).toMatch(/repos\.3\.vps/);
    expect(r.json.error).toMatch(/repos\.4\.vps/);
    expect((await request('GET', '/api/projects/' + project.slug + '/repos')).json.repos.map((x: any) => x.name)).toEqual(['keep']);
    expect((await request('PUT', '/api/projects/' + project.slug + '/repos', { body: { nope: 1 } })).status).toBe(400);
  });

  it('is the owner\'s alone: the PC runner and a paired phone are refused, a signed-in browser is fine', async () => {
    const { project } = hub.projects.create({ name: 'Auth Proj' });
    const runner = await pair();
    expect((await request('GET', '/api/projects/' + project.slug + '/repos', { token: runner })).status).toBe(403);
    expect((await putRepos(project.slug, [{ name: 'x', remote: REMOTE_APP }], { token: runner })).status).toBe(403);
    expect(runnerMayAccess('GET', '/api/projects/x/repos')).toBe(false);
    expect(runnerMayAccess('PUT', '/api/projects/x/repos')).toBe(false);
    const minted = await request('POST', '/api/devices/pairing', { body: {} });
    const dev = await request('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'Pixel' } });
    expect(dev.status).toBe(200);
    expect((await request('GET', '/api/projects/' + project.slug + '/repos', { token: dev.json.token })).status).toBe(403);
    expect((await putRepos(project.slug, [{ name: 'x', remote: REMOTE_APP }], { token: dev.json.token })).status).toBe(403);
    expect(deviceMayAccess('GET', '/api/projects/x/repos')).toBe(false);
    expect(deviceMayAccess('PUT', '/api/projects/x/repos')).toBe(false);
    expect((await request('GET', '/api/projects/' + project.slug + '/repos', { token: null })).status).toBe(401);
    const cookie = await sessionCookie();
    expect((await request('GET', '/api/projects/' + project.slug + '/repos', { token: null, cookie })).status).toBe(200);
    expect((await putRepos(project.slug, [], { token: null, cookie })).status).toBe(200);
  });

  it('reads a hand-edited, invalid repos.json as no repos', async () => {
    const { project } = hub.projects.create({ name: 'Hand Proj' });
    const file = path.join(hub.projects.dirOf(project.slug), 'repos.json');
    fs.writeFileSync(file, JSON.stringify({ repos: [{ name: 'x', remote: REMOTE_APP, vps: '../../escape', sync: 'wip-branch' }] }));
    expect(hub.projects.reposFile(project.slug)).toEqual({ repos: [] });
    fs.writeFileSync(file, '{ not json');
    expect((await request('GET', '/api/projects/' + project.slug + '/repos')).json).toEqual({ repos: [] });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('sessions mapped to project repos', () => {
  it('computes links at read: remote match across ssh/https and case, a name fallback with no remote, nothing else', async () => {
    const { project } = hub.projects.create({ name: 'Links Proj' });
    const { project: other } = hub.projects.create({ name: 'Links Other' });
    await putRepos(project.slug, [{ name: 'app', remote: 'https://github.com/acme/app' }, { name: 'plain', remote: 'git@github.com:acme/plain.git' }]);
    await putRepos(other.slug, [{ name: 'appcopy', remote: 'ssh://git@GITHUB.com/acme/app.git' }]);
    const L = 'f0000000-0000-0000-0000-00000000000';
    seedSession(L + '1', { name: 'whatever', remote: 'git@GitHub.com:acme/app.git' });
    seedSession(L + '2', { name: 'plain', remote: null });
    seedSession(L + '3', { name: 'app', remote: 'https://github.com/someone-else/app.git' });
    seedSession(L + '4', null);
    const list = (await request('GET', '/api/pc-sessions')).json.sessions as { id: string; links: { project: string; repo: string }[] }[];
    const links = (id: string) => list.find((s) => s.id === id)!.links;
    const mine = (id: string) => links(id).filter((l) => l.project === project.slug || l.project === other.slug);
    expect(mine(L + '1')).toEqual(expect.arrayContaining([{ project: project.slug, repo: 'app' }, { project: other.slug, repo: 'appcopy' }]));
    expect(mine(L + '1')).toHaveLength(2);
    expect(mine(L + '2')).toEqual([{ project: project.slug, repo: 'plain' }]);
    expect(mine(L + '3')).toEqual([]);
    expect(links(L + '4')).toEqual([]);
    expect((await request('GET', '/api/pc-sessions/' + L + '1')).json.links.filter((l: any) => l.project === project.slug)).toHaveLength(1);
    // Computed at read: removing the repo removes the link.
    await putRepos(project.slug, []);
    expect(hub.pcSessions.get(L + '1')!.links.filter((l) => l.project === project.slug)).toEqual([]);
    expect(hub.pcSessions.get(L + '1')!.links.filter((l) => l.project === other.slug)).toEqual([{ project: other.slug, repo: 'appcopy' }]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('a bot on a repo-linked project chat', () => {
  let slug: string;
  let foreignSlug: string;
  let bot: Bot;
  let room: Room;
  function setup() {
    bot = mkBot('Linked');
    const mate = mkBot('Mate');
    const made = hub.projects.create({ name: 'Linked Proj ' + n, memberIds: [bot.id, mate.id] });
    slug = made.project.slug;
    room = hub.repos.createRoom({ kind: 'group', name: 'linked room ' + n, memberIds: [bot.id, mate.id], coordinatorBotId: null }) as Room;
    hub.projects.setRoom(slug, room.id);
    const foreign = hub.projects.create({ name: 'Foreign Proj ' + n });
    foreignSlug = foreign.project.slug;
  }
  async function repos() {
    expect((await putRepos(slug, [
      { name: 'app', remote: REMOTE_APP, sync: 'wip-branch', protected: ['staging'] },
      { name: 'lib', remote: REMOTE_LIB, sync: 'bundle' },
      { name: 'client-site', remote: 'git@github.com:acme/client-site.git', sync: 'wip-branch', client: true },
      { name: 'off', remote: 'git@github.com:acme/off.git', sync: 'none' },
    ])).status).toBe(200);
    expect((await putRepos(foreignSlug, [{ name: 'secret', remote: 'git@github.com:other/secret.git', sync: 'wip-branch' }])).status).toBe(200);
    seedSession(SID_APP, { name: 'app', remote: 'https://github.com/acme/app' });
    seedSession(SID_LIB, { name: 'lib', remote: REMOTE_LIB });
    seedSession(SID_OTHER, { name: 'unrelated', remote: 'git@github.com:nobody/unrelated.git' });
    seedSession(SID_FOREIGN, { name: 'secret', remote: 'git@github.com:other/secret.git' }, 'Foreign work');
    hub.pcSessions.upsert('c1c1c1c1-0000-0000-0000-000000000000', { machine: 'pc', projectDir: 'p', cwd: null, title: 'client work', repo: { name: 'client-site', remote: 'git@github.com:acme/client-site.git', branch: 'x', head: null }, firstAt: 1, lastAt: Date.now() });
    hub.pcSessions.upsert('0f0f0f0f-0000-0000-0000-000000000000', { machine: 'pc', projectDir: 'p', cwd: null, title: 'off work', repo: { name: 'off', remote: 'git@github.com:acme/off.git', branch: 'x', head: null }, firstAt: 1, lastAt: Date.now() });
  }
  function ctxFor(b: Bot, r: Room, answer: { allowed: boolean; message: string } = { allowed: false, message: 'declined in test' }) {
    const cards: any[] = [];
    const ctx: ToolCtx = {
      bot: b, room: r, members: [b], turnId: 't', hop: 0, causeId: 'c', repos: hub.repos,
      memory: new MemoryService(), skills: new SkillService(hub.repos),
      dispatchFromBot: () => [], setState: () => undefined, models: [],
      pcRunner: hub.pcRunner, pcSessions: hub.pcSessions, projects: hub.projects,
      confirmFleetChange: async (a) => { cards.push(a); return answer; },
    };
    return { ctx, cards };
  }
  const tool = (tools: ReturnType<typeof createHubTools>, name: string) => tools.find((t) => t.name === name)!;
  const call = async (tools: ReturnType<typeof createHubTools>, name: string, input: Record<string, unknown>) => (await tool(tools, name).handler(input)) as ToolOutput;

  it('lists and reads only the sessions of its project\'s repos; the persona still sees all', async () => {
    setup();
    await repos();
    personaId = null;
    const tools = createHubTools(ctxFor(bot, room).ctx);
    const list = textOf(await call(tools, 'list_pc_sessions', {}));
    expect(list).toContain(SID_APP);
    expect(list).toContain(SID_LIB);
    expect(list).not.toContain(SID_OTHER);
    expect(list).not.toContain(SID_FOREIGN);
    expect(textOf(await call(tools, 'read_pc_session', { id: SID_APP }))).toContain('hello from aaaa');
    for (const id of [SID_OTHER, SID_FOREIGN, 'no-such-session']) {
      const out = await call(tools, 'read_pc_session', { id });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/No session/);
    }
    expect(tools.map((t) => t.name)).not.toContain('read_any_room');
    expect(tools.map((t) => t.name)).not.toContain('dispatch');
    const repoList = textOf(await call(tools, 'list_repos', {}));
    expect(repoList).toMatch(/app \| git@github\.com:acme\/app\.git \| sync wip-branch \| protected: main, master, staging/);
    expect(repoList).toMatch(/client-site .*client repo/);
    expect(repoList).not.toContain('secret');
    expect(repoList).not.toMatch(/C:\\/);

    const persona = mkBot('Persona');
    personaId = persona.id;
    const dm = hub.repos.createRoom({ kind: 'dm', name: 'persona dm', memberIds: [persona.id], coordinatorBotId: null }) as Room;
    const pTools = createHubTools(ctxFor(persona, dm).ctx);
    const pList = textOf(await call(pTools, 'list_pc_sessions', {}));
    for (const id of [SID_APP, SID_LIB, SID_OTHER, SID_FOREIGN]) expect(pList).toContain(id);
    personaId = null;
  });

  it('has none of it when the bot is not on the project, the room is not linked, or the project lists no repos', async () => {
    setup();
    await repos();
    const outsider = mkBot('Outsider');
    const roomWith = hub.repos.createRoom({ kind: 'group', name: 'unlinked ' + n, memberIds: [outsider.id], coordinatorBotId: null }) as Room;
    const names = (b: Bot, r: Room) => createHubTools(ctxFor(b, r).ctx).map((t) => t.name);
    expect(names(outsider, roomWith)).not.toContain('list_pc_sessions');
    expect(names(outsider, roomWith)).not.toContain('list_repos');
    // In the project room but not a member of the project.
    const guest = mkBot('Guest');
    hub.repos.updateRoom?.(room.id, { memberIds: [...room.memberIds, guest.id] } as never);
    const fresh = hub.repos.getRoom(room.id)!;
    expect(names(guest, fresh)).not.toContain('list_pc_sessions');
    // A project with no repos.
    const bare = hub.projects.create({ name: 'Bare ' + n, memberIds: [outsider.id] });
    const bareRoom = hub.repos.createRoom({ kind: 'group', name: 'bare room ' + n, memberIds: [outsider.id], coordinatorBotId: null }) as Room;
    hub.projects.setRoom(bare.project.slug, bareRoom.id);
    expect(names(outsider, bareRoom)).not.toContain('list_pc_sessions');
    expect(names(outsider, bareRoom)).not.toContain('list_repos');
  });

  it('can propose a resume or a sync for a session of its repos, and not for any other', async () => {
    setup();
    await repos();
    await pair();
    personaId = null;
    const { ctx, cards } = ctxFor(bot, room);
    const t = runOnPcTool(ctx, hub.pcRunner);
    const before = hub.pcRunner.list(200).length;
    const run = async (input: Record<string, unknown>) => (await t.handler(input)) as ToolOutput;

    // Another bot's access is not this bot's: unrelated, foreign-project and unknown sessions get no card and no job.
    for (const input of [
      { mode: 'resume', session_id: SID_OTHER, prompt: 'p' },
      { mode: 'resume', session_id: SID_FOREIGN, prompt: 'p' },
      { mode: 'sync', session_id: SID_OTHER, repo: 'app' },
      { mode: 'sync', session_id: SID_FOREIGN, repo: 'secret' },
      { mode: 'sync', session_id: SID_APP, repo: 'lib' },
      { mode: 'sync', session_id: SID_APP, repo: 'secret' },
      { mode: 'sync', session_id: SID_APP, repo: 'client-site' },
      { mode: 'sync', session_id: SID_APP },
      { mode: 'sync', session_id: 'c1c1c1c1-0000-0000-0000-000000000000', repo: 'client-site' },
      { mode: 'sync', session_id: '0f0f0f0f-0000-0000-0000-000000000000', repo: 'off' },
      { mode: 'resume', session_id: SID_APP },
    ]) {
      const out = await run(input);
      expect(out.isError, JSON.stringify(input)).toBe(true);
    }
    expect(cards).toEqual([]);
    expect(hub.pcRunner.list(200).length).toBe(before);
    // The reasons for a client repo and for sync none say so.
    expect(textOf(await run({ mode: 'sync', session_id: 'c1c1c1c1-0000-0000-0000-000000000000', repo: 'client-site' }))).toMatch(/client repo/);
    expect(textOf(await run({ mode: 'sync', session_id: '0f0f0f0f-0000-0000-0000-000000000000', repo: 'off' }))).toMatch(/sync set to none/);

    // Its own repos' sessions raise the sign-in-only card (declined here, so the job is cancelled).
    const resume = await run({ mode: 'resume', session_id: SID_APP, prompt: 'carry on' });
    expect(resume.isError).toBe(true);
    expect(textOf(resume)).toMatch(/declined in test/);
    const sync = await run({ mode: 'sync', session_id: SID_APP, repo: 'app' });
    expect(textOf(sync)).toMatch(/declined in test/);
    expect(cards.map((c) => [c.tool, c.input.mode, c.evenUnderBypass])).toEqual([['run_on_pc', 'resume', true], ['run_on_pc', 'sync', true]]);
    expect(cards[1].input).toMatchObject({ session_id: SID_APP, project: slug, repo: 'app', sync: 'wip-branch', remote: REMOTE_APP });
    expect(JSON.stringify(cards[1].input)).not.toContain('C:\\Work');
    expect(hub.pcRunner.list(200).filter((j) => j.status === 'cancelled').length).toBe(2);
  });

  it('carries an approved sync to the runner with its sync object and takes the result back', async () => {
    setup();
    await repos();
    const runner = await pair();
    personaId = null;
    const { ctx } = ctxFor(bot, room, { allowed: true, message: 'ok' });
    const done = runOnPcTool(ctx, hub.pcRunner).handler({ mode: 'sync', session_id: SID_APP, repo: 'app' }) as Promise<ToolOutput>;
    const job = await claim(runner);
    expect(job).toMatchObject({
      mode: 'sync', sessionId: SID_APP, folder: null, origin: 'bot',
      sync: { project: slug, repo: 'app', remote: REMOTE_APP, mode: 'wip-branch', protected: ['main', 'master', 'staging'] },
    });
    expect(job.bot.handle).toBe(bot.handle);
    expect((await request('POST', '/api/pc-runner/jobs/' + job.id + '/start', { token: runner, body: {} })).status).toBe(200);
    const res = await request('POST', '/api/pc-runner/jobs/' + job.id + '/result', {
      token: runner,
      body: { ok: true, output: 'pushed', sync: { mode: 'wip-branch', branch: 'wip/pc/aaaaaaaa', commit: 'abc1234def5678', scan: { blocked: false, findings: [] } } },
    });
    expect(res.status).toBe(200);
    const out = textOf(await done);
    expect(out).toMatch(/Synced app \(wip-branch\)/);
    expect(out).toContain('wip/pc/aaaaaaaa');
    expect(out).toContain('abc1234def56');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the owner starts a sync (POST /api/pc-runner/jobs)', () => {
  let slug: string;
  async function setup(extra: Record<string, unknown>[] = []) {
    slug = hub.projects.create({ name: 'Owner Sync ' + n++ }).project.slug;
    expect((await putRepos(slug, [
      { name: 'app', remote: REMOTE_APP, sync: 'wip-branch' },
      { name: 'lib', remote: REMOTE_LIB, sync: 'bundle' },
      { name: 'client-site', remote: 'git@github.com:acme/client-site.git', sync: 'wip-branch', client: true },
      { name: 'off', remote: 'git@github.com:acme/off.git', sync: 'none' },
      ...extra,
    ])).status).toBe(200);
    seedSession(SID_APP, { name: 'app', remote: REMOTE_APP });
    seedSession(SID_LIB, { name: 'lib', remote: REMOTE_LIB });
    seedSession(SID_OTHER, { name: 'unrelated', remote: 'git@github.com:nobody/unrelated.git' });
    hub.pcSessions.upsert('c1c1c1c1-0000-0000-0000-000000000001', { machine: 'pc', projectDir: 'p', cwd: null, title: 'client', repo: { name: 'client-site', remote: 'git@github.com:acme/client-site.git', branch: null, head: null }, firstAt: 1, lastAt: Date.now() });
    hub.pcSessions.upsert('0f0f0f0f-0000-0000-0000-000000000001', { machine: 'pc', projectDir: 'p', cwd: null, title: 'off', repo: { name: 'off', remote: 'git@github.com:acme/off.git', branch: null, head: null }, firstAt: 1, lastAt: Date.now() });
  }
  const start = (cookie: string, body: Record<string, unknown>) => request('POST', '/api/pc-runner/jobs', { token: null, cookie, body });

  it('is refused with the hub token and the runner token, and accepted from a signed-in browser', async () => {
    await setup();
    const runner = await pair();
    const body = { mode: 'sync', sessionId: SID_APP, project: slug, repo: 'app' };
    const syncIds = () => hub.pcRunner.list(200).filter((j) => j.mode === 'sync').map((j) => j.id);
    const had = syncIds();
    const hubToken = await request('POST', '/api/pc-runner/jobs', { body });
    expect(hubToken.status).toBe(403);
    expect(hubToken.json.signInRequired).toBe(true);
    expect((await request('POST', '/api/pc-runner/jobs', { token: runner, body })).status).toBe(403);
    expect(syncIds()).toEqual(had);
    const cookie = await sessionCookie();
    const ok = await start(cookie, body);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      mode: 'sync', sessionId: SID_APP, origin: 'owner', status: 'queued', folder: null,
      sync: { project: slug, repo: 'app', remote: REMOTE_APP, mode: 'wip-branch', protected: ['main', 'master'] },
      syncResult: null, hubImport: null,
    });
    const job = await claim(runner);
    expect(job).toMatchObject({ id: ok.json.id, mode: 'sync', sessionId: SID_APP, sync: { repo: 'app', mode: 'wip-branch' } });
    expect(job.bot.handle).toBe('(the app)');
    expect(listAudit(hub.repos.db, { limit: 20 }).some((a) => a.action === 'pc-runner.job.approved' && /sync/.test(a.detail ?? ''))).toBe(true);
  });

  it('refuses a client repo, sync none, an unmapped session and bad input with 400', async () => {
    await setup();
    await pair();
    const cookie = await sessionCookie();
    const syncJobs = () => hub.pcRunner.list(200).filter((j) => j.mode === 'sync').map((j) => j.id);
    const had = syncJobs();
    const bad = async (body: Record<string, unknown>, re: RegExp) => {
      const r = await start(cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toMatch(re);
    };
    await bad({ mode: 'sync', sessionId: 'c1c1c1c1-0000-0000-0000-000000000001', project: slug, repo: 'client-site' }, /client repo/);
    await bad({ mode: 'sync', sessionId: '0f0f0f0f-0000-0000-0000-000000000001', project: slug, repo: 'off' }, /sync set to none/);
    await bad({ mode: 'sync', sessionId: SID_OTHER, project: slug, repo: 'app' }, /does not belong/);
    await bad({ mode: 'sync', sessionId: SID_LIB, project: slug, repo: 'app' }, /does not belong/);
    await bad({ mode: 'sync', sessionId: SID_APP, project: slug, repo: 'nope' }, /no repo called/);
    await bad({ mode: 'sync', sessionId: SID_APP, project: 'no-such-project', repo: 'app' }, /No project/);
    await bad({ mode: 'sync', sessionId: 'not-in-the-mirror', project: slug, repo: 'app' }, /mirror/);
    await bad({ mode: 'sync', sessionId: SID_APP, repo: 'app' }, /project and repo/);
    await bad({ mode: 'sync', project: slug, repo: 'app' }, /sessionId/);
    await bad({ mode: 'new', folder: 'site' }, /prompt/);
    expect(syncJobs()).toEqual(had);
    // A sync takes no prompt; the other modes still do and still work.
    expect((await start(cookie, { mode: 'new', folder: 'site', prompt: 'hi' })).status).toBe(200);
  });

  it('turns a blocked scan into a failed job whatever the runner says, and keeps the findings (redacted)', async () => {
    await setup();
    const runner = await pair();
    const cookie = await sessionCookie();
    const made = await start(cookie, { mode: 'sync', sessionId: SID_APP, project: slug, repo: 'app' });
    await claim(runner);
    await request('POST', '/api/pc-runner/jobs/' + made.json.id + '/start', { token: runner, body: {} });
    const key = 'sk-ant-api03-' + 'Zq9'.repeat(14);
    const res = await request('POST', '/api/pc-runner/jobs/' + made.json.id + '/result', {
      token: runner,
      body: { ok: true, output: 'blocked', sync: { mode: 'wip-branch', commit: 'abc1234', scan: { blocked: true, findings: ['.env added', 'line has ' + key] } } },
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('failed');
    const view = (await request('GET', '/api/pc-runner/jobs/' + made.json.id)).json;
    expect(view.status).toBe('failed');
    expect(view.syncResult.scan.blocked).toBe(true);
    expect(view.syncResult.scan.findings[0]).toBe('.env added');
    expect(JSON.stringify(view)).not.toContain(key);
  });

  it('needs a sync object for a successful sync, with the right mode', async () => {
    await setup();
    const runner = await pair();
    const cookie = await sessionCookie();
    const made = await start(cookie, { mode: 'sync', sessionId: SID_APP, project: slug, repo: 'app' });
    await claim(runner);
    await request('POST', '/api/pc-runner/jobs/' + made.json.id + '/start', { token: runner, body: {} });
    const post = (body: unknown) => request('POST', '/api/pc-runner/jobs/' + made.json.id + '/result', { token: runner, body });
    expect((await post({ ok: true, output: 'x' })).status).toBe(400);
    expect((await post({ ok: true, output: 'x', sync: { mode: 'bundle', commit: 'abc1234', scan: { blocked: false, findings: [] } } })).status).toBe(400);
    expect((await post({ ok: true, output: 'x', sync: { mode: 'wip-branch', commit: 'abc1234', scan: { blocked: false, findings: [] } } })).status).toBe(400);
    expect((await post({ ok: true, output: 'x', sync: { mode: 'wip-branch', branch: 'main', commit: 'abc1234', scan: { blocked: false, findings: [] } } })).status).toBe(400);
    expect((await post({ ok: true, output: 'x', sync: { mode: 'wip-branch', branch: 'wip/pc/aaaaaaaa', commit: 'abc1234', scan: { blocked: false, findings: [] } } })).status).toBe(200);
    expect((await request('GET', '/api/pc-runner/jobs/' + made.json.id)).json).toMatchObject({ status: 'done', syncResult: { branch: 'wip/pc/aaaaaaaa', commit: 'abc1234' } });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('uploading a bundle', () => {
  let slug: string;
  let src: string;
  let runner: string;
  let cookie: string;
  const vpsOf = () => path.join(hub.projects.dirOf(slug), 'repos', 'lib');

  /** A tiny source repo on the "PC" with a commit on main, as a bundle of one ref. */
  function makeBundle(files: Record<string, string> = { 'a.txt': 'hello\n' }, ref = 'HEAD') {
    src = fs.mkdtempSync(path.join(tmp, 'src-'));
    git(src, 'init', '-q', '-b', 'main');
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
      fs.writeFileSync(path.join(src, f), c);
    }
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'wip: snapshot');
    const out = path.join(src, '..', path.basename(src) + '.bundle');
    git(src, 'bundle', 'create', out, ref);
    const buf = fs.readFileSync(out);
    expect(buf.length).toBeLessThan(BUNDLE_CAP);
    return { buf, sha: createHash('sha256').update(buf).digest('hex'), commit: git(src, 'rev-parse', 'HEAD') };
  }

  async function newJob(sid = SID_LIB, repo = 'lib'): Promise<string> {
    const made = await request('POST', '/api/pc-runner/jobs', { token: null, cookie, body: { mode: 'sync', sessionId: sid, project: slug, repo } });
    expect(made.status).toBe(200);
    const next = await claim(runner);
    expect(next.id).toBe(made.json.id);
    await request('POST', '/api/pc-runner/jobs/' + next.id + '/start', { token: runner, body: {} });
    return next.id;
  }
  const upload = (jobId: string, buf: Buffer, o: { sha?: string; token?: string | null; cookie?: string; type?: string; headers?: Record<string, string>; chunked?: boolean } = {}) =>
    request('POST', '/api/pc-runner/jobs/' + jobId + '/bundle', {
      raw: buf, token: o.token === undefined ? runner : o.token, cookie: o.cookie,
      headers: { 'content-type': o.type ?? 'application/octet-stream', 'x-bundle-sha256': o.sha ?? createHash('sha256').update(buf).digest('hex'), ...(o.headers ?? {}) },
      chunked: o.chunked,
    });
  const leftovers = () => (fs.existsSync(path.join(vpsOf(), '.incoming')) ? fs.readdirSync(path.join(vpsOf(), '.incoming')) : []);
  const branches = () => (fs.existsSync(path.join(vpsOf(), '.git')) ? git(vpsOf(), 'for-each-ref', '--format=%(refname)=%(objectname)', 'refs/heads').split('\n').filter(Boolean) : []);

  async function setup() {
    slug = hub.projects.create({ name: 'Bundle Proj ' + n++ }).project.slug;
    expect((await putRepos(slug, [
      { name: 'lib', remote: REMOTE_LIB, sync: 'bundle' },
      { name: 'app', remote: REMOTE_APP, sync: 'wip-branch' },
    ])).status).toBe(200);
    seedSession(SID_LIB, { name: 'lib', remote: REMOTE_LIB });
    seedSession(SID_APP, { name: 'app', remote: REMOTE_APP });
    runner = await pair();
    cookie = await sessionCookie();
  }

  it('imports a real bundle on wip/<machine>/<session> and touches no other branch', async () => {
    await setup();
    // A VPS copy that already exists, with its own main.
    fs.mkdirSync(vpsOf(), { recursive: true });
    git(vpsOf(), 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(vpsOf(), 'own.txt'), 'mine\n');
    git(vpsOf(), 'add', '-A');
    git(vpsOf(), 'commit', '-q', '-m', 'vps main');
    git(vpsOf(), 'branch', 'feature-x');
    const before = branches();
    expect(before).toHaveLength(2);

    const b = makeBundle({ 'a.txt': 'hello\n', 'src/b.ts': 'export {}\n' });
    const id = await newJob();
    const r = await upload(id, b.buf);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, branch: 'wip/pc/bbbbbbbb', bytes: b.buf.length });

    const after = branches();
    expect(after.filter((x) => !x.startsWith('refs/heads/wip/'))).toEqual(before);
    expect(after.find((x) => x.startsWith('refs/heads/wip/pc/bbbbbbbb='))).toBe('refs/heads/wip/pc/bbbbbbbb=' + b.commit);
    expect(git(vpsOf(), 'show', 'wip/pc/bbbbbbbb:src/b.ts')).toBe('export {}');
    // The VPS copy's own checkout is untouched.
    expect(git(vpsOf(), 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(fs.readFileSync(path.join(vpsOf(), 'own.txt'), 'utf8')).toBe('mine\n');
    expect(fs.existsSync(path.join(vpsOf(), 'a.txt'))).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(vpsOf(), '.incoming'))).toBe(false);

    // The result then closes the job and the owner's view shows what the hub imported.
    const res = await request('POST', '/api/pc-runner/jobs/' + id + '/result', {
      token: runner, body: { ok: true, output: 'uploaded', sync: { mode: 'bundle', commit: b.commit, bundleBytes: b.buf.length, scan: { blocked: false, findings: [] } } },
    });
    expect(res.status).toBe(200);
    expect((await request('GET', '/api/pc-runner/jobs/' + id)).json).toMatchObject({
      status: 'done', sync: { mode: 'bundle' }, syncResult: { commit: b.commit, bundleBytes: b.buf.length }, hubImport: { branch: 'wip/pc/bbbbbbbb', vps: 'repos/lib', bytes: b.buf.length },
    });
    expect(listAudit(hub.repos.db, { limit: 30 }).some((a) => a.action === 'pc-runner.bundle.imported' && a.target === id)).toBe(true);
    // Once only.
    const again = await upload(id, b.buf);
    expect(again.status).toBe(409);
  });

  it('creates the VPS copy when there is none, from an empty template', async () => {
    await setup();
    const b = makeBundle();
    const id = await newJob();
    expect((await upload(id, b.buf)).status).toBe(200);
    expect(branches()).toEqual(['refs/heads/wip/pc/bbbbbbbb=' + b.commit]);
    const hooks = path.join(vpsOf(), '.git', 'hooks');
    expect(fs.existsSync(hooks) ? fs.readdirSync(hooks) : []).toEqual([]);
  });

  it('refuses a wrong hash, a body past the cap, a missing length and other types, and leaves nothing behind', async () => {
    await setup();
    const b = makeBundle();
    const id = await newJob();
    const wrong = await upload(id, b.buf, { sha: '0'.repeat(64) });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toMatch(/sha256/);
    expect(await upload(id, b.buf, { sha: 'nothex' })).toMatchObject({ status: 400 });
    expect((await upload(id, b.buf, { headers: { 'x-bundle-sha256': '' } })).status).toBe(400);
    const big = await upload(id, Buffer.alloc(BUNDLE_CAP + 904, 7));
    expect(big.status).toBe(413);
    expect((await upload(id, b.buf, { type: 'application/json' })).status).toBe(415);
    expect((await upload(id, b.buf, { type: 'text/plain' })).status).toBe(415);
    expect((await upload(id, b.buf, { chunked: true })).status).toBe(411);
    expect(branches()).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(hub.pcRunner.get(id)?.syncImport).toBeNull();
    // The right bundle still goes in afterwards.
    expect((await upload(id, b.buf)).status).toBe(200);
  });

  it('refuses a corrupt bundle, a bundle with more than one ref and a bundle for a job that is not a bundle sync', async () => {
    await setup();
    const id = await newJob();
    const junk = Buffer.from('# v2 git bundle\nnot really\n');
    expect((await upload(id, junk)).status).toBe(400);
    expect(leftovers()).toEqual([]);

    const two = makeBundle();
    git(src, 'branch', 'second');
    const twoOut = path.join(src, 'two.bundle');
    git(src, 'bundle', 'create', twoOut, '--all');
    const twoBuf = fs.readFileSync(twoOut);
    expect(twoBuf.length).toBeLessThan(BUNDLE_CAP);
    const r = await upload(id, twoBuf);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/exactly one ref/);
    expect(branches().filter((x) => x.includes('refs/heads/wip/'))).toEqual([]);
    expect(two.buf.length).toBeGreaterThan(0);
  });

  it('refuses an unknown job, a wip-branch job, a finished job and every principal but the runner', async () => {
    await setup();
    const b = makeBundle();
    expect((await upload('nosuchjob', b.buf)).status).toBe(404);
    // A wip-branch sync takes no bundle.
    const wipJob = await newJob(SID_APP, 'app');
    expect((await upload(wipJob, b.buf)).status).toBe(409);
    await request('POST', '/api/pc-runner/jobs/' + wipJob + '/result', { token: runner, body: { ok: false, output: 'x' } });
    // A bundle job that is not claimed any more.
    const id = await newJob();
    await request('POST', '/api/pc-runner/jobs/' + id + '/result', { token: runner, body: { ok: false, output: 'gave up' } });
    expect((await upload(id, b.buf)).status).toBe(409);
    // Other principals: the hub token, a signed-in browser, a phone, no token.
    const live = await newJob();
    expect((await upload(live, b.buf, { token: TOKEN })).status).toBe(403);
    expect((await upload(live, b.buf, { token: null, cookie })).status).toBe(403);
    expect((await upload(live, b.buf, { token: null })).status).toBe(401);
    const minted = await request('POST', '/api/devices/pairing', { body: {} });
    const dev = await request('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'Pixel' } });
    expect((await upload(live, b.buf, { token: dev.json.token })).status).toBe(403);
    expect(runnerMayAccess('POST', '/api/pc-runner/jobs/abc/bundle')).toBe(true);
    expect(branches()).toEqual([]);
    expect(hub.pcRunner.get(live)?.syncImport).toBeNull();
    // And the runner may not use the upload route for anything else, nor send JSON to it.
    expect(runnerMayAccess('GET', '/api/pc-runner/jobs/abc/bundle')).toBe(false);
    expect((await upload(live, b.buf)).status).toBe(200);
  });

  it('refuses when the owner has since made the repo a client repo or turned sync off', async () => {
    await setup();
    const b = makeBundle();
    const id = await newJob();
    await putRepos(slug, [{ name: 'lib', remote: REMOTE_LIB, sync: 'bundle', client: true }, { name: 'app', remote: REMOTE_APP, sync: 'wip-branch' }]);
    expect((await upload(id, b.buf)).status).toBe(409);
    await putRepos(slug, [{ name: 'lib', remote: REMOTE_LIB, sync: 'none' }, { name: 'app', remote: REMOTE_APP, sync: 'wip-branch' }]);
    expect((await upload(id, b.buf)).status).toBe(409);
    expect(branches()).toEqual([]);
  });

  it('never runs a hook or any program the VPS copy\'s own git config names', async () => {
    await setup();
    // A VPS copy someone planted programs in: a hook in .git/hooks, a core.hooksPath to another hooks folder, a core.fsmonitor.
    fs.mkdirSync(vpsOf(), { recursive: true });
    git(vpsOf(), 'init', '-q', '-b', 'main');
    const marker = path.join(tmp, 'HOOK-RAN-' + n++);
    const evilDir = path.join(tmp, 'evil-hooks-' + n++);
    fs.mkdirSync(evilDir);
    const script = '#!/bin/sh\necho ran >> "' + marker.replaceAll('\\', '/') + '"\nexit 0\n';
    const plant = (dir: string, names: string[]) => {
      for (const nm of names) {
        fs.writeFileSync(path.join(dir, nm), script);
        fs.chmodSync(path.join(dir, nm), 0o755);
      }
    };
    plant(path.join(vpsOf(), '.git', 'hooks'), ['reference-transaction', 'post-checkout', 'post-merge', 'pre-auto-gc']);
    plant(evilDir, ['reference-transaction', 'post-checkout']);
    const fsmon = path.join(evilDir, 'fsmonitor.sh');
    fs.writeFileSync(fsmon, '#!/bin/sh\necho ran >> "' + marker.replaceAll('\\', '/') + '"\nexit 0\n');
    fs.chmodSync(fsmon, 0o755);
    fs.appendFileSync(path.join(vpsOf(), '.git', 'config'), '[core]\n\thooksPath = ' + evilDir.replaceAll('\\', '/') + '\n\tfsmonitor = ' + fsmon.replaceAll('\\', '/') + '\n');

    // Control: with the planted config in effect a plain ref update really does run the hook, so the check below means something.
    git(vpsOf(), 'commit', '-q', '--allow-empty', '-m', 'seed');
    expect(fs.existsSync(marker), 'the planted hook should run under plain git').toBe(true);
    fs.rmSync(marker);

    const b = makeBundle();
    const id = await newJob();
    const r = await upload(id, b.buf);
    expect(r.status).toBe(200);
    expect(branches().some((x) => x.startsWith('refs/heads/wip/pc/bbbbbbbb='))).toBe(true);
    expect(fs.existsSync(marker), 'the import must never run a hook or fsmonitor').toBe(false);
  });

  it('does not import into a VPS copy whose .git is a file, or whose folder is a link out of the project', async () => {
    await setup();
    const b = makeBundle();
    fs.mkdirSync(vpsOf(), { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    fs.writeFileSync(path.join(vpsOf(), '.git'), 'gitdir: ' + elsewhere.replaceAll('\\', '/') + '\n');
    const id = await newJob();
    const r = await upload(id, b.buf);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not a plain folder/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(leftovers()).toEqual([]);
  });
});
