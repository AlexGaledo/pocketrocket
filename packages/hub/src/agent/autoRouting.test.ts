import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_MODEL, MODELS, type Bot, type ModelInfo, type ProviderCheck, type ProviderId, type Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { events } from '../events.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { RoutingRules, DEFAULT_ROUTING } from '../services/RoutingRules.js';
import { PermissionBroker, type PermCtx } from '../permissions/PermissionBroker.js';
import { routingFileWrite } from '../permissions/readOnlyRoots.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RoomRouter } from '../rooms/RoomRouter.js';
import { ROUTING_PATH, WORKSPACE_DIR, botHome } from '../config.js';
import { deviceMayAccess } from '../api/guard.js';
import { createHub, type Hub } from '../hub.js';
import { BotRunner, type TurnRequest } from './BotRunner.js';
import { buildSystemPrompt } from './PromptBuilder.js';

const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const CLAUDE: ModelInfo[] = MODELS.map((m) => ({ id: m.id, label: m.label.replace(' (default)', '') }));

type Step = Partial<TurnOutcome> & { text?: string; call?: { name: string; input: Record<string, unknown> }; answers?: string[] };

class ScriptedProvider implements AgentProvider {
  readonly label = 'Scripted';
  readonly info;
  seen: TurnContext[] = [];
  answers: string[] = [];
  constructor(private script: Step[], readonly id: ProviderId = 'claude', private list: ModelInfo[] = CLAUDE) {
    this.info = { id, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  }
  async models(): Promise<ModelInfo[]> { return this.list; }
  modelsSync(): ModelInfo[] { return this.list; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    sink.onSession('session-' + this.seen.length);
    const step = this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    if (step.call) {
      const out = await ctx.tools.find((t) => t.name === step.call!.name)!.handler(step.call.input);
      this.answers.push((out.content[0] as { text: string }).text);
    }
    if (step.text) sink.onText(step.text);
    const costUsd = step.costUsd ?? 0.01;
    return { ok: step.ok ?? true, error: step.error, costUsd, usage: { ...EMPTY_USAGE, costUsd }, durationMs: 1 };
  }
}

const closeDb = (db: Db) => (db as unknown as { raw: { close(): void } }).raw.close();
const homes: string[] = [];
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-routing-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const id of homes.splice(0)) fs.rmSync(botHome(id), { recursive: true, force: true });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const MOVE_UP = { name: 'use_stronger_model', input: { reason: 'multi-step design' } };

function setup(script: Step[], opts: { model?: string; id?: ProviderId; list?: ModelInfo[]; routing?: RoutingRules; bypass?: boolean; budget?: number } = {}) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Worker', handle: 'worker', title: '', description: '', avatar: '', model: opts.model ?? AUTO_MODEL, allowedTools: ['Read'], maxBudgetUsd: opts.budget ?? 2 });
  homes.push(bot.id);
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new ScriptedProvider(script, opts.id, opts.list);
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const broker = new PermissionBroker(repos, { bypass: () => !!opts.bypass });
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), broker, new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(), undefined, { routing: opts.routing },
  );
  const turn = (p: Partial<TurnRequest> = {}) => runner.runTurn({ bot, room, members: [bot], injected: '#1 [alex]: hello', hop: 0, causeId: 'c1', ...p });
  const notes = () => repos.listMessages(room.id).filter((m) => m.kind === 'system').map((m) => m.text);
  return { repos, bot, room, provider, runner, broker, turn, notes };
}
const toolNames = (c: TurnContext) => c.tools.map((t) => t.name);

