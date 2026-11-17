import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type SteerInput, type SteerResult, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner, type TurnResult } from './BotRunner.js';

/**
 * Steering, task 1.2: BotRunner.steer only reaches a live provider run, always the provider the turn started on, and
 * a steer a run leaves unconsumed is carried into the next run of the same turn (continuation, stale-session retry)
 * or returned as unanswered, never dropped.
 */

interface Step {
  ok?: boolean;
  error?: string;
  /** Hold this run open until `release()` (or Stop). */
  block?: boolean;
  /** Whether the steers this run knew of were consumed (else they come back pending). */
  consume?: boolean;
  /** Narration/reply text sent before the run returns. */
  text?: string;
}

/** A steering provider driven by a script, one step per run. */
class SteerProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly label = 'Steer';
  readonly info = { id: 'claude' as ProviderId, label: 'Steer', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  pushed: SteerInput[] = [];
  private known = new Set<string>();
  private reading = false;
  private gate: (() => void) | null = null;
  constructor(private script: Step[]) {}
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean {
    this.release();
    return true;
  }
  release() {
    const g = this.gate;
    this.gate = null;
    g?.();
  }
  steer(_turnId: string, input: SteerInput): SteerResult {
    if (!this.reading) return { status: 'queued', reason: 'between-runs' };
    this.pushed.push(input);
    this.known.add(input.uuid);
    return { status: 'accepted' };
  }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    const step = this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    this.known = new Set((ctx.carriedSteers ?? []).map((s) => s.uuid));
    this.reading = true;
    sink.onSession('session-' + this.seen.length);
    if (step.block) await new Promise<void>((r) => (this.gate = r));
    this.reading = false;
    if (step.text) sink.onText(step.text);
    const uuids = [...this.known];
    return {
      ok: step.ok ?? false, error: step.error, costUsd: 0, usage: EMPTY_USAGE, durationMs: 1,
      ...(uuids.length ? { steers: step.consume ? { consumed: uuids, pending: [] } : { consumed: [], pending: uuids } } : {}),
    };
  }
}

/** Codex-like: no live input channel. */
class PlainProvider extends SteerProvider {
  constructor(script: Step[]) {
    super(script);
    (this as { steer?: unknown }).steer = undefined;
  }
}

function setup(provider: SteerProvider) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  let active: AgentProvider = provider;
  const providers = { active: () => active, get: () => active } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  const start = (resume = false): Promise<TurnResult> => {
    if (resume) {
      repos.saveSession(bot.id, room.id, { sdkSessionId: 'old-session', provider: 'claude' });
      // Measured and recent, so the session is resumed rather than rotated.
      repos.saveSessionState(bot.id, room.id, { contextTokens: 1000, contextAt: Date.now(), costTotal: 0 });
    }
    return runner.runTurn({ bot, room, members: [bot], injected: 'go', hop: 0, causeId: 'c1' } as never);
  };
  return { repos, bot, room, runner, start, setActive: (p: AgentProvider) => { active = p; } };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const offs: (() => void)[] = [];
afterEach(() => { for (const off of offs.splice(0)) off(); });

