import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApprovalPayload, ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { PermissionBroker, PARKED_MESSAGE } from './PermissionBroker.js';
import { events } from '../events.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { RoutineScheduler } from '../services/RoutineScheduler.js';
import { FollowUp } from '../services/FollowUp.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner } from '../agent/BotRunner.js';
import { RoomRouter } from '../rooms/RoomRouter.js';

/**
 * P2 2.4, acceptance: "a 3 a.m. routine waits for a morning approval, then completes". A routine (strict) turn
 * whose card nobody answers does not time out into a denial: it parks (card stays pending, turn ends, slot
 * freed), survives a hub restart, and the user's answer hours later resumes the bot, which then finishes.
 * A card parked longer than the max park age (24 h) is denied. The clock is fake.
 */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const HOUR = 3_600_000;

describe('PermissionBroker parking (unit)', () => {
  function setup(now: () => number) {
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const store = new ApprovalStore(db, now);
    const broker = new PermissionBroker(repos, { store, now, parkAfterMs: 15 });
    const bot = repos.createBot({ name: 'Nightly', handle: 'nightly', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const parks: string[] = [];
    const ctx = (strict: boolean) => ({
      bot, room, turnId: 't', hop: 2, causeId: 'cause', setState: () => undefined, strictApprovals: strict, runId: 'run-9',
      park: (why: string) => parks.push(why),
    });
    return { db, repos, store, broker, bot, room, ctx, parks };
  }
  const signal = () => new AbortController().signal;

  it('a strict card nobody answers parks instead of timing out, and stays pending', async () => {
    const t = 0;
    const s = setup(() => t);
    const d = await s.broker.decide(s.ctx(true), 'Bash', { command: 'git push origin main' }, { signal: signal() });
    expect(d).toMatchObject({ behavior: 'deny', message: PARKED_MESSAGE, interrupt: true });
    expect(s.parks).toHaveLength(1);
    const [p] = s.store.listParked();
    expect(p).toMatchObject({ botId: s.bot.id, roomId: s.room.id, toolName: 'Bash', causeId: 'cause', hop: 2, runId: 'run-9' });
    const card = s.repos.messagesAfter(s.room.id, 0).find((m) => m.kind === 'approval')!;
    expect(card.payload).toMatchObject({ status: 'pending', parked: true });
    // A hub restart expires ordinary open cards, not parked ones.
    s.repos.expirePendingApprovals();
    expect(s.store.listParked()).toHaveLength(1);
    expect((s.repos.getMessage(card.id)!.payload as ApprovalPayload).status).toBe('pending');
  });

  it('a non-strict (user) card still times out the old way and never parks', async () => {
    const s = setup(() => 0);
    const broker = new PermissionBroker(s.repos, { store: s.store, parkAfterMs: 15 });
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') setTimeout(() => broker.resolve(ev.approval.approvalId, 'deny'), 30); });
    const d = await broker.decide(s.ctx(false), 'Bash', { command: 'git push' }, { signal: signal() });
    off();
    expect(d.behavior).toBe('deny');
    expect(s.parks).toHaveLength(0);
    expect(s.store.listParked()).toHaveLength(0);
  });

  it('allowing a parked card later grants exactly one retry of the same call, without a second card', async () => {
    let t = 0;
    const s = setup(() => t);
    await s.broker.decide(s.ctx(true), 'Bash', { command: 'git push origin main', description: 'push' }, { signal: signal() });
    const [p] = s.store.listParked();
    const decided: string[] = [];
    s.broker.onParkedDecision = (_p, d) => decided.push(d);
    t += 7 * HOUR; // the morning
    expect(s.broker.resolve(p.id, 'allow')).toBe(true);
    expect(decided).toEqual(['allow']);
    expect(s.store.listParked()).toHaveLength(0);
    let cards = 0;
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') { cards++; setTimeout(() => s.broker.resolve(ev.approval.approvalId, 'deny'), 0); } });
    // The retry (its description may differ) goes through once...
    expect(await s.broker.decide(s.ctx(false), 'Bash', { command: 'git push origin main', description: 'retry' }, { signal: signal() })).toEqual({ behavior: 'allow' });
    // ...and only once.
    expect((await s.broker.decide(s.ctx(false), 'Bash', { command: 'git push origin main' }, { signal: signal() })).behavior).toBe('deny');
    off();
    expect(cards).toBe(1);
  });

  it('a parked card older than the max park age is denied (fake clock)', async () => {
    let t = 1_000;
    const s = setup(() => t);
    await s.broker.askFleetChange(s.ctx(true), 'create_routine', { name: 'x' }, 'schedule x', signal());
    const decided: string[] = [];
    s.broker.onParkedDecision = (_p, d) => decided.push(d);
    t += 24 * HOUR - 1;
    expect(s.broker.sweepParked()).toEqual([]);
    t += 2;
    expect(s.broker.sweepParked()).toHaveLength(1);
    expect(decided).toEqual(['timeout']);
    const card = s.repos.messagesAfter(s.room.id, 0).find((m) => m.kind === 'approval')!;
    expect(card.payload).toMatchObject({ status: 'timeout', parked: false });
  });

  it('an answer to an unknown card is still refused', () => {
    const s = setup(() => 0);
    expect(s.broker.resolve('nope', 'allow')).toBe(false);
  });
});

class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Scripted';
  readonly info = { id: 'claude' as ProviderId, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  inputs: string[] = [];
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  /** Every turn tries the same risky push; a parked turn is cut off by the abort. */
  async runTurn(ctx: TurnContext): Promise<TurnOutcome> {
    this.inputs.push(ctx.input);
    const d = await ctx.permission('Bash', { command: 'git push origin main' });
    if (ctx.signal.aborted) return { ok: false, error: 'error_during_execution: interrupted', costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
    return { ok: d === 'allow', error: d === 'allow' ? undefined : 'denied', costUsd: 0.01, usage: { ...EMPTY_USAGE, costUsd: 0.01 }, durationMs: 1 };
  }
}

describe('a 3 a.m. routine parks on its card and completes after the morning approval', () => {
  function hub(dbFile: string, now: () => number) {
    const db = new Db(dbFile);
    const repos = new Repos(db);
    const store = new ApprovalStore(db, now);
    const usage = new UsageTracker(repos);
    // Bypass on: a routine still asks (decision Q6), and with nobody there its card parks.
    const broker = new PermissionBroker(repos, { bypass: () => true, store, now, parkAfterMs: 20 });
    const provider = new ScriptedProvider();
    const router = new RoomRouter(repos, usage);
    const runner = new BotRunner(
      repos, new MemoryService(), new SkillService(repos), broker, usage,
      { dispatchFromBot: (req, t) => router.dispatchFromBot(req, t), setState: () => undefined },
      { active: () => provider, get: () => provider } as unknown as ProviderRegistry, new TurnRegistry(),
    );
    router.runner = runner;
    broker.onParkedDecision = (p, d) => router.resumeParked(p.botId, p.roomId, { causeId: p.causeId, hop: p.hop, runId: p.runId, note: 'Approval: ' + d });
    return { db, repos, store, broker, provider, router, scheduler: new RoutineScheduler(repos, router, { timezone: () => 'UTC' }) };
  }

  it('parks, survives a restart, resumes on the answer, and closes the routine run as a success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-park-'));
    const file = path.join(dir, 'hub.db');
    let t = Date.UTC(2026, 10, 2, 3, 0); // 03:00
    const now = () => t;
    const h1 = hub(file, now);
    const bot = h1.repos.createBot({ name: 'Nightly', handle: 'nightly', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = h1.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const routine = h1.repos.createRoutine({ botId: bot.id, roomId: room.id, name: 'Deploy', cron: '0 3 * * *', prompt: 'push the release', enabled: true });
    expect(h1.scheduler.fire(routine.id)).toBe(true);

    await until(() => h1.store.listParked().length === 1);
    await until(() => !h1.router.isBusy(bot.id, room.id));
    expect(h1.repos.listRuns(routine.id)[0].status).toBe('running');
    expect(h1.repos.messagesAfter(room.id, 0).some((m) => m.kind === 'system' && /waiting for an answer/.test(m.text))).toBe(true);
    expect(h1.repos.messagesAfter(room.id, 0).some((m) => / turn ended: /.test(m.text))).toBe(false);
    h1.scheduler.stop();

    // The hub restarts overnight: the parked card and its open run survive.
    const h2 = hub(file, now);
    h2.repos.expirePendingApprovals();
    new FollowUp({ repos: h2.repos, router: h2.router, heldRuns: () => h2.store.parkedRunIds() }).resumeInterrupted();
    expect(h2.store.listParked()).toHaveLength(1);
    expect(h2.repos.listRuns(routine.id)[0].status).toBe('running');

    // 08:30: the user allows it. The bot is resumed with the answer, retries the push without a new card, finishes.
    t = Date.UTC(2026, 10, 2, 8, 30);
    let cards = 0;
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') cards++; });
    const [p] = h2.store.listParked();
    expect(h2.broker.resolve(p.id, 'allow')).toBe(true);
    await until(() => h2.repos.listRuns(routine.id)[0].status !== 'running');
    off();
    expect(h2.repos.listRuns(routine.id)[0].status).toBe('success');
    expect(cards).toBe(0);
    expect(h2.provider.inputs.at(-1)).toContain('Approval: allow');
    h2.db.raw.close();
    h1.db.raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('a trigger turn (P5) parks on its card like a routine turn', () => {
  it('parks under bypass, resumes on the answer without a second card, and stays a trigger turn', async () => {
    let t = Date.UTC(2026, 10, 2, 3, 0);
    const now = () => t;
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const store = new ApprovalStore(db, now);
    const usage = new UsageTracker(repos);
    const broker = new PermissionBroker(repos, { bypass: () => true, store, now, parkAfterMs: 20 });
    const provider = new ScriptedProvider();
    const router = new RoomRouter(repos, usage);
    router.runner = new BotRunner(
      repos, new MemoryService(), new SkillService(repos), broker, usage,
      { dispatchFromBot: (req, tg) => router.dispatchFromBot(req, tg), setState: () => undefined },
      { active: () => provider, get: () => provider } as unknown as ProviderRegistry, new TurnRegistry(),
    );
    broker.onParkedDecision = (p, d) => router.resumeParked(p.botId, p.roomId, { causeId: p.causeId, hop: p.hop, runId: p.runId, note: 'Approval: ' + d });
    const bot = repos.createBot({ name: 'Releaser', handle: 'releaser', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const results: boolean[] = [];
    const msg = router.fireTrigger(room, bot, {
      name: 'Tag pushed', prompt: 'Push the release.',
      event: { source: 'github.repo', id: 'ev-1', title: 'v1.2.0', text: 'tag created', from: 'octocat', url: 'https://github.com/acme/app', at: '2026-11-02T03:00:00Z', fields: {} },
      payload: { triggerId: 'tr', fireId: 'f', name: 'Tag pushed', source: 'github.repo', eventId: 'ev-1' },
      onDone: (r) => results.push(r.ok),
    });

    await until(() => store.listParked().length === 1);
    await until(() => !router.isBusy(bot.id, room.id));
    const [p] = store.listParked();
    expect(p).toMatchObject({ botId: bot.id, roomId: room.id, causeId: msg.id, toolName: 'Bash' });
    expect(repos.messagesAfter(room.id, 0).some((m) => m.kind === 'approval' && (m.payload as ApprovalPayload).parked)).toBe(true);

    t = Date.UTC(2026, 10, 2, 8, 30);
    let cards = 0;
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') cards++; });
    expect(broker.resolve(p.id, 'allow')).toBe(true);
    await until(() => provider.inputs.length === 2 && !router.isBusy(bot.id, room.id));
    off();
    expect(cards).toBe(0);
    expect(provider.inputs.at(-1)).toContain('Approval: allow');
    const kinds = db.raw.prepare('SELECT cause_kind AS k FROM usage WHERE cause_id = ?').all(msg.id) as { k: string }[];
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((r) => r.k === 'trigger')).toBe(true);
    db.raw.close();
  });
});
