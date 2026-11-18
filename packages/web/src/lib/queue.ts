import type { LaneQueue, QueueItem } from '@pocketrocket/shared';

/**
 * Queue controls (02 task 2.4). The store keeps one {@link LaneQueue} per bot and room, fed by `queue.changed` and by
 * `GET /api/rooms/:id/queue` when a room loads (and again after a reconnect). Only lanes worth showing are kept: one
 * with something waiting, or a paused one. An empty, unpaused lane means nothing is waiting, so it is dropped.
 */
export type Queues = Record<string, LaneQueue>;

export const laneKey = (botId: string, roomId: string) => botId + ':' + roomId;

/** A lane the chip row shows: something is waiting, or the owner paused it. */
export function laneShows(q: Pick<LaneQueue, 'items' | 'paused'>): boolean {
  return q.items.length > 0 || q.paused;
}

/** One lane changed (`queue.changed`). Returns the same object when nothing changes, so subscribers do not re-render. */
export function applyLaneQueue(queues: Queues, q: LaneQueue): Queues {
  const key = laneKey(q.botId, q.roomId);
  if (laneShows(q)) return { ...queues, [key]: q };
  if (!(key in queues)) return queues;
  const next = { ...queues };
  delete next[key];
  return next;
}

/** A room's whole snapshot (`GET /api/rooms/:id/queue`): replaces every lane of that room, other rooms untouched. */
export function replaceRoomQueues(queues: Queues, roomId: string, lanes: LaneQueue[]): Queues {
  let next: Queues = {};
  for (const [key, q] of Object.entries(queues)) if (q.roomId !== roomId) next[key] = q;
  for (const q of lanes) if (q.roomId === roomId) next = applyLaneQueue(next, q);
  return next;
}

/** The room's lanes in member order (the header's order), so chips do not jump around as lanes come and go. */
export function roomLanes(queues: Queues, roomId: string, memberIds: readonly string[]): LaneQueue[] {
  const out: LaneQueue[] = [];
  for (const id of memberIds) {
    const q = queues[laneKey(id, roomId)];
    if (q) out.push(q);
  }
  return out;
}

/** "1 message" / "3 messages": what a chip and its popover count. */
export function countWords(n: number): string {
  return n + (n === 1 ? ' message' : ' messages');
}

/**
 * Who an item came from, in words, for anything that is not the person's own message (those need no label). Bot names
 * come from `name`; an unknown bot reads "A bot".
 */
export function itemSource(item: Pick<QueueItem, 'kind' | 'authorType' | 'authorId'>, name: (botId: string) => string | undefined): string | null {
  switch (item.kind) {
    case 'message': return item.authorType === 'user' ? null : 'From ' + (item.authorId ? name(item.authorId) ?? 'a bot' : 'a bot');
    case 'handoff': return 'Hand-off' + (item.authorId && name(item.authorId) ? ' from ' + name(item.authorId) : '');
    case 'routine': return 'Routine';
    case 'trigger': return 'Trigger';
    case 'followup': return 'Follow-up from the hub';
    default: return null;
  }
}

/**
 * Why an item of the person's own cannot be edited, in plain words, or null when it can (or is not theirs, which needs
 * no explanation). The hub's own reason wins; without one, a general sentence that is still true.
 */
export function editRefusalText(item: Pick<QueueItem, 'editable' | 'editRefusal' | 'authorType'>): string | null {
  if (item.editable || item.authorType !== 'user') return null;
  return "Can't edit: " + lowerFirst(item.editRefusal?.trim() || 'a bot has started on it.');
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