describe('use_stronger_model', () => {
  it('continues on Opus in the same session, on what is left of the budget, and says so in one line', async () => {
    const s = setup([{ call: MOVE_UP, text: 'NO_REPLY', costUsd: 0.5 }, { text: 'Here is the design.', costUsd: 0.25 }]);
    const r = await s.turn();
    expect(s.provider.seen.map((c) => c.model)).toEqual([SONNET, OPUS]);
    expect(s.provider.seen[1].resumeToken).toBe('session-1');
    expect(s.provider.seen.map((c) => c.maxBudgetUsd)).toEqual([2, 1.5]);
    expect(r).toMatchObject({ ok: true, model: OPUS, finalText: 'Here is the design.', costUsd: 0.75 });
    expect(s.notes()).toEqual(['Moved to Opus 5: multi-step design']);
    // The reply is stamped with the model that wrote it, and usage splits by model.
    const msg = s.repos.listMessages(s.room.id).find((m) => m.authorType === 'bot' && m.kind === 'text')!;
    expect(msg).toMatchObject({ model: OPUS, modelReason: expect.stringContaining('multi-step design') });
    const rows = s.repos.db.all<{ model: string; route_reason: string }>('SELECT model, route_reason FROM usage ORDER BY id');
    expect(rows).toEqual([{ model: SONNET, route_reason: 'default' }, { model: OPUS, route_reason: 'stronger' }]);
  });

  it('stores nothing: the next turn is back on Sonnet, still resuming the same conversation', async () => {
    const s = setup([{ call: MOVE_UP, text: 'NO_REPLY' }, { text: 'done' }, { text: 'next' }]);
    await s.turn();
    await s.turn({ injected: '#2 [alex]: thanks' });
    expect(s.provider.seen.map((c) => c.model)).toEqual([SONNET, OPUS, SONNET]);
    expect(s.provider.seen[2].resumeToken).toBe('session-2');
    expect(s.repos.getBot(s.bot.id)!.model).toBe(AUTO_MODEL);
  });

  it('runs once a turn, however many times it is called', async () => {
    const s = setup([{ call: MOVE_UP, text: 'NO_REPLY' }, { call: MOVE_UP, text: 'done' }]);
    await s.turn();
    expect(s.provider.seen.map((c) => c.model)).toEqual([SONNET, OPUS]);
    expect(s.provider.answers[1]).toContain('already');
    expect(s.notes()).toHaveLength(1);
  });

  it('does not start the stronger run when the budget is gone, a stop arrived, or the run failed', async () => {
    const spent = setup([{ call: MOVE_UP, text: 'NO_REPLY', costUsd: 2 }]);
    await spent.turn();
    expect(spent.provider.seen).toHaveLength(1);
    expect(spent.notes().at(-1)).toContain('budget');
    const failed = setup([{ call: MOVE_UP, ok: false, error: 'error_during_execution' }]);
    await failed.turn();
    expect(failed.provider.seen).toHaveLength(1);
  });

  it('survives the step limit: the continuation is on Opus, with no second switch', async () => {
    const s = setup([{ call: MOVE_UP, ok: false, error: 'error_max_turns' }, { text: 'done' }]);
    await s.turn();
    expect(s.provider.seen.map((c) => c.model)).toEqual([SONNET, OPUS]);
  });

  it('is offered only on Auto on Sonnet, on a thread a person started, on Claude', async () => {
    const offered = async (o: Parameters<typeof setup>[1], p: Partial<TurnRequest> = {}) => {
      const s = setup([{ text: 'x' }], o);
      await s.turn(p);
      return toolNames(s.provider.seen[0]).includes('use_stronger_model');
    };
    expect(await offered({})).toBe(true);
    expect(await offered({}, { hop: 1 })).toBe(true); // a hand-off on a person's thread
    expect(await offered({ model: SONNET })).toBe(false);
    expect(await offered({ model: OPUS })).toBe(false);
    expect(await offered({}, { chatModel: OPUS })).toBe(false);
    expect(await offered({}, { chatModel: SONNET })).toBe(false);
    expect(await offered({}, { latestUserText: 'ultrathink' })).toBe(false); // already on Opus
    // Forwarded text must not be able to buy Opus.
    expect(await offered({}, { causeKind: 'routine' })).toBe(false);
    expect(await offered({}, { causeKind: 'trigger' })).toBe(false);
    expect(await offered({}, { causeKind: 'bot', hop: 1, strictApprovals: true })).toBe(false);
    expect(await offered({ id: 'codex', list: [{ id: 'gpt-a', label: 'A', default: true }, { id: 'gpt-b', label: 'B', note: 'hardest tasks' }] })).toBe(false);
    }, 30_000);
});

