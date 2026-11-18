import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, DeliveryPayload, LaneQueue, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { FollowUp } from '../services/FollowUp.js';
import { installSettings } from '../services/SettingsStore.js';
import type { BotRunner, LaneSteerResult, SteerRequest, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { QueueError, RoomRouter } from './RoomRouter.js';

/**
 * Queue controls (02 Phase 2): read a bot's queue (2.1a), cancel, edit and send now (2.1b), pause (2.2) and the
 * "stopped by you" note (2.3). A fake runner holds each turn open until the test finishes it.
 */

interface Running {
  turnId: string;
  req: TurnRequest;
  uuids: string[];
  finish: (extra?: Partial<TurnResult>) => void;
}

function makeRunner() {
  const reqs: TurnRequest[] = [];
  const running = new Map<string, Running>();
  const interrupts: { botId: string; roomId: string; by?: string }[] = [];
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
      const r = running.get(botId + ':' + roomId);
      if (!r) return { status: 'queued', reason: 'between-runs' };
      r.uuids.push(req.uuid);
      return { status: 'accepted', turnId: r.turnId };
    },
    interrupt: () => true,
    interruptLane: (botId: string, roomId: string, by?: string) => {
      interrupts.push({ botId, roomId, by });
      return running.has(botId + ':' + roomId);
    },
  };
  return { runner: runner as unknown as BotRunner, reqs, running, interrupts };
}

function setup(opts: { group?: boolean; repos?: Repos } = {}) {
  const repos = opts.repos ?? new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const r = makeRunner();
  router.runner = r.runner;
  const find = (h: string) => repos.listBots().find((b) => b.handle === h);
  const ada = find('ada') ?? repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const bo = find('bo') ?? repos.createBot({ name: 'Bo', handle: 'bo', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const room = opts.group
    ? repos.listRooms().find((x) => x.kind === 'group') ?? repos.createRoom({ kind: 'group', name: 'Team', memberIds: [ada.id, bo.id], coordinatorBotId: ada.id })
    : repos.listRooms().find((x) => x.kind === 'dm') ?? repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [ada.id], coordinatorBotId: null });
  const lane = (bot: Bot = ada, rm: Room = room) => r.running.get(bot.id + ':' + rm.id);
  const queue = (bot: Bot = ada) => router.laneQueue(bot.id, room.id);
  const notes = () => repos.listMessages(room.id).filter((m) => m.kind === 'system').map((m) => m.text);
  return { repos, router, room, ada, bo, lane, queue, notes, ...r };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const statuses = (repos: Repos) => repos.db.all<{ status: string }>('SELECT status FROM lane_journal ORDER BY created_at, rowid').map((j) => j.status);
const refusal = (fn: () => unknown): QueueError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof QueueError) return e;
    throw e;
  }
  throw new Error('expected a QueueError');
};

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  installSettings(null as never);
});

/** Ada busy with a first message, then `texts` queued behind it (Ctrl+Enter). */
async function busyWithQueue(s: ReturnType<typeof setup>, ...texts: string[]) {
  s.router.onUserMessage(s.room.id, 'build the page');
  await until(() => s.reqs.length === 1);
  return texts.map((t) => s.router.onUserMessage(s.room.id, t, undefined, undefined, 'queue'));
}

