import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId, ServerEvent } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner } from './BotRunner.js';

/** 02 task 2.3: a turn the owner stops ends without a failure note or an error event; any other stop keeps its note. */

/** Runs until stopped, then reports the abort the way the Claude adapter does. */
class BlockingProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly label = 'Blocking';
  readonly info = { id: 'claude' as ProviderId, label: 'Blocking', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  started = 0;
  private gate: (() => void) | null = null;
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean {
    this.gate?.();
    return true;
  }
  async runTurn(ctx: TurnContext): Promise<TurnOutcome> {
    this.started++;
    await new Promise<void>((r) => (this.gate = r));
    return { ok: false, error: ctx.signal.aborted ? 'error_during_execution: aborted' : 'x', costUsd: 0, usage: EMPTY_USAGE, durationMs: 1 };
  }
}

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const p = new BlockingProvider();
  const providers = { active: () => p, get: () => p } as unknown as ProviderRegistry;
  const states: string[] = [];
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: (_b, _r, st) => states.push(st) }, providers, new TurnRegistry(),
  );
  const seen: ServerEvent[] = [];
  offs.push(events.onEvent((ev) => seen.push(ev)));
  const start = () => runner.runTurn({ bot, room, members: [bot], injected: 'go', hop: 0, causeId: 'c1' } as never);
  const notes = () => repos.listMessages(room.id).filter((m) => m.kind === 'system').map((m) => m.text);
  return { repos, bot, room, p, runner, start, seen, states, notes };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const offs: (() => void)[] = [];
afterEach(() => { for (const off of offs.splice(0)) off(); });

describe('owner stop', () => {
  it('Stop by the owner leaves no failure note and no error on turn.end', async () => {
    const s = setup();
    const turn = s.start();
    await until(() => s.p.started === 1);
    const turnId = (s.seen.find((e) => e.type === 'turn.start') as { turnId: string }).turnId;
    expect(s.runner.interrupt(turnId, 'owner')).toBe(true);
    const res = await turn;
    expect(res).toMatchObject({ stopped: true, stoppedBy: 'owner' });
    expect(s.notes().filter((t) => t.includes('turn ended'))).toEqual([]);
    const end = s.seen.find((e) => e.type === 'turn.end') as Extract<ServerEvent, { type: 'turn.end' }>;
    expect(end.error).toBeUndefined();
    expect(end.stoppedBy).toBe('owner');
    expect(s.states.at(-1)).toBe('done');
  });

  it('a stop the owner did not ask for (bot removed, shutdown) still posts its note', async () => {
    const s = setup();
    const turn = s.start();
    await until(() => s.p.started === 1);
    expect(s.runner.interruptLane(s.bot.id, s.room.id)).toBe(true);
    const res = await turn;
    expect(res.stopped).toBe(true);
    expect(res.stoppedBy).toBeUndefined();
    expect(s.notes().some((t) => t.startsWith('Ada turn ended:'))).toBe(true);
    const end = s.seen.find((e) => e.type === 'turn.end') as Extract<ServerEvent, { type: 'turn.end' }>;
    expect(end.error).toBeTruthy();
    expect(end.stoppedBy).toBeUndefined();
  });

  it('interruptLane as the owner (Send now) is an owner stop too', async () => {
    const s = setup();
    const turn = s.start();
    await until(() => s.p.started === 1);
    expect(s.runner.interruptLane(s.bot.id, s.room.id, 'owner')).toBe(true);
    expect((await turn).stoppedBy).toBe('owner');
    expect(s.notes().filter((t) => t.includes('turn ended'))).toEqual([]);
  });
});
