import type { Bot, BotState, Message, Room } from '@claudebot/shared';
import { CAUSE_COST_CAP_USD, MAX_CONCURRENT_TURNS, MAX_HOPS, USER_NAME } from '../config.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import type { UsageTracker } from '../services/UsageTracker.js';
import { parseMentions } from './mentions.js';

interface LaneItem {
  causeId: string;
  hop: number;
  triggerSeq: number;
  onDone?: (r: TurnResult) => void;
}
interface Lane {
  running: boolean;
  pending: LaneItem[];
}

const STATE_RANK: Record<BotState, number> = { idle: 0, done: 1, thinking: 2, working: 3, waiting: 4, blocked: 5, error: 6 };

export class RoomRouter {
  private lanes = new Map<string, Lane>();
  private states = new Map<string, Map<string, BotState>>(); // botId -> roomId -> state
  private runningTurns = 0;
  private waiters: (() => void)[] = [];
  runner!: BotRunner;

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
    const msg = this.repos.insertMessage({ roomId, authorType: 'user', authorId: null, kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null });
    // a user message starts a new cause chain
    const withCause = this.repos.updateMessage(msg.id, {}) ?? msg;
    this.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
    withCause.causeId = msg.id;
    events.emitEvent({ type: 'message.new', message: withCause });
    this.dispatchUser(room, withCause);
    return withCause;
  }

  /** Fire a routine prompt into a room for a specific bot. */
  fireRoutine(room: Room, bot: Bot, text: string, payload: Message['payload'], onDone?: (r: TurnResult) => void): Message {
    const msg = this.repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'routine', text, payload, causeId: null, hop: 0, turnId: null });
    this.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
    msg.causeId = msg.id;
    events.emitEvent({ type: 'message.new', message: msg });
    this.enqueue(bot, room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, onDone });
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
    for (const t of targets) this.enqueue(t, room, { causeId: msg.causeId ?? msg.id, hop: 0, triggerSeq: msg.seq });
  }

  /** Bot -> bot routing (after a turn or from tools). Returns dispatched handles. */
  dispatchFromBot(req: TurnRequest, targets: Bot[]): string[] {
    const hop = req.hop + 1;
    const room = this.repos.getRoom(req.room.id) ?? req.room;
    const members = this.members(room);
    const valid = targets.filter((t) => t.id !== req.bot.id && members.some((m) => m.id === t.id));
    if (!valid.length) return [];
    if (hop > MAX_HOPS) {
      this.note(room, 'Hop budget exhausted (' + MAX_HOPS + '). @' + req.bot.handle + ' cannot pass work to ' + valid.map((v) => '@' + v.handle).join(', ') + ' on this thread.', req.causeId, hop);
      return [];
    }
    const spent = this.usage.causeCost(req.causeId);
    if (spent >= CAUSE_COST_CAP_USD) {
      this.note(room, 'Cost cap reached for this thread ($' + spent.toFixed(2) + ' >= $' + CAUSE_COST_CAP_USD + '). Send a new message to continue.', req.causeId, hop);
      return [];
    }
    const seq = this.repos.maxSeq(room.id);
    for (const t of valid) this.enqueue(t, room, { causeId: req.causeId, hop, triggerSeq: seq });
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
    lane.pending.push(item);
    if (!lane.running) void this.runLane(key, bot.id, room.id);
  }

  private async runLane(key: string, botId: string, roomId: string) {
    const lane = this.lanes.get(key)!;
    lane.running = true;
    try {
      while (lane.pending.length) {
        const items = lane.pending.splice(0);
        const bot = this.repos.getBot(botId);
        const room = this.repos.getRoom(roomId);
        if (!bot || !room) break;
        const hop = Math.max(...items.map((i) => i.hop));
        const causeId = items[0].causeId;
        const session = this.repos.getSession(bot.id, room.id);
        const startSeq = this.repos.maxSeq(room.id);
        const injected = this.buildInjected(bot, room, session.lastSeenSeq, items.map((i) => i.triggerSeq));
        const req: TurnRequest = { bot, room, members: this.members(room), hop, causeId, injected };
        await this.acquire();
        let result: TurnResult;
        try {
          result = await this.runner.runTurn(req);
        } finally {
          this.release();
        }
        this.repos.saveSession(bot.id, room.id, { lastSeenSeq: startSeq });
        for (const i of items) i.onDone?.(result);
        if (result.ok && result.finalText) {
          // re-read members: the turn may have created or added bots
          const freshRoom = this.repos.getRoom(roomId) ?? room;
          const targets = parseMentions(result.finalText, this.members(freshRoom), bot.id);
          if (targets.length) this.dispatchFromBot({ ...req, room: freshRoom }, targets);
        }
      }
    } catch (e) {
      console.error('[lane ' + key + ']', e);
    } finally {
      lane.running = false;
    }
  }

  private buildInjected(bot: Bot, room: Room, lastSeenSeq: number, triggerSeqs: number[]): string {
    const msgs = this.repos
      .messagesAfter(room.id, lastSeenSeq)
      .filter((m) => (m.kind === 'text' || m.kind === 'handoff' || m.kind === 'routine') && m.authorId !== bot.id);
    const who = (m: Message) => {
      if (m.authorType === 'user') return USER_NAME;
      if (m.authorType === 'system') return m.kind === 'routine' ? 'routine' : 'system';
      const b = this.repos.getBot(m.authorId ?? '');
      return b ? '@' + b.handle : 'bot';
    };
    const lines = msgs.map((m) => '#' + m.seq + ' [' + who(m) + ']: ' + m.text);
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
}
