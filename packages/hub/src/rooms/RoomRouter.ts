import { randomUUID } from 'node:crypto';
import { pickCoordinator } from './coordinator.js';
import { MAX_ATTACHMENTS, QUEUE_PREVIEW_CHARS } from '@pocketrocket/shared';
import type { Bot, BotState, CauseKind, DeliveryPayload, LaneQueue, Message, QueueItem, QueueReason, Room, SendMode, TriggerEvent, TriggerPayload } from '@pocketrocket/shared';
import { CAUSE_COST_CAP_USD, CUTOFF_RETRIES, MAX_CONCURRENT_TURNS, MAX_HOPS } from '../config.js';
import { ownerTag, settings } from '../services/SettingsStore.js';
import { quoteTags } from './transcript.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import type { UsageTracker } from '../services/UsageTracker.js';
import type { AutoMemory } from '../services/AutoMemory.js';
import { parseMentions } from './mentions.js';
import { triggerText } from './untrusted.js';
import { logError } from '../providers/redact.js';
import { hopBudgetLine, rosterText } from '../agent/PromptBuilder.js';

interface LaneItem {
  causeId: string;
  hop: number;
  triggerSeq: number;
  onDone?: (r: TurnResult) => void;
  /** P8: what started this item; feeds the model router and the usage breakdown. */
  causeKind?: CauseKind;
  // ---- P3 ----
  /** Routine run this item belongs to, journaled so a resumed turn can still close the run. */
  runId?: string;
  /** Extra line for the bot's input (a follow-up nudge, a resume after restart). */
  note?: string;
  /** `lane_journal` row; removed when the item settles. */
  journalId?: string;
  /** Restarts this item was already resumed across (journaled). */
  attempts?: number;
  // ---- P5 ----
  /** Most this item's turn may spend (a trigger's remaining daily budget); the cause cap still applies. */
  budgetUsd?: number;
  /** Re-queued after a cut-off turn: run it in a fresh session. */
  freshSession?: boolean;
  /** Queue controls: the message behind this item (a person's, a routine's or a trigger's), journaled. */
  messageId?: string;
}
interface Lane {
  running: boolean;
  pending: LaneItem[];
  /** The owner removed this bot from the room while a turn ran; whatever that turn says hands nothing on. */
  left?: boolean;
  /** Steering: messages pushed into the running turn, by steer uuid. Settled when the turn ends. */
  steered: Map<string, SteeredItem>;
  /** The running turn's start seq (its unread window ends there); undefined while no turn is in progress. */
  turnStartSeq?: number;
  /** The owner pressed Send now: the turn was stopped so the queue runs next (the stop note says so). */
  sendNow?: boolean;
}
interface SteeredItem {
  message: Message;
  /** Its own `lane_journal` row (status 'steered'), so a restart before it is answered re-queues it. */
  journalId: string;
}

/**
 * The messages after `lastSeenSeq` that a bot's next turn in a room is shown as unread, minus the steers its turns
 * already answered and the messages the owner cancelled. The read cursor stays at a turn's start (a message that
 * arrives mid-turn is unread for the next one), so without this filter a steer would be shown twice. Every reader of
 * the unread window goes through here: the injected transcript, the attached pictures and the text the model router
 * reads. Queue cancel (02 task 2.1b) hides a message from every bot once nobody holds it (`cancelledAt`), and from
 * the one lane it was cancelled in straight away (a 'cancelled' journal marker), even while another bot still has it.
 */
export function unreadForLane(repos: Repos, botId: string, roomId: string, lastSeenSeq: number): Message[] {
  const hidden = repos.hiddenMessageIds(botId, roomId);
  return repos.messagesAfter(roomId, lastSeenSeq).filter((m) => !m.cancelledAt && !hidden.has(m.id));
}

/** The note after the owner stopped a turn that left nothing re-queued (02 task 2.3). */
export function stoppedNote(botName: string, sendNow: boolean): string {
  return botName + ' was stopped by you' + (sendNow ? '; its queued messages run now.' : '.');
}

/** A queue control the hub refused; `status` is the HTTP status REST answers with. */
export class QueueError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** The line posted when a turn ends with steers it never answered: they run next. */
export function requeuedNote(botName: string, n: number, stopped: boolean): string {
  return (stopped ? 'Stopped. ' : '') + botName + ' will answer your ' + (n === 1 ? 'new message' : n + ' new messages') + ' next.';
}

/** A turn that stopped because it ran out of room (token brake, step limit), not because it broke. */
export function isCutOff(error: string | undefined): boolean {
  return !!error && /^(token_budget|error_max_turns)/.test(error);
}

const STATE_RANK: Record<BotState, number> = { idle: 0, done: 1, thinking: 2, working: 3, waiting: 4, blocked: 5, error: 6 };

/** Messages a bot is shown as conversation: text, handoffs and routine prompts (not tool chips or system notes). */
export function isConversation(m: Message): boolean {
  return m.kind === 'text' || m.kind === 'handoff' || m.kind === 'routine' || m.kind === 'trigger';
}
/** One transcript line as bots see it: `#seq [author]: text`. */
export function formatMessage(repos: Repos, m: Message, text: string = m.text): string {
  let who: string;
  if (m.authorType === 'user') who = ownerTag();
  else if (m.authorType === 'system') who = m.kind === 'routine' ? 'routine' : m.kind === 'trigger' ? 'trigger' : 'system';
  else {
    const b = repos.getBot(m.authorId ?? '');
    who = b ? '@' + b.handle : 'bot';
  }
  const pics = m.attachments?.length ? ' [' + m.attachments.length + (m.attachments.length === 1 ? ' picture' : ' pictures') + ' attached]' : '';
  return '#' + m.seq + ' [' + who + ']: ' + quoteTags(text) + pics;
}

/** Most unread messages one turn is shown (after a context reset, or when a bot joins a busy room). */
export const BACKLOG_MAX_MESSAGES = 60;
/** ...and most bytes of them; whichever limit is hit first wins. */
export const BACKLOG_MAX_BYTES = 30 * 1024;

/**
 * The newest transcript lines that fit {@link BACKLOG_MAX_MESSAGES} and {@link BACKLOG_MAX_BYTES}, plus how many
 * older ones were left out. The newest line is always kept, however long: it is usually what the bot must answer.
 */
export function capBacklog(lines: string[], maxMessages = BACKLOG_MAX_MESSAGES, maxBytes = BACKLOG_MAX_BYTES): { lines: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const cost = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (kept.length && used + cost > maxBytes) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  return { lines: kept, dropped: lines.length - kept.length };
}