describe('reading the queue (2.1a)', () => {
  it('lists the waiting items in order, with reason and rights, and pushes queue.changed on each change', async () => {
    const s = setup();
    const pushed: LaneQueue[] = [];
    offs.push(events.onEvent((ev) => { if (ev.type === 'queue.changed') pushed.push(ev.queue); }));
    const [a, b] = await busyWithQueue(s, 'first queued', 'second queued');
    const q = s.queue();
    expect(q).toMatchObject({ botId: s.ada.id, roomId: s.room.id, paused: false, running: true });
    expect(q.items.map((i) => [i.messageId, i.preview, i.position, i.reason, i.kind, i.authorType])).toEqual([
      [a.id, 'first queued', 1, 'shortcut', 'message', 'user'],
      [b.id, 'second queued', 2, 'shortcut', 'message', 'user'],
    ]);
    expect(q.items.every((i) => i.editable && i.cancellable && !i.editRefusal)).toBe(true);
    expect(s.router.queueSnapshot(s.room.id)).toEqual([q]);
    // Pushed when each was queued (the last push already carries the reason), and when the next turn took them in.
    expect(pushed.at(-1)!.items.map((i) => i.reason)).toEqual(['shortcut', 'shortcut']);
    s.lane()!.finish();
    await until(() => s.reqs.length === 2);
    expect(pushed.at(-1)).toMatchObject({ running: true, items: [] });
  });

  it('a hand-off waits in the queue but is neither editable nor cancellable', async () => {
    const s = setup({ group: true });
    s.router.onUserMessage(s.room.id, '@bo start');
    await until(() => s.reqs.length === 1);
    // Ada (coordinator) hands work to Bo while Bo is busy.
    s.router.dispatchFromBot({ bot: s.ada, room: s.room, hop: 0, causeId: 'c' } as TurnRequest, [s.bo]);
    const [item] = s.queue(s.bo).items;
    expect(item).toMatchObject({ kind: 'handoff', messageId: null, editable: false, cancellable: false });
    expect(item.editRefusal).toBe('Only your own messages can be edited.');
    expect(refusal(() => s.router.cancelQueued(item.journalId)).status).toBe(403);
    expect(refusal(() => s.router.editQueued(item.journalId, 'x')).status).toBe(403);
    expect(s.queue(s.bo).items).toHaveLength(1);
  });

  it('a room the hub does not know is a 404', () => {
    const s = setup();
    expect(refusal(() => s.router.queueSnapshot('nope')).status).toBe(404);
  });
});

describe('cancel (2.1b)', () => {
  it('a cancelled message never reaches the next turn, and stays cancelled across a restart', async () => {
    const s = setup();
    const [drop, keep] = await busyWithQueue(s, 'CANCEL-ME', 'KEEP-ME');
    const updates: unknown[] = [];
    offs.push(events.onEvent((ev) => { if (ev.type === 'message.update' && ev.id === drop.id) updates.push(ev.patch); }));
    const journalId = s.queue().items[0].journalId;
    const after = s.router.cancelQueued(journalId);
    expect(after.cancelledAt).toBeGreaterThan(0);
    expect(after.payload).toBeNull();
    expect(updates).toEqual([{ payload: null, cancelledAt: after.cancelledAt }]);
    expect(s.queue().items.map((i) => i.messageId)).toEqual([keep.id]);
    expect(statuses(s.repos)).toEqual(['queued', 'cancelled', 'queued']);
    // Cancelling again: it is gone.
    expect(refusal(() => s.router.cancelQueued(journalId)).status).toBe(404);

    s.lane()!.finish();
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('KEEP-ME');
    expect(s.reqs[1].injected).not.toContain('CANCEL-ME');

    // Restart mid-turn: the cancelled row is not work, and the message stays hidden.
    s.router.freeze();
    s.lane()!.finish({ ok: false, error: 'aborted' });
    await tick();
    const next = setup({ repos: s.repos });
    expect(new FollowUp({ repos: s.repos, router: next.router }).resumeInterrupted()).toBe(1);
    await until(() => next.reqs.length === 1);
    expect(next.reqs[0].injected).not.toContain('CANCEL-ME');
    expect(s.repos.getMessage(drop.id)!.cancelledAt).toBe(after.cancelledAt);
  });

  it('in a group, cancelling one bot\'s copy hides it from that bot only; the last copy cancels the message', async () => {
    const s = setup({ group: true });
    s.router.onUserMessage(s.room.id, '@ada @bo warm up');
    await until(() => s.reqs.length === 2);
    const msg = s.router.onUserMessage(s.room.id, '@ada @bo BOTH-QUEUED', undefined, undefined, 'queue');
    expect((msg.payload as DeliveryPayload).queued).toEqual({ [s.ada.id]: { reason: 'shortcut' }, [s.bo.id]: { reason: 'shortcut' } });

    const afterAda = s.router.cancelQueued(s.queue(s.ada).items[0].journalId);
    expect(afterAda.cancelledAt).toBeUndefined();
    expect((afterAda.payload as DeliveryPayload).queued).toEqual({ [s.bo.id]: { reason: 'shortcut' } });

    // Ada's next turn (woken by something else) does not see it; Bo's does.
    s.lane(s.ada)!.finish();
    s.router.onUserMessage(s.room.id, '@ada next thing', undefined, undefined, 'queue');
    s.lane(s.bo)!.finish();
    await until(() => s.reqs.length === 4);
    const ada2 = s.reqs.find((r, i) => i >= 2 && r.bot.id === s.ada.id)!;
    const bo2 = s.reqs.find((r, i) => i >= 2 && r.bot.id === s.bo.id)!;
    expect(ada2.injected).not.toContain('BOTH-QUEUED');
    expect(bo2.injected).toContain('BOTH-QUEUED');
  });

  it('settles the item: its onDone hears "cancelled"', async () => {
    const s = setup();
    const results: TurnResult[] = [];
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    // A resumed item (restart) carrying its message id and an onDone.
    s.router.resume(s.ada, s.room, { causeId: 'c', hop: 0, triggerSeq: 1, attempts: 1, messageId: s.repos.listMessages(s.room.id)[0].id, onDone: (r) => results.push(r) });
    s.router.cancelQueued(s.queue().items[0].journalId);
    expect(results).toEqual([expect.objectContaining({ ok: false, error: 'cancelled' })]);
  });

  it('refuses a journal id from another room', async () => {
    const s = setup();
    await busyWithQueue(s, 'queued');
    expect(refusal(() => s.router.cancelQueued(s.queue().items[0].journalId, 'other-room')).status).toBe(404);
    expect(s.queue().items).toHaveLength(1);
  });
});

