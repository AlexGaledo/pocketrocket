import { describe, expect, it } from 'vitest';
import type { LaneQueue, QueueItem } from '@pocketrocket/shared';
import { applyLaneQueue, countWords, editRefusalText, itemSource, laneKey, laneShows, replaceRoomQueues, roomLanes, type Queues } from './queue';

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  journalId: 'j1', messageId: 'm1', kind: 'message', authorType: 'user', authorId: 'me', preview: 'hi', reason: 'shortcut',
  position: 1, editable: true, cancellable: true, ...over,
});
const lane = (botId: string, roomId: string, over: Partial<LaneQueue> = {}): LaneQueue => ({ botId, roomId, paused: false, running: true, items: [item()], ...over });

describe('applyLaneQueue: queue.changed', () => {
  it('adds a lane with items, keyed bot:room', () => {
    const q = applyLaneQueue({}, lane('ada', 'r1'));
    expect(Object.keys(q)).toEqual([laneKey('ada', 'r1')]);
    expect(q['ada:r1'].items).toHaveLength(1);
  });

  it('replaces the lane with the newer copy', () => {
    const one = applyLaneQueue({}, lane('ada', 'r1'));
    const two = applyLaneQueue(one, lane('ada', 'r1', { items: [item(), item({ journalId: 'j2', position: 2 })] }));
    expect(two['ada:r1'].items.map((i) => i.journalId)).toEqual(['j1', 'j2']);
  });

  it('drops a lane once it is empty and unpaused', () => {
    const one = applyLaneQueue({}, lane('ada', 'r1'));
    expect(applyLaneQueue(one, lane('ada', 'r1', { items: [] }))).toEqual({});
  });

  it('keeps an empty lane while it is paused, so Resume stays reachable', () => {
    const q = applyLaneQueue({}, lane('ada', 'r1', { items: [], paused: true, running: false }));
    expect(q['ada:r1'].paused).toBe(true);
  });

  it('returns the same object when an empty lane it never had goes away', () => {
    const before: Queues = { 'bo:r1': lane('bo', 'r1') };
    expect(applyLaneQueue(before, lane('ada', 'r1', { items: [] }))).toBe(before);
  });

  it('leaves other lanes and rooms alone', () => {
    let q = applyLaneQueue({}, lane('ada', 'r1'));
    q = applyLaneQueue(q, lane('ada', 'r2'));
    q = applyLaneQueue(q, lane('ada', 'r1', { items: [] }));
    expect(Object.keys(q)).toEqual(['ada:r2']);
  });
});

describe('replaceRoomQueues: GET /api/rooms/:id/queue', () => {
  it("replaces only that room's lanes and filters out running-only lanes", () => {
    const before: Queues = { 'ada:r1': lane('ada', 'r1'), 'bo:r1': lane('bo', 'r1'), 'ada:r2': lane('ada', 'r2') };
    const after = replaceRoomQueues(before, 'r1', [lane('bo', 'r1', { paused: true }), lane('cy', 'r1', { items: [] })]);
    expect(Object.keys(after).sort()).toEqual(['ada:r2', 'bo:r1']);
    expect(after['bo:r1'].paused).toBe(true);
    expect(after['ada:r2']).toBe(before['ada:r2']);
  });

  it('ignores a lane from another room in the answer', () => {
    expect(replaceRoomQueues({}, 'r1', [lane('ada', 'r9')])).toEqual({});
  });
});

describe('roomLanes', () => {
  it('lists lanes in member order, only for that room', () => {
    const q: Queues = { 'bo:r1': lane('bo', 'r1'), 'ada:r1': lane('ada', 'r1'), 'ada:r2': lane('ada', 'r2') };
    expect(roomLanes(q, 'r1', ['ada', 'bo', 'cy']).map((l) => l.botId)).toEqual(['ada', 'bo']);
  });
});

describe('words', () => {
  it('counts', () => {
    expect(countWords(1)).toBe('1 message');
    expect(countWords(3)).toBe('3 messages');
  });

  it('shows a lane with items or a pause only', () => {
    expect(laneShows({ items: [], paused: false })).toBe(false);
    expect(laneShows({ items: [], paused: true })).toBe(true);
  });

  it('labels items that are not the person’s own', () => {
    const name = (id: string) => (id === 'dev' ? 'Dev' : undefined);
    expect(itemSource(item(), name)).toBeNull();
    expect(itemSource(item({ kind: 'handoff', authorType: null, authorId: 'dev' }), name)).toBe('Hand-off from Dev');
    expect(itemSource(item({ kind: 'handoff', authorType: null, authorId: null }), name)).toBe('Hand-off');
    expect(itemSource(item({ kind: 'routine' }), name)).toBe('Routine');
    expect(itemSource(item({ kind: 'followup' }), name)).toBe('Follow-up from the hub');
  });

  it('explains an edit refusal in plain words, from the hub’s reason', () => {
    expect(editRefusalText(item())).toBeNull();
    expect(editRefusalText(item({ editable: false, editRefusal: 'A bot has already read it.' }))).toBe("Can't edit: a bot has already read it.");
    expect(editRefusalText(item({ editable: false, editRefusal: 'It already joined a running turn.' }))).toBe("Can't edit: it already joined a running turn.");
    expect(editRefusalText(item({ editable: false }))).toBe("Can't edit: a bot has started on it.");
  });

  it('says nothing about editing a bot’s hand-off', () => {
    expect(editRefusalText(item({ kind: 'handoff', authorType: null, editable: false, editRefusal: 'Only your own messages can be edited.' }))).toBeNull();
  });
});
