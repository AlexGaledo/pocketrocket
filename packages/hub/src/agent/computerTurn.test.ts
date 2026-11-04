import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ComputersRepo } from '../db/computers.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ComputerManager, unitName, type Systemctl } from '../services/ComputerManager.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { causeCostCap, spendCapsOff } from '../config.js';
import { BotRunner } from './BotRunner.js';
import { SHARED_BROWSER_NOTE, SHARED_TAB_NOTE } from './desktopTools.js';

/** P1 task 1.3: each bot's turn is wired to its own computer (CDP endpoint, prompt, roots). */

class RecordingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Recording';
  readonly info = { id: 'claude' as ProviderId, label: 'Recording', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  onRun: () => void = () => undefined;
  /** The turn calls a browser tool, which is what starts a computer. What the gate answered is kept per turn. */
  usesBrowser = true;
  gate: (string | null | undefined)[] = [];
  /** Keeps the next turn open until this settles, so another can overlap it. */
  hold: Promise<void> | null = null;
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    if (this.usesBrowser) this.gate.push(await ctx.computerGate?.('mcp__browser__browser_navigate'));
    const hold = this.hold;
    this.hold = null;
    this.onRun();
    await hold;
    sink.onToolUse('t1', 'mcp__browser__browser_navigate', { url: 'https://example.com' });
    sink.onText('done');
    return { ok: true, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

class FakeSystemctl implements Systemctl {
  active = new Set<string>();
  async start(u: string) { this.active.add(u); }
  async stop(u: string) { this.active.delete(u); }
  async isActive(u: string) { return this.active.has(u); }
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(opts: { enabled?: boolean; maxRunning?: number } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-turn-'));
  dirs.push(dir);
  const sys = new FakeSystemctl();
  let now = 1_000;
  const computers = new ComputerManager(new ComputersRepo(db), {
    enabled: opts.enabled ?? true, maxRunning: opts.maxRunning ?? 3, dir, dataDir: dir, systemctl: sys,
    probe: async () => true, now: () => now, startTimeoutMs: 20, pollMs: 1, quotaBytes: 100,
  });
  const provider = new RecordingProvider();
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(), computers,
  );
  const mk = (handle: string, tools: string[]) => {
    const bot = repos.createBot({ name: handle, handle, title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: tools, maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM ' + handle, memberIds: [bot.id], coordinatorBotId: null });
    return { bot, room };
  };
  const run = (b: ReturnType<typeof mk>) => runner.runTurn({ bot: b.bot, room: b.room, members: [b.bot], injected: 'hi', hop: 0, causeId: 'c-' + b.bot.id });
  return { computers, sys, provider, mk, run, runner, repos, advance: (ms: number) => (now += ms) };
}

describe('turns on per-bot computers', () => {
  it('starts each Browser bot its own computer and points the Browser tool at its own CDP port', async () => {
    const s = setup();
    const a = s.mk('alpha', ['Read', 'Browser']);
    const b = s.mk('beta', ['Read', 'Browser']);
    await s.run(a);
    await s.run(b);
    const [ca, cb] = s.provider.seen;
    expect(ca.cdpUrl).toBe('http://127.0.0.1:9401');
    expect(cb.cdpUrl).toBe('http://127.0.0.1:9402');
    expect(ca.computerFilesDir).not.toBe(cb.computerFilesDir);
    expect(s.sys.active).toEqual(new Set([unitName(1, a.bot.id), unitName(2, b.bot.id)]));
    expect(ca.systemPrompt).toContain('## Your computer');
    expect(ca.systemPrompt).toContain('display :201');
    expect(cb.systemPrompt).toContain('display :202');
    expect(ca.systemPrompt).toContain('~/Shared');
    expect(ca.allowedBuiltins).toContain('Browser');
  });

  it('does not start a computer for a bot without Browser or Desktop', async () => {
    const s = setup();
    await s.run(s.mk('plain', ['Read', 'Bash']));
    expect(s.sys.active.size).toBe(0);
    expect(s.provider.seen[0].cdpUrl).toBeUndefined();
    expect(s.provider.seen[0].systemPrompt).toContain('## Shared computer');
  });

  it('holds the computer busy for the turn and lets it idle out afterwards', async () => {
    const s = setup();
    const a = s.mk('alpha', ['Browser']);
    s.provider.onRun = () => {
      s.advance(2 * 60 * 60_000);
      void s.computers.sweep().then((stopped) => expect(stopped).toEqual([]));
    };
    await s.run(a);
    expect(s.computers.status(a.bot.id).state).toBe('live');
    s.advance(31 * 60_000);
    expect(await s.computers.sweep()).toEqual([a.bot.id]);
  });

  it('gives a turn no budget when spend caps are off, and the bot and request budgets otherwise', async () => {
    const s = setup();
    s.provider.usesBrowser = false;
    const a = s.mk('alpha', ['Read']);
    await s.runner.runTurn({ bot: a.bot, room: a.room, members: [a.bot], injected: 'hi', hop: 0, causeId: 'c1', causeBudgetUsd: 0.5 });
    expect(s.provider.seen[0].maxBudgetUsd).toBe(0.5);
    process.env.POCKETROCKET_NO_SPEND_CAPS = '1';
    try {
      await s.runner.runTurn({ bot: a.bot, room: a.room, members: [a.bot], injected: 'hi', hop: 0, causeId: 'c2', causeBudgetUsd: 0.5 });
      expect(s.provider.seen[1].maxBudgetUsd).toBe(Infinity);
    } finally {
      delete process.env.POCKETROCKET_NO_SPEND_CAPS;
    }
  });

  it('reads the request cap from the environment, and has none when spend caps are off', () => {
    expect(causeCostCap({})).toBe(5);
    expect(causeCostCap({ CAUSE_COST_CAP_USD: '9' })).toBe(9);
    expect(causeCostCap({ POCKETROCKET_NO_SPEND_CAPS: '1', CAUSE_COST_CAP_USD: '9' })).toBe(Infinity);
    expect(spendCapsOff({ POCKETROCKET_NO_SPEND_CAPS: '0' })).toBe(false);
  });

  it('starts no computer for a turn that never calls Browser or Desktop', async () => {
    const s = setup();
    s.provider.usesBrowser = false;
    const a = s.mk('alpha', ['Read', 'Browser', 'Desktop']);
    await s.run(a);
    expect(s.sys.active.size).toBe(0);
    expect(s.computers.status(a.bot.id).state).toBe('asleep');
    // The tools are still offered, pointed at the computer it would start.
    expect(s.provider.seen[0].cdpUrl).toBe('http://127.0.0.1:9401');
    expect(s.provider.seen[0].allowedBuiltins).toContain('Browser');
    expect(s.computers.turnsOn(a.bot.id)).toBe(0);
  });

  it('sends a second chat on one computer to its own tab, and leaves the first where it is', async () => {
    const s = setup();
    const a = s.mk('alpha', ['Browser']);
    const room2 = s.repos.createRoom({ kind: 'group', name: 'Other', memberIds: [a.bot.id], coordinatorBotId: null });
    let done = () => undefined as void;
    s.provider.hold = new Promise((r) => { done = r; });
    s.provider.onRun = () => {
      s.provider.onRun = () => undefined;
      void s.runner.runTurn({ bot: a.bot, room: room2, members: [a.bot], injected: 'hi', hop: 0, causeId: 'c2' }).finally(done);
    };
    await s.run(a);
    expect(s.provider.gate[0]).toBeNull();
    expect(s.provider.gate[1]).toBe(SHARED_BROWSER_NOTE);
    expect(s.sys.active.size).toBe(1);
  });

  it('lets the second chat through once it opens its tab, and only asks once', async () => {
    const s = setup();
    const a = s.mk('alpha', ['Browser']);
    const room2 = s.repos.createRoom({ kind: 'group', name: 'Other', memberIds: [a.bot.id], coordinatorBotId: null });
    const answers: (string | null)[] = [];
    let done = () => undefined as void;
    s.provider.hold = new Promise((r) => { done = r; });
    s.provider.onRun = () => {
      s.provider.onRun = () => undefined;
      void s.runner.runTurn({ bot: a.bot, room: room2, members: [a.bot], injected: 'hi', hop: 0, causeId: 'c2' }).finally(done);
    };
    const original = s.provider.runTurn.bind(s.provider);
    let n = 0;
    s.provider.runTurn = async (ctx, sink) => {
      if (++n === 2) {
        answers.push(await ctx.computerGate!('mcp__browser__browser_navigate'));
        // Listing tabs is not owning one: the next navigate is still refused.
        answers.push(await ctx.computerGate!('mcp__browser__browser_tabs', { action: 'list' }));
        answers.push(await ctx.computerGate!('mcp__browser__browser_navigate'));
        answers.push(await ctx.computerGate!('mcp__browser__browser_tabs', { action: 'new' }));
        answers.push(await ctx.computerGate!('mcp__browser__browser_navigate'));
      }
      return original(ctx, sink);
    };
    await s.run(a);
    expect(answers).toEqual([SHARED_BROWSER_NOTE, null, SHARED_BROWSER_NOTE, null, null]);
  });

  it('keeps a shared chat to its own tab: no numbered close, no select, and a close ends its claim', async () => {
    const s = setup();
    const a = s.mk('alpha', ['Browser']);
    const room2 = s.repos.createRoom({ kind: 'group', name: 'Other', memberIds: [a.bot.id], coordinatorBotId: null });
    const tabs = 'mcp__browser__browser_tabs';
    const nav = 'mcp__browser__browser_navigate';
    const answers: (string | null)[] = [];
    let done = () => undefined as void;
    s.provider.hold = new Promise((r) => { done = r; });
    s.provider.onRun = () => {
      s.provider.onRun = () => undefined;
      void s.runner.runTurn({ bot: a.bot, room: room2, members: [a.bot], injected: 'hi', hop: 0, causeId: 'c2' }).finally(done);
    };
    const original = s.provider.runTurn.bind(s.provider);
    let n = 0;
    s.provider.runTurn = async (ctx, sink) => {
      if (++n === 2) {
        const g = ctx.computerGate!;
        answers.push(await g(tabs, { action: 'close' })); // no tab of its own yet: this would close the first chat's
        answers.push(await g(tabs, { action: 'new' }));
        answers.push(await g(tabs, { action: 'close', index: 1 }));
        answers.push(await g(tabs, { action: 'select', index: 0 }));
        answers.push(await g(nav));
        answers.push(await g(tabs, { action: 'close' }));
        answers.push(await g(nav)); // the browser tool now sits on a neighbour's tab
      }
      return original(ctx, sink);
    };
    await s.run(a);
    expect(answers).toEqual([SHARED_TAB_NOTE, null, SHARED_TAB_NOTE, SHARED_TAB_NOTE, null, null, SHARED_BROWSER_NOTE]);
  });

  it('lets a chat alone on the computer close and select by number', async () => {
    const s = setup();
    const a = s.mk('alpha', ['Browser']);
    const answers: (string | null)[] = [];
    const original = s.provider.runTurn.bind(s.provider);
    s.provider.runTurn = async (ctx, sink) => {
      await ctx.computerGate!('mcp__browser__browser_navigate');
      answers.push(await ctx.computerGate!('mcp__browser__browser_tabs', { action: 'select', index: 1 }));
      answers.push(await ctx.computerGate!('mcp__browser__browser_tabs', { action: 'close', index: 1 }));
      return original(ctx, sink);
    };
    await s.run(a);
    expect(answers).toEqual([null, null]);
  });

  it('refuses the browser call, and says why, when the computer cannot start', async () => {
    const s = setup({ maxRunning: 1 });
    const a = s.mk('alpha', ['Browser']);
    const b = s.mk('beta', ['Read', 'Browser', 'Desktop']);
    // Alpha's turn is in flight when beta asks: the only running computer is busy, so beta gets none.
    let inner: Promise<unknown> = Promise.resolve();
    s.provider.onRun = () => { s.provider.onRun = () => undefined; inner = s.run(b); };
    await s.run(a);
    await inner;
    const cb = s.provider.seen[1];
    expect(cb.allowedBuiltins).toContain('Browser');
    expect(s.provider.gate[1]).toContain('Your computer could not start');
    expect(s.provider.gate[1]).toContain('MAX_RUNNING_COMPUTERS=1');
    expect(s.computers.turnsOn(b.bot.id)).toBe(0);
  });

  it('refuses Browser and Desktop when per-bot computers are off, with no shared-screen fallback', async () => {
    const s = setup({ enabled: false });
    await s.run(s.mk('alpha', ['Read', 'Browser', 'Desktop']));
    const c = s.provider.seen[0];
    expect(c.allowedBuiltins).toEqual(['Read']);
    expect(c.cdpUrl).toBeUndefined();
    expect(c.computerFilesDir).toBeUndefined();
    expect(c.tools.some((t) => t.name.startsWith('desktop_'))).toBe(false);
    expect(c.systemPrompt).toContain('Your computer is unavailable this turn');
    expect(c.systemPrompt).toContain('no per-bot computers');
    expect(c.systemPrompt).not.toContain('browser_navigate');
    expect(s.sys.active.size).toBe(0);
  });

  it('leaves a bot without those tools alone when per-bot computers are off', async () => {
    const s = setup({ enabled: false });
    await s.run(s.mk('plain', ['Read', 'Bash']));
    const c = s.provider.seen[0];
    expect(c.allowedBuiltins).toEqual(['Read', 'Bash']);
    expect(c.systemPrompt).not.toContain('Your computer is unavailable');
  });
});
