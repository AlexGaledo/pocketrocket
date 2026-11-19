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
import type { PassOutcome } from '../services/AutoMemory.js';
import { BotRunner } from './BotRunner.js';
import { ROTATE_CONTEXT_TOKENS, ROTATE_IDLE_MS, ROTATE_SEED_MESSAGES, TURN_CACHE_READ_CAP } from '../config.js';

/**
 * Token efficiency in the runner: sessions rotate instead of growing forever (legacy rows once, on their next turn),
 * the SDK's cumulative cost is turned into a per-run baseline, the system prompt keeps the memory a session started
 * with, and a turn that has read too many cached tokens is not continued.
 */

type Step = Partial<TurnOutcome> & { cacheRead?: number };

class ScriptedProvider implements AgentProvider {
  readonly label = 'Scripted';
  readonly info;
  seen: TurnContext[] = [];
  constructor(private script: Step[], readonly id: ProviderId = 'claude') {
    this.info = { id, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  }
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    const step = this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    sink.onSession(ctx.resumeToken ?? 'new-' + this.seen.length);
    const costUsd = step.costUsd ?? 0;
    return {
      ok: step.ok ?? false, error: step.error, costUsd, durationMs: 1,
      usage: { ...EMPTY_USAGE, costUsd, outputTokens: 1, cacheReadTokens: step.cacheRead ?? 0 },
      sessionCostUsd: step.sessionCostUsd, contextTokens: step.contextTokens, braked: step.braked,
    };
  }
}

function setup(script: Step[], providerId: ProviderId = 'claude') {
  const repos = new Repos(new Db(':memory:'));
  const memory = new MemoryService();
  const bot = repos.createBot({ name: 'Rota', handle: 'rota', title: '', description: 'desc', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new ScriptedProvider(script, providerId);
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, memory, new SkillService(repos), new PermissionBroker(repos), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined },
    providers, new TurnRegistry(),
  );
  const summaries: string[] = [];
  runner.summarize = async (prompt): Promise<PassOutcome> => {
    summaries.push(prompt);
    return { ok: true, text: '- the user wants the report in French', usage: { ...EMPTY_USAGE, costUsd: 0.001, inputTokens: 900, outputTokens: 40 } };
  };
  /** n conversation messages the bot has already seen. */
  const history = (n: number) => {
    for (let i = 1; i <= n; i++) {
      repos.insertMessage({ roomId: room.id, authorType: i % 2 ? 'user' : 'bot', authorId: i % 2 ? null : bot.id, kind: 'text', text: 'line ' + i, payload: null, causeId: null, hop: 0, turnId: null });
    }
    repos.saveSession(bot.id, room.id, { lastSeenSeq: repos.maxSeq(room.id) });
  };
  const resumeFrom = (token: string) => repos.saveSession(bot.id, room.id, { sdkSessionId: token, provider: providerId });
  const turn = () => runner.runTurn({ bot, room, members: [bot], injected: 'new question', hop: 0, causeId: 'c1' } as never);
  const notes = () => repos.listMessages(room.id, { limit: 200 }).filter((m) => m.kind === 'system').map((m) => m.text);
  return { repos, memory, bot, room, provider, runner, summaries, history, resumeFrom, turn, notes };
}