export class RoomRouter {
  private lanes = new Map<string, Lane>();
  /** Cut-off retries so far, per request and bot (afterCutOff). */
  private cutOffs = new Map<string, number>();
  private states = new Map<string, Map<string, BotState>>(); // botId -> roomId -> state
  /**
   * botId:roomId -> the roster that bot's session last saw, and which session. The roster rides the injected
   * message only on a fresh session or when it changed, never in the cached system prompt. In memory only:
   * after a restart every bot is shown it once more.
   */
  private rosterSeen = new Map<string, { roster: string; sessionId: string }>();
  /** botId:roomId -> the bots a running turn already woke with a tool (handoff, send_message) on its own thread. */
  private toolDispatched = new Map<string, { causeId: string; botIds: Set<string> }>();
  private runningTurns = 0;
  private waiters: (() => void)[] = [];
  runner!: BotRunner;
  autoMemory?: AutoMemory;
  /** P2: computer control. A paused bot's lane waits; a hand-back note rides along with its next turn. */
  control?: LaneControl;
  /**
   * Hardening pass: what is left of a trigger's rolling daily budget (TriggerService), or undefined for a trigger
   * that no longer exists. Read for every item whose thread a trigger started, so a turn resumed after a restart
   * or a parked approval, and every hop on the thread, stays inside the trigger's budget too.
   */
  triggerBudget?: (triggerId: string) => number | undefined;
  /** P6: opt-in post-run skill reflection; counts skill runs and may propose a pending version. */
  skillReflection?: { afterTurn(botId: string, roomId: string, result: TurnResult): unknown };

  constructor(private repos: Repos, private usage: UsageTracker) {}

  // ---------- state ----------
  botStates(): Record<string, BotState> {
    const out: Record<string, BotState> = {};
    for (const b of this.repos.listBots()) out[b.id] = this.aggregateState(b.id);
    return out;
  }
  private aggregateState(botId: string): BotState {
    let best: BotState = 'idle';
    for (const s of this.states.get(botId)?.values() ?? []) if (STATE_RANK[s] > STATE_RANK[best]) best = s;
    return best;
  }
  setState(botId: string, roomId: string, state: BotState, note?: string) {
    let m = this.states.get(botId);
    if (!m) this.states.set(botId, (m = new Map()));
    m.set(roomId, state);
    events.emitEvent({ type: 'bot.state', botId, state: this.aggregateState(botId), roomId, note });
    if (state === 'done' || state === 'error') {
      setTimeout(() => {
        if (m!.get(roomId) === state) {
          m!.set(roomId, 'idle');
          events.emitEvent({ type: 'bot.state', botId, state: this.aggregateState(botId), roomId });
        }
      }, 1500);
    }
  }

  // ---------- entry points ----------
  /**
   * A person's message. `mode` (steering) says what it does where a target bot is busy: `join` pushes it into the
   * running turn, `queue` waits; left out, Settings > busyMessages decides. The returned message carries a
   * {@link DeliveryPayload} when any target was busy (also sent as `message.update`).
   */
  onUserMessage(roomId: string, text: string, clientMsgId?: string, attachments?: string[], mode?: SendMode): Message {
    const room = this.repos.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    // A repeat of a send the hub already took (a client replaying its outbox): no second message and no second
    // turn. The message is announced again, because the repeat usually means the first announcement was missed.
    const seen = clientMsgId ? this.repos.findByClientMsgId(roomId, clientMsgId) : undefined;
    if (seen) {
      events.emitEvent({ type: 'message.new', message: seen });
      return seen;
    }
    const msg = this.repos.insertMessage({ roomId, authorType: 'user', authorId: this.repos.owner().id, kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null, ...(attachments?.length ? { attachments } : {}), ...(clientMsgId ? { clientMsgId } : {}) });
    // a user message starts a new cause chain
    const withCause = this.repos.updateMessage(msg.id, {}) ?? msg;
    this.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
    withCause.causeId = msg.id;
    events.emitEvent({ type: 'message.new', message: withCause });
    const delivery = this.dispatchUser(room, withCause, mode);
    if (!delivery) return withCause;
    const updated = this.setDelivery(withCause, delivery);
    // The queue was pushed when the item went in, before its reason was stored: push it again with the reason.
    for (const botId of Object.keys(delivery.queued ?? {})) this.emitQueue(botId, roomId);
    return updated;
  }

  /** Stores a message's per-bot steering outcome and tells clients. */
  private setDelivery(msg: Message, payload: DeliveryPayload): Message {
    const updated = this.repos.updateMessage(msg.id, { payload }) ?? { ...msg, payload };
    events.emitEvent({ type: 'message.update', id: msg.id, roomId: msg.roomId, patch: { payload } });
    return updated;
  }

