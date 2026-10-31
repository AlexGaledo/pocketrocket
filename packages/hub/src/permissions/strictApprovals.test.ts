import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { PermissionBroker } from './PermissionBroker.js';
import { events } from '../events.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { RoutineScheduler } from '../services/RoutineScheduler.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner, type TurnRequest, type TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from '../rooms/RoomRouter.js';

/**
 * Decision Q6 (docs/specs/decisions.md): a turn started by a routine (and, from P5, a trigger) goes through
 * approvals even when the hub runs in bypass mode. Nobody is watching a 3 a.m. routine, so "the user is in
 * charge" cannot stand in for the cards.
 */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

function cardCounter(broker: PermissionBroker) {
  let cards = 0;
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') { cards++; setTimeout(() => broker.resolve(ev.approval.approvalId, 'deny'), 0); }
  });
  return { cards: () => cards, off };
}

describe('strict (routine) turns ignore bypass in the broker', () => {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const broker = new PermissionBroker(repos, { bypass: () => true });
  const ctx = (strict: boolean) => ({ bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined, strictApprovals: strict });
  const signal = () => new AbortController().signal;

  it('a normal turn under bypass raises no card', async () => {
    const c = cardCounter(broker);
    expect(await broker.decide(ctx(false), 'Bash', { command: 'rm -rf /tmp/x' }, { signal: signal() })).toEqual({ behavior: 'allow' });
    expect((await broker.askFleetChange(ctx(false), 'delete_bot', {}, 'r', signal())).allowed).toBe(true);
    c.off();
    expect(c.cards()).toBe(0);
  });

  it('a routine turn under bypass still raises a card for a risky tool, request_approval and a fleet change', async () => {
    const c = cardCounter(broker);
    const d = await broker.decide(ctx(true), 'Bash', { command: 'rm -rf /tmp/x' }, { signal: signal() });
    const a = await broker.ask(ctx(true), { action: 'git push', command: 'git push --force' }, signal());
    const f = await broker.askFleetChange(ctx(true), 'create_routine', {}, 'schedule', signal());
    c.off();
    expect(d.behavior).toBe('deny');
    expect(a.allowed).toBe(false);
    expect(f.allowed).toBe(false);
    expect(c.cards()).toBe(3);
  });

  it('still lets safe in-workspace work through without a card', async () => {
    const c = cardCounter(broker);
    expect(await broker.decide(ctx(true), 'mcp__pocketrocket__send_message', {}, { signal: signal() })).toEqual({ behavior: 'allow' });
    c.off();
    expect(c.cards()).toBe(0);
  });
});

class RecordingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Recording';
  readonly info = { id: 'claude' as ProviderId, label: 'Recording', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    return { ok: true, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

describe('routine-fired turns run in ask mode even when the hub bypasses approvals', () => {
  function hub() {
    const repos = new Repos(new Db(':memory:'));
    const usage = new UsageTracker(repos);
    const broker = new PermissionBroker(repos, { bypass: () => true });
    const provider = new RecordingProvider();
    const router = new RoomRouter(repos, usage);
    const runner = new BotRunner(
      repos, new MemoryService(), new SkillService(repos), broker, usage,
      { dispatchFromBot: (req, t) => router.dispatchFromBot(req, t), setState: () => undefined },
      { active: () => provider, get: () => provider } as unknown as ProviderRegistry, new TurnRegistry(),
    );
    router.runner = runner;
    const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    return { repos, router, provider, bot, room, scheduler: new RoutineScheduler(repos, router, { timezone: () => 'UTC' }) };
  }

  it('a user message under bypass runs with bypassPermissions', async () => {
    const h = hub();
    h.router.onUserMessage(h.room.id, 'hi');
    await until(() => h.provider.seen.length === 1);
    expect(h.provider.seen[0].bypassPermissions).toBe(true);
  });

  it('a routine fired under bypass runs with approvals on, and its prompt says cards apply', async () => {
    const h = hub();
    const r = h.repos.createRoutine({ botId: h.bot.id, roomId: h.room.id, name: 'Nightly', cron: '0 3 * * *', prompt: 'clean up', enabled: true });
    expect(h.scheduler.fire(r.id)).toBe(true);
    await until(() => h.provider.seen.length === 1);
    expect(h.provider.seen[0].bypassPermissions).toBe(false);
    expect(h.provider.seen[0].systemPrompt).toContain('an approval card before anything changes');
    h.scheduler.stop();
  });
});

describe('RoomRouter marks every turn on a non-user thread strict', () => {
  it('routine turns and the bot hops they cause are strict; user turns are not', async () => {
    const repos = new Repos(new Db(':memory:'));
    const router = new RoomRouter(repos, new UsageTracker(repos));
    const a = repos.createBot({ name: 'ann', handle: 'ann', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const b = repos.createBot({ name: 'bob', handle: 'bob', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [a.id, b.id], coordinatorBotId: a.id });
    const reqs: TurnRequest[] = [];
    router.runner = {
      runTurn: async (req: TurnRequest): Promise<TurnResult> => {
        reqs.push(req);
        return { ok: true, turnId: 't', finalText: req.bot.id === a.id && req.hop === 0 ? '@bob your turn' : '', costUsd: 0 };
      },
    } as unknown as BotRunner;

    router.onUserMessage(room.id, 'hello');
    await until(() => reqs.length === 2); // ann, then bob from ann's mention
    expect(reqs.map((r) => r.strictApprovals)).toEqual([false, false]);

    router.fireRoutine(room, a, '[Routine "x"] go', { routineId: 'r', runId: 'run', name: 'x' });
    await until(() => reqs.length === 4);
    expect(reqs.slice(2).map((r) => [r.bot.handle, r.strictApprovals])).toEqual([['ann', true], ['bob', true]]);
  });
});