describe('legacy sessions (no context size recorded) rotate once, on their next turn', () => {
  it('drops the resume token, seeds the input, posts a note and baselines the cost at 0', async () => {
    const s = setup([{ ok: true, costUsd: 0.4, sessionCostUsd: 0.4, contextTokens: 9000 }]);
    s.history(4);
    s.resumeFrom('legacy-200k');
    // A pre-migration row: context_tokens and cost_total are NULL.
    expect(s.repos.getSessionState(s.bot.id, s.room.id)).toMatchObject({ contextTokens: null, costTotal: null });

    await s.turn();

    const ctx = s.provider.seen[0];
    expect(ctx.resumeToken).toBeNull();
    expect(ctx.sessionCostUsd).toBe(0);
    expect(ctx.input).toContain('Earlier context (session was reset to save tokens)');
    expect(ctx.input).toContain('line 4');
    expect(ctx.input.endsWith('new question')).toBe(true);
    expect(s.notes().some((t) => t.includes('starting a fresh session to save tokens'))).toBe(true);
    // Few messages: the seed already holds them all, so no summary call is spent.
    expect(s.summaries).toHaveLength(0);
    // The fresh session's numbers are stored, so the next turn resumes it.
    expect(s.repos.getSessionState(s.bot.id, s.room.id)).toMatchObject({ costTotal: 0.4, contextTokens: 9000 });
    expect(s.repos.getSession(s.bot.id, s.room.id, 'claude').sdkSessionId).toBe('new-1');
    // Only the turn's own cost was recorded.
    expect(s.repos.usageTotals({ botId: s.bot.id }).costUsd).toBeCloseTo(0.4);
  });

  it('does not rotate again: the next turn resumes with the stored cumulative as its baseline', async () => {
    const s = setup([{ ok: true, sessionCostUsd: 0.4, contextTokens: 9000, costUsd: 0.4 }, { ok: true, sessionCostUsd: 0.7, contextTokens: 11000, costUsd: 0.3 }]);
    s.resumeFrom('legacy');
    await s.turn();
    await s.turn();
    expect(s.provider.seen[1].resumeToken).toBe('new-1');
    expect(s.provider.seen[1].sessionCostUsd).toBe(0.4);
    expect(s.provider.seen[1].input).toBe('new question');
    expect(s.notes().filter((t) => t.includes('fresh session'))).toHaveLength(1);
    expect(s.repos.getSessionState(s.bot.id, s.room.id).costTotal).toBe(0.7);
  });

  it('a rotated run that dies before reporting a session leaves nothing old to resume', async () => {
    const s = setup([{ error: 'boom' }]);
    s.resumeFrom('legacy');
    s.provider.runTurn = async (ctx) => {
      s.provider.seen.push({ ...ctx });
      return { ok: false, error: 'boom', costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
    };
    await s.turn();
    expect(s.repos.getSession(s.bot.id, s.room.id, 'claude').sdkSessionId).toBeNull();
  });

  it('only Claude reports context sizes, so other providers keep resuming', async () => {
    const s = setup([{ ok: true }], 'codex');
    s.resumeFrom('thread-1');
    await s.turn();
    expect(s.provider.seen[0].resumeToken).toBe('thread-1');
    expect(s.notes().some((t) => t.includes('fresh session'))).toBe(false);
  });
});

describe('measured sessions rotate on size and on a cold cache', () => {
  it('a small, recent session is resumed', async () => {
    const s = setup([{ ok: true }]);
    s.resumeFrom('sess');
    s.repos.saveSessionState(s.bot.id, s.room.id, { contextTokens: 20_000, contextAt: Date.now(), costTotal: 1 });
    await s.turn();
    expect(s.provider.seen[0].resumeToken).toBe('sess');
    expect(s.provider.seen[0].sessionCostUsd).toBe(1);
  });

  it('a session past the size limit rotates and folds older messages into the running summary', async () => {
    const s = setup([{ ok: true }]);
    s.history(ROTATE_SEED_MESSAGES + 5);
    s.resumeFrom('big');
    s.repos.saveSessionState(s.bot.id, s.room.id, { contextTokens: ROTATE_CONTEXT_TOKENS + 1, contextAt: Date.now(), summary: '- old fact' });
    await s.turn();

    expect(s.provider.seen[0].resumeToken).toBeNull();
    // The summary pass sees the previous summary and only the messages the seed will not replay.
    expect(s.summaries).toHaveLength(1);
    expect(s.summaries[0]).toContain('- old fact');
    expect(s.summaries[0]).toContain('line 5');
    expect(s.summaries[0]).not.toContain('line 6\n');
    const input = s.provider.seen[0].input;
    expect(input).toContain('the user wants the report in French');
    expect(input).toContain('line ' + (ROTATE_SEED_MESSAGES + 5));
    expect(input).not.toMatch(/\]: line 5\n/);
    expect(s.repos.getSessionState(s.bot.id, s.room.id).summary).toBe('- the user wants the report in French');
    // The pass is billed to the bot, outside the thread's cause.
    expect(s.repos.usageTotals({ botId: s.bot.id }).costUsd).toBeCloseTo(0.001);
  });

  it('an idle session above the idle floor rotates; a small idle one does not', async () => {
    const big = setup([{ ok: true }]);
    big.resumeFrom('idle-big');
    big.repos.saveSessionState(big.bot.id, big.room.id, { contextTokens: 60_000, contextAt: Date.now() - ROTATE_IDLE_MS - 1000 });
    await big.turn();
    expect(big.provider.seen[0].resumeToken).toBeNull();

    const small = setup([{ ok: true }]);
    small.resumeFrom('idle-small');
    small.repos.saveSessionState(small.bot.id, small.room.id, { contextTokens: 5_000, contextAt: Date.now() - ROTATE_IDLE_MS - 1000 });
    await small.turn();
    expect(small.provider.seen[0].resumeToken).toBe('idle-small');
  });
});

describe('the system prompt keeps the memory its session started with', () => {
  it('reuses the snapshot on a warm resume and refreshes it on a fresh session', async () => {
    const s = setup([{ ok: true, contextTokens: 1000 }]);
    s.memory.write(s.bot.id, 'MEMORY-ONE');
    await s.turn(); // fresh session: snapshot taken
    expect(s.provider.seen[0].systemPrompt).toContain('MEMORY-ONE');

    s.memory.write(s.bot.id, 'MEMORY-TWO');
    await s.turn(); // resumed, warm: same bytes as before
    expect(s.provider.seen[1].resumeToken).toBe('new-1');
    expect(s.provider.seen[1].systemPrompt).toContain('MEMORY-ONE');
    expect(s.provider.seen[1].systemPrompt).not.toContain('MEMORY-TWO');

    // The cache has gone cold anyway (but the session is small, so it is resumed): the new memory is picked up.
    s.repos.saveSessionState(s.bot.id, s.room.id, { contextAt: Date.now() - ROTATE_IDLE_MS - 1000 });
    await s.turn();
    expect(s.provider.seen[2].resumeToken).toBe('new-1');
    expect(s.provider.seen[2].systemPrompt).toContain('MEMORY-TWO');
  });
});

describe('the token brake', () => {
  it('hands every run its cache-read budget, and does not continue a turn that has used it up', async () => {
    const s = setup([{ error: 'error_max_turns', cacheRead: TURN_CACHE_READ_CAP + 1 }, { ok: true }]);
    const r = await s.turn();
    expect(s.provider.seen).toHaveLength(1);
    expect(s.provider.seen[0].cacheReadBudget).toBe(TURN_CACHE_READ_CAP);
    expect(r.ok).toBe(false);
    expect(s.notes().some((t) => t.includes('stopped instead of continuing') && t.includes('cached tokens'))).toBe(true);
  });

  it('a continuation gets only what is left of the budget', async () => {
    const s = setup([{ error: 'error_max_turns', cacheRead: 1_000_000 }, { ok: true }]);
    await s.turn();
    expect(s.provider.seen).toHaveLength(2);
    expect(s.provider.seen[1].cacheReadBudget).toBe(TURN_CACHE_READ_CAP - 1_000_000);
  });
});
