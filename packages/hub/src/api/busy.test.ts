import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Bot, BusyInfo, ModelInfo, ProviderCheck, ProviderId, Room } from '@pocketrocket/shared';
import { MAX_MAINTENANCE_HOLD_MINUTES } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner } from '../agent/BotRunner.js';
import { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess, runnerMayAccess } from './guard.js';

/**
 * 04-A3: GET /api/busy counts only work a restart would lose (running turns, live cards); the maintenance hold
 * and stop let the desktop updater drain the hub and stop it cleanly.
 */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

/** Every turn asks for one risky push and waits for the answer. */
class AskingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Asking';
  readonly info = { id: 'claude' as ProviderId, label: 'Asking', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext): Promise<TurnOutcome> {
    const d = await ctx.permission('Bash', { command: 'git push origin main' });
    if (ctx.signal.aborted) return { ok: false, error: 'error_during_execution: interrupted', costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
    return { ok: d === 'allow', error: d === 'allow' ? undefined : 'denied', costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

describe('busy counts (runner + broker)', () => {
  function wired() {
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const store = new ApprovalStore(db);
    const usage = new UsageTracker(repos);
    const broker = new PermissionBroker(repos, { store, parkAfterMs: 20 });
    const provider = new AskingProvider();
    const router = new RoomRouter(repos, usage);
    const runner = new BotRunner(
      repos, new MemoryService(), new SkillService(repos), broker, usage,
      { dispatchFromBot: (req, t) => router.dispatchFromBot(req, t), setState: () => undefined },
      { active: () => provider, get: () => provider } as unknown as ProviderRegistry, new TurnRegistry(),
    );
    router.runner = runner;
    const bot = repos.createBot({ name: 'Pusher', handle: 'pusher', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    return { repos, broker, runner, router, bot, room };
  }

  it('a running turn waiting on a live card counts both; answering it clears both', async () => {
    const s = wired();
    let approvalId = '';
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') approvalId = ev.approval.approvalId; });
    s.router.onUserMessage(s.room.id, 'push it');
    await until(() => !!approvalId);
    expect(s.runner.activeTurnCount()).toBe(1);
    expect(s.broker.liveCardCount()).toBe(1);
    expect(s.broker.parked()).toHaveLength(0);
    s.broker.resolve(approvalId, 'allow');
    await until(() => s.runner.activeTurnCount() === 0);
    expect(s.broker.liveCardCount()).toBe(0);
    off();
  });

  it('a parked card is not live and its turn has ended', async () => {
    const s = wired();
    // A routine's (strict) card parks after parkAfterMs when nobody answers.
    s.router.fireRoutine(s.room, s.bot, 'push', null);
    await until(() => s.broker.parked().length === 1);
    await until(() => s.runner.activeTurnCount() === 0);
    expect(s.broker.liveCardCount()).toBe(0);
  });
});

describe('GET /api/busy and the maintenance routes', () => {
  const TOKEN = 'busy-test-token';
  let hub: Hub;
  let base: string;
  const exit = vi.fn();

  beforeAll(async () => {
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, exit });
    base = 'http://127.0.0.1:' + (await hub.listen());
  });
  afterAll(async () => {
    if (!exit.mock.calls.length) await hub.shutdown();
  });

  async function api<T>(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: T }> {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as T };
  }

  it('answers 401 without the hub token', async () => {
    expect((await api('GET', '/api/busy', undefined, null)).status).toBe(401);
    expect((await api('POST', '/api/maintenance/hold', {}, null)).status).toBe(401);
    expect((await api('POST', '/api/maintenance/release', {}, null)).status).toBe(401);
    expect((await api('POST', '/api/maintenance/stop', {}, 'wrong')).status).toBe(401);
    expect(exit).not.toHaveBeenCalled();
  });

  it('is refused to paired devices and the PC runner', () => {
    for (const [m, p] of [['GET', '/api/busy'], ['POST', '/api/maintenance/hold'], ['POST', '/api/maintenance/release'], ['POST', '/api/maintenance/stop']]) {
      expect(deviceMayAccess(m, p), m + ' ' + p).toBe(false);
      expect(runnerMayAccess(m, p), m + ' ' + p).toBe(false);
    }
  });

  it('reports an idle hub as not blocking', async () => {
    const r = await api<BusyInfo>('GET', '/api/busy');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ blocking: 0, running: 0, liveCards: 0, pendingLanes: 0, parkedCards: 0, waitingRuns: 0, heldUntil: null });
  });

  it('blocking is running turns plus live cards only', async () => {
    const a = vi.spyOn(hub.runner, 'activeTurnCount').mockReturnValue(2);
    const b = vi.spyOn(hub.broker, 'liveCardCount').mockReturnValue(1);
    const c = vi.spyOn(hub.broker, 'parked').mockReturnValue([{} as never, {} as never]);
    const body = (await api<BusyInfo>('GET', '/api/busy')).body;
    expect(body).toMatchObject({ blocking: 3, running: 2, liveCards: 1, parkedCards: 2 });
    a.mockRestore(); b.mockRestore(); c.mockRestore();
  });

  it('validates the hold length (default 10, at most the cap)', async () => {
    expect((await api('POST', '/api/maintenance/hold', { minutes: 0 })).status).toBe(400);
    expect((await api('POST', '/api/maintenance/hold', { minutes: MAX_MAINTENANCE_HOLD_MINUTES + 1 })).status).toBe(400);
    expect((await api('POST', '/api/maintenance/hold', { minutes: 'x' })).status).toBe(400);
    const before = Date.now();
    const r = await api<BusyInfo>('POST', '/api/maintenance/hold', {});
    expect(r.status).toBe(200);
    expect(r.body.heldUntil! - before).toBeGreaterThanOrEqual(10 * 60_000 - 50);
    expect(r.body.heldUntil! - before).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    expect((await api<BusyInfo>('POST', '/api/maintenance/release', {})).body.heldUntil).toBeNull();
  });

  it('while held, a new message is accepted and queued: a pending lane, not blocking', async () => {
    const bot = (await api<Bot>('POST', '/api/bots', { name: 'Held', handle: 'held' })).body;
    const room = (await api<Room>('POST', '/api/rooms', { kind: 'dm', name: 'Held', memberIds: [bot.id] })).body;
    const held = (await api<BusyInfo>('POST', '/api/maintenance/hold', { minutes: 5 })).body;
    expect(held.heldUntil).toBeGreaterThan(Date.now());
    expect((await api('POST', '/api/rooms/' + room.id + '/messages', { text: 'during the hold' })).status).toBe(200);
    await until(() => hub.busy().pendingLanes === 1);
    expect(hub.busy()).toMatchObject({ blocking: 0, running: 0, pendingLanes: 1 });
    expect((await api<BusyInfo>('GET', '/api/busy')).body).toMatchObject({ blocking: 0, pendingLanes: 1, heldUntil: held.heldUntil });
    // Left held on purpose: releasing would start a real turn. stop() below freezes the router.
  });

  it('stop answers first, then shuts the hub down and exits 0', async () => {
    const shutdown = vi.spyOn(hub, 'shutdown');
    const r = await api<{ ok: boolean; stopping: boolean }>('POST', '/api/maintenance/stop', {});
    expect(r).toEqual({ status: 200, body: { ok: true, stopping: true } });
    await until(() => exit.mock.calls.length === 1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // A signal arriving during or after the stop joins it instead of shutting down twice.
    await hub.stop('SIGTERM');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
