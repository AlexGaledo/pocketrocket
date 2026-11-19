import { afterEach, describe, expect, it } from 'vitest';
import { ClientEventSchema, RoomMessageInputSchema, type Bot, type DeliveryPayload, type Message, type Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { FollowUp } from '../services/FollowUp.js';
import { SettingsStore, installSettings } from '../services/SettingsStore.js';
import type { BotRunner, LaneSteerResult, SteerRequest, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';

/**
 * Steering, task 1.3: a person's message to a busy bot joins its running turn instead of queueing (unless sent with
 * `mode: 'queue'`, or the provider cannot), is never shown to that bot twice, is re-queued when the turn ends without
 * answering it (Stop included), and survives a restart through its own journal row.
 */

interface Running {
  turnId: string;
  req: TurnRequest;
  uuids: string[];
  finish: (extra?: Partial<TurnResult>) => void;
}

function makeRunner(repos: Repos, opts: { steers: boolean }) {
  const reqs: TurnRequest[] = [];
  const steerCalls: { botId: string; req: SteerRequest }[] = [];
  const running = new Map<string, Running>();
  let n = 0;
  const runner = {
    runTurn: (req: TurnRequest) =>
      new Promise<TurnResult>((resolve) => {
        reqs.push(req);
        const turnId = 't' + ++n;
        const key = req.bot.id + ':' + req.room.id;
        running.set(key, {
          turnId, req, uuids: [],
          finish: (extra = {}) => {
            running.delete(key);
            resolve({ ok: true, turnId, finalText: '', costUsd: 0, ...extra });
          },
        });
      }),
    steer: (botId: string, roomId: string, req: SteerRequest): LaneSteerResult => {
      steerCalls.push({ botId, req });
      if (!opts.steers) return { status: 'queued', reason: 'provider' };
      const r = running.get(botId + ':' + roomId);
      if (!r) return { status: 'queued', reason: 'between-runs' };
      r.uuids.push(req.uuid);
      return { status: 'accepted', turnId: r.turnId };
    },
    interrupt: () => true,
    interruptLane: () => true,
  };
  return { runner: runner as unknown as BotRunner, reqs, steerCalls, running };
}

function setup(opts: { steers?: boolean; group?: boolean; repos?: Repos } = {}) {
  const repos = opts.repos ?? new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const r = makeRunner(repos, { steers: opts.steers ?? true });
  router.runner = r.runner;
  let ada = repos.listBots().find((b) => b.handle === 'ada');
  let bo = repos.listBots().find((b) => b.handle === 'bo');
  ada ??= repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  bo ??= repos.createBot({ name: 'Bo', handle: 'bo', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const room = opts.group
    ? repos.listRooms().find((x) => x.kind === 'group') ?? repos.createRoom({ kind: 'group', name: 'Team', memberIds: [ada.id, bo.id], coordinatorBotId: ada.id })
    : repos.listRooms().find((x) => x.kind === 'dm') ?? repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [ada.id], coordinatorBotId: null });
  const lane = (bot: Bot = ada!, rm: Room = room) => r.running.get(bot.id + ':' + rm.id);
  /** Ends the lane's turn having answered every steer it took. */
  const finishAnswered = (bot: Bot = ada!) => {
    const l = lane(bot)!;
    l.finish({ consumedSteers: [...l.uuids], unansweredSteers: [] });
  };
  return { repos, router, room, ada: ada!, bo: bo!, lane, finishAnswered, ...r };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const journal = (repos: Repos) => repos.db.all<{ status: string; message_id: string | null; attempts: number }>('SELECT status, message_id, attempts FROM lane_journal ORDER BY created_at, rowid');
const delivery = (repos: Repos, id: string) => repos.getMessage(id)!.payload as DeliveryPayload | null;
/** How often `text` appears in a string. */
const count = (hay: string, text: string) => hay.split(text).length - 1;

afterEach(() => installSettings(null as never));

describe('steering a busy bot', () => {
  it('a message to a busy bot joins its turn: marked steered, not queued, and the turn answers it', async () => {
    const s = setup();
    const updates: Message['payload'][] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'message.update' && ev.patch.payload) updates.push(ev.patch.payload); });
    const first = s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    const steer = s.router.onUserMessage(s.room.id, 'use the other file');
    off();
    expect(s.steerCalls).toHaveLength(1);
    expect(s.steerCalls[0].req.text).toMatch(/^#\d+ \[.*\(owner\)\]: use the other file$/);
    // The answer (REST) and the broadcast (WS) both carry the per-bot outcome.
    expect(steer.payload).toEqual({ steered: { [s.ada.id]: 't1' } });
    expect(updates).toEqual([{ steered: { [s.ada.id]: 't1' } }]);
    // Not in the lane queue; its own journal row instead.
    expect(s.router.pendingLaneCount()).toBe(0);
    expect(journal(s.repos).map((j) => j.status)).toEqual(['queued', 'steered']);

    s.finishAnswered();
    await tick();
    // Answered inside the turn: nothing runs after it.
    expect(s.reqs).toHaveLength(1);
    expect(journal(s.repos)).toEqual([{ status: 'consumed', message_id: steer.id, attempts: 0 }]);
    // It joined the thread of the turn that answered it.
    expect(s.repos.getMessage(steer.id)!.causeId).toBe(first.id);
  });

  it('the next turn does not show an answered steer again, but still shows the rest of the window', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    s.router.onUserMessage(s.room.id, 'STEER-ONE');
    s.finishAnswered();
    await tick();
    s.router.onUserMessage(s.room.id, 'NEXT-MESSAGE');
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('NEXT-MESSAGE');
    expect(s.reqs[1].injected).not.toContain('STEER-ONE');
    expect(s.reqs[1].latestUserText).toBe('NEXT-MESSAGE');
    s.lane()!.finish();
    await tick();
    // The cursor has passed it now, so the marker is gone.
    expect(journal(s.repos)).toEqual([]);
  });

  it('group room: steer, another bot\'s message, a second steer; the next turn shows only the bot message', async () => {
    const s = setup({ group: true });
    s.router.onUserMessage(s.room.id, '@ada build the page');
    await until(() => s.reqs.length === 1);
    s.router.onUserMessage(s.room.id, '@ada STEER-ONE');
    s.repos.insertMessage({ roomId: s.room.id, authorType: 'bot', authorId: s.bo.id, kind: 'text', text: 'BO-REPORT', payload: null, causeId: null, hop: 0, turnId: null });
    s.router.onUserMessage(s.room.id, '@ada STEER-TWO');
    expect(s.lane()!.uuids).toHaveLength(2);
    s.finishAnswered();
    await tick();
    expect(s.reqs).toHaveLength(1);
    s.router.onUserMessage(s.room.id, '@ada NEXT');
    await until(() => s.reqs.length === 2);
    const injected = s.reqs[1].injected;
    expect(injected).toContain('BO-REPORT');
    expect(injected).toContain('NEXT');
    expect(injected).not.toContain('STEER-ONE');
    expect(injected).not.toContain('STEER-TWO');
  });

  it('one message to two bots can steer one lane and start the other', async () => {
    const s = setup({ group: true });
    s.router.onUserMessage(s.room.id, '@ada build the page');
    await until(() => s.reqs.length === 1);
    const both = s.router.onUserMessage(s.room.id, '@ada @bo BOTH');
    // Bo was idle: no outcome for it, it just starts.
    expect(both.payload).toEqual({ steered: { [s.ada.id]: 't1' } });
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].bot.id).toBe(s.bo.id);
    expect(s.reqs[1].injected).toContain('BOTH');
  });

  it('a provider that cannot steer queues the message with reason provider', async () => {
    const s = setup({ steers: false });
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    const m = s.router.onUserMessage(s.room.id, 'QUEUED-ONE');
    expect(m.payload).toEqual({ queued: { [s.ada.id]: { reason: 'provider' } } });
    expect(s.router.pendingLaneCount()).toBe(1);
    s.lane()!.finish();
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('QUEUED-ONE');
  });

  it('mode queue (Ctrl+Enter) never steers, and is still unread for the next turn', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    const m = s.router.onUserMessage(s.room.id, 'LATER', undefined, undefined, 'queue');
    expect(s.steerCalls).toHaveLength(0);
    expect(m.payload).toEqual({ queued: { [s.ada.id]: { reason: 'shortcut' } } });
    s.lane()!.finish();
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('LATER');
  });

  it('Settings > busyMessages = queue makes queue the default; an explicit join still steers', async () => {
    const s = setup();
    const store = new SettingsStore({ repos: s.repos });
    store.patch({ busyMessages: 'queue' });
    installSettings(store);
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    expect(s.router.onUserMessage(s.room.id, 'by default').payload).toEqual({ queued: { [s.ada.id]: { reason: 'setting' } } });
    expect(s.router.onUserMessage(s.room.id, 'join anyway', undefined, undefined, 'join').payload).toEqual({ steered: { [s.ada.id]: 't1' } });
  });

  it('a bot-to-bot hand-off to a busy bot always queues', async () => {
    const s = setup({ group: true });
    s.router.onUserMessage(s.room.id, '@ada build the page');
    await until(() => s.reqs.length === 1);
    const handles = s.router.dispatchFromBot({ ...s.reqs[0], bot: s.bo, hop: 0 }, [s.ada]);
    expect(handles).toEqual(['ada']);
    expect(s.steerCalls).toHaveLength(0);
    expect(s.router.pendingLaneCount()).toBe(1);
  });

  it('Stop with an unanswered steer re-queues it, says so, and the bot answers it next', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    const steer = s.router.onUserMessage(s.room.id, 'ANSWER-ME');
    const l = s.lane()!;
    l.finish({ ok: false, error: 'aborted', stopped: true, consumedSteers: [], unansweredSteers: [...l.uuids] });
    await until(() => s.reqs.length === 2);
    const notes = s.repos.listMessages(s.room.id, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text);
    expect(notes).toContain('Stopped. Ada will answer your new message next.');
    expect(delivery(s.repos, steer.id)).toEqual({ queued: { [s.ada.id]: { reason: 'requeued' } } });
    expect(count(s.reqs[1].injected, 'ANSWER-ME')).toBe(1);
    // Its own cause again, since no turn answered it.
    expect(s.repos.getMessage(steer.id)!.causeId).toBe(steer.id);
    expect(journal(s.repos).map((j) => j.status)).toEqual(['queued']);
  });

  it('a routine turn can be steered and keeps its strict approvals', async () => {
    const s = setup();
    s.router.fireRoutine(s.room, s.ada, 'daily report', null);
    await until(() => s.reqs.length === 1);
    expect(s.reqs[0].strictApprovals).toBe(true);
    expect(s.reqs[0].causeKind).toBe('routine');
    const m = s.router.onUserMessage(s.room.id, 'also include sales');
    expect(m.payload).toEqual({ steered: { [s.ada.id]: 't1' } });
    s.finishAnswered();
    await tick();
    // Answered inside the routine's own turn: no separate, non-strict turn for it.
    expect(s.reqs).toHaveLength(1);
  });
});