describe('the chat picker', () => {
  it('runs the pick, keeps the bot as it was, and resumes the session across every change of model', async () => {
    const s = setup([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]);
    await s.turn({ chatModel: OPUS });
    await s.turn({ chatModel: HAIKU });
    await s.turn({ chatModel: AUTO_MODEL });
    await s.turn();
    expect(s.provider.seen.map((c) => c.model)).toEqual([OPUS, HAIKU, SONNET, SONNET]);
    expect(s.provider.seen.map((c) => c.resumeToken)).toEqual([null, 'session-1', 'session-2', 'session-3']);
    expect(s.repos.getBot(s.bot.id)!.model).toBe(AUTO_MODEL);
    const msg = s.repos.listMessages(s.room.id).find((m) => m.text === 'a')!;
    expect(msg.modelReason).toBe('Chosen for this chat');
    expect(s.repos.db.all<{ route_reason: string }>('SELECT route_reason FROM usage ORDER BY id')[0].route_reason).toBe('chosen');
  });

  it('a manual pick never escalates, and Auto on a pinned bot does', async () => {
    const pick = setup([{ ok: false, error: 'error_max_turns' }, { text: 'done' }]);
    await pick.turn({ chatModel: SONNET });
    expect(pick.provider.seen.map((c) => c.model)).toEqual([SONNET, SONNET]);
    const auto = setup([{ ok: false, error: 'error_max_turns' }, { text: 'done' }], { model: HAIKU });
    await auto.turn({ chatModel: AUTO_MODEL });
    expect(auto.provider.seen.map((c) => c.model)).toEqual([SONNET, OPUS]);
  });

  it('is ignored by other providers, and for an id the provider does not list', async () => {
    const list: ModelInfo[] = [{ id: 'gpt-a', label: 'A', default: true }];
    for (const chatModel of [OPUS, AUTO_MODEL]) {
      const s = setup([{ text: 'x' }], { id: 'codex', list, model: 'gpt-a' });
      await s.turn({ chatModel });
      expect(s.provider.seen[0].model).toBe('gpt-a');
    }
    const gone = setup([{ text: 'x' }], { model: SONNET });
    await gone.turn({ chatModel: 'claude-old' });
    expect(gone.provider.seen[0].model).toBe(SONNET);
  });
});

