import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ModelInfo, type ProviderId, type Settings } from '@pocketrocket/shared';
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
import { SWITCH_SEED_LEAD, switchNote } from '../services/SessionRotation.js';
import { BotRunner, type TurnResult } from './BotRunner.js';

/** M6 (spec 01 P1-2, P1-4, P1-7): a provider per bot, through BotRunner and the real registry. */

/**
 * The placeholder adapter (providers/stub.ts) with a turn that waits to be released or stopped, so two turns can be
 * held open at once and Stop can be aimed at one of them.
 */
class HeldProvider extends StubProvider {
  started: TurnContext[] = [];
  interrupted: string[] = [];
  private open = new Map<string, (o: Partial<TurnOutcome>) => void>();
  constructor(id: ProviderId, label: string, models: ModelInfo[]) {
    super({ id, label, blurb: '', authModes: ['subscription'], secretKeys: [], permissions: id === 'claude' ? 'full' : 'best-effort', maturity: 'verified' }, models, '');
  }
  override async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.started.push(ctx);
    sink.onInit?.({ model: ctx.model, version: this.id + '-1' });
    const extra = await new Promise<Partial<TurnOutcome>>((resolve) => this.open.set(ctx.turnId, resolve));
    sink.onSession(this.id + '-session-' + this.started.length);
    return { ok: true, costUsd: 0.01, usage: { ...EMPTY_USAGE, costUsd: 0.01, inputTokens: 3 }, durationMs: 1, contextTokens: 1000, sessionCostUsd: 0.01, ...extra };
  }
  override interrupt(turnId: string): boolean {
    const done = this.open.get(turnId);
    if (!done) return false;
    this.interrupted.push(turnId);
    this.open.delete(turnId);
    done({ ok: false, error: 'interrupted' });
    return true;
  }
  /** Ends every turn still open, successfully. */
  finish() {
    for (const [id, done] of [...this.open]) {
      this.open.delete(id);
      done({ ok: true });
    }
  }
}