describe('edit (2.1b)', () => {
  it('rewrites a queued message before it starts; the next turn reads the new text', async () => {
    const s = setup();
    const [m] = await busyWithQueue(s, 'OLD-TEXT');
    const edited = s.router.editQueued(s.queue().items[0].journalId, 'NEW-TEXT');
    expect(edited.text).toBe('NEW-TEXT');
    expect(s.repos.getMessage(m.id)).toMatchObject({ text: 'NEW-TEXT', editedAt: edited.editedAt });
    expect(s.queue().items[0].preview).toBe('NEW-TEXT');
    s.lane()!.finish();
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('NEW-TEXT');
    expect(s.reqs[1].injected).not.toContain('OLD-TEXT');
  });

  it('stays edited across a restart: the resumed item is still editable and its turn reads the new text', async () => {
    const s = setup();
    const [m] = await busyWithQueue(s, 'OLD-TEXT');
    const edited = s.router.editQueued(s.queue().items[0].journalId, 'NEW-TEXT');

    // Restart before the queued item ran: the running turn is cut off, both items come back from the journal.
    s.router.freeze();
    s.lane()!.finish({ ok: false, error: 'aborted' });
    await tick();
    const next = setup({ repos: s.repos });
    next.router.setQueuePaused(next.room.id, next.ada.id, true);
    expect(new FollowUp({ repos: s.repos, router: next.router }).resumeInterrupted()).toBe(2);
    await tick();
    expect(next.reqs).toHaveLength(0);
    const item = next.queue().items.find((i) => i.messageId === m.id)!;
    expect(item).toMatchObject({ preview: 'NEW-TEXT', editable: true });
    expect(s.repos.getMessage(m.id)).toMatchObject({ text: 'NEW-TEXT', editedAt: edited.editedAt });

    next.router.setQueuePaused(next.room.id, next.ada.id, false);
    await until(() => next.reqs.length === 1);
    expect(next.reqs[0].injected).toContain('NEW-TEXT');
    expect(next.reqs[0].injected).not.toContain('OLD-TEXT');
  });

  it('is refused once another bot\'s turn is reading it, and once a cursor passed it', async () => {
    const s = setup({ group: true });
    s.router.onUserMessage(s.room.id, '@ada warm up');
    await until(() => s.reqs.length === 1);
    // Queued for busy Ada; idle Bo starts a turn on it right away.
    s.router.onUserMessage(s.room.id, '@ada @bo SHARED', undefined, undefined, 'queue');
    await until(() => s.reqs.length === 2);
    const item = s.queue(s.ada).items[0];
    expect(item).toMatchObject({ editable: false, editRefusal: 'A bot is reading it now.', cancellable: true });
    expect(refusal(() => s.router.editQueued(item.journalId, 'changed')).status).toBe(409);
    s.lane(s.bo)!.finish();
    await tick();
    expect(s.queue(s.ada).items[0].editRefusal).toBe('A bot has already read it.');
    // Cancelling Ada's copy is still allowed, but the message itself is not marked cancelled: Bo read it.
    expect(s.router.cancelQueued(item.journalId).cancelledAt).toBeUndefined();
  });

  it('is refused once a lane steered it', async () => {
    const s = setup({ group: true });
    s.router.onUserMessage(s.room.id, '@ada @bo warm up');
    await until(() => s.reqs.length === 2);
    // Bo's lane is between turns of its own (no run to join), so Bo queues while Ada takes it in.
    s.lane(s.bo)!.finish();
    s.router.setQueuePaused(s.room.id, s.bo.id, true);
    await tick();
    s.router.onUserMessage(s.room.id, '@ada @bo STEER-AND-QUEUE');
    const item = s.queue(s.bo).items[0];
    expect(item.reason).toBe('paused');
    expect(item.editRefusal).toBe('It already joined a running turn.');
  });

  it('rejects an empty edit at the schema', async () => {
    const { ClientEventSchema } = await import('@pocketrocket/shared');
    expect(ClientEventSchema.safeParse({ type: 'queue.edit', journalId: 'j', text: '   ' }).success).toBe(false);
    expect(ClientEventSchema.safeParse({ type: 'queue.edit', journalId: 'j', text: 'ok' }).success).toBe(true);
  });
});