describe('RoomRouter and the pick', () => {
  function roomSetup() {
    const repos = new Repos(new Db(':memory:'));
    const mk = (handle: string, model: string) => repos.createBot({ name: handle, handle, title: '', description: '', avatar: '', model, allowedTools: ['Read'], maxBudgetUsd: 1 });
    const a = mk('alpha', AUTO_MODEL);
    const b = mk('beta', HAIKU);
    homes.push(a.id, b.id);
    const room = repos.createRoom({ kind: 'group', name: 'team', memberIds: [a.id, b.id], coordinatorBotId: a.id });
    const router = new RoomRouter(repos, new UsageTracker(repos));
    const seen: TurnRequest[] = [];
    router.runner = { runTurn: async (r: TurnRequest) => { seen.push(r); return { ok: true, turnId: 't', finalText: r.hop === 0 && r.bot.id === a.id ? '@beta please check' : '', costUsd: 0 }; }, interrupt: () => false } as never;
    const idle = async () => { for (let i = 0; i < 40 && (router.isBusy(a.id, room.id) || router.isBusy(b.id, room.id)); i++) await new Promise((res) => setTimeout(res, 5)); };
    return { repos, a, b, room, router, seen, idle };
  }

  it('applies to the turn a person starts and stays on, while the hand-off it causes uses the bot\'s own model', async () => {
    const s = roomSetup();
    s.repos.setRoomChatModel(s.room.id, OPUS);
    s.router.onUserMessage(s.room.id, 'hello');
    await s.idle();
    expect(s.seen.map((r) => [r.bot.handle, r.hop, r.chatModel])).toEqual([['alpha', 0, OPUS], ['beta', 1, undefined]]);
    s.seen.length = 0;
    s.router.onUserMessage(s.room.id, 'again');
    await s.idle();
    expect(s.seen[0].chatModel).toBe(OPUS);
    s.repos.setRoomChatModel(s.room.id, null);
    s.seen.length = 0;
    s.router.onUserMessage(s.room.id, 'cleared');
    await s.idle();
    expect(s.seen[0].chatModel).toBeUndefined();
  });

  it('never reaches a routine, a trigger, or a routine resumed after a restart', async () => {
    const s = roomSetup();
    s.repos.setRoomChatModel(s.room.id, OPUS);
    const msg = s.router.fireRoutine(s.room, s.b, 'check the inbox', null);
    await s.idle();
    expect(s.seen[0]).toMatchObject({ causeKind: 'routine', routinePrompt: 'check the inbox' });
    expect(s.seen[0].chatModel).toBeUndefined();
    s.seen.length = 0;
    s.router.resume(s.b, s.room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, attempts: 1 });
    await s.idle();
    expect(s.seen[0].causeKind).toBe('routine');
    expect(s.seen[0].chatModel).toBeUndefined();
    s.seen.length = 0;
    s.router.fireTrigger(s.room, s.b, { name: 't', prompt: 'p', event: { source: 'gmail', id: '1', title: 't', text: 'body', from: 'x', url: '', at: '', fields: {} }, payload: { triggerId: 't1', fireId: 'f1', name: 't', source: 'gmail', eventId: '1' } as never });
    await s.idle();
    expect(s.seen[0].causeKind).toBe('trigger');
    expect(s.seen[0].chatModel).toBeUndefined();
  });

  it('a person\'s turn resumed after a restart keeps the pick', async () => {
    const s = roomSetup();
    s.repos.setRoomChatModel(s.room.id, OPUS);
    const msg = s.repos.insertMessage({ roomId: s.room.id, authorType: 'user', authorId: null, kind: 'text', text: 'hi', payload: null, causeId: null, hop: 0, turnId: null });
    s.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
    s.router.resume(s.b, s.room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, attempts: 1 });
    await s.idle();
    expect(s.seen[0]).toMatchObject({ causeKind: 'user', chatModel: OPUS });
  });
});

