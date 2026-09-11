import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ModelInfo, type ProviderCheck, type ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { PermissionBroker } from './PermissionBroker.js';
import { events } from '../events.js';
import { buildCodexArgs } from '../providers/codex.js';
import { buildConfigContent } from '../providers/opencode/server.js';
import { SettingsRejected, SettingsStore, settings as ambientSettings } from '../services/SettingsStore.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner } from '../agent/BotRunner.js';
import { createHubTools } from '../agent/botTools.js';

/**
 * Approvals bypassed: no approval card is ever raised — not for a tool call, not for a `request_approval`,
 * and (since the user asked for bots to have full control) not for a fleet or room change either.
 */

function setup(bypass: boolean) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const broker = new PermissionBroker(repos, { bypass: () => bypass });
  const ctx = { bot, room, turnId: 'turn-1', hop: 0, causeId: 'c1', setState: () => undefined };
  let cards = 0;
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') { cards++; setTimeout(() => broker.resolve(ev.approval.approvalId, 'deny'), 0); }
  });
  return { broker, ctx, cards: () => cards, off };
}

describe('bypass permissions', () => {
  it('allows a destructive Bash command and an out-of-workspace write without a card', async () => {
    const s = setup(true);
    const signal = new AbortController().signal;
    const bash = await s.broker.decide(s.ctx, 'Bash', { command: 'rm -rf /tmp/anything' }, { signal });
    const write = await s.broker.decide(s.ctx, 'Write', { file_path: '/etc/motd', content: 'hi' }, { signal });
    s.off();
    expect(bash).toEqual({ behavior: 'allow' });
    expect(write).toEqual({ behavior: 'allow' });
    expect(s.cards()).toBe(0);
  });

  it('answers request_approval yes without a card or a grant record', async () => {
    const s = setup(true);
    const r = await s.broker.ask(s.ctx, { action: 'git push', command: 'git push --force' }, new AbortController().signal);
    s.off();
    expect(r.allowed).toBe(true);
    expect(r.approvalId).toBeUndefined();
    expect(s.cards()).toBe(0);
  });

  it('allows a fleet change without a card too', async () => {
    const s = setup(true);
    const d = await s.broker.askFleetChange(s.ctx, 'delete_bot', { botId: s.ctx.bot.id }, 'delete Codey', new AbortController().signal);
    s.off();
    expect(d.allowed).toBe(true);
    expect(s.cards()).toBe(0);
  });

  it('a fleet change still asks when bypass is off', async () => {
    const s = setup(false);
    const d = await s.broker.askFleetChange(s.ctx, 'delete_bot', { botId: s.ctx.bot.id }, 'delete Codey', new AbortController().signal);
    s.off();
    expect(d.allowed).toBe(false);
    expect(s.cards()).toBe(1);
  });

  it('is off by default in the broker itself (the hub passes the live approvals setting explicitly)', async () => {
    const repos = new Repos(new Db(':memory:'));
    expect(new PermissionBroker(repos).bypassed).toBe(false);
    const s = setup(false);
    const d = await s.broker.decide(s.ctx, 'Bash', { command: 'rm -rf /tmp/anything' }, { signal: new AbortController().signal });
    s.off();
    expect(d.behavior).toBe('deny');
    expect(s.cards()).toBe(1);
  });

  it('opens the Codex and OpenCode sandboxes', () => {
    const base = { workspaceDir: 'C:\\ws', botHome: 'C:\\bots\\b1', model: 'm', mcpUrl: 'http://127.0.0.1:1/mcp', resumeToken: null };
    const full = buildCodexArgs({ ...base, readOnly: false, fullAccess: true });
    expect(full[full.indexOf('--sandbox') + 1]).toBe('danger-full-access');
    expect(full.some((a) => a.startsWith('sandbox_workspace_write'))).toBe(false);
    // A bot without Bash stays read-only even under bypass.
    const ro = buildCodexArgs({ ...base, readOnly: true, fullAccess: true });
    expect(ro[ro.indexOf('--sandbox') + 1]).toBe('read-only');

    const cfg = JSON.parse(buildConfigContent({ mcpUrl: 'http://x', mcpToken: 't', bypass: true }));
    expect(Object.values(cfg.permission).every((v) => v === 'allow')).toBe(true);
  });
});

/** Records what every turn was handed, so a test can see the approvals mode each one started under. */
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