describe('BotRunner.steer', () => {
  it('pushes into the live run and reports the steer consumed', async () => {
    const p = new SteerProvider([{ ok: true, block: true, consume: true }]);
    const s = setup(p);
    const turn = s.start();
    await until(() => p.seen.length === 1);
    const r = s.runner.steer(s.bot.id, s.room.id, { uuid: 'u1', text: '#9 [you (owner)]: use the other file' });
    expect(r.status).toBe('accepted');
    expect(r.status === 'accepted' && r.turnId).toBeTruthy();
    expect(p.pushed.map((x) => x.text)).toEqual(['#9 [you (owner)]: use the other file']);
    p.release();
    const res = await turn;
    expect(res.ok).toBe(true);
    expect(res.consumedSteers).toEqual(['u1']);
    expect(res.unansweredSteers).toEqual([]);
  });

  it('queues with no turn running, and never reaches a run that has returned (the gap between runs)', async () => {
    const p = new SteerProvider([{ error: 'error_max_turns', text: 'partial' }, { ok: true }]);
    const s = setup(p);
    expect(s.runner.steer(s.bot.id, s.room.id, { uuid: 'u0', text: 'x' })).toEqual({ status: 'queued', reason: 'between-runs' });
    // The held text of run 1 is posted after that run returned and before the continuation starts.
    const inGap: unknown[] = [];
    offs.push(events.onEvent((ev) => {
      if (ev.type === 'message.new' && ev.message.text === 'partial') inGap.push(s.runner.steer(s.bot.id, s.room.id, { uuid: 'u1', text: 'x' }));
    }));
    await s.start();
    expect(inGap).toEqual([{ status: 'queued', reason: 'between-runs' }]);
    expect(p.pushed).toHaveLength(0);
  });

  it('a provider without steer queues with reason provider', async () => {
    const p = new PlainProvider([{ ok: true, block: true }]);
    const s = setup(p);
    const turn = s.start();
    await until(() => p.seen.length === 1);
    expect(s.runner.steer(s.bot.id, s.room.id, { uuid: 'u1', text: 'x' })).toEqual({ status: 'queued', reason: 'provider' });
    p.release();
    const res = await turn;
    expect(res.consumedSteers).toBeUndefined();
  });

  it('carries a steer the step-limit run left unconsumed into the continuation', async () => {
    const p = new SteerProvider([{ error: 'error_max_turns', block: true }, { ok: true, consume: true }]);
    const s = setup(p);
    const turn = s.start();
    await until(() => p.seen.length === 1);
    expect(s.runner.steer(s.bot.id, s.room.id, { uuid: 'u1', text: 'steer one' }).status).toBe('accepted');
    p.release();
    const res = await turn;
    expect(p.seen).toHaveLength(2);
    expect(p.seen[0].carriedSteers).toBeUndefined();
    expect(p.seen[1].carriedSteers?.map((x) => x.uuid)).toEqual(['u1']);
    expect(res.consumedSteers).toEqual(['u1']);
    expect(res.unansweredSteers).toEqual([]);
  });

  it('carries a pending steer into the stale-session retry', async () => {
    const p = new SteerProvider([{ error: 'No conversation found with session ID: x', block: true }, { ok: true, consume: true }]);
    const s = setup(p);
    const turn = s.start(true);
    await until(() => p.seen.length === 1);
    expect(s.runner.steer(s.bot.id, s.room.id, { uuid: 'u1', text: 'steer one' }).status).toBe('accepted');
    p.release();
    const res = await turn;
    expect(p.seen[1].resumeToken).toBeNull();
    expect(p.seen[1].carriedSteers?.map((x) => x.uuid)).toEqual(['u1']);
    expect(res.consumedSteers).toEqual(['u1']);
  });

  it('Stop returns an unconsumed steer as unanswered, and says the turn was stopped', async () => {
    const p = new SteerProvider([{ error: 'aborted', block: true }]);
    const s = setup(p);
    const turn = s.start();
    await until(() => p.seen.length === 1);
    const r = s.runner.steer(s.bot.id, s.room.id, { uuid: 'u1', text: 'x' });
    expect(r.status).toBe('accepted');
    s.runner.interrupt((r as { turnId: string }).turnId);
    const res = await turn;
    expect(res.stopped).toBe(true);
    expect(res.consumedSteers).toEqual([]);
    expect(res.unansweredSteers).toEqual(['u1']);
    // No continuation was started for it after Stop.
    expect(p.seen).toHaveLength(1);
  });

  it('a steer goes to the provider the turn started on, even after the active provider changes', async () => {
    const p = new SteerProvider([{ ok: true, block: true, consume: true }]);
    const s = setup(p);
    const turn = s.start();
    await until(() => p.seen.length === 1);
    const other = new SteerProvider([{ ok: true }]);
    s.setActive(other);
    expect(s.runner.steer(s.bot.id, s.room.id, { uuid: 'u1', text: 'x' }).status).toBe('accepted');
    expect(p.pushed).toHaveLength(1);
    expect(other.pushed).toHaveLength(0);
    p.release();
    await turn;
  });
});
