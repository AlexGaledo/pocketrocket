import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ModelInfo, type ProviderId, type ServerEvent } from '@pocketrocket/shared';
import { events } from '../events.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ProviderHealth } from '../services/ProviderHealth.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { StubProvider } from '../providers/stub.js';
import { createProviders } from '../providers/registry.js';
import { EMPTY_USAGE, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import { BotRunner } from './BotRunner.js';

/** M8 through BotRunner: a failover turn's provider and model (P3-1), and rotation for any provider that measures context (P4-1). */

class Scripted extends StubProvider {
  started: TurnContext[] = [];
  next: (sink: TurnSink) => Partial<TurnOutcome> = () => ({});
  reportsContextTokens?: boolean;
  constructor(id: ProviderId, label: string, models: ModelInfo[]) {
    super({ id, label, blurb: '', authModes: ['subscription'], secretKeys: [], permissions: id === 'claude' ? 'full' : 'best-effort', maturity: 'verified' }, models, '');
  }
  override async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.started.push(ctx);
    const extra = this.next(sink);
    sink.onSession(this.id + '-session-' + this.started.length);
    return { ok: true, costUsd: 0.01, usage: { ...EMPTY_USAGE, costUsd: 0.01, inputTokens: 3 }, durationMs: 1, sessionCostUsd: 0.01, ...extra };
  }
}

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const providers = createProviders({ settings: { get: () => ({ ...DEFAULT_SETTINGS }) }, enabled: ['claude', 'codex'], health: new ProviderHealth(), claudeExe: () => true });
  const claude = new Scripted('claude', 'Claude', [{ id: 'claude-sonnet-5', label: 'Sonnet 5', default: true }]);
  const codex = new Scripted('codex', 'Codex', [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', default: true }, { id: 'gpt-5-mini', label: 'mini' }]);
  providers.byId.claude = claude as never;
  providers.byId.codex = codex;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos),
    new UsageTracker(repos), { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  runner.summarize = async () => ({ ok: true, text: '- earlier: the plan', usage: { ...EMPTY_USAGE }, costUsd: 0 } as never);
  const bot = repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: 'Ada.', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 10, provider: 'claude' });
  const room = repos.createRoom({ kind: 'dm', name: 'Ada', memberIds: [bot.id], coordinatorBotId: null });
  const turn = (extra: Record<string, unknown> = {}) =>
    runner.runTurn({ bot: repos.getBot(bot.id)!, room: repos.getRoom(room.id)!, members: [repos.getBot(bot.id)!], injected: 'hi', hop: 0, causeId: 'c1', ...extra } as never);
  const notes = () => repos.listMessages(room.id, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text);
  return { repos, runner, claude, codex, bot, room, turn, notes };
}

describe('M8 (P3-1): a failover turn', () => {
  it('runs on the backup provider and model, seeded as a switch, and says which provider ran it', async () => {
    const s = setup();
    await s.turn();
    expect(s.claude.started).toHaveLength(1);
    const r = await s.turn({ providerOverride: { provider: 'codex', model: 'gpt-5-mini' }, strictApprovals: true, chatModel: 'claude-sonnet-5' });
    expect(s.codex.started).toHaveLength(1);
    expect(s.claude.started).toHaveLength(1);
    // The backup's model, not the bot's own nor the composer's pick; a fresh session seeded with what came before.
    expect(s.codex.started[0].model).toBe('gpt-5-mini');
    expect(s.codex.started[0].resumeToken).toBeNull();
    expect(s.codex.started[0].strictApprovals).toBe(true);
    expect(s.notes()).toContain('Ada now runs on Codex; earlier context carried over as a summary.');
    expect(r.provider).toBe('codex');
    // The bot itself is unchanged: its next ordinary turn is on Claude again (seeded once more).
    expect(s.repos.getBot(s.bot.id)!.provider).toBe('claude');
    await s.turn();
    expect(s.claude.started).toHaveLength(2);
    expect(s.claude.started[1].resumeToken).toBeNull();
  });
});

describe('M8 (P4-1): rotation for any provider that reports its context size', () => {
  const big = { contextTokens: 10_000_000 };

  it('a non-Claude provider that reports contextTokens rotates at the threshold', async () => {
    const s = setup();
    s.repos.updateBot(s.bot.id, { provider: 'codex', model: 'gpt-5-codex' });
    s.codex.reportsContextTokens = true;
    s.codex.next = () => big;
    await s.turn();
    await s.turn();
    expect(s.codex.started[1].resumeToken).toBeNull();
    expect(s.notes().some((n) => /conversation context grew large/.test(n))).toBe(true);
  });

  it('one that does not report it is never rotated on size (it is resumed)', async () => {
    const s = setup();
    s.repos.updateBot(s.bot.id, { provider: 'codex', model: 'gpt-5-codex' });
    s.codex.next = () => big;
    await s.turn();
    await s.turn();
    expect(s.codex.started[1].resumeToken).toBe('codex-session-1');
    expect(s.notes().some((n) => /grew large/.test(n))).toBe(false);
  });

  it("a provider's note (an ACP compaction) becomes a quiet system note", async () => {
    const s = setup();
    s.claude.next = (sink) => {
      sink.onNote?.('compacted its conversation context to make room; earlier details may be summarised.');
      sink.onText('Done.');
      return {};
    };
    await s.turn();
    expect(s.notes()).toContain("Ada's Claude session compacted its conversation context to make room; earlier details may be summarised.");
  });
});

describe('P4-2: turn.end carries the context meter', () => {
  const ends = async (s: ReturnType<typeof setup>) => {
    const seen: ServerEvent[] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'turn.end' && ev.botId === s.bot.id) seen.push(ev); });
    try { await s.turn(); } finally { off(); }
    return seen as Extract<ServerEvent, { type: 'turn.end' }>[];
  };

  it('with size, window and rotation point when the provider reports context size', async () => {
    const s = setup();
    s.claude.reportsContextTokens = true;
    s.claude.next = () => ({ contextTokens: 84_000, contextWindow: 1_000_000 });
    const [end] = await ends(s);
    expect(end.context).toEqual({ contextTokens: 84_000, window: 1_000_000, rotateAt: 120_000 });
    expect(s.repos.getSessionState(s.bot.id, s.room.id).contextWindow).toBe(1_000_000);
  });

  it('without it when the provider does not', async () => {
    const s = setup();
    s.claude.next = () => ({ contextTokens: 84_000 });
    const [end] = await ends(s);
    expect(end).toBeDefined();
    expect(end.context).toBeUndefined();
  });
});