describe('send now (2.1b) and the stop note (2.3)', () => {
  it('stops the running turn as the owner, then runs the queue next with one note', async () => {
    const s = setup();
    await busyWithQueue(s, 'RUN-ME-NOW');
    expect(s.router.sendNow(s.room.id, s.ada.id)).toEqual({ interrupted: true });
    expect(s.interrupts).toEqual([{ botId: s.ada.id, roomId: s.room.id, by: 'owner' }]);
    s.lane()!.finish({ ok: false, error: 'aborted', stopped: true, stoppedBy: 'owner' });
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('RUN-ME-NOW');
    expect(s.notes()).toEqual(['Ada was stopped by you; its queued messages run now.']);
  });

  it('unanswered steers are re-queued as on Stop, ahead of nothing lost, with the re-queue note only', async () => {
    const s = setup();
    await busyWithQueue(s, 'QUEUED-ONE');
    s.router.onUserMessage(s.room.id, 'STEERED-ONE');
    expect(s.lane()!.uuids).toHaveLength(1);
    s.router.sendNow(s.room.id, s.ada.id);
    s.lane()!.finish({ ok: false, error: 'aborted', stopped: true, stoppedBy: 'owner', consumedSteers: [], unansweredSteers: [...s.lane()!.uuids] });
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('QUEUED-ONE');
    expect(s.reqs[1].injected).toContain('STEERED-ONE');
    expect(s.notes()).toEqual(['Stopped. Ada will answer your new message next.']);
  });

  it('Stop with nothing queued posts "stopped by you"', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    s.lane()!.finish({ ok: false, error: 'aborted', stopped: true, stoppedBy: 'owner' });
    await tick();
    expect(s.notes()).toEqual(['Ada was stopped by you.']);
  });

  it('a stop the owner did not make (removed from the room) posts no "stopped by you"', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, 'build the page');
    await until(() => s.reqs.length === 1);
    s.lane()!.finish({ ok: false, error: 'aborted', stopped: true });
    await tick();
    expect(s.notes()).toEqual([]);
  });

  it('is refused with nothing queued, and resumes a paused queue', async () => {
    const s = setup();
    expect(refusal(() => s.router.sendNow(s.room.id, s.ada.id)).status).toBe(409);
    s.router.setQueuePaused(s.room.id, s.ada.id, true);
    s.router.onUserMessage(s.room.id, 'HELD');
    await tick();
    expect(s.reqs).toHaveLength(0);
    // Nothing running: no stop, the queue just starts.
    expect(s.router.sendNow(s.room.id, s.ada.id)).toEqual({ interrupted: false });
    await until(() => s.reqs.length === 1);
    expect(s.repos.lanePaused(s.ada.id, s.room.id)).toBe(false);
  });
});