/** A hub in miniature: the real SettingsStore feeding the real broker the way hub.ts wires them. */
function hubSetup(approvalsEnv: 'ask' | 'bypass' | null = null) {
  const repos = new Repos(new Db(':memory:'));
  const store = new SettingsStore({ repos, approvalsEnv });
  const broker = new PermissionBroker(repos, { bypass: () => store.approvals() === 'bypass' });
  const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new RecordingProvider();
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), broker, new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined },
    { active: () => provider, get: () => provider } as unknown as ProviderRegistry, new TurnRegistry(),
  );
  const run = () => runner.runTurn({ bot, room, members: [bot], injected: 'hi', hop: 0, causeId: 'c1' });
  const ctx = { bot, room, turnId: 'turn-1', hop: 0, causeId: 'c1', setState: () => undefined };
  return { repos, store, broker, provider, run, ctx };
}

describe('approvals setting', () => {
  it("defaults to 'ask': a fresh install raises cards", async () => {
    expect(DEFAULT_SETTINGS.approvals).toBe('ask');
    const h = hubSetup();
    expect(h.store.get().approvals).toBe('ask');
    expect(h.store.approvals()).toBe('ask');
    expect(h.store.approvalsLocked).toBe(false);

    let cards = 0;
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') { cards++; setTimeout(() => h.broker.resolve(ev.approval.approvalId, 'deny'), 0); }
    });
    const d = await h.broker.decide(h.ctx, 'Bash', { command: 'rm -rf /tmp/anything' }, { signal: new AbortController().signal });
    off();
    expect(d.behavior).toBe('deny');
    expect(cards).toBe(1);

    await h.run();
    expect(h.provider.seen[0].bypassPermissions).toBe(false);
  });

  it('a toggle in Settings reaches the broker and the next turn without a restart', async () => {
    const h = hubSetup();
    await h.run();
    expect(h.provider.seen[0].bypassPermissions).toBe(false);
    expect(h.provider.seen[0].systemPrompt).toContain('an approval card before anything changes');

    h.store.patch({ approvals: 'bypass' });
    const d = await h.broker.decide(h.ctx, 'Bash', { command: 'rm -rf /tmp/anything' }, { signal: new AbortController().signal });
    expect(d).toEqual({ behavior: 'allow' });
    await h.run();
    expect(h.provider.seen[1].bypassPermissions).toBe(true);
    expect(h.provider.seen[1].systemPrompt).toContain('this hub runs without approval cards');

    h.store.patch({ approvals: 'ask' });
    expect(h.broker.bypassed).toBe(false);
    await h.run();
    expect(h.provider.seen[2].bypassPermissions).toBe(false);
    // Persisted, so a restart keeps whatever the human chose.
    expect(new SettingsStore({ repos: h.repos, approvalsEnv: null }).get().approvals).toBe('ask');
  });

  it('POCKETROCKET_BYPASS_PERMISSIONS overrides the stored value and locks it', async () => {
    const on = hubSetup('bypass');
    expect(on.store.get().approvals).toBe('ask');
    expect(on.store.approvals()).toBe('bypass');
    expect(on.store.approvalsLocked).toBe(true);
    expect(on.broker.bypassed).toBe(true);
    await on.run();
    expect(on.provider.seen[0].bypassPermissions).toBe(true);
    // Locked: Settings cannot flip it, and the refusal carries a 409 for rest.ts.
    const refused = (() => {
      try { on.store.patch({ approvals: 'bypass' }); return null; } catch (e) { return e; }
    })();
    expect(refused).toBeInstanceOf(SettingsRejected);
    expect((refused as SettingsRejected).status).toBe(409);
    // Everything else still saves, and re-sending the stored value is not a change.
    expect(on.store.patch({ userName: 'Alex', approvals: 'ask' }).userName).toBe('Alex');

    const off = hubSetup('ask');
    off.repos.setSetting('approvals', 'bypass');
    off.store.reload();
    expect(off.store.approvals()).toBe('ask');
    expect(off.broker.bypassed).toBe(false);
  });

  it('no bot tool can reach the settings: they only ever see a read-only accessor', () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const tools = createHubTools({
      bot, room, members: [bot], turnId: 't1', hop: 0, causeId: 'c1', repos, memory: new MemoryService(),
      skills: new SkillService(repos), dispatchFromBot: () => [], setState: () => undefined, models: [], desktop: true,
      requestApproval: async () => ({ allowed: false, message: '' }),
    });
    expect(tools.map((t) => t.name).filter((n) => /setting|bypass|permission|provider/i.test(n))).toEqual([]);
    // botTools / PromptBuilder import this ambient accessor, never the store itself.
    expect(Object.keys(ambientSettings)).toEqual(['get']);
  });
});