describe('routing.md belongs to the owner', () => {
  it('reads the seed, strips comments, caps the prompt and never overwrites the owner', () => {
    const f = path.join(tmp(), 'routing.md');
    const r = new RoutingRules(f);
    expect(r.read()).toBe(DEFAULT_ROUTING);
    expect(r.promptText()).not.toContain('<!--');
    r.ensureSeeded();
    expect(fs.readFileSync(f, 'utf8')).toBe(DEFAULT_ROUTING);
    r.write('- mine\n');
    r.ensureSeeded();
    expect(r.read()).toBe('- mine\n');
    expect(() => r.write('x'.repeat(3000))).toThrow(/limited/);
    fs.writeFileSync(f, 'é'.repeat(3000)); // edited over SSH, too long and cut mid-character
    const capped = r.promptText();
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(2048);
    expect(capped).not.toContain('�');
  });

  it('refuses a bot writing it in every approvals mode, with no card', async () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'B', handle: 'bb', title: '', description: '', avatar: '', model: SONNET, allowedTools: ['Read', 'Write', 'Bash'], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined } as unknown as PermCtx;
    const signal = new AbortController().signal;
    const attempts: [string, Record<string, unknown>][] = [
      ['Write', { file_path: ROUTING_PATH, content: '- hijacked' }],
      ['Edit', { file_path: ROUTING_PATH, old_string: 'a', new_string: 'b' }],
      ['Bash', { command: 'echo hijacked > ' + ROUTING_PATH.replace(/\\/g, '/') }],
      ['Bash', { command: 'cd ' + path.dirname(WORKSPACE_DIR).replace(/\\/g, '/') + ' && tee routing.md < /dev/null' }],
      ['Bash', { command: 'echo x >> ../routing.md' }],
    ];
    for (const bypass of [false, true]) {
      const broker = new PermissionBroker(repos, { bypass: () => bypass });
      for (const [name, input] of attempts) {
        const r = await broker.decide(ctx, name, input, { signal });
        expect(r.behavior, name + ' ' + JSON.stringify(input) + ' bypass=' + bypass).toBe('deny');
      }
      expect(await broker.ask(ctx, { action: 'edit', command: 'echo x > ' + ROUTING_PATH.replace(/\\/g, '/') }, signal)).toMatchObject({ allowed: false });
    }
    expect(repos.listMessages(room.id)).toEqual([]);
    // Reading it, or writing next to it, is not refused here.
    expect(routingFileWrite('Bash', { command: 'cat ' + ROUTING_PATH.replace(/\\/g, '/') }, WORKSPACE_DIR)).toBeNull();
    expect(routingFileWrite('Write', { file_path: path.join(WORKSPACE_DIR, 'routing.md') }, WORKSPACE_DIR)).toBeNull();
    expect(routingFileWrite('Read', { file_path: ROUTING_PATH }, WORKSPACE_DIR)).toBeNull();
  });

  it('adds a proposed line only when the owner says yes on the card, under bypass too', async () => {
    const file = path.join(tmp(), 'routing.md');
    const routing = new RoutingRules(file);
    routing.write('- first\n');
    const line = { name: 'propose_routing_change', input: { line: 'Invoices  go to @finance', reason: 'Asked for it' } };
    for (const [decision, expected] of [['deny', '- first\n'], ['allow', '- first\n- Invoices go to @finance\n']] as const) {
      const s = setup([{ call: line, text: 'ok' }], { routing, bypass: true });
      const off = events.onEvent((ev) => { if (ev.type === 'approval.request') setTimeout(() => s.broker.resolve(ev.approval.approvalId, decision), 0); });
      await s.turn();
      off();
      expect(fs.readFileSync(file, 'utf8')).toBe(expected);
      const card = s.repos.listMessages(s.room.id).find((m) => m.kind === 'approval')!;
      expect(card.payload).toMatchObject({ toolName: 'propose_routing_change', toolInput: { line: 'Invoices go to @finance' } });
    }
  });

  it('refuses a proposal that would not fit, before any card', async () => {
    const file = path.join(tmp(), 'routing.md');
    const routing = new RoutingRules(file);
    routing.write('x'.repeat(2000));
    const s = setup([{ call: { name: 'propose_routing_change', input: { line: 'y'.repeat(200), reason: 'why' } }, text: 'ok' }], { routing });
    await s.turn();
    expect(s.provider.answers[0]).toMatch(/full/);
    expect(s.repos.listMessages(s.room.id).some((m) => m.kind === 'approval')).toBe(false);
  });

  it('is proposed only on a turn the owner started, never on automation or a hand-off', async () => {
    const routing = new RoutingRules(path.join(tmp(), 'routing.md'));
    const offered = async (p: Partial<TurnRequest>) => {
      const s = setup([{ text: 'x' }], { routing });
      await s.turn(p);
      return toolNames(s.provider.seen[0]).includes('propose_routing_change');
    };
    expect(await offered({})).toBe(true);
    expect(await offered({ causeKind: 'routine', strictApprovals: true })).toBe(false);
    expect(await offered({ causeKind: 'trigger', strictApprovals: true })).toBe(false);
    expect(await offered({ causeKind: 'bot', hop: 1 })).toBe(false);
  });

  it('rides the prompt as the owner\'s instructions, with the tools only when offered', () => {
    const bot = { id: 'b', name: 'B', handle: 'bb', title: '', description: '' } as Bot;
    const room: Room = { id: 'r', kind: 'dm', name: 'DM', memberIds: ['b'], coordinatorBotId: null, createdAt: 0 };
    const base = { bot, room, members: [bot], hop: 0, memory: '', identity: '' };
    expect(buildSystemPrompt(base)).not.toContain('## Routing');
    const p = buildSystemPrompt({ ...base, routing: '- Invoices go to @finance', canMoveUp: true, canProposeRouting: true });
    expect(p).toContain('- Invoices go to @finance');
    expect(p).toContain('use_stronger_model');
    expect(p).toContain('propose_routing_change');
    const q = buildSystemPrompt({ ...base, routing: '- Invoices go to @finance' });
    expect(q).toContain('- Invoices go to @finance');
    expect(q).not.toContain('use_stronger_model');
    expect(q).not.toContain('propose_routing_change');
  });
});