const CLAUDE_MODELS: ModelInfo[] = [{ id: 'claude-sonnet-5', label: 'Sonnet 5', default: true }, { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }];
const CODEX_MODELS: ModelInfo[] = [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', default: true }];

function setup() {
  const repos = new Repos(new Db(':memory:'));
  let settings: Settings = { ...DEFAULT_SETTINGS };
  const health = new ProviderHealth();
  const providers = createProviders({ settings: { get: () => settings }, enabled: ['claude', 'codex'], health, claudeExe: () => true });
  const claude = new HeldProvider('claude', 'Claude', CLAUDE_MODELS);
  const codex = new HeldProvider('codex', 'Codex', CODEX_MODELS);
  providers.byId.claude = claude as never;
  providers.byId.codex = codex;
  const skills = new SkillService(repos);
  const runner = new BotRunner(
    repos, new MemoryService(), skills, new PermissionBroker(repos),
    new UsageTracker(repos), { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  runner.summarize = async () => ({ ok: true, text: '- earlier: the plan was agreed', usage: { ...EMPTY_USAGE }, costUsd: 0 } as never);
  const mk = (name: string, handle: string, provider: ProviderId | null) => {
    const bot = repos.createBot({ name, handle, title: '', description: name + ' writes reports.', avatar: '', model: 'auto', allowedTools: ['Read'], maxBudgetUsd: 10, provider });
    const room = repos.createRoom({ kind: 'dm', name: name, memberIds: [bot.id], coordinatorBotId: null });
    return { bot, room };
  };
  const turn = (bot: { id: string }, room: { id: string }, causeId = 'c-' + Math.random()) =>
    runner.runTurn({ bot: repos.getBot(bot.id)!, room: repos.getRoom(room.id)!, members: [repos.getBot(bot.id)!], injected: 'hi', hop: 0, causeId } as never);
  const notes = (roomId: string) => repos.listMessages(roomId, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text);
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };
  return { repos, runner, providers, claude, codex, skills, mk, turn, notes, until, setDefault: (p: ProviderId) => { settings = { ...settings, provider: p }; } };
}

describe('M6: each bot runs on its own provider (P1-2)', () => {
  it('two bots on two providers run at the same time, and Stop reaches only the provider running that turn', async () => {
    const s = setup();
    const ada = s.mk('Ada', 'ada', null); // follows the default (Claude)
    const cy = s.mk('Cy', 'cy', 'codex');
    const adaTurn = s.turn(ada.bot, ada.room);
    const cyTurn = s.turn(cy.bot, cy.room);
    await s.until(() => s.claude.started.length === 1 && s.codex.started.length === 1);
    expect(s.claude.started[0].bot.id).toBe(ada.bot.id);
    expect(s.codex.started[0].bot.id).toBe(cy.bot.id);

    // Stop Cy's turn: only Codex is asked, and Ada's Claude turn keeps running.
    expect(s.runner.interrupt(s.codex.started[0].turnId, 'owner')).toBe(true);
    expect(s.codex.interrupted).toEqual([s.codex.started[0].turnId]);
    expect(s.claude.interrupted).toEqual([]);
    const cyResult: TurnResult = await cyTurn;
    expect(cyResult.stoppedBy).toBe('owner');
    expect(s.runner.isActive(s.claude.started[0].turnId)).toBe(true);

    // A turn id no provider is running stops nothing (it used to fall through to the default provider).
    expect(s.runner.interrupt('no-such-turn')).toBe(false);

    s.claude.finish();
    expect((await adaTurn).ok).toBe(true);
    // Usage rows name the provider that ran each turn.
    expect(s.repos.usageBy('provider').map((g) => g.key).sort()).toEqual(['claude', 'codex']);
  });

  it('keeps the last init of each provider apart', async () => {
    const s = setup();
    const ada = s.mk('Ada', 'ada', null);
    const cy = s.mk('Cy', 'cy', 'codex');
    const a = s.turn(ada.bot, ada.room);
    const c = s.turn(cy.bot, cy.room);
    await s.until(() => s.claude.started.length === 1 && s.codex.started.length === 1);
    s.claude.finish();
    s.codex.finish();
    await Promise.all([a, c]);
    expect(s.runner.lastInit.claude).toMatchObject({ version: 'claude-1' });
    expect(s.runner.lastInit.codex).toMatchObject({ version: 'codex-1' });
  });

  it('a bot that follows the default moves with it; a bot with its own provider does not', async () => {
    const s = setup();
    const ada = s.mk('Ada', 'ada', null);
    const cy = s.mk('Cy', 'cy', 'claude');
    s.setDefault('codex');
    const a = s.turn(ada.bot, ada.room);
    const c = s.turn(cy.bot, cy.room);
    await s.until(() => s.claude.started.length === 1 && s.codex.started.length === 1);
    expect(s.codex.started[0].bot.id).toBe(ada.bot.id);
    expect(s.claude.started[0].bot.id).toBe(cy.bot.id);
    s.claude.finish();
    s.codex.finish();
    await Promise.all([a, c]);
  });
});

describe('M6: changing a bot\'s provider keeps the agent (P1-4)', () => {
  it('the first turn after a switch starts fresh, seeded, with a note; switching back seeds again', async () => {
    const s = setup();
    const { bot, room } = s.mk('Ada', 'ada', null);
    const say = (text: string) => s.repos.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null });
    say('Plan the launch report.');

    // Turn 1 on Claude: a session is stored for Claude.
    let t = s.turn(bot, room);
    await s.until(() => s.claude.started.length === 1);
    s.claude.finish();
    await t;
    const last = say('Ship it on Friday.');
    s.repos.saveSession(bot.id, room.id, { lastSeenSeq: last.seq });
    expect(s.repos.getSession(bot.id, room.id)).toMatchObject({ provider: 'claude', sdkSessionId: 'claude-session-1' });
    const promptOnClaude = s.claude.started[0].systemPrompt;

    // The owner moves Ada to Codex. Its next turn cannot resume Claude's session: it starts over, seeded.
    s.repos.updateBot(bot.id, { provider: 'codex' });
    t = s.turn(bot, room);
    await s.until(() => s.codex.started.length === 1);
    const onCodex = s.codex.started[0];
    expect(onCodex.resumeToken).toBeNull();
    expect(onCodex.sessionCostUsd).toBe(0);
    expect(onCodex.input).toContain('<earlier_context>');
    expect(onCodex.input).toContain(SWITCH_SEED_LEAD);
    expect(onCodex.input).toContain('Ship it on Friday.');
    // Memory and identity carry over unchanged.
    expect(onCodex.systemPrompt).toContain('Ada writes reports.');
    expect(promptOnClaude).toContain('Ada writes reports.');
    s.codex.finish();
    await t;
    expect(s.notes(room.id)).toContain(switchNote('Ada', 'Codex'));
    expect(switchNote('Ada', 'Codex')).toBe('Ada now runs on Codex; earlier context carried over as a summary.');

    // The next Codex turn resumes Codex's own session, with no new note.
    t = s.turn(bot, room);
    await s.until(() => s.codex.started.length === 2);
    expect(s.codex.started[1].resumeToken).toBe('codex-session-1');
    expect(s.codex.started[1].input).not.toContain('<earlier_context>');
    s.codex.finish();
    await t;

    // Back to Claude: a fresh, seeded session again, not the old Claude one (its cost baseline is gone).
    s.repos.updateBot(bot.id, { provider: null });
    t = s.turn(bot, room);
    await s.until(() => s.claude.started.length === 2);
    expect(s.claude.started[1].resumeToken).toBeNull();
    expect(s.claude.started[1].input).toContain(SWITCH_SEED_LEAD);
    s.claude.finish();
    await t;
    expect(s.notes(room.id).filter((n) => n.includes('now runs on'))).toEqual([switchNote('Ada', 'Codex'), switchNote('Ada', 'Claude')]);
  });
});

