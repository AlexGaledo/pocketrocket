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
import { BotRunner } from './BotRunner.js';

/** P1 task 1.3: each bot's turn is wired to its own computer (CDP endpoint, prompt, roots). */

class RecordingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Recording';
  readonly info = { id: 'claude' as ProviderId, label: 'Recording', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  onRun: () => void = () => undefined;
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    this.onRun();
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
  return { computers, sys, provider, mk, run, advance: (ms: number) => (now += ms) };
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

  it('runs the turn without Browser/Desktop, and says why, when the computer cannot start', async () => {
    const s = setup({ maxRunning: 1 });
    const a = s.mk('alpha', ['Browser']);
    const b = s.mk('beta', ['Read', 'Browser', 'Desktop']);
    // Alpha's turn is in flight when beta asks: the only running computer is busy, so beta gets none.
    let inner: Promise<unknown> = Promise.resolve();
    s.provider.onRun = () => { s.provider.onRun = () => undefined; inner = s.run(b); };
    await s.run(a);
    await inner;
    const cb = s.provider.seen[1];
    expect(cb.allowedBuiltins).toEqual(['Read']);
    expect(cb.cdpUrl).toBeUndefined();
    expect(cb.systemPrompt).toContain('Your computer is unavailable this turn');
    expect(cb.systemPrompt).toContain('MAX_RUNNING_COMPUTERS=1');
    expect(cb.tools.some((t) => t.name.startsWith('desktop_'))).toBe(false);
  });

  it('keeps the shared screen exactly as before when per-bot computers are off', async () => {
    const s = setup({ enabled: false });
    await s.run(s.mk('alpha', ['Browser']));
    const c = s.provider.seen[0];
    expect(c.cdpUrl).toBeUndefined();
    expect(c.computerFilesDir).toBeUndefined();
    expect(c.systemPrompt).toContain('## Shared computer');
    expect(c.systemPrompt).not.toContain('## Your computer');
    expect(s.sys.active.size).toBe(0);
  });
});