describe('a first hand-off to a bot outside the chat', () => {
  function brokerSetup(opts: { bypass?: boolean } = {}) {
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const bot = repos.createBot({ name: 'A', handle: 'aa', title: '', description: '', avatar: '', model: SONNET, allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const store = new ApprovalStore(db);
    const broker = new PermissionBroker(repos, { store, bypass: () => !!opts.bypass });
    const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined } as unknown as PermCtx;
    const cards = () => repos.listMessages(room.id).filter((m) => m.kind === 'approval').length;
    const ask = (to: string, c: PermCtx = ctx) => broker.askOutsideHandoff(c, { to_bot: to, task: 'x' }, 'why', new AbortController().signal);
    return { repos, store, broker, ctx, cards, ask, bot };
  }
  const answering = (broker: PermissionBroker, decision: 'allow' | 'deny', o?: { device?: boolean }) =>
    events.onEvent((ev) => { if (ev.type === 'approval.request') setTimeout(() => broker.resolve(ev.approval.approvalId, decision, o), 0); });

  it('shows a card the first time per pair, and not again', async () => {
    const s = brokerSetup();
    const off = answering(s.broker, 'allow');
    expect((await s.ask('finance')).allowed).toBe(true);
    expect((await s.ask('finance')).allowed).toBe(true);
    expect(s.cards()).toBe(1);
    await s.ask('research'); // another bot is another first time
    off();
    expect(s.cards()).toBe(2);
    expect(s.store.listPolicies(s.bot.id).map((p) => [p.tool, p.pattern, p.decision])).toEqual([['handoff', 'finance', 'allow'], ['handoff', 'research', 'allow']]);
  });

  it('shows the card under bypass too, because that bot has different logins', async () => {
    const s = brokerSetup({ bypass: true });
    const off = answering(s.broker, 'allow');
    await s.ask('finance');
    off();
    expect(s.cards()).toBe(1);
  });

  it('asks again after a no, and after the rule is revoked', async () => {
    const s = brokerSetup();
    let off = answering(s.broker, 'deny');
    expect((await s.ask('finance')).allowed).toBe(false);
    off();
    expect(s.store.listPolicies(s.bot.id)).toEqual([]);
    off = answering(s.broker, 'allow');
    await s.ask('finance');
    off();
    expect(s.cards()).toBe(2);
    s.store.removePolicy(s.store.listPolicies(s.bot.id)[0].id);
    const again = answering(s.broker, 'deny');
    expect((await s.ask('finance')).allowed).toBe(false);
    again();
    expect(s.cards()).toBe(3);
  });

  it('a paired device answers once and records no standing rule', async () => {
    const s = brokerSetup();
    const off = answering(s.broker, 'allow', { device: true });
    expect((await s.ask('finance')).allowed).toBe(true);
    off();
    expect(s.store.listPolicies(s.bot.id)).toEqual([]);
  });

  it('a routine or trigger turn always asks, and records nothing', async () => {
    const s = brokerSetup();
    const strict = { ...s.ctx, strictApprovals: true } as PermCtx;
    let off = answering(s.broker, 'allow');
    await s.ask('finance');
    await s.ask('finance', strict);
    off();
    expect(s.cards()).toBe(2);
    expect(s.store.listPolicies(s.bot.id)).toHaveLength(1);
    s.store.removePolicy(s.store.listPolicies(s.bot.id)[0].id);
    off = answering(s.broker, 'allow');
    await s.ask('finance', strict);
    off();
    expect(s.store.listPolicies(s.bot.id)).toEqual([]);
  });
});

describe('a hand-off from a DM, through the real router and runner', () => {
  it('asks, runs the bot in its own chat on its own model, and brings one result back', async () => {
    const repos = new Repos(new Db(':memory:'));
    const mk = (handle: string, model: string) => repos.createBot({ name: handle, handle, title: '', description: '', avatar: '', model, allowedTools: ['Read'], maxBudgetUsd: 1 });
    const chief = mk('chief', AUTO_MODEL);
    const fin = mk('finance', HAIKU);
    homes.push(chief.id, fin.id);
    const dm = repos.createRoom({ kind: 'dm', name: 'Chief', memberIds: [chief.id], coordinatorBotId: null });
    repos.setRoomChatModel(dm.id, OPUS);
    const usage = new UsageTracker(repos);
    const router = new RoomRouter(repos, usage);
    const provider = new ScriptedProvider([
      { call: { name: 'handoff', input: { to_bot: '@finance', task: 'Compare the invoices' } }, text: 'Passed it on.' },
      { text: 'Invoices compared: all match.' },
    ]);
    const broker = new PermissionBroker(repos);
    const runner = new BotRunner(
      repos, new MemoryService(), new SkillService(repos), broker, usage,
      { dispatchFromBot: (req, targets, onDone) => router.dispatchFromBot(req, targets, onDone), setState: (b, r, s, n) => router.setState(b, r, s, n) },
      { active: () => provider, get: () => provider } as unknown as ProviderRegistry, new TurnRegistry(),
    );
    router.runner = runner;
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') setTimeout(() => broker.resolve(ev.approval.approvalId, 'allow'), 0); });
    router.onUserMessage(dm.id, 'Who can check the invoices?');
    const work = () => repos.listRooms().find((r) => r.memberIds[0] === fin.id);
    for (let i = 0; i < 200 && !(work() && !router.isBusy(chief.id, dm.id) && !router.isBusy(fin.id, work()!.id)); i++) await new Promise((res) => setTimeout(res, 5));
    off();
    // The pick is for the turn the person started; the hand-off uses the target's own model and session.
    expect(provider.seen.map((c) => [c.bot.handle, c.model, c.resumeToken])).toEqual([['chief', OPUS, null], ['finance', HAIKU, null]]);
    expect(repos.getRoom(dm.id)!.memberIds).toEqual([chief.id]);
    const here = repos.listMessages(dm.id);
    expect(here.filter((m) => m.kind === 'approval')).toHaveLength(1);
    expect(here.filter((m) => m.kind === 'handoff')).toHaveLength(1);
    expect(here.at(-1)).toMatchObject({ authorId: fin.id, text: 'Invoices compared: all match.', payload: { workRoomId: work()!.id } });
    // It is the same thread, so the hop and cost caps still bound it.
    const there = repos.listMessages(work()!.id).find((m) => m.authorId === fin.id)!;
    expect(there).toMatchObject({ hop: 1, causeId: here[0].id });
    // The chief reads the result on its next turn.
    expect(repos.messagesAfter(dm.id, 0).some((m) => m.authorId === fin.id && m.kind === 'text')).toBe(true);
  });
});

describe('REST', () => {
  let hub: Hub;
  let base: string;
  let room: Room;
  let bot: Bot;
  const file = path.join(os.tmpdir(), 'pr-routing-rest-' + process.pid + '.md');
  const api = async <T>(method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };
  beforeAll(async () => {
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null, routingFile: file });
    base = 'http://127.0.0.1:' + (await hub.listen());
    bot = (await api<Bot>('POST', '/api/bots', { name: 'Picky', handle: 'picky' + process.pid })).body;
    room = (await api<Room>('POST', '/api/rooms', { kind: 'dm', name: 'Picky', memberIds: [bot.id] })).body;
  });
  afterAll(async () => {
    fs.rmSync(botHome(bot.id), { recursive: true, force: true });
    fs.rmSync(file, { force: true });
    await hub.shutdown();
  });

  it('stores the pick on the chat, leaves the bot alone, and refuses anything else', async () => {
    const before = (await api<Bot[]>('GET', '/api/bots')).body.find((b) => b.id === bot.id)!.model;
    expect((await api<Room>('PUT', '/api/rooms/' + room.id + '/model', { model: OPUS })).body.chatModel).toBe(OPUS);
    expect((await api<Room[]>('GET', '/api/rooms')).body.find((r) => r.id === room.id)!.chatModel).toBe(OPUS);
    expect((await api<Bot[]>('GET', '/api/bots')).body.find((b) => b.id === bot.id)!.model).toBe(before);
    // PATCHing the room does not lose it.
    await api('PATCH', '/api/rooms/' + room.id, { name: 'Renamed' });
    expect((await api<Room[]>('GET', '/api/rooms')).body.find((r) => r.id === room.id)!.chatModel).toBe(OPUS);
    for (const bad of ['claude-fable-5-1', 'nonsense', 3]) expect((await api('PUT', '/api/rooms/' + room.id + '/model', { model: bad })).status).toBe(400);
    expect((await api('PUT', '/api/rooms/nope/model', { model: OPUS })).status).toBe(404);
    expect((await api<Room>('PUT', '/api/rooms/' + room.id + '/model', { model: null })).body.chatModel).toBeNull();
  });

  it('reads and writes the rules, within the limit', async () => {
    expect((await api<{ text: string }>('PUT', '/api/routing', { text: '- Invoices go to @finance\n' })).status).toBe(200);
    expect((await api<{ text: string }>('GET', '/api/routing')).body.text).toBe('- Invoices go to @finance\n');
    expect((await api('PUT', '/api/routing', { text: 'x'.repeat(3000) })).status).toBe(400);
    expect((await api('PUT', '/api/routing', { text: 'é'.repeat(1500) })).status).toBe(400); // over in bytes
    expect((await api<{ text: string }>('GET', '/api/routing')).body.text).toBe('- Invoices go to @finance\n');
  });

  it('adds the chat_model column to an older database', () => {
    const file = path.join(tmp(), 'old.db');
    const db = new Db(file);
    db.run('ALTER TABLE rooms DROP COLUMN chat_model');
    db.run("DELETE FROM schema_version WHERE version=101");
    closeDb(db);
    const repos = new Repos(new Db(file));
    const bot2 = repos.createBot({ name: 'x', handle: 'xx', title: '', description: '', avatar: '', model: SONNET, allowedTools: [], maxBudgetUsd: 1 });
    const r = repos.createRoom({ kind: 'dm', name: 'x', memberIds: [bot2.id], coordinatorBotId: null });
    expect(r.chatModel).toBeNull();
    expect(repos.setRoomChatModel(r.id, OPUS)!.chatModel).toBe(OPUS);
    closeDb(repos.db);
  });

  it('refuses a paired device on both, and no bot tool reaches either', async () => {
    expect(deviceMayAccess('PUT', '/api/rooms/r1/model')).toBe(false);
    expect(deviceMayAccess('PUT', '/api/routing')).toBe(false);
    expect(deviceMayAccess('GET', '/api/routing')).toBe(false);
    const s = setup([{ text: 'x' }]);
    await s.turn();
    const names = toolNames(s.provider.seen[0]);
    expect(names.some((n) => /routing/.test(n) && n !== 'propose_routing_change')).toBe(false);
    expect(names.some((n) => /chat_?model|set_model|settings/i.test(n))).toBe(false);
  });
});
