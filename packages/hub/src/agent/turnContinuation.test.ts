import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner } from './BotRunner.js';
import { MAX_TURN_CONTINUATIONS, MAX_TURNS_PER_QUERY } from '../config.js';

/**
 * Running out of steps is an unfinished job, not a failure: BotRunner resumes the session instead of
 * handing back a dead turn. The bound matters as much as the behaviour — a bot looping forever must still
 * stop, so these pin the limit, the budget brake and the abort path as well as the happy case.
 */

/** Answers with a scripted sequence of outcomes, recording the context it was handed each time. */
class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Scripted';
  readonly info = { id: 'claude' as ProviderId, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  constructor(private script: Array<Partial<TurnOutcome>>) {}
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    sink.onSession('session-' + this.seen.length);
    const step = this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    const costUsd = step.costUsd ?? 0;
    return { ok: step.ok ?? false, error: step.error, costUsd, usage: { ...EMPTY_USAGE, costUsd }, durationMs: 1 };
  }
}

function setup(script: Array<Partial<TurnOutcome>>, maxBudgetUsd = 10) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Worker', handle: 'worker', title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new ScriptedProvider(script);
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos),
    new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined },
    providers, new TurnRegistry(),
  );
  return { repos, bot, room, provider, runner };
}

const systemTexts = (repos: Repos, roomId: string) =>
  repos.listMessages(roomId, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text ?? '');

describe('a turn that runs out of steps is continued, not abandoned', () => {
  it('resumes and reports success when the continuation finishes the job', async () => {
    const s = setup([{ error: 'error_max_turns' }, { ok: true }]);
    const r = await s.runner.runTurn({ bot: s.bot, room: s.room, members: [s.bot], injected: 'go', hop: 0, causeId: 'c1' } as never);

    expect(s.provider.seen).toHaveLength(2);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    // The continuation resumes the session the first run reported, and tells the model to carry on.
    expect(s.provider.seen[1].resumeToken).toBe('session-1');
    expect(s.provider.seen[1].input).toContain('Continue from exactly where you left off');
    expect(systemTexts(s.repos, s.room.id).some((t) => t.includes('continuing (1/'))).toBe(true);
  });

  it('stops at the continuation limit instead of retrying forever', async () => {
    const s = setup([{ error: 'error_max_turns' }]);
    const r = await s.runner.runTurn({ bot: s.bot, room: s.room, members: [s.bot], injected: 'go', hop: 0, causeId: 'c1' } as never);

    expect(s.provider.seen).toHaveLength(1 + MAX_TURN_CONTINUATIONS);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('error_max_turns');
  });

  it('does not continue when the budget is already spent', async () => {
    // First run costs the whole budget, so no continuation may start even though it ran out of steps.
    const s = setup([{ error: 'error_max_turns', costUsd: 1 }], 1);
    await s.runner.runTurn({ bot: s.bot, room: s.room, members: [s.bot], injected: 'go', hop: 0, causeId: 'c1' } as never);

    expect(s.provider.seen).toHaveLength(1);
  });

  it('shrinks the budget it hands each continuation by what has already been spent', async () => {
    const s = setup([{ error: 'error_max_turns', costUsd: 3 }, { ok: true }], 10);
    await s.runner.runTurn({ bot: s.bot, room: s.room, members: [s.bot], injected: 'go', hop: 0, causeId: 'c1' } as never);

    expect(s.provider.seen[0].maxBudgetUsd).toBe(10);
    expect(s.provider.seen[1].maxBudgetUsd).toBe(7);
  });

  it('leaves every other failure alone', async () => {
    const s = setup([{ error: 'error_during_execution' }]);
    const r = await s.runner.runTurn({ bot: s.bot, room: s.room, members: [s.bot], injected: 'go', hop: 0, causeId: 'c1' } as never);

    expect(s.provider.seen).toHaveLength(1);
    expect(r.error).toBe('error_during_execution');
  });

  it('never raises the per-run step limit', async () => {
    const s = setup([{ error: 'error_max_turns' }, { ok: true }]);
    await s.runner.runTurn({ bot: s.bot, room: s.room, members: [s.bot], injected: 'go', hop: 0, causeId: 'c1' } as never);

    for (const ctx of s.provider.seen) expect(ctx.maxTurns).toBe(MAX_TURNS_PER_QUERY);
  });
});
