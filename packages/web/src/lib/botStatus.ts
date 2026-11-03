/**
 * Who a bot is waiting on. The hub reports one `waiting` state for a takeover, a pause and a hand-off, and a
 * parked approval or takeover ends the turn altogether, so `bot.state` alone cannot say whether the user must act.
 * This derives the answer on the client from the state, the control status and the open approval cards.
 *
 * Cards come from loaded rooms and from `hello`, which lists every open card, so this is right after a reload too.
 */
import { useMemo } from 'react';
import type { ApprovalPayload, BotState, ControlStatus, Message, OpenApproval } from '@pocketrocket/shared';
import { useStore } from '../store';

export type BotStatus = 'needs_you' | 'paused' | 'waiting_on_bot' | 'idle' | 'thinking' | 'working' | 'done' | 'error';

export const STATUS_LABEL: Record<BotStatus, string> = {
  needs_you: 'Needs you',
  paused: 'Paused',
  waiting_on_bot: 'Waiting on a bot',
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  done: 'Done',
  error: 'Stopped with an error',
};

/** The avatar ring for each status: rings are drawn from the hub's states (`.state-*` in index.css). */
const RING: Record<BotStatus, BotState> = {
  needs_you: 'blocked',
  paused: 'waiting',
  waiting_on_bot: 'waiting',
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  done: 'done',
  error: 'error',
};

export const avatarStatus = (status: BotStatus) => ({ state: RING[status], label: STATUS_LABEL[status] });

export const isWorking = (status: BotStatus) => status === 'thinking' || status === 'working';

export function botStatus(state: BotState | undefined, control: ControlStatus | undefined, awaitingApproval: boolean): BotStatus {
  if (state === 'blocked' || awaitingApproval || control?.takeover) return 'needs_you';
  if (control?.control === 'paused') return 'paused';
  if (state === 'waiting') return 'waiting_on_bot';
  return state ?? 'idle';
}

/** Bot id to a room holding one of its open approval cards. */
function openApprovals(messages: Record<string, Message[]>, known: OpenApproval[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of known) out.set(a.botId, a.roomId);
  for (const [roomId, list] of Object.entries(messages)) {
    for (const m of list) {
      if (m.kind === 'approval' && m.authorId && (m.payload as ApprovalPayload | null)?.status === 'pending') out.set(m.authorId, roomId);
    }
  }
  return out;
}

export function useBotStatus() {
  const botStates = useStore((s) => s.botStates);
  const control = useStore((s) => s.control);
  const messages = useStore((s) => s.messages);
  const known = useStore((s) => s.openApprovals);
  const approvals = useMemo(() => openApprovals(messages, known), [messages, known]);
  return {
    statusOf: (botId: string) => botStatus(botStates[botId], control[botId], approvals.has(botId)),
    /** The room where the user can act: not always the bot's DM, since a card can sit in a group chat. */
    needsYouRoom: (botId: string): string | null => control[botId]?.takeover?.roomId ?? approvals.get(botId) ?? null,
  };
}