  /**
   * Fire a routine prompt into a room for a specific bot. `causeKind` (P8) tells the model router this is
   * automation; an outside event (P5) can pass 'trigger'.
   */
  fireRoutine(room: Room, bot: Bot, text: string, payload: Message['payload'], onDone?: (r: TurnResult) => void, causeKind: CauseKind = 'routine'): Message {
    const msg = this.repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'routine', text, payload, causeId: null, hop: 0, turnId: null });
    this.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
    msg.causeId = msg.id;
    events.emitEvent({ type: 'message.new', message: msg });
    const runId = (payload as { runId?: string } | null)?.runId;
    this.enqueue(bot, room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, onDone, causeKind, runId, messageId: msg.id });
    return msg;
  }

  private members(room: Room): Bot[] {
    return room.memberIds.map((id) => this.repos.getBot(id)).filter((b): b is Bot => !!b);
  }

  private dispatchUser(room: Room, msg: Message, mode?: SendMode): DeliveryPayload | null {
    const members = this.members(room);
    let targets: Bot[];
    if (room.kind === 'dm' || members.length === 1) targets = members.slice(0, 1);
    else {
      targets = parseMentions(msg.text, members);
      if (!targets.length) {
        let coord = room.coordinatorBotId ? members.find((b) => b.id === room.coordinatorBotId) : undefined;
        // A group with no coordinator (an older room, or one whose coordinator left) gets one now, so an
        // unaddressed message is never dropped. Saved, and said in the chat, so the owner can change it.
        if (!coord && room.kind === 'group') {
          coord = pickCoordinator(members) ?? undefined;
          if (coord) {
            this.repos.updateRoom(room.id, { coordinatorBotId: coord.id });
            events.emitEvent({ type: 'rooms.changed', rooms: this.repos.listRooms() });
            this.note(room, coord.name + ' (@' + coord.handle + ') is now coordinator of this chat: messages with no @mention go to them. Change it in the chat settings.', msg.causeId, 0);
          }
        }
        if (coord) targets = [coord];
      }
    }
    if (!targets.length) {
      this.note(room, 'Nobody was mentioned and this room has no coordinator. Mention a bot with @handle or set a coordinator.', msg.causeId, 0);
      return null;
    }
    const steered: Record<string, string> = {};
    const queued: Record<string, { reason: QueueReason }> = {};
    for (const t of targets) {
      // A paused queue (02 task 2.2) holds the message whatever else happens, except that a turn already running
      // may still take it in: pause stops new turns, not the one in progress.
      const paused = this.repos.lanePaused(t.id, room.id);
      // Only a busy lane gets a steering outcome; an idle bot simply starts a turn.
      if (this.lanes.get(t.id + ':' + room.id)?.running) {
        const r = this.trySteer(t, room, msg, mode);
        if (r.status === 'accepted') {
          steered[t.id] = r.turnId;
          continue;
        }
        queued[t.id] = { reason: paused ? 'paused' : r.reason };
      } else if (paused) queued[t.id] = { reason: 'paused' };
      this.enqueue(t, room, { causeId: msg.causeId ?? msg.id, hop: 0, triggerSeq: msg.seq, causeKind: 'user', messageId: msg.id });
    }
    if (!Object.keys(steered).length && !Object.keys(queued).length) return null;
    return { ...(Object.keys(steered).length ? { steered } : {}), ...(Object.keys(queued).length ? { queued } : {}) };
  }

  /**
   * Steering: pushes a person's message into the turn `bot` is running here. Only for a person's own message at hop 0
   * (dispatchUser): hand-offs, routines, triggers and follow-ups always queue, so a steer never wakes a bot or loops.
   * The turn keeps its cause, hop, budget and strict approvals; an accepted steer gets its own journal row.
   */
  private trySteer(bot: Bot, room: Room, msg: Message, mode?: SendMode): { status: 'accepted'; turnId: string } | { status: 'queued'; reason: QueueReason } {
    if (mode === 'queue') return { status: 'queued', reason: 'shortcut' };
    if (!mode && settings.get().busyMessages === 'queue') return { status: 'queued', reason: 'setting' };
    const uuid = randomUUID();
    const r = this.runner.steer(bot.id, room.id, { uuid, text: formatMessage(this.repos, msg), ...(msg.attachments?.length ? { images: msg.attachments } : {}) });
    if (r.status !== 'accepted') return r;
    const journalId = this.repos.journalAdd({
      botId: bot.id, roomId: room.id, causeId: msg.causeId ?? msg.id, hop: 0, triggerSeq: msg.seq, runId: null, note: null,
      status: 'steered', messageId: msg.id,
    });
    this.lanes.get(bot.id + ':' + room.id)!.steered.set(uuid, { message: msg, journalId });
    return r;
  }

  /**
   * After a turn: a steer it answered becomes a 'consumed' marker (hidden from the next turn, see `unreadForLane`)
   * and joins the turn's thread; one it never answered (Stop, an error) is queued as an ordinary message so the bot
   * answers it next. Returns how many were queued again; the caller tells the room.
   */
  private settleSteers(bot: Bot, room: Room, lane: Lane, req: TurnRequest, result: TurnResult, left: boolean): number {
    if (!lane.steered.size) return 0;
    const consumed = new Set(result.consumedSteers ?? []);
    const settled = [...lane.steered.entries()];
    lane.steered.clear();
    let requeued = 0;
    for (const [uuid, s] of settled) {
      const current = this.repos.getMessage(s.message.id) ?? s.message;
      const delivery: DeliveryPayload = { ...((current.payload as DeliveryPayload | null) ?? {}) };
      if (consumed.has(uuid)) {
        this.repos.journalMarkConsumed(s.journalId);
        // Its thread is now the turn that answered it, so threads and usage group there. Only when this was the
        // message's one delivery: a message also queued for another bot stays its own thread.
        if (!delivery.queued && Object.keys(delivery.steered ?? {}).length === 1 && current.causeId !== req.causeId) {
          this.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', req.causeId, s.message.id);
          events.emitEvent({ type: 'message.update', id: s.message.id, roomId: room.id, patch: { causeId: req.causeId } });
        }
        continue;
      }
      this.repos.journalRemove([s.journalId]);
      // A bot the owner removed from the room answers nothing more there.
      if (left || !this.repos.getRoom(room.id)?.memberIds.includes(bot.id)) continue;
      const steered = { ...(delivery.steered ?? {}) };
      delete steered[bot.id];
      this.setDelivery(current, {
        ...(Object.keys(steered).length ? { steered } : {}),
        queued: { ...(delivery.queued ?? {}), [bot.id]: { reason: 'requeued' } },
      });
      this.enqueue(bot, room, { causeId: s.message.causeId ?? s.message.id, hop: 0, triggerSeq: s.message.seq, causeKind: 'user', messageId: s.message.id });
      requeued++;
    }
    return requeued;
  }

  /** Bot -> bot routing (after a turn or from tools). Returns dispatched handles. */
  dispatchFromBot(req: TurnRequest, targets: Bot[], onDone?: (r: TurnResult) => void): string[] {
    const hop = req.hop + 1;
    const room = this.repos.getRoom(req.room.id) ?? req.room;
    const members = this.members(room);
    const valid = targets.filter((t) => t.id !== req.bot.id && members.some((m) => m.id === t.id));
    if (!valid.length) return [];
    if (hop > MAX_HOPS) {
      this.note(room, 'Too many hand-offs in a row (' + MAX_HOPS + '). @' + req.bot.handle + ' cannot pass this to ' + valid.map((v) => '@' + v.handle).join(', ') + '. Send a new message to continue.', req.causeId, hop);
      return [];
    }
    const spent = this.usage.causeCost(req.causeId);
    if (spent >= CAUSE_COST_CAP_USD) {
      this.note(room, 'Spending limit reached for this request ($' + spent.toFixed(2) + ' of $' + CAUSE_COST_CAP_USD + '). Send a new message to continue.', req.causeId, hop);
      return [];
    }
    const seq = this.repos.maxSeq(room.id);
    for (const t of valid) this.enqueue(t, room, { causeId: req.causeId, hop, triggerSeq: seq, causeKind: 'bot', onDone });
    // Called from a running turn's tool: note who it woke, so its final message does not wake them again.
    const running = this.toolDispatched.get(req.bot.id + ':' + room.id);
    if (running?.causeId === req.causeId) for (const t of valid) running.botIds.add(t.id);
    return valid.map((v) => v.handle);
  }

  /**
   * A turn the token brake or the step limit stopped is unfinished work, not a failure: nobody else will pick it up.
   * The same bot goes again in a fresh session, up to CUTOFF_RETRIES times per request; after that the coordinator
   * is woken to decide, so the chain never just stops. Routine runs are left to their schedule.
   */
  private afterCutOff(bot: Bot, roomId: string, req: TurnRequest, items: LaneItem[]) {
    if (items.some((i) => i.runId)) return;
    const room = this.repos.getRoom(roomId);
    if (!room || !room.memberIds.includes(bot.id)) return;
    const key = req.causeId + ':' + bot.id;
    const tries = (this.cutOffs.get(key) ?? 0) + 1;
    this.cutOffs.set(key, tries);
    if (this.cutOffs.size > 500) this.cutOffs.delete(this.cutOffs.keys().next().value!);
    if (tries <= CUTOFF_RETRIES) {
      this.note(room, '@' + bot.handle + ' was cut off before finishing, so it continues in a fresh session (' + tries + '/' + CUTOFF_RETRIES + ').', req.causeId, req.hop);
      this.enqueue(bot, room, {
        causeId: req.causeId, hop: req.hop, triggerSeq: this.repos.maxSeq(room.id), causeKind: req.causeKind, freshSession: true,
        note: '(Your last turn was cut off before you finished, because it read too much. You are in a fresh session now. ' +
          'Check the files and the room to see what is already done, then finish the task and report. Keep this turn small: ' +
          'read only the files you need, never node_modules, build output or long logs.)',
      });
      return;
    }
    const coord = room.coordinatorBotId && room.coordinatorBotId !== bot.id ? this.repos.getBot(room.coordinatorBotId) : undefined;
    if (!coord) {
      this.note(room, '@' + bot.handle + ' was cut off ' + tries + ' times on this request and stopped. Send a new message to continue.', req.causeId, req.hop);
      return;
    }
    this.followUp(room, coord, {
      causeId: req.causeId, hop: req.hop,
      note: '(@' + bot.handle + ' was cut off ' + tries + ' times before finishing its task and has stopped. Check what it got done ' +
        '(files, room), then decide: split the rest into smaller tasks, give it to someone else, or finish it yourself.)',
    });
  }

  private note(room: Room, text: string, causeId: string | null, hop: number) {
    const msg = this.repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'system', text, payload: null, causeId, hop, turnId: null });
    events.emitEvent({ type: 'message.new', message: msg });
  }

  // ---------- lanes ----------
  private enqueue(bot: Bot, room: Room, item: LaneItem) {
    const key = bot.id + ':' + room.id;
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = { running: false, pending: [], steered: new Map() }));
    item.journalId ??= this.repos.journalAdd({
      botId: bot.id, roomId: room.id, causeId: item.causeId, hop: item.hop, triggerSeq: item.triggerSeq,
      runId: item.runId ?? null, note: item.note ?? null, attempts: item.attempts, messageId: item.messageId ?? null,
    });
    lane.pending.push(item);
    if (!lane.running) void this.runLane(key, bot.id, room.id);
    this.emitQueue(bot.id, room.id);
  }

  private async runLane(key: string, botId: string, roomId: string) {
    const lane = this.lanes.get(key)!;
    lane.running = true;
    try {
      while (lane.pending.length) {
        const bot = this.repos.getBot(botId);
        const room = this.repos.getRoom(roomId);
        if (!bot || !room) break;
        // P2: a paused bot starts nothing; its queued items wait here until it is resumed.
        if (this.control?.isPaused(botId)) {
          this.setState(botId, roomId, 'waiting', 'paused');
          await this.control.waitUnpaused(botId);
          this.setState(botId, roomId, 'idle');
          continue;
        }
        // 02 task 2.2: the owner paused this queue. Its items wait (journaled, so a restart keeps them) until resumed.
        if (this.repos.lanePaused(botId, roomId)) {
          this.setState(botId, roomId, 'waiting', 'queue paused');
          await this.queueResumed(key);
          this.setState(botId, roomId, 'idle');
          continue;
        }
        // Maintenance hold (an update is about to stop the hub): start nothing; the items stay queued and journaled.
        if (this.heldUntil() !== null) {
          this.setState(botId, roomId, 'waiting', 'maintenance');
          await this.holdLifted();
          this.setState(botId, roomId, 'idle');
          continue;
        }
        // A slot first, so a turn that queued behind others sees what they spent.
        await this.acquire();
        let items: LaneItem[];
        let req: TurnRequest;
        let startSeq: number;
        let result: TurnResult;
        let shownRoster: string | null = null;
        let sessionBefore: string | null = null;
        const wokeByTool = new Set<string>();
        try {
          // A hold or a queue pause that began while this lane waited for a slot: hand the slot back and wait above.
          if (this.heldUntil() !== null || this.repos.lanePaused(botId, roomId)) continue;
          // The cost cap covers every cause (user message, routine, later triggers), not only bot hops: a
          // trigger whose thread already spent the cap is dropped with a note instead of starting a turn,
          // and a turn that does start may spend at most what is left of the cap.
          items = this.withinCostCap(bot, room, lane.pending.splice(0));
          if (!items.length) {
            this.emitQueue(botId, roomId);
            continue;
          }
          const hop = Math.max(...items.map((i) => i.hop));
          const causeId = items[0].causeId;
          const session = this.repos.getSession(bot.id, room.id);
          startSeq = this.repos.maxSeq(room.id);
          // From here this turn reads everything up to startSeq: queued messages in that window are no longer editable.
          lane.turnStartSeq = startSeq;
          this.emitRoomQueues(roomId, key);
          // The unread window, minus steers an earlier turn already answered (read once, used three times below).
          const unread = unreadForLane(this.repos, bot.id, room.id, session.lastSeenSeq);
          const members = this.members(room);
          const notes = [...new Set(items.map((i) => i.note).filter((n): n is string => !!n))];
          const handBack = this.control?.takeNote(bot.id);
          if (handBack) notes.push(handBackNote(handBack));
          // What changes from turn to turn (hop budget, roster) ends the input; the system prompt stays cacheable.
          const roster = rosterText(members, bot.id);
          const seen = this.rosterSeen.get(key);
          shownRoster = !session.sdkSessionId || !seen || seen.roster !== roster || seen.sessionId !== session.sdkSessionId ? roster : null;
          const injected = this.buildInjected(bot, room, unread, items.map((i) => i.triggerSeq)) +
            (notes.length ? '\n\n' + notes.join('\n') : '') +
            '\n\n(' + hopBudgetLine(hop) + ')' + (shownRoster ? '\n' + shownRoster : '');
          this.toolDispatched.set(key, { causeId, botIds: wokeByTool });
          // P5: a trigger item also brings its own remaining daily budget; the turn gets the tighter of the two.
          const causeBudgetUsd = Math.min(CAUSE_COST_CAP_USD - this.usage.causeCost(causeId), ...items.map((i) => i.budgetUsd ?? Infinity));
          // A person's message in the batch outranks automation, so a routine never drags a reply down to triage.
          const causeKind = items.find((i) => i.causeKind === 'user')?.causeKind ?? items[0].causeKind;
          // Decision Q6: a turn any of whose causes the human did not start (a routine, later a trigger)
          // goes through approvals even when the hub runs in bypass mode.
          const strictApprovals = items.some((i) => this.requiresApprovals(i.causeId));
          // Only a person's own newest words can ask for a stronger model, never a forwarded trigger payload.
          const latestUserText = unread.filter((m) => m.authorType === 'user').at(-1)?.text;
          // A routine's own prompt may invoke a skill. Its owner wrote it, unlike anything else in the transcript.
          const cause = causeKind === 'routine' ? this.repos.getMessage(causeId) : undefined;
          const routinePrompt = cause?.kind === 'routine' ? cause.text : undefined;
          // The composer's pick is for what a person starts here. Hand-offs and schedules keep each bot's own model.
          const chatModel = items.some((i) => i.causeKind === 'user' && i.hop === 0) ? room.chatModel ?? undefined : undefined;
          const images = this.userImages(bot, unread);
          req = { bot, room, members, hop, causeId, injected, ...(images.length ? { images } : {}), ...(items.some((i) => i.freshSession) ? { freshSession: true } : {}), latestUserText, routinePrompt, chatModel, causeBudgetUsd, causeKind, strictApprovals, runId: items.find((i) => i.runId)?.runId };
          sessionBefore = session.sdkSessionId;
          result = await this.runner.runTurn(req);
        } finally {
          this.release();
          this.toolDispatched.delete(key);
          lane.turnStartSeq = undefined;
        }
        // Remember which session has seen which roster. A roster sent this turn reached whatever session the turn
        // ended on (a fresh or rotated one included); a session that changed without one has not seen any.
        const sessionAfter = this.repos.getSession(bot.id, room.id).sdkSessionId;
        if (shownRoster && result.ok && sessionAfter) this.rosterSeen.set(key, { roster: shownRoster, sessionId: sessionAfter });
        else if (shownRoster || sessionAfter !== sessionBefore) this.rosterSeen.delete(key);
        // Shutting down: the hub interrupted the turn, it did not finish. Leave its journal rows (and the
        // session cursor) alone so the next start resumes it (services/FollowUp.ts).
        if (this.frozen) return;
        const left = lane.left;
        lane.left = false;
        this.repos.journalRemove(items.map((i) => i.journalId).filter((id): id is string => !!id));
        this.repos.saveSession(bot.id, room.id, { lastSeenSeq: startSeq });
        // Consumed-steer markers the cursor has now passed are no longer needed; this turn's own steers settle after.
        this.repos.journalPruneConsumed(bot.id, room.id, startSeq);
        const requeued = this.settleSteers(bot, room, lane, req, result, !!left);
        const sendNow = !!lane.sendNow;
        lane.sendNow = false;
        // One note after a stop: the re-queued steers it left (they run next), or else "stopped by you" (02 task 2.3).
        if (requeued) this.note(room, requeuedNote(bot.name, requeued, !!result.stopped), req.causeId, req.hop);
        else if (result.stoppedBy === 'owner' && !left) this.note(room, stoppedNote(bot.name, sendNow && lane.pending.length > 0), req.causeId, req.hop);
        // The cursor moved: other lanes' queued messages this turn read are no longer editable.
        this.emitRoomQueues(roomId, key);
        // Counts the turn and, every N turns, starts a background pass; never awaited, so the lane moves on.
        this.autoMemory?.afterTurn(bot.id, room.id, result);
        // P6: same idea per skill, for bots that opted in; never awaited either.
        try { this.skillReflection?.afterTurn(bot.id, room.id, result); } catch (e) { console.error('[skill-reflection]', e); }
        // P2: a parked turn is not finished; its routine run stays open until the resumed turn ends.
        for (const i of items) if (!(result.parked && i.runId)) i.onDone?.(result);
        if (!result.ok && !left && isCutOff(result.error)) this.afterCutOff(bot, roomId, req, items);
        if (result.ok && result.finalText && !left) {
          // re-read members: the turn may have created or added bots
          const freshRoom = this.repos.getRoom(roomId) ?? room;
          // A bot this turn already woke with handoff or send_message is not woken again because the final message
          // names it too ("handed this to @x"): that second turn costs a full context load for nothing new.
          const targets = parseMentions(result.finalText, this.members(freshRoom), bot.id).filter((t) => !wokeByTool.has(t.id));
          // Work a bot was handed ends in a report. One that names nobody would otherwise reach no one and the chain
          // stops there, so it goes to the coordinator, who decides what is next. Hops still bound it.
          const coord = freshRoom.coordinatorBotId;
          if (!targets.length && !wokeByTool.size && req.hop > 0 && coord && coord !== bot.id) {
            const c = this.members(freshRoom).find((m) => m.id === coord);
            if (c) targets.push(c);
          }
          if (targets.length) this.dispatchFromBot({ ...req, room: freshRoom }, targets);
        }
      }
    } catch (e) {
      logError('[lane ' + key + ']', e);
    } finally {
      lane.running = false;
    }
  }

  /** Drops (and notes once per cause) the items whose cause has already spent CAUSE_COST_CAP_USD. */
  private withinCostCap(bot: Bot, room: Room, items: LaneItem[]): LaneItem[] {
    const spentBy = new Map<string, number>();
    const overBudget = new Set<string>();
    const keep: LaneItem[] = [];
    for (const i of items) {
      if (!spentBy.has(i.causeId)) {
        const spent = this.usage.causeCost(i.causeId);
        spentBy.set(i.causeId, spent);
        if (spent >= CAUSE_COST_CAP_USD) {
          this.note(room, 'Spending limit reached for this request ($' + spent.toFixed(2) + ' of $' + CAUSE_COST_CAP_USD + '), so @' + bot.handle + ' did not start. Send a new message to continue.', i.causeId, i.hop);
        }
      }
      if (spentBy.get(i.causeId)! >= CAUSE_COST_CAP_USD) {
        if (i.journalId) this.repos.journalRemove([i.journalId]);
        i.onDone?.({ ok: false, turnId: '', finalText: '', costUsd: 0, error: 'cost cap reached' });
        continue;
      }
      const trig = this.triggerLeft(i.causeId);
      if (trig && trig.left <= 0) {
        if (!overBudget.has(i.causeId)) {
          overBudget.add(i.causeId);
          this.note(room, 'Daily budget reached for trigger "' + trig.name + '", so @' + bot.handle + ' did not start.', i.causeId, i.hop);
        }
        if (i.journalId) this.repos.journalRemove([i.journalId]);
        i.onDone?.({ ok: false, turnId: '', finalText: '', costUsd: 0, error: 'trigger budget reached' });
        continue;
      }
      if (trig) i.budgetUsd = Math.min(i.budgetUsd ?? Infinity, trig.left);
      keep.push(i);
    }
    return keep;
  }

  /** The trigger that started a thread, with what is left of its daily budget; null for any other thread. */
  private triggerLeft(causeId: string): { name: string; left: number } | null {
    if (!this.triggerBudget) return null;
    const cause = this.repos.getMessage(causeId);
    if (cause?.kind !== 'trigger' || cause.authorType !== 'system') return null;
    const p = cause.payload as TriggerPayload | null;
    if (!p?.triggerId) return null;
    // A deleted trigger has no budget left to spend.
    return { name: p.name, left: this.triggerBudget(p.triggerId) ?? 0 };
  }

  /** Pictures the person attached in the unread window, newest {@link MAX_ATTACHMENTS}; only what a person sent. */
  private userImages(bot: Bot, unread: Message[]): string[] {
    const refs = unread
      .filter((m) => m.authorType === 'user' && m.authorId !== bot.id)
      .flatMap((m) => m.attachments ?? []);
    return [...new Set(refs)].slice(-MAX_ATTACHMENTS);
  }

  private buildInjected(bot: Bot, room: Room, unread: Message[], triggerSeqs: number[]): string {
    const msgs = unread.filter((m) => isConversation(m) && m.authorId !== bot.id);
    const { lines, dropped } = capBacklog(msgs.map((m) => formatMessage(this.repos, m)));
    if (dropped) lines.unshift('(' + dropped + ' earlier unread message' + (dropped === 1 ? ' was' : 's were') + ' left out to keep this short. Use read_room to read them if you need them.)');
    const trig = triggerSeqs.length ? '\n\n(Message' + (triggerSeqs.length > 1 ? 's' : '') + ' that triggered you: ' + triggerSeqs.map((s) => '#' + s).join(', ') + '.' : '(';
    const reminder = room.kind === 'group'
      ? ' Reply NO_REPLY if you have nothing new to add, if your part depends on another bot that has not finished, or if this was already handled.)'
      : ')';
    if (!lines.length) return '(No new messages; you were triggered on #' + triggerSeqs.join(', #') + '.)';
    return lines.join('\n') + trig + reminder;
  }

  private acquire(): Promise<void> {
    if (this.runningTurns < MAX_CONCURRENT_TURNS) {
      this.runningTurns++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(() => { this.runningTurns++; resolve(); }));
  }
  private release() {
    this.runningTurns--;
    const w = this.waiters.shift();
    if (w) w();
  }

  /** The owner's Stop (WS `turn.interrupt`): the turn ends with "stopped by you", not a failure note. */
  interrupt(turnId: string) {
    return this.runner.interrupt(turnId, 'owner');
  }

  // ---------- queue controls (02 Phase 2: cancel, edit, send now, pause; no reorder) ----------
  /**
   * The bots' queues in a room (GET /api/rooms/:id/queue): one entry per member whose lane has items waiting, a turn
   * in progress, or a paused queue.
   */
  queueSnapshot(roomId: string): LaneQueue[] {
    const room = this.repos.getRoom(roomId);
    if (!room) throw new QueueError(404, 'Room not found');
    return room.memberIds
      .map((id) => this.laneQueue(id, roomId))
      .filter((q) => q.items.length || q.paused || q.running);
  }

  /** One lane as clients see it. Items are in queue order; the lane's next turn takes all of them at once. */
  laneQueue(botId: string, roomId: string): LaneQueue {
    const lane = this.lanes.get(botId + ':' + roomId);
    return {
      botId, roomId,
      paused: this.repos.lanePaused(botId, roomId),
      running: lane?.turnStartSeq !== undefined,
      items: (lane?.pending ?? []).filter((i) => i.journalId).map((i, n) => this.queueItem(botId, i, n + 1)),
    };
  }

  private queueItem(botId: string, i: LaneItem, position: number): QueueItem {
    const msg = i.messageId ? this.repos.getMessage(i.messageId) : undefined;
    const own = msg?.authorType === 'user';
    const kind: QueueItem['kind'] = msg
      ? (msg.kind === 'routine' ? 'routine' : msg.kind === 'trigger' ? 'trigger' : 'message')
      : (i.note ? 'followup' : 'handoff');
    const editRefusal = own ? this.editRefusal(msg) : 'Only your own messages can be edited.';
    const text = msg?.text ?? i.note ?? '';
    return {
      journalId: i.journalId!,
      messageId: msg?.id ?? null,
      kind,
      authorType: msg?.authorType ?? null,
      authorId: msg?.authorId ?? null,
      preview: text.length > QUEUE_PREVIEW_CHARS ? text.slice(0, QUEUE_PREVIEW_CHARS - 1) + '…' : text,
      reason: own ? ((msg.payload as DeliveryPayload | null)?.queued?.[botId]?.reason ?? null) : null,
      position,
      editable: !editRefusal,
      ...(editRefusal ? { editRefusal } : {}),
      cancellable: own,
    };
  }

  /**
   * Why a person's queued message can no longer be edited, or null when it still can: once any lane steered it,
   * once any bot's read cursor is at or past it, or while a turn in the room is reading it.
   */
  private editRefusal(msg: Message): string | null {
    if (msg.cancelledAt) return 'It was cancelled.';
    if (this.repos.journalSteered(msg.id)) return 'It already joined a running turn.';
    return this.readRefusal(msg);
  }
  private readRefusal(msg: Message): string | null {
    if (this.repos.anyCursorAt(msg.roomId, msg.seq)) return 'A bot has already read it.';
    for (const [key, lane] of this.lanes) {
      if (key.endsWith(':' + msg.roomId) && lane.turnStartSeq !== undefined && lane.turnStartSeq >= msg.seq) return 'A bot is reading it now.';
    }
    return null;
  }

  /** The lane holding a queued item, by its journal row; throws when it is no longer queued (or not in `roomId`). */
  private findQueued(journalId: string, roomId?: string): { botId: string; roomId: string; lane: Lane; index: number; item: LaneItem } {
    for (const [key, lane] of this.lanes) {
      const index = lane.pending.findIndex((i) => i.journalId === journalId);
      if (index < 0) continue;
      const [botId, laneRoom] = key.split(':');
      if (roomId && laneRoom !== roomId) break;
      return { botId, roomId: laneRoom, lane, index, item: lane.pending[index] };
    }
    throw new QueueError(404, 'That item is no longer queued.');
  }
  private ownMessage(item: LaneItem, what: string): Message {
    const msg = item.messageId ? this.repos.getMessage(item.messageId) : undefined;
    if (msg?.authorType !== 'user') throw new QueueError(403, 'Only your own messages can be ' + what + ' here.');
    return msg;
  }

  /**
   * Cancel (02 task 2.1b), per lane: the item leaves this bot's queue and its journal, and this bot is never shown
   * the message (a 'cancelled' marker, see `unreadForLane`). Once no lane holds it and no bot has read it, the message
   * itself is marked cancelled, which hides it from every bot. Only a person's own message: a hand-off, routine,
   * trigger or follow-up has its own controls (or none) and is never dropped from here.
   */
  cancelQueued(journalId: string, roomId?: string): Message {
    const q = this.findQueued(journalId, roomId);
    const msg = this.ownMessage(q.item, 'cancelled');
    q.lane.pending.splice(q.index, 1);
    this.repos.journalMarkCancelled(journalId);
    q.item.onDone?.({ ok: false, turnId: '', finalText: '', costUsd: 0, error: 'cancelled' });
    const delivery = { ...((msg.payload as DeliveryPayload | null) ?? {}) };
    const patch: Partial<Message> = {};
    if (delivery.queued?.[q.botId]) {
      const queued = { ...delivery.queued };
      delete queued[q.botId];
      const payload: DeliveryPayload = { ...(delivery.steered ? { steered: delivery.steered } : {}), ...(Object.keys(queued).length ? { queued } : {}) };
      patch.payload = Object.keys(payload).length ? payload : null;
      this.repos.updateMessage(msg.id, { payload: patch.payload });
    }
    const held = [...this.lanes.values()].some((l) => l.pending.some((i) => i.messageId === msg.id) || [...l.steered.values()].some((st) => st.message.id === msg.id));
    if (!held && !this.repos.journalSteered(msg.id) && !this.readRefusal(msg)) patch.cancelledAt = this.repos.markMessageCancelled(msg.id);
    if (Object.keys(patch).length) events.emitEvent({ type: 'message.update', id: msg.id, roomId: msg.roomId, patch });
    this.emitQueue(q.botId, q.roomId);
    return this.repos.getMessage(msg.id) ?? msg;
  }

  /**
   * Edit (02 task 2.1b): the owner rewrites their own queued message before any bot read it. Refused (409, with the
   * reason the snapshot also shows) once a lane steered it, a bot's cursor passed it, or a turn is reading it.
   */
  editQueued(journalId: string, text: string, roomId?: string): Message {
    const q = this.findQueued(journalId, roomId);
    const msg = this.ownMessage(q.item, 'edited');
    const why = this.editRefusal(msg);
    if (why) throw new QueueError(409, why);
    const editedAt = this.repos.editMessageText(msg.id, text);
    events.emitEvent({ type: 'message.update', id: msg.id, roomId: msg.roomId, patch: { text, editedAt } });
    this.emitRoomQueues(msg.roomId);
    return { ...msg, text, editedAt };
  }

  /**
   * Send now (02 task 2.1b): stops the bot's running turn in this room (as the owner, so "stopped by you", not a
   * failure) and lets its queue run as the next turn. Steers that turn had not answered are re-queued as on Stop. A
   * paused queue is resumed. Returns whether a turn was stopped (false: none was running, the queue just starts).
   */
  sendNow(roomId: string, botId: string): { interrupted: boolean } {
    const lane = this.lanes.get(botId + ':' + roomId);
    if (!lane?.pending.length) throw new QueueError(409, 'Nothing is queued for this bot here.');
    if (this.repos.lanePaused(botId, roomId)) this.setQueuePaused(roomId, botId, false);
    lane.sendNow = true;
    const interrupted = this.runner.interruptLane(botId, roomId, 'owner');
    if (!interrupted) lane.sendNow = false;
    return { interrupted };
  }

  /**
   * Pause or resume a bot's queue in a room (02 task 2.2), or every member's when `botId` is left out. A paused queue
   * starts no new turn (a running one finishes and may still take steers); the pause is stored, so it survives a
   * restart. Separate from the computer-takeover pause (`LaneControl`).
   */
  setQueuePaused(roomId: string, botId: string | undefined, paused: boolean): LaneQueue[] {
    const room = this.repos.getRoom(roomId);
    if (!room) throw new QueueError(404, 'Room not found');
    if (botId && !room.memberIds.includes(botId)) throw new QueueError(404, 'That bot is not in this room.');
    const ids = botId ? [botId] : room.memberIds;
    for (const id of ids) {
      this.repos.setLanePaused(id, roomId, paused);
      if (!paused) this.wakeQueue(id + ':' + roomId);
      this.emitQueue(id, roomId);
    }
    return ids.map((id) => this.laneQueue(id, roomId));
  }

  private queueWaiters = new Map<string, (() => void)[]>();
  private queueResumed(key: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.queueWaiters.get(key) ?? [];
      list.push(resolve);
      this.queueWaiters.set(key, list);
    });
  }
  private wakeQueue(key: string) {
    const list = this.queueWaiters.get(key);
    this.queueWaiters.delete(key);
    for (const w of list ?? []) w();
  }

  private emitQueue(botId: string, roomId: string) {
    events.emitEvent({ type: 'queue.changed', queue: this.laneQueue(botId, roomId) });
  }
  /** Re-sends every lane in the room with items waiting (their editability may have changed), plus `alsoKey`'s. */
  private emitRoomQueues(roomId: string, alsoKey?: string) {
    for (const [key, lane] of this.lanes) {
      const [botId, laneRoom] = key.split(':');
      if (laneRoom === roomId && (lane.pending.length || key === alsoKey)) this.emitQueue(botId, roomId);
    }
  }

  // ---------- maintenance hold (04-A3) ----------
  private holdUntil = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  private holdWaiters: (() => void)[] = [];
  /**
   * Starts no new turn for `ms` (POST /api/maintenance/hold), so a running hub drains before an update stops it.
   * Messages are still accepted and queued; running turns finish. Calling it again replaces the end time.
   */
  hold(ms: number): number {
    this.holdUntil = Date.now() + ms;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.releaseHold(), ms);
    this.holdTimer.unref?.();
    return this.holdUntil;
  }
  /** Ends the hold early (POST /api/maintenance/release); waiting lanes start again. */
  releaseHold() {
    this.holdUntil = 0;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    for (const w of this.holdWaiters.splice(0)) w();
  }
  /** When the hold ends (epoch ms), or null when there is none. */
  heldUntil(): number | null {
    return this.holdUntil > Date.now() ? this.holdUntil : null;
  }
  private holdLifted(): Promise<void> {
    if (this.heldUntil() === null) return Promise.resolve();
    return new Promise((resolve) => this.holdWaiters.push(resolve));
  }
  /** Lanes with items queued that have not started (GET /api/busy; they are journaled, so they do not block). */
  pendingLaneCount(): number {
    let n = 0;
    for (const lane of this.lanes.values()) if (lane.pending.length) n++;
    return n;
  }

  // ---------- P3: approvals for non-user causes, resume and follow-up ----------
  private frozen = false;
  /**
   * True when the thread `causeId` was not started by the human: its first message is a routine (or, from P5,
   * a trigger) rather than a user message. Such turns ask for approvals even in bypass mode (decision Q6).
   * An unknown cause counts as not-user, so the default is the safe answer.
   */
  requiresApprovals(causeId: string): boolean {
    return this.repos.getMessage(causeId)?.authorType !== 'user';
  }
  /** Hub shutdown: start no more turns and keep the journal, so the next start resumes what was in flight. */
  freeze() {
    this.frozen = true;
  }
  /**
   * The owner took a bot out of a room: work queued for it there is dropped and a running turn is stopped, so it
   * does not keep talking in a chat it has left. Parked work is covered too: `resumeParked` refuses a non-member.
   */
  botLeftRoom(botId: string, roomId: string) {
    // A paused queue does not outlive the bot's membership; a lane waiting on it wakes and finds nothing to run.
    this.repos.setLanePaused(botId, roomId, false);
    this.wakeQueue(botId + ':' + roomId);
    const lane = this.lanes.get(botId + ':' + roomId);
    if (!lane) return;
    for (const i of lane.pending.splice(0)) {
      if (i.journalId) this.repos.journalRemove([i.journalId]);
      i.onDone?.({ ok: false, turnId: '', finalText: '', costUsd: 0, error: 'removed from the room' });
    }
    this.emitQueue(botId, roomId);
    if (!lane.running) return;
    lane.left = true;
    this.runner.interruptLane(botId, roomId);
  }
  /** Whether a bot has a turn running or queued in a room. */
  isBusy(botId: string, roomId: string): boolean {
    const lane = this.lanes.get(botId + ':' + roomId);
    return !!lane && (lane.running || lane.pending.length > 0);
  }
  /** Re-queues a journaled item after a restart (FollowUp). It keeps its cause and hop; `attempts` is journaled. */
  resume(bot: Bot, room: Room, item: { causeId: string; hop: number; triggerSeq: number; attempts: number; runId?: string; note?: string; messageId?: string; onDone?: (r: TurnResult) => void }) {
    // It keeps its kind too: a routine cut off by a restart is still a routine, on the routine's model.
    this.enqueue(bot, room, { ...item, causeKind: item.hop > 0 ? 'bot' : this.resumedCauseKind(item.causeId) });
  }
  /**
   * A turn nobody @mentioned (FollowUp's stalled-handoff nudge). It is one more hop on the thread, so it is
   * refused, with a note, once the thread is out of hops or has spent its cost cap.
   */
  followUp(room: Room, bot: Bot, o: { causeId: string; hop: number; note: string }): boolean {
    const hop = o.hop + 1;
    if (hop > MAX_HOPS) {
      this.note(room, 'Too many hand-offs in a row (' + MAX_HOPS + '), so @' + bot.handle + ' was not reminded.', o.causeId, hop);
      return false;
    }
    const spent = this.usage.causeCost(o.causeId);
    if (spent >= CAUSE_COST_CAP_USD) {
      this.note(room, 'Spending limit reached for this request ($' + spent.toFixed(2) + '), so @' + bot.handle + ' was not reminded.', o.causeId, hop);
      return false;
    }
    this.enqueue(bot, room, { causeId: o.causeId, hop, triggerSeq: this.repos.maxSeq(room.id), note: o.note });
    return true;
  }
  // ---------- P2: resume after a parked approval or takeover ----------
  /**
   * Queues the turn that picks up where a parked one stopped: same thread and hop, so the hop and cost caps
   * still apply, and (for a routine) the same run, which this turn closes.
   */
  resumeParked(botId: string, roomId: string, o: { causeId: string; hop: number; runId: string | null; note: string }): boolean {
    const bot = this.repos.getBot(botId);
    const room = this.repos.getRoom(roomId);
    if (!bot || !room || !room.memberIds.includes(bot.id)) {
      if (o.runId) this.repos.finishRun(o.runId, 'error', null);
      return false;
    }
    const runId = o.runId ?? undefined;
    this.enqueue(bot, room, {
      causeId: o.causeId, hop: o.hop, triggerSeq: this.repos.maxSeq(room.id), note: o.note, runId,
      causeKind: this.resumedCauseKind(o.causeId),
      onDone: runId ? (r) => this.repos.finishRun(runId, r.ok ? 'success' : 'error', r.costUsd) : undefined,
    });
    return true;
  }

  /** P2 x P5: a resumed turn keeps its thread's kind (a trigger stays 'trigger' in usage and the model router). */
  private resumedCauseKind(causeId: string): CauseKind {
    if (!this.requiresApprovals(causeId)) return 'user';
    return this.repos.getMessage(causeId)?.kind === 'trigger' ? 'trigger' : 'routine';
  }

  /** Posts a system note into a room (FollowUp says what it did). */
  systemNote(room: Room, text: string, causeId: string | null, hop: number) {
    this.note(room, text, causeId, hop);
  }

  // ---------- P5: event triggers ----------
  /**
   * Fires an outside event into a room for one bot, like `fireRoutine` but with its own message kind and with
   * the event fenced as untrusted data (`untrusted.ts`). The cause message is a system message, so the turn and
   * every hop it causes are strict (approvals on even under bypass, decision Q6); `budgetUsd` caps the turn at
   * the trigger's remaining daily budget on top of the cause cap. Rate limits are the caller's (TriggerService).
   */
  fireTrigger(
    room: Room,
    bot: Bot,
    t: { name: string; prompt: string; event: TriggerEvent; payload: TriggerPayload; budgetUsd?: number; onDone?: (r: TurnResult) => void; nonce?: string },
  ): Message {
    const text = triggerText(t.name, t.prompt, t.event, t.nonce);
    const msg = this.repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'trigger', text, payload: t.payload, causeId: null, hop: 0, turnId: null });
    this.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
    msg.causeId = msg.id;
    events.emitEvent({ type: 'message.new', message: msg });
    this.enqueue(bot, room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, onDone: t.onDone, causeKind: 'trigger', budgetUsd: t.budgetUsd, messageId: msg.id });
    return msg;
  }
}

/** P2: what RoomRouter needs from ComputerControlService. */
export interface LaneControl {
  isPaused(botId: string): boolean;
  waitUnpaused(botId: string): Promise<void>;
  takeNote(botId: string): string | undefined;
}

/** The line a bot is given when the user hands its computer back with a note. */
export function handBackNote(note: string): string {
  return '(' + settings.get().userName + ' had control of your computer and handed it back with this note: "' + note +
    '". Take a screenshot or a browser snapshot before you act; things may have changed.)';
}