describe('M6: the rotation summary is a Claude pass (P1-6)', () => {
  it('a switch while Claude is not ready still seeds, without calling Haiku', async () => {
    const s = setup();
    let calls = 0;
    s.runner.summarize = async () => { calls++; return { ok: true, text: 'x', usage: { ...EMPTY_USAGE }, costUsd: 0 } as never; };
    s.runner.claudeReady = () => false;
    const { bot, room } = s.mk('Ada', 'ada', null);
    // Enough seen messages that a summary would be written for the ones older than the replayed window.
    let last = 0;
    for (let i = 0; i < 40; i++) last = s.repos.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'msg ' + i, payload: null, causeId: null, hop: 0, turnId: null }).seq;
    s.repos.saveSession(bot.id, room.id, { lastSeenSeq: last, provider: 'claude', sdkSessionId: 'old' });
    s.repos.updateBot(bot.id, { provider: 'codex' });
    const t = s.turn(bot, room);
    await s.until(() => s.codex.started.length === 1);
    expect(s.codex.started[0].input).toContain('msg 39');
    s.codex.finish();
    await t;
    expect(calls).toBe(0);
    // Ready again: the same path writes the summary.
    s.runner.claudeReady = () => true;
    s.repos.updateBot(bot.id, { provider: null });
    const t2 = s.turn(bot, room);
    await s.until(() => s.claude.started.length === 1);
    s.claude.finish();
    await t2;
    expect(calls).toBe(1);
  });
});

describe('M6: skills as text for providers other than Claude (P1-7)', () => {
  it('a Codex bot gets the skill index and read_skill; the prompt stays the same across a resumed session', async () => {
    const s = setup();
    const { bot, room } = s.mk('Cy', 'cy', 'codex');
    const skill = s.repos.upsertSkill({ name: 'weekly-report', description: 'How to write the weekly report', path: '/x/weekly-report', source: 'authored', reviewStatus: 'approved', createdByBot: null });
    const pending = s.repos.upsertSkill({ name: 'draft-thing', description: 'Not approved yet', path: '/x/draft-thing', source: 'bot', reviewStatus: 'pending', createdByBot: bot.id });
    s.repos.setBotSkills(bot.id, [skill.id, pending.id]);

    let t = s.turn(bot, room);
    await s.until(() => s.codex.started.length === 1);
    const first = s.codex.started[0];
    expect(first.systemPrompt).toContain('## Skills');
    expect(first.systemPrompt).toContain('- weekly-report: How to write the weekly report');
    expect(first.systemPrompt).not.toContain('draft-thing');
    expect(first.systemPrompt).toContain('read_skill');
    expect(first.tools.map((x) => x.name)).toContain('read_skill');
    s.codex.finish();
    await t;

    // The owner assigns another skill mid-session: the resumed session keeps the prompt it started with.
    const more = s.repos.upsertSkill({ name: 'another', description: 'Another skill', path: '/x/another', source: 'authored', reviewStatus: 'approved', createdByBot: null });
    s.repos.setBotSkills(bot.id, [skill.id, more.id]);
    t = s.turn(bot, room);
    await s.until(() => s.codex.started.length === 2);
    expect(s.codex.started[1].resumeToken).toBe('codex-session-1');
    expect(s.codex.started[1].systemPrompt).toBe(first.systemPrompt);
    s.codex.finish();
    await t;
  });

  it('a Claude bot gets neither (it loads skills from the plugin dir)', async () => {
    const s = setup();
    const { bot, room } = s.mk('Ada', 'ada', 'claude');
    const skill = s.repos.upsertSkill({ name: 'weekly-report', description: 'How to write the weekly report', path: '/x/weekly-report', source: 'authored', reviewStatus: 'approved', createdByBot: null });
    s.repos.setBotSkills(bot.id, [skill.id]);
    const t = s.turn(bot, room);
    await s.until(() => s.claude.started.length === 1);
    expect(s.claude.started[0].systemPrompt).not.toContain('## Skills');
    expect(s.claude.started[0].tools.map((x) => x.name)).not.toContain('read_skill');
    s.claude.finish();
    await t;
  });
});
