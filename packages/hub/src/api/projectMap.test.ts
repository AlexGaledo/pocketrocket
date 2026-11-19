import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MAX_MAP_BYTES, checkProjectMap, type ServerEvent } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { events } from '../events.js';
import { deviceMayAccess } from './guard.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SkillService } from '../services/SkillService.js';
import { PROJECT_MAP_SKILL, ensureBuiltinSkills } from '../services/builtinSkills.js';
import { DEV_TEAM_TEMPLATE } from '../services/devTeamTemplate.js';
import { SKILLS_DIR } from '../config.js';

const TOKEN = 'project-map-test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-projmap-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const good = () => ({
  version: 1,
  kind: 'architecture',
  generatedBy: 'shop-lead',
  generatedAt: '2026-11-20',
  nodes: [
    { id: 'web', label: 'web app', tech: 'React', group: 'client' },
    { id: 'hub', label: 'hub', group: 'core' },
  ],
  edges: [['web', 'hub', 'active']],
});

describe('ProjectMapSchema (checkProjectMap)', () => {
  it('accepts a valid map, with and without edge states', () => {
    const m = { ...good(), edges: [['web', 'hub'], ['hub', 'web', 'off']] };
    const r = checkProjectMap(m);
    expect('map' in r && r.map.edges).toEqual([['web', 'hub'], ['hub', 'web', 'off']]);
    const road = checkProjectMap({ ...good(), kind: 'roadmap', nodes: [{ id: 'a', label: 'MVP', state: 'done' }, { id: 'b', label: 'Beta', state: 'now' }], edges: [['a', 'b']] });
    expect('map' in road).toBe(true);
  });
  it('drops edges that point at missing nodes and counts them', () => {
    const r = checkProjectMap({ ...good(), edges: [['web', 'hub'], ['web', 'ghost'], ['ghost', 'hub', 'active']] });
    expect(r).toMatchObject({ droppedEdges: 2 });
    expect('map' in r && r.map.edges).toEqual([['web', 'hub']]);
  });
  it('names the first problem', () => {
    const err = (m: unknown) => ('error' in checkProjectMap(m) ? (checkProjectMap(m) as { error: string }).error : null);
    expect(err({ ...good(), version: 2 })).toMatch(/^version/);
    expect(err({ ...good(), kind: 'mindmap' })).toMatch(/^kind/);
    expect(err({ ...good(), generatedAt: 'yesterday' })).toMatch(/generatedAt: must be a date/);
    expect(err({ ...good(), nodes: [{ id: 'a', label: 'x'.repeat(41) }] })).toMatch(/^nodes\.0\.label/);
    expect(err({ ...good(), nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).toMatch(/duplicate node id "a"/);
    expect(err({ ...good(), nodes: [{ id: 'a', label: 'A', state: 'later' }] })).toMatch(/^nodes\.0\.state/);
    expect(err({ ...good(), edges: [['web', 'hub', 'flowing']] })).toMatch(/^edges\.0/);
    expect(err({ ...good(), nodes: Array.from({ length: 61 }, (_, i) => ({ id: 'n' + i, label: 'n' })) })).toMatch(/^nodes/);
    expect(err({ ...good(), edges: Array.from({ length: 121 }, () => ['web', 'hub']) })).toMatch(/^edges/);
    expect(err(null)).not.toBeNull();
  });
  it('accepts the example in the project-map skill', () => {
    const json = /```json\n([\s\S]*?)\n```/.exec(PROJECT_MAP_SKILL.markdown)![1];
    expect('map' in checkProjectMap(JSON.parse(json))).toBe(true);
  });
});

describe('the project-map skill', () => {
  const name = 'zz-builtin-test-' + process.pid;
  afterAll(() => fs.rmSync(path.join(SKILLS_DIR, name), { recursive: true, force: true }));

  it('is on the dev team template', () => {
    expect(DEV_TEAM_TEMPLATE.skills).toContain(PROJECT_MAP_SKILL.name);
  });
  it('is added once as an approved pool skill and never overwritten', () => {
    const repos = new Repos(new Db(':memory:'));
    const skills = new SkillService(repos);
    const list = [{ ...PROJECT_MAP_SKILL, name }];
    expect(ensureBuiltinSkills(skills, repos, list)).toEqual([name]);
    const skill = repos.getSkillByName(name)!;
    expect(skill).toMatchObject({ source: 'authored', reviewStatus: 'approved' });
    const md = skills.readMarkdown(skill);
    expect(md).toMatch(new RegExp('^---\\nname: ' + name + '\\ndescription: '));
    expect(md).toContain('map.json');
    fs.writeFileSync(path.join(skill.path, 'SKILL.md'), 'owner edit');
    expect(ensureBuiltinSkills(skills, repos, list)).toEqual([]);
    expect(skills.readMarkdown(skill)).toBe('owner edit');
  });
});

describe('/api/projects map, overview and projects.changed', () => {
  let hub: Hub;
  let port: number;
  const dir = path.join(tmp, 'hub');
  const seen: ServerEvent[] = [];
  const off = events.onEvent((ev) => { if (ev.type === 'projects.changed') seen.push(ev); });
  beforeAll(async () => {
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: dir });
    port = await hub.listen();
  });
  afterAll(async () => { off(); await hub.shutdown(); });

  function request(method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => { let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }); });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const put = (slug: string, name: string, text: string | Buffer) => fs.writeFileSync(path.join(dir, slug, name), text);

  it('emits one payload-free projects.changed for create, members, room and delete', async () => {
    const bot = hub.repos.createBot({ name: 'm', handle: 'map-member', title: '', description: 'x', avatar: '🔎', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
    const room = hub.repos.createRoom({ kind: 'group', name: 'Ev', memberIds: [bot.id], coordinatorBotId: null });
    seen.length = 0;
    await request('POST', '/api/projects', { name: 'Ev' });
    expect(seen).toHaveLength(1);
    await request('PUT', '/api/projects/ev/members', { memberIds: [bot.id] });
    expect(seen).toHaveLength(2);
    await request('PUT', '/api/projects/ev/room', { roomId: room.id });
    expect(seen).toHaveLength(3);
    // Reads and refused writes say nothing.
    await request('GET', '/api/projects/ev/map');
    await request('PUT', '/api/projects/ev/members', { memberIds: ['nope'] });
    expect(seen).toHaveLength(3);
    await request('DELETE', '/api/projects/ev');
    expect(seen).toHaveLength(4);
    expect(seen.every((e) => JSON.stringify(e) === '{"type":"projects.changed"}')).toBe(true);
  });

  it('reads map.json: missing, valid with dropped edges, bad JSON, invalid, too large', async () => {
    await request('POST', '/api/projects', { name: 'Mapped' });
    expect((await request('GET', '/api/projects/mapped/map')).json).toEqual({ map: null, error: null, mtime: null, droppedEdges: 0 });

    put('mapped', 'map.json', JSON.stringify({ ...good(), edges: [['web', 'hub'], ['web', 'gone']] }));
    const ok = await request('GET', '/api/projects/mapped/map');
    expect(ok.status).toBe(200);
    expect(ok.json.error).toBeNull();
    expect(ok.json.map.nodes).toHaveLength(2);
    expect(ok.json.map.edges).toEqual([['web', 'hub']]);
    expect(ok.json.droppedEdges).toBe(1);
    expect(typeof ok.json.mtime).toBe('number');

    put('mapped', 'map.json', '{ "version": 1, ');
    const bad = (await request('GET', '/api/projects/mapped/map')).json;
    expect(bad.map).toBeNull();
    expect(bad.error).toMatch(/not valid JSON/);

    put('mapped', 'map.json', JSON.stringify({ ...good(), kind: 'mindmap' }));
    expect((await request('GET', '/api/projects/mapped/map')).json.error).toMatch(/^map\.json: kind/);

    put('mapped', 'map.json', Buffer.alloc(MAX_MAP_BYTES + 1, 0x20));
    const big = (await request('GET', '/api/projects/mapped/map')).json;
    expect(big).toMatchObject({ map: null, error: expect.stringMatching(/too large/) });
  });

  it('never follows a link or reads a folder named map.json', async () => {
    await request('POST', '/api/projects', { name: 'Linked' });
    const outside = path.join(tmp, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(good()));
    let linked = true;
    try { fs.symlinkSync(outside, path.join(dir, 'linked', 'map.json'), 'file'); } catch { linked = false; }
    if (linked) expect((await request('GET', '/api/projects/linked/map')).json).toMatchObject({ map: null, error: null });
    fs.rmSync(path.join(dir, 'linked', 'map.json'), { force: true });
    fs.mkdirSync(path.join(dir, 'linked', 'map.json'));
    expect((await request('GET', '/api/projects/linked/map')).json).toMatchObject({ map: null, error: null });
  });

  it('reads the overview from current.md, and empty when it is missing', async () => {
    await request('POST', '/api/projects', { name: 'Planned' });
    // The starter current.md written on create has no plan.
    expect((await request('GET', '/api/projects/planned/overview')).json).toMatchObject({ plan: null, next: null, done: [], waiting: [] });
    put('planned', 'current.md', '---\nupdated: 2026-11-18\n---\n## Build\n- [x] a\n- [ ] b\n## Next\n- do b\n## Waiting on me\n- a decision\n');
    expect((await request('GET', '/api/projects/planned/overview')).json).toEqual({
      updated: '2026-11-18', plan: { done: 1, total: 2, stage: 'Build' }, next: 'do b', done: [], waiting: ['a decision'],
    });
    fs.rmSync(path.join(dir, 'planned', 'current.md'));
    expect((await request('GET', '/api/projects/planned/overview')).json).toEqual({ updated: null, plan: null, next: null, done: [], waiting: [] });
  });

  it('404s an unknown or traversing slug and refuses a paired phone', async () => {
    for (const p of ['/api/projects/none/map', '/api/projects/none/overview', '/api/projects/..%2F..%2Fetc/map', '/api/projects/%2E%2E/overview']) {
      expect((await request('GET', p)).status, p).toBe(404);
    }
    expect(deviceMayAccess('GET', '/api/projects/x/map')).toBe(false);
    expect(deviceMayAccess('GET', '/api/projects/x/overview')).toBe(false);
  });
});
