import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { hasColumn } from '../db/migrations.js';
import { UsageTracker } from './UsageTracker.js';
import { RoutineScheduler } from './RoutineScheduler.js';
import { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';

/** P3 3.1: routines run in `settings.timezone` (not the hub's local time) and can be one-shots. */

function setup(zone = 'Asia/Manila') {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const reqs: TurnRequest[] = [];
  router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0.01 }; } } as unknown as BotRunner;
  const bot = repos.createBot({ name: 'Ann', handle: 'ann', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [bot.id], coordinatorBotId: null });
  let tz = zone;
  const scheduler = new RoutineScheduler(repos, router, { timezone: () => tz });
  const routine = (o: { cron?: string; onceAt?: number | null }) =>
    repos.createRoutine({ botId: bot.id, roomId: room.id, name: 'r', prompt: 'go', enabled: true, cron: o.cron ?? '', onceAt: o.onceAt ?? null });
  return { repos, router, reqs, bot, room, scheduler, routine, setZone: (z: string) => { tz = z; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('routine time zones', () => {
  it('fires a daily 09:00 Manila routine at 09:00 Manila on a UTC hub', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z')); // 08:00 in Manila
    const s = setup('Asia/Manila');
    const r = s.routine({ cron: '0 9 * * *' });
    s.scheduler.start();
    expect(s.repos.getRoutine(r.id)!.nextRunAt).toBe(Date.parse('2026-11-01T01:00:00Z'));

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(s.repos.listRuns(r.id)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(s.repos.listRuns(r.id)).toHaveLength(1);
    expect(s.repos.getRoutine(r.id)!.nextRunAt).toBe(Date.parse('2026-11-02T01:00:00Z'));
    s.scheduler.stop();
  });

  it('reads the same cron in UTC as 09:00 UTC', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const s = setup('UTC');
    const r = s.routine({ cron: '0 9 * * *' });
    s.scheduler.reload();
    expect(s.repos.getRoutine(r.id)!.nextRunAt).toBe(Date.parse('2026-11-01T09:00:00Z'));
    s.scheduler.stop();
  });

  it('reschedules when settings.timezone changes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const s = setup('UTC');
    const r = s.routine({ cron: '0 9 * * *' });
    s.scheduler.start();
    expect(s.repos.getRoutine(r.id)!.nextRunAt).toBe(Date.parse('2026-11-01T09:00:00Z'));
    s.setZone('Asia/Manila');
    events.emitEvent({ type: 'settings.changed', settings: { ...DEFAULT_SETTINGS, timezone: 'Asia/Manila' } });
    expect(s.repos.getRoutine(r.id)!.nextRunAt).toBe(Date.parse('2026-11-01T01:00:00Z'));
    s.scheduler.stop();
  });
});

describe('one-shot routines', () => {
  it('resolves a local once_at in the zone and refuses the past, an empty schedule and a bad cron', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    expect(RoutineScheduler.resolveSchedule({ onceAt: '2026-11-02T09:00' }, 'Asia/Manila', now)).toEqual({ cron: '', onceAt: Date.parse('2026-11-02T01:00:00Z') });
    expect(RoutineScheduler.resolveSchedule({ onceAt: now + 1000, cron: '0 9 * * *' }, 'UTC', now)).toEqual({ cron: '', onceAt: now + 1000 });
    expect(RoutineScheduler.resolveSchedule({ onceAt: '2026-10-31T09:00' }, 'UTC', now)).toHaveProperty('error');
    expect(RoutineScheduler.resolveSchedule({ onceAt: 'tomorrow-ish!' }, 'UTC', now)).toHaveProperty('error');
    expect(RoutineScheduler.resolveSchedule({ cron: '' }, 'UTC', now)).toHaveProperty('error');
    expect(RoutineScheduler.resolveSchedule({ cron: '61 * * * *' }, 'UTC', now)).toHaveProperty('error');
    expect(RoutineScheduler.resolveSchedule({ cron: ' 0 9 * * 1-5 ' }, 'UTC', now)).toEqual({ cron: '0 9 * * 1-5', onceAt: null });
  });

  it('fires once at its time, then switches itself off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const s = setup();
    const at = Date.parse('2026-11-01T00:30:00Z');
    const r = s.routine({ onceAt: at });
    s.scheduler.start();
    expect(s.repos.getRoutine(r.id)!.nextRunAt).toBe(at);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(s.repos.listRuns(r.id)).toHaveLength(1);
    expect(s.repos.getRoutine(r.id)).toMatchObject({ enabled: false, nextRunAt: null });
    s.scheduler.reload();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(s.repos.listRuns(r.id)).toHaveLength(1);
    s.scheduler.stop();
  });

  it('"Run now" does not use up a one-shot', () => {
    const s = setup();
    const r = s.routine({ onceAt: Date.now() + 3_600_000 });
    s.scheduler.reload();
    expect(s.scheduler.fire(r.id, { manual: true })).toBe(true);
    expect(s.repos.getRoutine(r.id)).toMatchObject({ enabled: true, nextRunAt: r.onceAt });
    s.scheduler.stop();
  });

  it('fires a one-shot the hub was down for, once, at start', () => {
    const s = setup();
    const r = s.routine({ onceAt: Date.now() - 60_000 });
    s.scheduler.start();
    expect(s.repos.listRuns(r.id)).toHaveLength(1);
    expect(s.repos.getRoutine(r.id)!.enabled).toBe(false);
    s.scheduler.stop();
    s.scheduler.start();
    expect(s.repos.listRuns(r.id)).toHaveLength(1);
    s.scheduler.stop();
  });

  it('migration 30 adds routines.once_at', () => {
    const repos = new Repos(new Db(':memory:'));
    expect(hasColumn(repos.db.raw, 'routines', 'once_at')).toBe(true);
  });
});
