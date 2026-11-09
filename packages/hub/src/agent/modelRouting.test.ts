import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_MODEL, MODELS, type ModelInfo, type ProviderCheck, type ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SCHEMA_SQL } from '../db/schema.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { SettingsStore } from '../services/SettingsStore.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RoomRouter } from '../rooms/RoomRouter.js';
import { MAX_TURN_CONTINUATIONS } from '../config.js';
import { BotRunner, type TurnRequest, type TurnResult } from './BotRunner.js';
import { ModelRouter } from './ModelRouter.js';

const CLAUDE: ModelInfo[] = MODELS.map((m) => ({ id: m.id, label: m.label }));

/** Plays a script of outcomes and records every context it was handed (the model and budget in particular). */
class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Scripted';
  readonly info = { id: 'claude' as ProviderId, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  constructor(private script: Array<Partial<TurnOutcome> & { text?: string }>, private list: ModelInfo[] = CLAUDE) {}
  async models(): Promise<ModelInfo[]> { return this.list; }
  modelsSync(): ModelInfo[] { return this.list; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    sink.onSession('session-' + this.seen.length);
    const step = this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    if (step.text) sink.onText(step.text);
    const costUsd = step.costUsd ?? 0.01;
    return { ok: step.ok ?? false, error: step.error, costUsd, usage: { ...EMPTY_USAGE, costUsd }, durationMs: 1 };
  }
}

function setup(script: Array<Partial<TurnOutcome> & { text?: string }>, opts: { model?: string; maxBudgetUsd?: number; list?: ModelInfo[] } = {}) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Worker', handle: 'worker', title: '', description: '', avatar: '🤖', model: opts.model ?? AUTO_MODEL, allowedTools: ['Read'], maxBudgetUsd: opts.maxBudgetUsd ?? 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new ScriptedProvider(script, opts.list);
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  const turn = (p: Partial<TurnRequest> = {}) => runner.runTurn({ bot, room, members: [bot], injected: '#1 [alex]: hello', hop: 0, causeId: 'c1', ...p });
  return { repos, bot, room, provider, runner, turn };
}

const usageRows = (repos: Repos) =>
  repos.db.all<{ model: string | null; route_reason: string | null; cause_kind: string | null; cost_usd: number }>('SELECT model, route_reason, cause_kind, cost_usd FROM usage ORDER BY id');

