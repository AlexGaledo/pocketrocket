import { describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_TURNS } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';

/** 04-A3: a maintenance hold starts no new turn; messages still queue (journaled) and run after it ends. */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup(bots = 1) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const reqs: TurnRequest[] = [];
  /** Turns that have not been let finish yet. */
  const open: (() => void)[] = [];
  let blockTurns = false;
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      if (blockTurns) await new Promise<void>((r) => open.push(r));
      return { ok: true, turnId: 't' + reqs.length, finalText: '', costUsd: 0 };
    },
  } as unknown as BotRunner;
  const pairs = Array.from({ length: bots }, (_, i) => {
    const bot = repos.createBot({ name: 'B' + i, handle: 'b' + i, title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM' + i, memberIds: [bot.id], coordinatorBotId: null });
    return { bot, room };
  });
  return { repos, router, reqs, open, pairs, block: (v: boolean) => { blockTurns = v; } };
}

describe('maintenance hold', () => {
  it('holds a new message in its lane (journaled, counted as pending) and runs it on release', async () => {
    const s = setup();
    const { room } = s.pairs[0];
    const until0 = s.router.hold(60_000);
    expect(s.router.heldUntil()).toBe(until0);
    s.router.onUserMessage(room.id, 'hello');
    await tick();
    expect(s.reqs).toHaveLength(0);
    expect(s.router.pendingLaneCount()).toBe(1);
    // Journaled, so a restart during the hold still resumes it.
    expect(s.repos.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM lane_journal')[0].n).toBe(1);
    s.router.releaseHold();
    expect(s.router.heldUntil()).toBeNull();
    await until(() => s.reqs.length === 1);
    expect(s.reqs[0].injected).toContain('hello');
    await until(() => s.router.pendingLaneCount() === 0);
  });

  it('ends on its own when the time is up', async () => {
    const s = setup();
    s.router.hold(60);
    s.router.onUserMessage(s.pairs[0].room.id, 'later');
    await tick(20);
    expect(s.reqs).toHaveLength(0);
    await until(() => s.reqs.length === 1);
    expect(s.router.heldUntil()).toBeNull();
  });

  it('a running turn finishes, but the lane starts nothing more while held', async () => {
    const s = setup();
    s.block(true);
    const { room } = s.pairs[0];
    s.router.onUserMessage(room.id, 'first');
    await until(() => s.reqs.length === 1);
    s.router.hold(60_000);
    s.router.onUserMessage(room.id, 'second');
    s.block(false);
    s.open.shift()!();
    await tick();
    expect(s.reqs).toHaveLength(1);
    expect(s.router.pendingLaneCount()).toBe(1);
    s.router.releaseHold();
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('second');
  });

  it('a lane already waiting for a turn slot does not start once the hold begins', async () => {
    const s = setup(MAX_CONCURRENT_TURNS + 1);
    s.block(true);
    for (let i = 0; i < MAX_CONCURRENT_TURNS; i++) s.router.onUserMessage(s.pairs[i].room.id, 'busy ' + i);
    await until(() => s.reqs.length === MAX_CONCURRENT_TURNS);
    // The last lane is past the hold check and waiting on the semaphore.
    s.router.onUserMessage(s.pairs[MAX_CONCURRENT_TURNS].room.id, 'queued');
    await tick();
    expect(s.reqs).toHaveLength(MAX_CONCURRENT_TURNS);
    s.router.hold(60_000);
    s.block(false);
    for (const done of s.open.splice(0)) done();
    await tick(60);
    expect(s.reqs).toHaveLength(MAX_CONCURRENT_TURNS);
    expect(s.router.pendingLaneCount()).toBe(1);
    s.router.releaseHold();
    await until(() => s.reqs.length === MAX_CONCURRENT_TURNS + 1);
    expect(s.reqs.at(-1)!.injected).toContain('queued');
  });

  it('a second hold replaces the end time', () => {
    const s = setup();
    const a = s.router.hold(60_000);
    const b = s.router.hold(120_000);
    expect(b).toBeGreaterThan(a);
    expect(s.router.heldUntil()).toBe(b);
    s.router.releaseHold();
  });
});
