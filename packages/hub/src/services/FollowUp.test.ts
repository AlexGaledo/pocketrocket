import { describe, expect, it } from 'vitest';
import type { HandoffPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from './UsageTracker.js';
import { FollowUp, RESUME_NOTE } from './FollowUp.js';
import { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';
import { MAX_HOPS } from '../config.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const tick = () => new Promise((r) => setTimeout(r, 20));

/** A router whose turns either finish at once or hang (`hang` returns true for that request). */
function routerOn(repos: Repos, hang: (req: TurnRequest) => boolean = () => false) {
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const reqs: TurnRequest[] = [];
  router.runner = {
    runTurn: (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      return hang(req) ? new Promise(() => undefined) : Promise.resolve({ ok: true, turnId: 't', finalText: '', costUsd: 0.01 });
    },
  } as unknown as BotRunner;
  return { router, reqs };
}

function world() {
  const repos = new Repos(new Db(':memory:'));
  const mk = (h: string) => repos.createBot({ name: h, handle: h, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const coord = mk('chief');
  const ann = mk('ann');
  const bob = mk('bob');
  const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [coord.id, ann.id, bob.id], coordinatorBotId: coord.id });
  return { repos, coord, ann, bob, room };
}

describe('FollowUp: resume turns a restart cut off', () => {
  it('resumes a queued/running turn once after a restart, keeping its thread and routine run', async () => {
    const w = world();
    // First process: a user turn and a routine turn are in flight when the hub stops.
    const p1 = routerOn(w.repos, () => true);
    p1.router.onUserMessage(w.room.id, '@ann draft the plan');
    const run = w.repos.createRun('routine-1', null);
    const routineMsg = p1.router.fireRoutine(w.room, w.bob, '[Routine "nightly"] tidy', { routineId: 'routine-1', runId: run.id, name: 'nightly' });
    await until(() => p1.reqs.length === 2);
    p1.router.freeze();

    // Second process.
    const p2 = routerOn(w.repos);
    const f = new FollowUp({ repos: w.repos, router: p2.router });
    expect(f.resumeInterrupted()).toBe(2);
    await until(() => p2.reqs.length === 2);
    const byBot = Object.fromEntries(p2.reqs.map((r) => [r.bot.handle, r]));
    expect(byBot.ann.injected).toContain(RESUME_NOTE);
    expect(byBot.ann.strictApprovals).toBe(false);
    expect(byBot.bob.causeId).toBe(routineMsg.id);
    expect(byBot.bob.strictApprovals).toBe(true); // still a routine thread: approvals still required
    await until(() => w.repos.listRuns('routine-1')[0].status === 'success');
    expect(w.repos.listMessages(w.room.id, { limit: 50 }).filter((m) => m.text.includes('resuming'))).toHaveLength(2);
    await tick();
    expect(w.repos.journalTakeAll()).toEqual([]); // settled turns leave no journal rows behind
  });

  it('does not resume the same turn across a second restart (no crash loop)', async () => {
    const w = world();
    const p1 = routerOn(w.repos, () => true);
    p1.router.onUserMessage(w.room.id, '@ann go');
    await until(() => p1.reqs.length === 1);
    p1.router.freeze();

    const p2 = routerOn(w.repos, () => true);
    expect(new FollowUp({ repos: w.repos, router: p2.router }).resumeInterrupted()).toBe(1);
    await until(() => p2.reqs.length === 1);
    p2.router.freeze();

    const p3 = routerOn(w.repos);
    expect(new FollowUp({ repos: w.repos, router: p3.router }).resumeInterrupted()).toBe(0);
    await tick();
    expect(p3.reqs).toHaveLength(0);
    expect(w.repos.listMessages(w.room.id, { limit: 50 }).some((m) => m.text.includes('was not resumed'))).toBe(true);
  });

  it('closes a routine run that was left running with no turn to resume', () => {
    const w = world();
    const run = w.repos.createRun('routine-x', null);
    const { router } = routerOn(w.repos);
    new FollowUp({ repos: w.repos, router }).resumeInterrupted();
    expect(w.repos.listRuns('routine-x')[0]).toMatchObject({ id: run.id, status: 'error' });
  });
});

describe('FollowUp: nudge a stalled handoff once', () => {
  const N = 10 * 60_000;
  function setup(hang: (req: TurnRequest) => boolean = () => false) {
    const w = world();
    const { router, reqs } = routerOn(w.repos, hang);
    let t = 1_000_000;
    const f = new FollowUp({ repos: w.repos, router, nudgeAfterMs: N, now: () => t });
    const cause = router.onUserMessage(w.room.id, 'ship it'); // the coordinator takes it
    const handoff = (hop = 1, from = w.ann, to = w.bob) => {
      const payload: HandoffPayload = { fromBotId: from.id, toBotId: to.id, task: 'write tests' };
      const m = w.repos.insertMessage({ roomId: w.room.id, authorType: 'bot', authorId: from.id, kind: 'handoff', text: '@' + to.handle + ' handoff', payload, causeId: cause.id, hop, turnId: 'x' });
      events.emitEvent({ type: 'message.new', message: m });
      return m;
    };
    return { ...w, router, reqs, f, handoff, advance: (ms: number) => { t += ms; } };
  }

  it('nudges the coordinator once after N minutes of silence, and never again for that handoff', async () => {
    const s = setup();
    s.f.start();
    await until(() => s.reqs.length === 1);
    s.handoff();
    s.f.stop();
    expect(s.f.watching).toBe(1);

    s.advance(N - 1);
    expect(s.f.sweep()).toEqual([]);
    s.advance(1);
    expect(s.f.sweep()).toEqual(['chief']);
    await until(() => s.reqs.length === 2);
    const nudge = s.reqs[1];
    expect(nudge.bot.handle).toBe('chief');
    expect(nudge.hop).toBe(2); // one more hop on the thread: it counts toward MAX_HOPS
    expect(nudge.injected).toContain('has not answered handoff');

    s.advance(10 * N);
    expect(s.f.sweep()).toEqual([]);
    expect(s.f.watching).toBe(0);
    await tick();
    expect(s.reqs).toHaveLength(2);
  });

  it('does not nudge when the target answered', async () => {
    const s = setup();
    const h = s.handoff();
    s.f.watch(h);
    s.repos.insertMessage({ roomId: s.room.id, authorType: 'bot', authorId: s.bob.id, kind: 'text', text: 'on it', payload: null, causeId: h.causeId, hop: 2, turnId: 'y' });
    s.advance(N);
    expect(s.f.sweep()).toEqual([]);
  });

  it('waits while the target is still working on it', async () => {
    const s = setup((req) => req.bot.handle === 'bob');
    s.router.onUserMessage(s.room.id, '@bob start');
    await until(() => s.reqs.some((r) => r.bot.handle === 'bob'));
    s.f.watch(s.handoff());
    s.advance(N);
    expect(s.f.sweep()).toEqual([]);
    expect(s.f.watching).toBe(1);
  });

  it('nudges the bot that handed off when the room has no coordinator', async () => {
    const s = setup();
    s.repos.updateRoom(s.room.id, { coordinatorBotId: null });
    s.f.watch(s.handoff());
    s.advance(N);
    expect(s.f.sweep()).toEqual(['ann']);
  });

  it('is refused once the thread is out of hops', async () => {
    const s = setup();
    s.f.watch(s.handoff(MAX_HOPS));
    s.advance(N);
    expect(s.f.sweep()).toEqual([]);
    expect(s.repos.listMessages(s.room.id, { limit: 50 }).some((m) => m.text.includes('was not nudged'))).toBe(true);
  });
});
