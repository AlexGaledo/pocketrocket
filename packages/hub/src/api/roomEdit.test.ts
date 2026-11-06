import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome } from '../providers/types.js';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { MAX_ROOM_BOTS, mediaHash } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner } from '../agent/BotRunner.js';
import { RoomRouter } from '../rooms/RoomRouter.js';

const TOKEN = 'room-edit-token';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('PATCH /api/rooms/:id', () => {
  let hub: Hub;
  let port: number;
  let dir: string;
  let n = 0;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-room-'));
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, mediaDir: dir });
    port = await hub.listen();
  });
  afterAll(async () => {
    await hub.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const req = (method: string, url: string, body?: unknown, token = TOKEN) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + token, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  const bot = (name = 'B') => { const h = 'b' + ++n; return hub.repos.createBot({ name: name + n, handle: h, title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 }); };
  const group = (ids: string[], coordinatorBotId: string | null = null) => hub.repos.createRoom({ kind: 'group', name: 'crew', memberIds: ids, coordinatorBotId });
  const lines = (roomId: string) => hub.repos.listMessages(roomId, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text);
  const me = () => hub.settings.get().userName;

  it('renames, with a line in the chat', async () => {
    const a = bot();
    const room = group([a.id]);
    const r = await req('PATCH', '/api/rooms/' + room.id, { name: 'launch' });
    expect(r.status).toBe(200);
    expect(r.json.name).toBe('launch');
    expect(lines(room.id)).toEqual([me() + ' renamed this chat to "launch".']);
  });

  it('adds and removes, with a line for each, and says nothing when nothing changed', async () => {
    const [a, b, c] = [bot('Ann'), bot('Bob'), bot('Cid')];
    const room = group([a.id, b.id], a.id);
    await req('PATCH', '/api/rooms/' + room.id, { memberIds: [a.id, c.id] });
    expect(hub.repos.getRoom(room.id)!.memberIds.sort()).toEqual([a.id, c.id].sort());
    expect(lines(room.id)).toEqual([
      me() + ' added ' + c.name + ' (@' + c.handle + ').',
      me() + ' removed ' + b.name + ' (@' + b.handle + ').',
    ]);
    await req('PATCH', '/api/rooms/' + room.id, { name: 'crew', memberIds: [c.id, a.id] });
    expect(lines(room.id)).toHaveLength(2);
  });

  it('refuses removing the last bot, and leaves the room as it was', async () => {
    const a = bot();
    const room = group([a.id]);
    expect((await req('PATCH', '/api/rooms/' + room.id, { memberIds: [] })).status).toBe(400);
    expect(hub.repos.getRoom(room.id)!.memberIds).toEqual([a.id]);
    expect(lines(room.id)).toEqual([]);
  });

  it('respects MAX_ROOM_BOTS', async () => {
    const all = Array.from({ length: MAX_ROOM_BOTS + 1 }, () => bot().id);
    const room = group(all.slice(0, 2));
    expect((await req('PATCH', '/api/rooms/' + room.id, { memberIds: all })).status).toBe(400);
    expect(hub.repos.getRoom(room.id)!.memberIds).toHaveLength(2);
    expect((await req('PATCH', '/api/rooms/' + room.id, { memberIds: all.slice(0, MAX_ROOM_BOTS) })).status).toBe(200);
  });

  it('refuses an unknown bot, and a DM with two', async () => {
    const [a, b] = [bot(), bot()];
    const room = group([a.id]);
    expect((await req('PATCH', '/api/rooms/' + room.id, { memberIds: [a.id, 'nope'] })).status).toBe(404);
    const dm = hub.repos.createRoom({ kind: 'dm', name: 'd', memberIds: [a.id], coordinatorBotId: null });
    expect((await req('PATCH', '/api/rooms/' + dm.id, { memberIds: [a.id, b.id] })).status).toBe(400);
  });

  it('sets a coordinator only from the members, and clears one who leaves', async () => {
    const [a, b, c] = [bot('Ann'), bot('Bob'), bot('Cid')];
    const room = group([a.id, b.id], a.id);
    expect((await req('PATCH', '/api/rooms/' + room.id, { coordinatorBotId: c.id })).status).toBe(400);
    expect((await req('PATCH', '/api/rooms/' + room.id, { coordinatorBotId: b.id })).json.coordinatorBotId).toBe(b.id);
    expect(lines(room.id).at(-1)).toBe('Coordinator is now ' + b.name + ' (@' + b.handle + ').');
    const left = await req('PATCH', '/api/rooms/' + room.id, { memberIds: [a.id] });
    expect(left.json.coordinatorBotId).toBeNull();
    expect(lines(room.id).at(-1)).toBe('This chat has no coordinator now.');
  });

  it('always gives a group of two or more a coordinator, preferring a lead', async () => {
    const [a, b] = [bot('Ann'), bot('Bob')];
    const lead = hub.repos.createBot({ name: 'Lead', handle: 'crew-lead', title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const made = await req('POST', '/api/rooms', { kind: 'group', name: 'new', memberIds: [a.id, lead.id], coordinatorBotId: null });
    expect(made.json.coordinatorBotId).toBe(lead.id);
    const room = group([a.id, b.id], a.id);
    expect([a.id, b.id]).toContain((await req('PATCH', '/api/rooms/' + room.id, { coordinatorBotId: null })).json.coordinatorBotId);
    // The coordinator leaving makes the hub pick again, and it prefers the lead.
    const other = group([a.id, b.id], a.id);
    const swapped = await req('PATCH', '/api/rooms/' + other.id, { memberIds: [b.id, lead.id] });
    expect(swapped.json.coordinatorBotId).toBe(lead.id);
  });

  it('a deleted bot stops being the coordinator', async () => {
    const [a, b] = [bot(), bot()];
    const room = group([a.id, b.id], a.id);
    await req('DELETE', '/api/bots/' + a.id);
    expect(hub.repos.getRoom(room.id)!.coordinatorBotId).toBeNull();
  });

  it('stores a group picture or icon, without a chat line, and leaves it alone on other edits', async () => {
    const a = bot();
    const room = group([a.id]);
    const up = await req('POST', '/api/media', { data: PNG.toString('base64') });
    expect(hub.media.has(mediaHash(up.json.ref))).toBe(true);
    expect((await req('PATCH', '/api/rooms/' + room.id, { avatar: up.json.ref })).json.avatar).toBe(up.json.ref);
    expect((await req('PATCH', '/api/rooms/' + room.id, { name: 'pics' })).json.avatar).toBe(up.json.ref);
    expect((await req('PATCH', '/api/rooms/' + room.id, { avatar: 'rocket' })).json.avatar).toBe('rocket');
    expect((await req('PATCH', '/api/rooms/' + room.id, { avatar: 'img:' + 'c'.repeat(64) })).status).toBe(400);
    expect(hub.repos.getRoom(room.id)!.avatar).toBe('rocket');
    expect(lines(room.id)).toEqual([me() + ' renamed this chat to "pics".']);
  });

  it('a new group can start with a picture; its coordinator must be in it', async () => {
    const a = bot();
    const up = await req('POST', '/api/media', { data: PNG.toString('base64') });
    const made = await req('POST', '/api/rooms', { kind: 'group', name: 'n', memberIds: [a.id], avatar: up.json.ref });
    expect(made.json.avatar).toBe(up.json.ref);
    expect((await req('POST', '/api/rooms', { kind: 'group', name: 'n', memberIds: [a.id], coordinatorBotId: 'other' })).status).toBe(400);
  });
});

/** Runs until interrupted, then reports what a stopped turn reports. */
class HoldingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Holding';
  readonly info = { id: 'claude' as ProviderId, label: 'Holding', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  started: string[] = [];
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext): Promise<TurnOutcome> {
    this.started.push(ctx.input);
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { ok: false, error: 'error_during_execution: interrupted', costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

describe('removing a bot with a turn running', () => {
  function setup() {
    const repos = new Repos(new Db(':memory:'));
    const usage = new UsageTracker(repos);
    const provider = new HoldingProvider();
    const router = new RoomRouter(repos, usage);
    const runner = new BotRunner(
      repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos), usage,
      { dispatchFromBot: (req, t) => router.dispatchFromBot(req, t), setState: () => undefined },
      { active: () => provider, get: () => provider } as unknown as ProviderRegistry, new TurnRegistry(),
    );
    router.runner = runner;
    const mk = (h: string) => repos.createBot({ name: h, handle: h, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    return { repos, router, runner, provider, mk };
  }

  it('stops the turn, drops what was queued for it, and clears both from the journal', async () => {
    const { repos, router, provider, mk } = setup();
    const [ann, bob] = [mk('ann'), mk('bob')];
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [ann.id, bob.id], coordinatorBotId: null });
    router.onUserMessage(room.id, '@ann first');
    await until(() => provider.started.length === 1);
    router.onUserMessage(room.id, '@ann second');
    const journal = () => repos.db.all('SELECT id FROM lane_journal');
    await until(() => journal().length === 2);

    repos.updateRoom(room.id, { memberIds: [bob.id] });
    router.botLeftRoom(ann.id, room.id);
    await until(() => !router.isBusy(ann.id, room.id));

    expect(provider.started).toHaveLength(1);
    expect(journal()).toEqual([]);
    // The room still works for whoever is left.
    router.onUserMessage(room.id, 'next');
    await until(() => provider.started.length === 2);
    router.botLeftRoom(bob.id, room.id);
    await until(() => !router.isBusy(bob.id, room.id));
  });

  it('a bot removed while its turn was still starting never reaches the provider', async () => {
    const { repos, runner, provider, mk } = setup();
    const [ann, bob] = [mk('ann'), mk('bob')];
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [ann.id, bob.id], coordinatorBotId: null });
    repos.updateRoom(room.id, { memberIds: [bob.id] });
    // The request was built while she was still a member.
    const res = await runner.runTurn({ bot: ann, room, members: [ann, bob], hop: 0, causeId: 'c', injected: 'x', causeBudgetUsd: 5 } as never);
    expect(provider.started).toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('removed from this chat');
  });

  it('whatever a stopped turn said hands nothing on', async () => {
    const repos = new Repos(new Db(':memory:'));
    const router = new RoomRouter(repos, new UsageTracker(repos));
    const mk = (h: string) => repos.createBot({ name: h, handle: h, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const [ann, bob] = [mk('ann'), mk('bob')];
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [ann.id, bob.id], coordinatorBotId: null });
    const reqs: string[] = [];
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    router.runner = {
      interruptLane: () => { finish(); return true; },
      runTurn: async (req: { bot: { handle: string } }) => {
        reqs.push(req.bot.handle);
        await held;
        return { ok: true, turnId: 't', finalText: '@bob take this', costUsd: 0 };
      },
    } as unknown as BotRunner;
    router.onUserMessage(room.id, '@ann go');
    await until(() => reqs.length === 1);
    repos.updateRoom(room.id, { memberIds: [bob.id] });
    router.botLeftRoom(ann.id, room.id);
    await until(() => !router.isBusy(ann.id, room.id));
    await new Promise((r) => setTimeout(r, 20));
    expect(reqs).toEqual(['ann']);
  });

  it('a bot with nothing running is a no-op', () => {
    const { repos, router, mk } = setup();
    const ann = mk('ann');
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [ann.id], coordinatorBotId: null });
    expect(() => router.botLeftRoom(ann.id, room.id)).not.toThrow();
  });
});
