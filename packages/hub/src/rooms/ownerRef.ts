import type { TurnResult } from '../agent/BotRunner.js';

/**
 * Who a lane item (and the turn it becomes) belongs to, as one string that is journaled with the item and stored with
 * a parked approval: `routine:<runId>` or `workflow:<runId>:<nodeId>` (later `channel:<linkId>`). A turn's `onDone` is a
 * closure, so it is lost across a restart and across a park; the ref is what lets the hub build it again
 * (`RoomRouter.ownerDone`), so a resumed or parked turn still settles the run it belongs to.
 */
export const routineRef = (runId: string): string => 'routine:' + runId;
export const workflowRef = (runId: string, nodeId: string): string => 'workflow:' + runId + ':' + nodeId;

export type ParsedOwnerRef =
  | { kind: 'routine'; runId: string }
  | { kind: 'workflow'; runId: string; nodeId: string };

export function parseOwnerRef(ref: string | null | undefined): ParsedOwnerRef | null {
  if (!ref) return null;
  const [kind, a, b, ...rest] = ref.split(':');
  if (rest.length) return null;
  if (kind === 'routine' && a && b === undefined) return { kind, runId: a };
  if (kind === 'workflow' && a && b) return { kind, runId: a, nodeId: b };
  return null;
}

/** What an owner does with the turns that carry its ref. Registered with `RoomRouter.registerOwner`. */
export interface OwnerHandler {
  /** The owner's turn ended. Not called for a parked turn (the resumed turn calls it later). */
  onDone(ref: ParsedOwnerRef, result: TurnResult): void;
  /** The turn can never run (the bot left the room, a restart already resumed it once): settle the owner as failed. */
  onGone(ref: ParsedOwnerRef, reason: string): void;
  /** A person's message was pushed into the running turn (steering). */
  onSteer?(ref: ParsedOwnerRef, steer: { at: number; text: string }): void;
}
