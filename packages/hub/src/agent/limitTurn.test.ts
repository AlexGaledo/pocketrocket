import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ProviderHealth } from '../services/ProviderHealth.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type LimitReport, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { resetTime } from './turnFailure.js';
import { BotRunner } from './BotRunner.js';

/** M5 (spec 01 P0-1..P0-4) through BotRunner: the limit note, the hold, and the usage row's model. */

class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  readonly info = { id: 'claude' as ProviderId, label: 'Claude', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  constructor(private run: (sink: TurnSink) => Partial<TurnOutcome>) {}
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(_ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    return { ok: false, costUsd: 0.01, usage: { ...EMPTY_USAGE, costUsd: 0.01, inputTokens: 5 }, durationMs: 1, ...this.run(sink) };
  }
}

function setup(run: (sink: TurnSink) => Partial<TurnOutcome>) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: '', avatar: '🤖', model: 'claude-opus-5', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new ScriptedProvider(run);
  const health = new ProviderHealth();
  const providers = { active: () => provider, get: () => provider, health } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos),
    new UsageTracker(repos), { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  const turn = () => runner.runTurn({ bot, room, members: [bot], injected: 'hi', hop: 0, causeId: 'c1' } as never);
  const notes = () => repos.listMessages(room.id, { limit: 50 }).filter((m) => m.kind === 'system');
  return { repos, bot, room, health, turn, notes, runner };
}

describe('a turn that ends on a provider limit', () => {
  it('posts the note from the structured limit, holds Claude, and posts no reply', async () => {
    const resetsAt = Date.now() + 2 * 3600_000;
    const s = setup((sink) => {
      sink.onLimit?.({ status: 'rejected', kind: 'usage', window: 'five_hour', resetsAt } satisfies LimitReport);
      return { ok: false, error: 'usage limit reached (five_hour)', limit: { kind: 'usage', window: 'five_hour', resetsAt } };
    });
    const r = await s.turn();
    expect(r.ok).toBe(false);
    expect(r.finalText).toBe('');
    const [note] = s.notes();
    // M8: no backup set, so no card: the note points at the bot's settings instead.
    expect(note.text).toBe('Ada turn ended: Claude 5-hour limit reached, resets ' + resetTime(resetsAt) + ". Set a backup in Ada's settings to continue on another provider next time.");
    expect(note.payload).toEqual({ turnFailure: 'external', setBackup: true });
    // The router reads these to decide on a failover card.
    expect(r.limit).toEqual({ kind: 'usage', window: 'five_hour', resetsAt });
    expect(r.provider).toBe('claude');
    expect(s.repos.listMessages(s.room.id, { limit: 50 }).filter((m) => m.authorType === 'bot')).toEqual([]);
    expect(s.health.heldFor('claude')).toMatchObject({ status: 'held', window: 'five_hour', resetsAt });
  });

  it('M8: with a backup set the note has no pointer (the router offers the card); a sign-in failure never has one', async () => {
    const resetsAt = Date.now() + 2 * 3600_000;
    const s = setup(() => ({ ok: false, error: 'usage limit reached', limit: { kind: 'usage', window: 'five_hour', resetsAt } }));
    s.repos.updateBot(s.bot.id, { backup: { provider: 'gemini', model: 'gemini-3-pro' } } as never);
    const r = await s.runner.runTurn({ bot: s.repos.getBot(s.bot.id)!, room: s.room, members: [s.bot], injected: 'hi', hop: 0, causeId: 'c1' } as never);
    expect(r.limit?.kind).toBe('usage');
    expect(s.notes()[0].text).toBe('Ada turn ended: Claude 5-hour limit reached, resets ' + resetTime(resetsAt) + '.');
    expect(s.notes()[0].payload).toEqual({ turnFailure: 'external' });

    const a = setup(() => ({ ok: false, error: 'authentication_failed', limit: { kind: 'auth' } }));
    await a.turn();
    expect(a.notes()[0].text).not.toMatch(/backup/);
  });

  it('a warning reaches ProviderHealth without failing the turn', async () => {
    const s = setup((sink) => {
      sink.onLimit?.({ status: 'allowed_warning', kind: 'usage', window: 'five_hour', utilization: 0.85, resetsAt: Date.now() + 60_000 });
      sink.onText('Done.');
      return { ok: true };
    });
    expect((await s.turn()).ok).toBe(true);
    expect(s.health.isHeld('claude')).toBe(false);
    expect(s.health.list()).toMatchObject([{ status: 'warning', utilization: 0.85 }]);
    expect(s.notes()).toEqual([]);
  });

  it('records the model that answered on the usage row (an Opus turn the SDK ran on Sonnet)', async () => {
    const s = setup((sink) => {
      sink.onText('Done.');
      return { ok: true, model: 'claude-sonnet-5' };
    });
    await s.turn();
    expect(s.repos.usageBy('model').map((g) => g.key)).toEqual(['claude-sonnet-5']);
  });

  it('without a fallback the usage row keeps the routed model', async () => {
    const s = setup((sink) => {
      sink.onText('Done.');
      return { ok: true };
    });
    await s.turn();
    expect(s.repos.usageBy('model').map((g) => g.key)).toEqual(['claude-opus-5']);
  });
});