describe('steering across a restart', () => {
  /** Runs a turn, steers it, then "crashes": the hub freezes and the turn is cut off with nothing settled. */
  async function crashMidSteer() {
    const s = setup();
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    const steer = s.router.onUserMessage(s.room.id, 'STEERED-TEXT');
    s.router.freeze();
    s.lane()!.finish({ ok: false, error: 'aborted', stopped: true, consumedSteers: [], unansweredSteers: [...s.lane()!.uuids] });
    await tick();
    expect(journal(s.repos).map((j) => j.status)).toEqual(['queued', 'steered']);
    return { s, steer };
  }
  function restart(repos: Repos) {
    const next = setup({ repos });
    const followUp = new FollowUp({ repos, router: next.router });
    return { next, followUp };
  }

  it('re-queues the steer with its turn and shows it exactly once', async () => {
    const { s } = await crashMidSteer();
    const { next, followUp } = restart(s.repos);
    expect(followUp.resumeInterrupted()).toBe(2);
    await until(() => next.reqs.length === 1);
    await tick();
    expect(next.reqs).toHaveLength(1);
    expect(count(next.reqs[0].injected, 'STEERED-TEXT')).toBe(1);
  });

  it('re-queues the steer even when its turn has used its one resume, and only once', async () => {
    const { s } = await crashMidSteer();
    // The turn's own item was already resumed once before: FollowUp gives up on it.
    s.repos.db.run("UPDATE lane_journal SET attempts=1 WHERE status='queued'");
    const { next, followUp } = restart(s.repos);
    expect(followUp.resumeInterrupted()).toBe(1);
    await until(() => next.reqs.length === 1);
    expect(count(next.reqs[0].injected, 'STEERED-TEXT')).toBe(1);
    // Crash again while answering it: it is not resumed a second time.
    next.router.freeze();
    next.lane()!.finish({ ok: false, error: 'aborted', stopped: true });
    await tick();
    const third = restart(s.repos);
    expect(third.followUp.resumeInterrupted()).toBe(0);
  });

  it('an answered steer stays hidden after a restart (its marker is not resumed as work)', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    s.router.onUserMessage(s.room.id, 'ANSWERED');
    s.finishAnswered();
    await tick();
    const { next, followUp } = restart(s.repos);
    expect(followUp.resumeInterrupted()).toBe(0);
    next.router.onUserMessage(next.room.id, 'AFTER');
    await until(() => next.reqs.length === 1);
    expect(next.reqs[0].injected).toContain('AFTER');
    expect(next.reqs[0].injected).not.toContain('ANSWERED');
  });
});

describe('send mode on the wire', () => {
  it('WS message.send takes an optional mode of join or queue, nothing else', () => {
    const base = { type: 'message.send', roomId: 'r', text: 'hi' };
    expect(ClientEventSchema.safeParse(base).success).toBe(true);
    expect(ClientEventSchema.safeParse({ ...base, mode: 'join' }).success).toBe(true);
    expect(ClientEventSchema.safeParse({ ...base, mode: 'queue' }).success).toBe(true);
    expect(ClientEventSchema.safeParse({ ...base, mode: 'steer' }).success).toBe(false);
  });
  it('REST POST /api/rooms/:id/messages takes the same mode', () => {
    expect(RoomMessageInputSchema.parse({ text: 'hi', mode: 'queue' })).toEqual({ text: 'hi', mode: 'queue' });
    expect(RoomMessageInputSchema.safeParse({ text: 'hi', mode: 'now' }).success).toBe(false);
    expect(RoomMessageInputSchema.safeParse({ text: '' }).success).toBe(false);
  });
});