describe('pause (2.2)', () => {
  it('a paused queue starts nothing; resume drains it in one turn', async () => {
    const s = setup();
    const paused = s.router.setQueuePaused(s.room.id, s.ada.id, true);
    expect(paused).toEqual([expect.objectContaining({ botId: s.ada.id, paused: true, items: [] })]);
    const m = s.router.onUserMessage(s.room.id, 'ONE');
    s.router.onUserMessage(s.room.id, 'TWO');
    await tick();
    expect(s.reqs).toHaveLength(0);
    expect((m.payload as DeliveryPayload).queued).toEqual({ [s.ada.id]: { reason: 'paused' } });
    expect(s.queue()).toMatchObject({ paused: true, running: false });
    expect(s.queue().items.map((i) => i.preview)).toEqual(['ONE', 'TWO']);
    s.router.setQueuePaused(s.room.id, s.ada.id, false);
    await until(() => s.reqs.length === 1);
    expect(s.reqs[0].injected).toContain('ONE');
    expect(s.reqs[0].injected).toContain('TWO');
  });

  it('pausing lets the running turn finish, then holds what is queued behind it', async () => {
    const s = setup();
    await busyWithQueue(s, 'AFTER-PAUSE');
    s.router.setQueuePaused(s.room.id, s.ada.id, true);
    s.lane()!.finish();
    await tick();
    expect(s.reqs).toHaveLength(1);
    s.router.setQueuePaused(s.room.id, undefined, false);
    await until(() => s.reqs.length === 2);
  });

  it('survives a restart: resumed items wait until the queue is resumed', async () => {
    const s = setup();
    s.router.setQueuePaused(s.room.id, s.ada.id, true);
    s.router.onUserMessage(s.room.id, 'HELD-OVER-RESTART');
    await tick();
    s.router.freeze();
    const next = setup({ repos: s.repos });
    expect(new FollowUp({ repos: s.repos, router: next.router }).resumeInterrupted()).toBe(1);
    await tick();
    expect(next.reqs).toHaveLength(0);
    expect(next.queue()).toMatchObject({ paused: true });
    expect(next.queue().items[0].messageId).toBeTruthy();
    next.router.setQueuePaused(next.room.id, next.ada.id, false);
    await until(() => next.reqs.length === 1);
    expect(next.reqs[0].injected).toContain('HELD-OVER-RESTART');
  });

  it('without a bot it pauses every member; a non-member is refused', () => {
    const s = setup({ group: true });
    expect(s.router.setQueuePaused(s.room.id, undefined, true).map((q) => q.paused)).toEqual([true, true]);
    expect(s.repos.pausedBots(s.room.id).sort()).toEqual([s.ada.id, s.bo.id].sort());
    expect(refusal(() => s.router.setQueuePaused(s.room.id, 'stranger', true)).status).toBe(404);
  });

  it('a bot leaving the room drops its pause', () => {
    const s = setup();
    s.router.setQueuePaused(s.room.id, s.ada.id, true);
    s.router.botLeftRoom(s.ada.id, s.room.id);
    expect(s.repos.lanePaused(s.ada.id, s.room.id)).toBe(false);
  });
});
