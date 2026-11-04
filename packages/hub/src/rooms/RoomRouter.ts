import type { Bot, BotState, CauseKind, Message, Room, TriggerEvent, TriggerPayload } from '@pocketrocket/shared';
import { CAUSE_COST_CAP_USD, MAX_CONCURRENT_TURNS, MAX_HOPS } from '../config.js';
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
}
interface Lane {
  running: boolean;
  pending: LaneItem[];
  /** The owner removed this bot from the room while a turn ran; whatever that turn says hands nothing on. */
  left?: boolean;
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
  return '#' + m.seq + ' [' + who + ']: ' + quoteTags(text);
}

export class RoomRouter {
  private lanes = new Map<string, Lane>();
  private states = new Map<string, Map<string, BotState>>(); // botId -> roomId -> state
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
  onUserMessage(roomId: string, text: string): Message {
    const room = this.repos.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const msg = this.repos.insertMessage({ roomId, authorType: 'user', authorId: this.repos.owner().id, kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null });
    // a user message starts a new cause chain
    const withCause = this.repos.updateMessage(msg.id, {}) ?? msg;
    this.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
    withCause.causeId = msg.id;
    events.emitEvent({ type: 'message.new', message: withCause });
    this.dispatchUser(room, withCause);
    return withCause;
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
    this.enqueue(bot, room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, onDone, causeKind, runId });
    return msg;
  }

  private members(room: Room): Bot[] {
    return room.memberIds.map((id) => this.repos.getBot(id)).filter((b): b is Bot => !!b);
  }

  private dispatchUser(room: Room, msg: Message) {
    const members = this.members(room);
    let targets: Bot[];
    if (room.kind === 'dm' || members.length === 1) targets = members.slice(0, 1);
    else {
      targets = parseMentions(msg.text, members);
      if (!targets.length) {
        const coord = room.coordinatorBotId ? members.find((b) => b.id === room.coordinatorBotId) : undefined;
        if (coord) targets = [coord];
      }
    }
    if (!targets.length) {
      this.note(room, 'Nobody was mentioned and this room has no coordinator. Mention a bot with @handle or set a coordinator.', msg.causeId, 0);
      return;
    }
    for (const t of targets) this.enqueue(t, room, { causeId: msg.causeId ?? msg.id, hop: 0, triggerSeq: msg.seq, causeKind: 'user' });
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
    return valid.map((v) => v.handle);
  }

  private note(room: Room, text: string, causeId: string | null, hop: number) {
    const msg = this.repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'system', text, payload: null, causeId, hop, turnId: null });
    events.emitEvent({ type: 'message.new', message: msg });
  }

  // ---------- lanes ----------
  private enqueue(bot: Bot, room: Room, item: LaneItem) {
    const key = bot.id + ':' + room.id;
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = { running: false, pending: [] }));
    item.journalId ??= this.repos.journalAdd({
      botId: bot.id, roomId: room.id, causeId: item.causeId, hop: item.hop, triggerSeq: item.triggerSeq,
      runId: item.runId ?? null, note: item.note ?? null, attempts: item.attempts,
    });
    lane.pending.push(item);
    if (!lane.running) void this.runLane(key, bot.id, room.id);
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
        // A slot first, so a turn that queued behind others sees what they spent.
        await this.acquire();
        let items: LaneItem[];
        let req: TurnRequest;
        let startSeq: number;
        let result: TurnResult;
        try {
          // The cost cap covers every cause (user message, routine, later triggers), not only bot hops: a
          // trigger whose thread already spent the cap is dropped with a note instead of starting a turn,
          // and a turn that does start may spend at most what is left of the cap.
          items = this.withinCostCap(bot, room, lane.pending.splice(0));
          if (!items.length) continue;
          const hop = Math.max(...items.map((i) => i.hop));
          const causeId = items[0].causeId;
          const session = this.repos.getSession(bot.id, room.id);
          startSeq = this.repos.maxSeq(room.id);
          const notes = [...new Set(items.map((i) => i.note).filter((n): n is string => !!n))];
          const handBack = this.control?.takeNote(bot.id);
          if (handBack) notes.push(handBackNote(handBack));
          const injected = this.buildInjected(bot, room, session.lastSeenSeq, items.map((i) => i.triggerSeq)) + (notes.length ? '\n\n' + notes.join('\n') : '');
          // P5: a trigger item also brings its own remaining daily budget; the turn gets the tighter of the two.
          const causeBudgetUsd = Math.min(CAUSE_COST_CAP_USD - this.usage.causeCost(causeId), ...items.map((i) => i.budgetUsd ?? Infinity));
          // A person's message in the batch outranks automation, so a routine never drags a reply down to triage.
          const causeKind = items.find((i) => i.causeKind === 'user')?.causeKind ?? items[0].causeKind;
          // Decision Q6: a turn any of whose causes the human did not start (a routine, later a trigger)
          // goes through approvals even when the hub runs in bypass mode.
          const strictApprovals = items.some((i) => this.requiresApprovals(i.causeId));
          // Only a person's own newest words can ask for a stronger model, never a forwarded trigger payload.
          const latestUserText = this.repos.messagesAfter(room.id, session.lastSeenSeq).filter((m) => m.authorType === 'user').at(-1)?.text;
          // A routine's own prompt may invoke a skill. Its owner wrote it, unlike anything else in the transcript.
          const cause = causeKind === 'routine' ? this.repos.getMessage(causeId) : undefined;
          const routinePrompt = cause?.kind === 'routine' ? cause.text : undefined;
          // The composer's pick is for what a person starts here. Hand-offs and schedules keep each bot's own model.
          const chatModel = items.some((i) => i.causeKind === 'user' && i.hop === 0) ? room.chatModel ?? undefined : undefined;
          req = { bot, room, members: this.members(room), hop, causeId, injected, latestUserText, routinePrompt, chatModel, causeBudgetUsd, causeKind, strictApprovals, runId: items.find((i) => i.runId)?.runId };
          result = await this.runner.runTurn(req);
        } finally {
          this.release();
        }
        // Shutting down: the hub interrupted the turn, it did not finish. Leave its journal rows (and the
        // session cursor) alone so the next start resumes it (services/FollowUp.ts).
        if (this.frozen) return;
        const left = lane.left;
        lane.left = false;
        this.repos.journalRemove(items.map((i) => i.journalId).filter((id): id is string => !!id));
        this.repos.saveSession(bot.id, room.id, { lastSeenSeq: startSeq });
        // Counts the turn and, every N turns, starts a background pass; never awaited, so the lane moves on.
        this.autoMemory?.afterTurn(bot.id, room.id, result);
        // P6: same idea per skill, for bots that opted in; never awaited either.
        try { this.skillReflection?.afterTurn(bot.id, room.id, result); } catch (e) { console.error('[skill-reflection]', e); }
        // P2: a parked turn is not finished; its routine run stays open until the resumed turn ends.
        for (const i of items) if (!(result.parked && i.runId)) i.onDone?.(result);
        if (result.ok && result.finalText && !left) {
          // re-read members: the turn may have created or added bots
          const freshRoom = this.repos.getRoom(roomId) ?? room;
          const targets = parseMentions(result.finalText, this.members(freshRoom), bot.id);
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

  private buildInjected(bot: Bot, room: Room, lastSeenSeq: number, triggerSeqs: number[]): string {
    const msgs = this.repos
      .messagesAfter(room.id, lastSeenSeq)
      .filter((m) => isConversation(m) && m.authorId !== bot.id);
    const lines = msgs.map((m) => formatMessage(this.repos, m));
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

  interrupt(turnId: string) {
    return this.runner.interrupt(turnId);
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
    const lane = this.lanes.get(botId + ':' + roomId);
    if (!lane) return;
    for (const i of lane.pending.splice(0)) {
      if (i.journalId) this.repos.journalRemove([i.journalId]);
      i.onDone?.({ ok: false, turnId: '', finalText: '', costUsd: 0, error: 'removed from the room' });
    }
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
  resume(bot: Bot, room: Room, item: { causeId: string; hop: number; triggerSeq: number; attempts: number; runId?: string; note?: string; onDone?: (r: TurnResult) => void }) {
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
    this.enqueue(bot, room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, onDone: t.onDone, causeKind: 'trigger', budgetUsd: t.budgetUsd });
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