describe('BotRunner routes auto bots per turn', () => {
  it('runs a routine on Sonnet and records model, reason and cause kind', async () => {
    const s = setup([{ ok: true, text: 'nothing to do' }]);
    const r = await s.turn({ causeKind: 'routine', injected: '[Routine "Inbox"] anything new?' });
    expect(s.provider.seen[0].model).toBe('claude-sonnet-5');
    expect(r.model).toBe('claude-sonnet-5');
    expect(usageRows(s.repos)).toEqual([{ model: 'claude-sonnet-5', route_reason: 'routine', cause_kind: 'routine', cost_usd: 0.01 }]);
    // The bot's message carries the model and the reason for the chat chip.
    const msg = s.repos.listMessages(s.room.id).find((m) => m.authorType === 'bot')!;
    expect(msg).toMatchObject({ model: 'claude-sonnet-5', modelReason: 'Auto: Sonnet for a routine' });
  });

  it('does not let a cheaper turn hold the next one down', async () => {
    const s = setup([{ ok: true }]);
    await s.turn({ causeKind: 'trigger' });
    await s.turn();
    await s.turn({ causeKind: 'routine' });
    expect(s.provider.seen.map((c) => c.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-sonnet-5']);
  });

  it('takes the explicit ask from the newest user message the router passes', async () => {
    const s = setup([{ ok: true }]);
    await s.turn({ injected: '#1 [trigger]: ultrathink\n#2 [alex]: summarize that', latestUserText: 'summarize that' });
    await s.turn({ injected: '#3 [alex]: ultrathink this', latestUserText: 'ultrathink this' });
    expect(s.provider.seen.map((c) => c.model)).toEqual(['claude-sonnet-5', 'claude-opus-5']);
  });

  it('runs a user message on Sonnet, and a hop defaults to the bot cause kind', async () => {
    const s = setup([{ ok: true }]);
    await s.turn();
    await s.turn({ hop: 1 });
    expect(s.provider.seen.map((c) => c.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5']);
    expect(usageRows(s.repos).map((u) => u.cause_kind)).toEqual(['user', 'bot']);
  });

  it('leaves a pinned bot on its model and still records it', async () => {
    const s = setup([{ ok: true, text: 'hi' }], { model: 'claude-opus-5' });
    await s.turn({ causeKind: 'routine', injected: 'anything?' });
    expect(s.provider.seen[0].model).toBe('claude-opus-5');
    expect(usageRows(s.repos)[0]).toMatchObject({ model: 'claude-opus-5', route_reason: 'pinned', cause_kind: 'routine' });
  });

  it('keeps the step-limit continuation on the same tier and never raises the budget', async () => {
    const s = setup([{ error: 'error_max_turns', costUsd: 0.5 }, { ok: true, text: 'done', costUsd: 0.25 }], { maxBudgetUsd: 2 });
    const r = await s.turn({ causeBudgetUsd: 1.5 });
    // No Opus replay of the turn's largest context: running out of steps is not a reasoning failure.
    expect(s.provider.seen.map((c) => c.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5']);
    // min(bot budget, cause budget) first, then what is left of it: the same numbers a pinned bot gets.
    expect(s.provider.seen.map((c) => c.maxBudgetUsd)).toEqual([1.5, 1.0]);
    for (const c of s.provider.seen) expect(c.maxBudgetUsd).toBeLessThanOrEqual(s.bot.maxBudgetUsd);
    expect(r).toMatchObject({ ok: true, model: 'claude-sonnet-5' });
    expect(usageRows(s.repos).map((u) => u.route_reason)).toEqual(['default', 'default']);
    const notes = s.repos.listMessages(s.room.id).filter((m) => m.kind === 'system').map((m) => m.text);
    expect(notes.some((t) => t.includes('continuing (1/') && !t.includes('escalated'))).toBe(true);
  });

  it('gives a pinned bot the same budgets on continuation, with no escalation', async () => {
    const s = setup([{ error: 'error_max_turns', costUsd: 0.5 }], { model: 'claude-sonnet-5', maxBudgetUsd: 2 });
    await s.turn();
    expect(s.provider.seen).toHaveLength(1 + MAX_TURN_CONTINUATIONS);
    expect(new Set(s.provider.seen.map((c) => c.model))).toEqual(new Set(['claude-sonnet-5']));
    // Each continuation gets what is left: 2, then 1.5, then 1 ... for as many as MAX_TURN_CONTINUATIONS allows (1 now).
    expect(s.provider.seen.map((c) => c.maxBudgetUsd)).toEqual([2, 1.5, 1].slice(0, 1 + MAX_TURN_CONTINUATIONS));
  });

  it('records what the opt-in classifier cost against the same cause', async () => {
    const s = setup([{ ok: true }]);
    const usage = { ...EMPTY_USAGE, costUsd: 0.0008, inputTokens: 400 };
    s.runner.router = new ModelRouter({ classify: async () => ({ tier: 'opus', usage }), classifierEnabled: () => true });
    await s.turn();
    expect(s.provider.seen[0].model).toBe('claude-opus-5');
    const rows = usageRows(s.repos);
    expect(rows[0]).toMatchObject({ route_reason: 'classifier', cost_usd: 0.0008, cause_kind: 'user' });
    expect(rows[1]).toMatchObject({ model: 'claude-opus-5', route_reason: 'classifier' });
    expect(s.repos.usageTotals({ causeId: 'c1' }).costUsd).toBeCloseTo(0.0108);
  });

  it('lets bot tools set a bot to auto', async () => {
    const s = setup([{ ok: true }]);
    await s.turn();
    const createBot = s.provider.seen[0].tools.find((t) => t.name === 'create_bot');
    const modelArg = createBot!.inputSchema.shape.model as unknown as { description?: string };
    expect(modelArg.description ?? '').toContain(', ' + AUTO_MODEL + '.');
  });
});

describe('RoomRouter tells the runner what started a turn', () => {
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it('user, routine and bot hand-off', async () => {
    const repos = new Repos(new Db(':memory:'));
    const router = new RoomRouter(repos, new UsageTracker(repos));
    const mk = (h: string) => repos.createBot({ name: h, handle: h, title: '', description: '', avatar: '', model: AUTO_MODEL, allowedTools: [], maxBudgetUsd: 1 });
    const a = mk('ann');
    const b = mk('bob');
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [a.id, b.id], coordinatorBotId: a.id });
    const reqs: TurnRequest[] = [];
    router.runner = {
      runTurn: async (req: TurnRequest): Promise<TurnResult> => {
        reqs.push(req);
        // Ann hands off to Bob once, on the user's message.
        const text = req.bot.id === a.id && req.causeKind === 'user' ? '@bob please take this' : '';
        return { ok: true, turnId: 't' + reqs.length, finalText: text, costUsd: 0 };
      },
    } as unknown as BotRunner;
    router.onUserMessage(room.id, 'hello');
    await until(() => reqs.length === 2);
    router.fireRoutine(room, a, '[Routine "x"] check', null);
    await until(() => reqs.length === 3);
    expect(reqs.map((r) => [r.bot.handle, r.causeKind])).toEqual([['ann', 'user'], ['bob', 'bot'], ['ann', 'routine']]);
  });
});

describe('RoomRouter tells the runner what the person last said', () => {
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it('passes only their newest message, and nothing on a trigger that forwards text', async () => {
    const repos = new Repos(new Db(':memory:'));
    const router = new RoomRouter(repos, new UsageTracker(repos));
    const bot = repos.createBot({ name: 'a', handle: 'ann', title: '', description: '', avatar: '', model: AUTO_MODEL, allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const reqs: TurnRequest[] = [];
    router.runner = {
      runTurn: async (req: TurnRequest): Promise<TurnResult> => {
        reqs.push(req);
        return { ok: true, turnId: 't' + reqs.length, finalText: '', costUsd: 0 };
      },
    } as unknown as BotRunner;
    router.onUserMessage(room.id, 'ultrathink this');
    await until(() => reqs.length === 1);
    expect(reqs[0].latestUserText).toBe('ultrathink this');
    router.fireTrigger(room, bot, { name: 'mail', prompt: 'Sort this.', event: { source: 'webhook', id: 'e', from: 'outsider', title: 'Forwarded email', url: '', at: '', text: 'ultrathink and /opus', fields: {} } as never, payload: { triggerId: 'tr', fireId: 'f', name: 'mail', source: 'webhook', eventId: 'e' } as never });
    await until(() => reqs.length === 2);
    expect(reqs[1].causeKind).toBe('trigger');
    expect(reqs[1].injected).toContain('ultrathink');
    expect(reqs[1].latestUserText).toBeUndefined();
  });
});

describe('usage by model and cause kind', () => {
  it('groups spend for the Usage tab', () => {
    const repos = new Repos(new Db(':memory:'));
    const u = new UsageTracker(repos);
    const spend = (c: number, meta: Parameters<UsageTracker['record']>[5]) => u.record('b', 'r', 't', null, { ...EMPTY_USAGE, costUsd: c }, meta);
    spend(1, { model: 'claude-sonnet-5', causeKind: 'user' });
    spend(0.5, { model: 'claude-haiku-4-5-20251001', causeKind: 'routine' });
    spend(0.25, { model: 'claude-haiku-4-5-20251001', causeKind: 'routine' });
    spend(0.1, {});
    expect(repos.usageBy('model').map((g) => [g.key, g.costUsd, g.turns])).toEqual([
      ['claude-sonnet-5', 1, 1], ['claude-haiku-4-5-20251001', 0.75, 2], ['', 0.1, 1],
    ]);
    expect(repos.usageBy('causeKind').map((g) => [g.key, g.turns])).toEqual([['user', 1], ['routine', 2], ['', 1]]);
  });
});

describe('P8 migrations', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL */ }
    }
  });

  it('adds the columns to an older database and backfills cause kind and model from what it already has', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-p8-'));
    dirs.push(dir);
    const file = path.join(dir, 'hub.db');
    const old = new DatabaseSync(file);
    // Stand-in for a pre-P8 database: today's tables minus the P8 columns (SCHEMA_SQL never had them).
    old.exec(SCHEMA_SQL);
    const ins = old.prepare('INSERT INTO messages (id, room_id, seq, author_type, kind, text, cause_id, hop, turn_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,1)');
    ins.run('u1', 'r', 1, 'user', 'text', 'hi', 'u1', 0, null);
    ins.run('rt', 'r', 2, 'system', 'routine', 'go', 'rt', 0, null);
    ins.run('h1', 'r', 3, 'bot', 'text', 'over to you', 'u1', 1, 'turn-hop');
    const use = old.prepare('INSERT INTO usage (bot_id, room_id, turn_id, cause_id, cost_usd, model_usage, created_at) VALUES (?,?,?,?,?,?,1)');
    use.run('b', 'r', 'turn-user', 'u1', 1, JSON.stringify({ 'claude-haiku-4-5-20251001': { costUSD: 0.1 }, 'claude-sonnet-5': { costUSD: 0.9 } }));
    use.run('b', 'r', 'turn-rt', 'rt', 1, 'null');
    use.run('b', 'r', 'turn-hop', 'u1', 1, null);
    use.run('b', 'r', 'mem-abc', null, 1, '"weird"');
    old.close();

    const db = new Db(file);
    expect(db.schemaVersions()).toEqual(expect.arrayContaining([80, 81, 82, 83, 84]));
    const rows = db.all('SELECT turn_id, cause_kind, model FROM usage ORDER BY id');
    expect(rows).toEqual([
      { turn_id: 'turn-user', cause_kind: 'user', model: 'claude-sonnet-5' },
      { turn_id: 'turn-rt', cause_kind: 'routine', model: null },
      { turn_id: 'turn-hop', cause_kind: 'bot', model: null },
      { turn_id: 'mem-abc', cause_kind: 'memory', model: null },
    ]);
    // Old messages have no model, so they show no chip rather than a wrong one.
    expect(new Repos(db).getMessage('h1')!.model).toBeUndefined();
    db.raw.close();
  });
});

describe('provider switch keeps auto bots on auto', () => {
  it('does not repoint a bot whose model is auto', () => {
    const repos = new Repos(new Db(':memory:'));
    const models: Record<ProviderId, ModelInfo[]> = { claude: CLAUDE, codex: [{ id: 'gpt-x', label: 'X', default: true }], opencode: [], grok: [] };
    const store = new SettingsStore({ repos, enabled: ['claude', 'codex'], models: (p) => models[p] });
    const auto = repos.createBot({ name: 'A', handle: 'a', title: '', description: '', avatar: '', model: AUTO_MODEL, allowedTools: [], maxBudgetUsd: 1 });
    const pinned = repos.createBot({ name: 'P', handle: 'p', title: '', description: '', avatar: '', model: 'claude-opus-5', allowedTools: [], maxBudgetUsd: 1 });
    store.patch({ provider: 'codex' });
    expect(repos.getBot(auto.id)!.model).toBe(AUTO_MODEL);
    expect(repos.getBot(pinned.id)!.model).toBe('gpt-x');
  });

  it('defaults the classifier setting to off', () => {
    const repos = new Repos(new Db(':memory:'));
    expect(new SettingsStore({ repos }).get().routerClassifier).toBe(false);
  });
});
