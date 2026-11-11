import type { BotPreview, SearchHit } from '@pocketrocket/shared';
import { nanoid } from 'nanoid';
import {
  AUTO_MEMORY_EVERY,
  type Bot, type Room, type Message, type Routine, type RoutineRun, type Skill, type UsageTotals, type UsageRow, type MessageKind, type AuthorType,
  type CauseKind, type UsageGroup, type OpenApproval,
  type User,
} from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

const now = () => Date.now();

const SUM =
  'COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens),0) inp, COALESCE(SUM(output_tokens),0) out, ' +
  'COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw, COUNT(*) n';

export class Repos {
  constructor(readonly db: Db) {}

  /** The hub's owner. Created by migration 112, so it always exists. */
  owner(): User {
    const r = this.db.get("SELECT * FROM users WHERE role='owner' ORDER BY created_at LIMIT 1") as Record<string, unknown>;
    return {
      id: r.id as string,
      displayName: r.display_name as string,
      role: r.role as User['role'],
      previousNames: JSON.parse(r.previous_names as string) as string[],
      createdAt: r.created_at as number,
    };
  }

  /** Changes the owner's name and keeps the old one, so notes written under it still point at them. The id never changes. */
  renameOwner(name: string): User {
    const cur = this.owner();
    if (name === cur.displayName) return cur;
    const kept = cur.displayName && !cur.previousNames.includes(cur.displayName) ? [...cur.previousNames, cur.displayName] : cur.previousNames;
    const previous = kept.filter((n) => n !== name);
    this.db.run('UPDATE users SET display_name=?, previous_names=? WHERE id=?', name, JSON.stringify(previous), cur.id);
    return this.owner();
  }

  // ---------- bots ----------
  private rowToBot(r: Row): Bot {
    return {
      id: r.id as string,
      name: r.name as string,
      handle: r.handle as string,
      title: (r.title as string) ?? '',
      description: (r.description as string) ?? '',
      avatar: (r.avatar as string) || '',
      model: r.model as string,
      allowedTools: JSON.parse((r.allowed_tools as string) || '[]'),
      maxBudgetUsd: r.max_budget_usd as number,
      autoMemory: !!(r.auto_memory as number),
      autoMemoryEvery: (r.auto_memory_every as number) ?? AUTO_MEMORY_EVERY.default,
      createdAt: r.created_at as number,
    };
  }
  listBots(): Bot[] {
    return this.db.all('SELECT * FROM bots ORDER BY created_at').map((r) => this.rowToBot(r));
  }
  getBot(id: string): Bot | undefined {
    const r = this.db.get('SELECT * FROM bots WHERE id=?', id);
    return r && this.rowToBot(r);
  }
  getBotByHandle(handle: string): Bot | undefined {
    const r = this.db.get('SELECT * FROM bots WHERE handle=?', handle);
    return r && this.rowToBot(r);
  }
  /** The auto-memory fields are optional here and default to on, every {@link AUTO_MEMORY_EVERY}.default turns. */
  createBot(b: Omit<Bot, 'id' | 'createdAt' | 'autoMemory' | 'autoMemoryEvery'> & Partial<Pick<Bot, 'autoMemory' | 'autoMemoryEvery'>>): Bot {
    const bot: Bot = { ...b, autoMemory: b.autoMemory ?? true, autoMemoryEvery: b.autoMemoryEvery ?? AUTO_MEMORY_EVERY.default, id: nanoid(10), createdAt: now() };
    this.db.run(
      'INSERT INTO bots (id,name,handle,title,description,avatar,model,allowed_tools,max_budget_usd,auto_memory,auto_memory_every,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      bot.id, bot.name, bot.handle, bot.title, bot.description, bot.avatar, bot.model,
      JSON.stringify(bot.allowedTools), bot.maxBudgetUsd, bot.autoMemory ? 1 : 0, bot.autoMemoryEvery, bot.createdAt,
    );
    return bot;
  }
  updateBot(id: string, patch: Partial<Omit<Bot, 'id' | 'createdAt'>>): Bot | undefined {
    const cur = this.getBot(id);
    if (!cur) return undefined;
    const b = { ...cur, ...patch };
    this.db.run(
      'UPDATE bots SET name=?,handle=?,title=?,description=?,avatar=?,model=?,allowed_tools=?,max_budget_usd=?,auto_memory=?,auto_memory_every=? WHERE id=?',
      b.name, b.handle, b.title, b.description, b.avatar, b.model, JSON.stringify(b.allowedTools), b.maxBudgetUsd,
      b.autoMemory ? 1 : 0, b.autoMemoryEvery, id,
    );
    return b;
  }
  deleteBot(id: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM bots WHERE id=?', id);
      this.db.run('DELETE FROM room_members WHERE bot_id=?', id);
      this.db.run('DELETE FROM sessions WHERE bot_id=?', id);
      this.db.run('DELETE FROM auto_memory WHERE bot_id=?', id);
      this.db.run('DELETE FROM bot_skills WHERE bot_id=?', id);
      this.db.run('DELETE FROM routines WHERE bot_id=?', id);
      this.db.run('UPDATE rooms SET coordinator_bot_id=NULL WHERE coordinator_bot_id=?', id);
    });
  }

  // ---------- rooms ----------
  private rowToRoom(r: Row): Room {
    const members = this.db
      .all<{ bot_id: string }>('SELECT bot_id FROM room_members WHERE room_id=?', r.id as string)
      .map((m) => m.bot_id);
    return {
      id: r.id as string,
      kind: r.kind as Room['kind'],
      name: r.name as string,
      memberIds: members,
      coordinatorBotId: (r.coordinator_bot_id as string) ?? null,
      createdAt: r.created_at as number,
      chatModel: (r.chat_model as string) ?? null,
      avatar: (r.avatar as string) || '',
    };
  }
  listRooms(): Room[] {
    return this.db.all('SELECT * FROM rooms ORDER BY created_at').map((r) => this.rowToRoom(r));
  }
  getRoom(id: string): Room | undefined {
    const r = this.db.get('SELECT * FROM rooms WHERE id=?', id);
    return r && this.rowToRoom(r);
  }
  createRoom(input: { kind: Room['kind']; name: string; memberIds: string[]; coordinatorBotId: string | null; avatar?: string }): Room {
    const id = nanoid(10);
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO rooms (id,kind,name,coordinator_bot_id,created_at,avatar) VALUES (?,?,?,?,?,?)',
        id, input.kind, input.name, input.coordinatorBotId, now(), input.avatar ?? '',
      );
      for (const m of new Set(input.memberIds)) this.db.run('INSERT INTO room_members (room_id,bot_id) VALUES (?,?)', id, m);
    });
    return this.getRoom(id)!;
  }
  updateRoom(id: string, patch: Partial<{ name: string; memberIds: string[]; coordinatorBotId: string | null; avatar: string }>): Room | undefined {
    const cur = this.getRoom(id);
    if (!cur) return undefined;
    this.db.tx(() => {
      this.db.run(
        'UPDATE rooms SET name=?, coordinator_bot_id=?, avatar=? WHERE id=?',
        patch.name ?? cur.name,
        patch.coordinatorBotId === undefined ? cur.coordinatorBotId : patch.coordinatorBotId,
        patch.avatar ?? cur.avatar ?? '',
        id,
      );
      if (patch.memberIds) {
        this.db.run('DELETE FROM room_members WHERE room_id=?', id);
        for (const m of new Set(patch.memberIds)) this.db.run('INSERT INTO room_members (room_id,bot_id) VALUES (?,?)', id, m);
      }
    });
    return this.getRoom(id);
  }
  /** The composer's pick for this chat. Only the owner's REST route calls this; no bot tool does. */
  setRoomChatModel(id: string, model: string | null): Room | undefined {
    this.db.run('UPDATE rooms SET chat_model=? WHERE id=?', model, id);
    return this.getRoom(id);
  }
  deleteRoom(id: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM rooms WHERE id=?', id);
      this.db.run('DELETE FROM room_members WHERE room_id=?', id);
      this.db.run('DELETE FROM messages WHERE room_id=?', id);
      this.db.run('DELETE FROM sessions WHERE room_id=?', id);
      this.db.run('DELETE FROM auto_memory WHERE room_id=?', id);
      this.db.run('DELETE FROM routines WHERE room_id=?', id);
      this.db.run('DELETE FROM approvals WHERE room_id=?', id);
    });
  }

  // ---------- messages ----------
  private rowToMessage(r: Row): Message {
    return {
      id: r.id as string,
      roomId: r.room_id as string,
      seq: r.seq as number,
      authorType: r.author_type as AuthorType,
      authorId: (r.author_id as string) ?? null,
      kind: r.kind as MessageKind,
      text: (r.text as string) ?? '',
      payload: r.payload ? JSON.parse(r.payload as string) : null,
      causeId: (r.cause_id as string) ?? null,
      hop: (r.hop as number) ?? 0,
      turnId: (r.turn_id as string) ?? null,
      createdAt: r.created_at as number,
      ...(r.model ? { model: r.model as string, modelReason: (r.model_reason as string) ?? undefined } : {}),
      ...(r.attachments ? { attachments: JSON.parse(r.attachments as string) as string[] } : {}),
    };
  }
  insertMessage(m: Omit<Message, 'id' | 'seq' | 'createdAt'> & { id?: string }): Message {
    return this.db.tx(() => {
      const seq =
        this.db.get<{ s: number }>('SELECT COALESCE(MAX(seq),0)+1 AS s FROM messages WHERE room_id=?', m.roomId)?.s ?? 1;
      const msg: Message = { ...m, id: m.id ?? nanoid(12), seq, createdAt: now() };
      this.db.run(
        'INSERT INTO messages (id,room_id,seq,author_type,author_id,kind,text,payload,cause_id,hop,turn_id,created_at,model,model_reason,attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        msg.id, msg.roomId, msg.seq, msg.authorType, msg.authorId, msg.kind, msg.text,
        msg.payload ? JSON.stringify(msg.payload) : null, msg.causeId, msg.hop, msg.turnId, msg.createdAt,
        msg.model ?? null, msg.modelReason ?? null, msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
      );
      return msg;
    });
  }
  updateMessage(id: string, patch: Partial<Pick<Message, 'text' | 'payload'>>): Message | undefined {
    const cur = this.getMessage(id);
    if (!cur) return undefined;
    const m = { ...cur, ...patch };
    this.db.run('UPDATE messages SET text=?, payload=? WHERE id=?', m.text, m.payload ? JSON.stringify(m.payload) : null, id);
    return m;
  }
  getMessage(id: string): Message | undefined {
    const r = this.db.get('SELECT * FROM messages WHERE id=?', id);
    return r && this.rowToMessage(r);
  }
  listMessages(roomId: string, opts: { before?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.before
      ? this.db.all('SELECT * FROM messages WHERE room_id=? AND seq<? ORDER BY seq DESC LIMIT ?', roomId, opts.before, limit)
      : this.db.all('SELECT * FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT ?', roomId, limit);
    return rows.reverse().map((r) => this.rowToMessage(r));
  }
  /** Each bot's latest message, from any room, cut short. A bot that has said nothing has no entry. */
  botPreviews(): Record<string, BotPreview> {
    const rows = this.db.all<{ author_id: string; text: string; at: number }>(
      "SELECT author_id, substr(text,1,200) AS text, created_at AS at, MAX(rowid) FROM messages WHERE author_type='bot' AND kind='text' AND author_id IS NOT NULL AND text<>'' GROUP BY author_id",
    );
    return Object.fromEntries(rows.map((r) => [r.author_id, { text: r.text, at: r.at }]));
  }
  /** Messages people read, in every room, containing `query` in any case. Newest first. */
  searchMessages(query: string, limit: number): SearchHit[] {
    const rows = this.db.all<{ id: string; room_id: string; room_name: string; seq: number; text: string; created_at: number }>(
      "SELECT m.id, m.room_id, r.name AS room_name, m.seq, m.text, m.created_at FROM messages m JOIN rooms r ON r.id=m.room_id " +
        "WHERE m.kind='text' AND m.text LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?",
      '%' + query.replace(/[\\%_]/g, '\\$&') + '%', limit,
    );
    const lower = query.toLowerCase();
    return rows.map((r) => {
      const at = Math.max(0, r.text.toLowerCase().indexOf(lower));
      const start = Math.max(0, at - 50);
      const end = Math.min(r.text.length, at + query.length + 90);
      const snippet = (start ? '…' : '') + r.text.slice(start, end).replace(/\s+/g, ' ') + (end < r.text.length ? '…' : '');
      return { id: r.id, roomId: r.room_id, roomName: r.room_name, seq: r.seq, snippet, createdAt: r.created_at };
    });
  }
  /** What the owner wrote, newest first, across every room or just one. */
  listOwnerMessages(o: { since?: number; before?: number; roomId?: string; query?: string; limit: number }): Array<{ createdAt: number; roomName: string; text: string }> {
    const where = ["m.author_type='user'", "m.kind='text'"];
    const args: Array<string | number> = [];
    if (o.since !== undefined) { where.push('m.created_at>=?'); args.push(o.since); }
    if (o.before !== undefined) { where.push('m.created_at<?'); args.push(o.before); }
    if (o.roomId) { where.push('m.room_id=?'); args.push(o.roomId); }
    if (o.query) { where.push("m.text LIKE ? ESCAPE '\\'"); args.push('%' + o.query.replace(/[\\%_]/g, '\\$&') + '%'); }
    const rows = this.db.all<{ created_at: number; room_name: string; text: string }>(
      'SELECT m.created_at, m.text, r.name AS room_name FROM messages m JOIN rooms r ON r.id=m.room_id WHERE ' + where.join(' AND ') + ' ORDER BY m.created_at DESC LIMIT ?',
      ...args, o.limit,
    );
    return rows.map((r) => ({ createdAt: r.created_at, roomName: r.room_name, text: r.text }));
  }
  messagesAfter(roomId: string, seq: number): Message[] {
    return this.db
      .all('SELECT * FROM messages WHERE room_id=? AND seq>? ORDER BY seq', roomId, seq)
      .map((r) => this.rowToMessage(r));
  }
  maxSeq(roomId: string): number {
    return this.db.get<{ s: number }>('SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE room_id=?', roomId)?.s ?? 0;
  }

  // ---------- sessions ----------
  /**
   * Session token for (bot, room). `provider` names the adapter that created the token; pass the active
   * provider id to get `sdkSessionId: null` for a token another provider wrote (resume tokens are not portable).
   */
  getSession(botId: string, roomId: string, provider?: string): { sdkSessionId: string | null; lastSeenSeq: number; provider: string | null } {
    const r = this.db.get('SELECT * FROM sessions WHERE bot_id=? AND room_id=?', botId, roomId);
    if (!r) return { sdkSessionId: null, lastSeenSeq: 0, provider: null };
    const rowProvider = (r.provider as string) ?? null;
    const stale = provider !== undefined && rowProvider !== null && rowProvider !== provider;
    return {
      sdkSessionId: stale ? null : ((r.sdk_session_id as string) ?? null),
      lastSeenSeq: r.last_seen_seq as number,
      provider: rowProvider,
    };
  }
  saveSession(botId: string, roomId: string, patch: { sdkSessionId?: string | null; lastSeenSeq?: number; provider?: string | null }) {
    const cur = this.getSession(botId, roomId);
    const s = { ...cur, ...patch };
    this.db.run(
      'INSERT INTO sessions (bot_id,room_id,sdk_session_id,last_seen_seq,updated_at,provider) VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(bot_id,room_id) DO UPDATE SET sdk_session_id=excluded.sdk_session_id,last_seen_seq=excluded.last_seen_seq,' +
        'updated_at=excluded.updated_at,provider=excluded.provider',
      botId, roomId, s.sdkSessionId, s.lastSeenSeq, now(), s.provider,
    );
  }

  /**
   * Token-efficiency state of the (bot, room) session (migration 170). Kept apart from getSession/saveSession so
   * their shape stays as it was. Every field is null when unknown, which on a legacy row means "never measured".
   */
  getSessionState(botId: string, roomId: string): SessionState {
    const r = this.db.get('SELECT * FROM sessions WHERE bot_id=? AND room_id=?', botId, roomId);
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      costTotal: num(r?.cost_total),
      contextTokens: num(r?.context_tokens),
      contextAt: num(r?.context_at),
      memorySnapshot: str(r?.memory_snapshot),
      identitySnapshot: str(r?.identity_snapshot),
      summary: str(r?.summary),
    };
  }
  /** Writes only the fields given (an explicit null clears one). Creates the row when there is none. */
  saveSessionState(botId: string, roomId: string, patch: Partial<SessionState>) {
    const cols: Record<keyof SessionState, string> = {
      costTotal: 'cost_total', contextTokens: 'context_tokens', contextAt: 'context_at',
      memorySnapshot: 'memory_snapshot', identitySnapshot: 'identity_snapshot', summary: 'summary',
    };
    const keys = (Object.keys(patch) as (keyof SessionState)[]).filter((k) => k in cols && patch[k] !== undefined);
    if (!keys.length) return;
    this.db.run('INSERT OR IGNORE INTO sessions (bot_id,room_id,last_seen_seq,updated_at) VALUES (?,?,0,?)', botId, roomId, now());
    this.db.run(
      'UPDATE sessions SET ' + keys.map((k) => cols[k] + '=?').join(',') + ' WHERE bot_id=? AND room_id=?',
      ...keys.map((k) => patch[k]), botId, roomId,
    );
  }

  // ---------- auto-memory progress ----------
  getAutoMemory(botId: string, roomId: string): { turnsSince: number; lastSeq: number; retryAt: number } {
    const r = this.db.get('SELECT * FROM auto_memory WHERE bot_id=? AND room_id=?', botId, roomId);
    if (!r) return { turnsSince: 0, lastSeq: 0, retryAt: 0 };
    return { turnsSince: r.turns_since as number, lastSeq: r.last_seq as number, retryAt: r.retry_at as number };
  }
  saveAutoMemory(botId: string, roomId: string, patch: Partial<{ turnsSince: number; lastSeq: number; retryAt: number }>) {
    const s = { ...this.getAutoMemory(botId, roomId), ...patch };
    this.db.run(
      'INSERT INTO auto_memory (bot_id,room_id,turns_since,last_seq,retry_at) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(bot_id,room_id) DO UPDATE SET turns_since=excluded.turns_since,last_seq=excluded.last_seq,retry_at=excluded.retry_at',
      botId, roomId, s.turnsSince, s.lastSeq, s.retryAt,
    );
  }

  /** Records that auto-memory just wrote to the bot's memory.md (notes or a merge) from this room. */
  markAutoMemorySaved(botId: string, roomId: string, at: number = now()) {
    this.saveAutoMemory(botId, roomId, {});
    this.db.run('UPDATE auto_memory SET saved_at=? WHERE bot_id=? AND room_id=?', at, botId, roomId);
  }
  /** When auto-memory last wrote to the bot's memory.md, from any room; null when it never has. */
  lastAutoMemorySave(botId: string): number | null {
    const r = this.db.get<{ at: number | null }>('SELECT MAX(saved_at) AS at FROM auto_memory WHERE bot_id=?', botId);
    return r?.at ?? null;
  }

  // ---------- settings (key -> JSON value) ----------
  allSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      try { out[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt row */ }
    }
    return out;
  }
  setSetting(key: string, value: unknown) {
    this.db.run(
      'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, JSON.stringify(value),
    );
  }
  resetSession(botId: string, roomId: string) {
    this.db.run('DELETE FROM sessions WHERE bot_id=? AND room_id=?', botId, roomId);
  }

  // ---------- routines ----------
  private rowToRoutine(r: Row): Routine {
    return {
      id: r.id as string,
      botId: r.bot_id as string,
      roomId: r.room_id as string,
      name: r.name as string,
      cron: r.cron as string,
      prompt: r.prompt as string,
      enabled: !!(r.enabled as number),
      lastRunAt: (r.last_run_at as number) ?? null,
      nextRunAt: (r.next_run_at as number) ?? null,
      onceAt: (r.once_at as number) ?? null,
    };
  }
  listRoutines(): Routine[] {
    return this.db.all('SELECT * FROM routines ORDER BY name').map((r) => this.rowToRoutine(r));
  }
  getRoutine(id: string): Routine | undefined {
    const r = this.db.get('SELECT * FROM routines WHERE id=?', id);
    return r && this.rowToRoutine(r);
  }
  createRoutine(i: Omit<Routine, 'id' | 'lastRunAt' | 'nextRunAt' | 'onceAt'> & { onceAt?: number | null }): Routine {
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO routines (id,bot_id,room_id,name,cron,prompt,enabled,once_at) VALUES (?,?,?,?,?,?,?,?)',
      id, i.botId, i.roomId, i.name, i.cron, i.prompt, i.enabled ? 1 : 0, i.onceAt ?? null,
    );
    return this.getRoutine(id)!;
  }
  updateRoutine(id: string, patch: Partial<Routine>): Routine | undefined {
    const cur = this.getRoutine(id);
    if (!cur) return undefined;
    const r = { ...cur, ...patch };
    this.db.run(
      'UPDATE routines SET bot_id=?,room_id=?,name=?,cron=?,prompt=?,enabled=?,last_run_at=?,next_run_at=?,once_at=? WHERE id=?',
      r.botId, r.roomId, r.name, r.cron, r.prompt, r.enabled ? 1 : 0, r.lastRunAt, r.nextRunAt, r.onceAt, id,
    );
    return r;
  }
  deleteRoutine(id: string) {
    this.db.run('DELETE FROM routines WHERE id=?', id);
    this.db.run('DELETE FROM routine_runs WHERE routine_id=?', id);
  }
  createRun(routineId: string, messageId: string | null): RoutineRun {
    const run: RoutineRun = { id: nanoid(10), routineId, startedAt: now(), endedAt: null, status: 'running', messageId, costUsd: null };
    this.db.run(
      'INSERT INTO routine_runs (id,routine_id,started_at,status,message_id) VALUES (?,?,?,?,?)',
      run.id, routineId, run.startedAt, run.status, messageId,
    );
    return run;
  }
  finishRun(id: string, status: RoutineRun['status'], costUsd: number | null) {
    this.db.run('UPDATE routine_runs SET ended_at=?, status=?, cost_usd=? WHERE id=?', now(), status, costUsd, id);
  }
  listRuns(routineId: string, limit = 20): RoutineRun[] {
    return this.db
      .all('SELECT * FROM routine_runs WHERE routine_id=? ORDER BY started_at DESC LIMIT ?', routineId, limit)
      .map((r) => ({
        id: r.id as string,
        routineId: r.routine_id as string,
        startedAt: r.started_at as number,
        endedAt: (r.ended_at as number) ?? null,
        status: r.status as RoutineRun['status'],
        messageId: (r.message_id as string) ?? null,
        costUsd: (r.cost_usd as number) ?? null,
      }));
  }

  // ---------- skills ----------
  private rowToSkill(r: Row): Skill {
    return {
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string) ?? '',
      path: r.path as string,
      source: r.source as Skill['source'],
      reviewStatus: r.review_status as Skill['reviewStatus'],
      createdByBot: (r.created_by_bot as string) ?? null,
      // P6: the live version; candidate versions (parent_id set) never come out of listSkills.
      version: (r.version as number) ?? 1,
      parentId: (r.parent_id as string) ?? null,
      ...(r.pending_versions !== undefined ? { pendingVersions: r.pending_versions as number } : {}),
    };
  }
  listSkills(): Skill[] {
    // P6: candidate versions are rows with parent_id set; they are not pool skills.
    return this.db
      .all("SELECT s.*, (SELECT COUNT(*) FROM skills v WHERE v.parent_id=s.id AND v.review_status='pending') AS pending_versions FROM skills s WHERE s.parent_id IS NULL ORDER BY s.name")
      .map((r) => this.rowToSkill(r));
  }
  getSkill(id: string): Skill | undefined {
    const r = this.db.get('SELECT * FROM skills WHERE id=?', id);
    return r && this.rowToSkill(r);
  }
  getSkillByName(name: string): Skill | undefined {
    const r = this.db.get('SELECT * FROM skills WHERE name=?', name);
    return r && this.rowToSkill(r);
  }
  upsertSkill(s: Omit<Skill, 'id'>): Skill {
    const existing = this.getSkillByName(s.name);
    if (existing) {
      this.db.run(
        'UPDATE skills SET description=?, path=?, source=?, review_status=?, created_by_bot=? WHERE id=?',
        s.description, s.path, s.source, s.reviewStatus, s.createdByBot, existing.id,
      );
      return { ...s, id: existing.id };
    }
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO skills (id,name,description,path,source,review_status,created_by_bot) VALUES (?,?,?,?,?,?,?)',
      id, s.name, s.description, s.path, s.source, s.reviewStatus, s.createdByBot,
    );
    return { ...s, id };
  }
  setSkillReview(id: string, status: Skill['reviewStatus']) {
    this.db.run('UPDATE skills SET review_status=? WHERE id=?', status, id);
  }
  deleteSkill(id: string) {
    this.db.run('DELETE FROM skills WHERE id=?', id);
    this.db.run('DELETE FROM bot_skills WHERE skill_id=?', id);
  }
  botSkillIds(botId: string): string[] {
    return this.db.all<{ skill_id: string }>('SELECT skill_id FROM bot_skills WHERE bot_id=?', botId).map((r) => r.skill_id);
  }
  setBotSkills(botId: string, skillIds: string[]) {
    this.db.tx(() => {
      this.db.run('DELETE FROM bot_skills WHERE bot_id=?', botId);
      for (const s of new Set(skillIds)) this.db.run('INSERT INTO bot_skills (bot_id,skill_id) VALUES (?,?)', botId, s);
    });
  }

  // ---------- approvals ----------
  createApproval(a: { id: string; botId: string; roomId: string; turnId: string; toolName: string; toolInput: unknown; reason: string }) {
    this.db.run(
      'INSERT INTO approvals (id,bot_id,room_id,turn_id,tool_name,tool_input,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      a.id, a.botId, a.roomId, a.turnId, a.toolName, JSON.stringify(a.toolInput ?? null), a.reason, 'pending', now(),
    );
  }
  /** `decidedBy`: 'owner' when a person answered the card. An aborted turn records `deny` with no one behind it. */
  decideApproval(id: string, status: string, decidedBy: 'owner' | null = null) {
    this.db.run('UPDATE approvals SET status=?, decided_at=?, decided_by=? WHERE id=?', status, now(), decidedBy, id);
  }
  /** Cards still waiting for an answer, parked ones included (expirePendingApprovals clears the rest at startup). */
  openApprovals(): OpenApproval[] {
    return this.db.all<{ id: string; bot_id: string; room_id: string }>("SELECT id, bot_id, room_id FROM approvals WHERE status='pending'")
      .map((r) => ({ approvalId: r.id, botId: r.bot_id, roomId: r.room_id }));
  }
  /**
   * Startup: every approval still `pending` belonged to a turn that died with the previous hub process, so
   * nothing can act on it. Marks those rows and their cards `expired`; returns the card messages it changed.
   */
  expirePendingApprovals(): Message[] {
    return this.db.tx(() => {
      // P2: a parked card or takeover (its turn ended and waits for the user) survives a restart.
      this.db.run("UPDATE approvals SET status='expired', decided_at=? WHERE status='pending' AND parked_at IS NULL", now());
      const open = "((kind='approval' AND json_extract(payload, '$.status')='pending' AND json_extract(payload, '$.parked') IS NOT 1) OR " +
        "(kind='takeover' AND json_extract(payload, '$.status')='waiting'))";
      const ids = this.db.all<{ id: string }>('SELECT id FROM messages WHERE ' + open).map((r) => r.id);
      this.db.run("UPDATE messages SET payload=json_set(payload, '$.status', 'expired') WHERE " + open);
      return ids.map((id) => this.getMessage(id)).filter((m): m is Message => !!m);
    });
  }

  /** Takeover cards whose turn ended and which still wait for the user to hand back. */
  parkedTakeovers(): Message[] {
    return this.db.all<{ id: string }>("SELECT id FROM messages WHERE kind='takeover' AND json_extract(payload, '$.status')='parked' ORDER BY rowid")
      .map((r) => this.getMessage(r.id)).filter((m): m is Message => !!m);
  }

  // ---------- usage ----------
  recordUsage(u: {
    botId: string; roomId: string; turnId: string; causeId: string | null; costUsd: number; inputTokens: number;
    outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; modelUsage: unknown; durationMs: number;
    /** P8: the model that ran, why the router chose it, and what kind of cause started the turn. */
    model?: string; routeReason?: string; causeKind?: CauseKind;
  }) {
    this.db.run(
      'INSERT INTO usage (bot_id,room_id,turn_id,cause_id,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,model_usage,duration_ms,created_at,model,route_reason,cause_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      u.botId, u.roomId, u.turnId, u.causeId, u.costUsd, u.inputTokens, u.outputTokens, u.cacheReadTokens,
      u.cacheWriteTokens, JSON.stringify(u.modelUsage ?? null), u.durationMs, now(),
      u.model ?? null, u.routeReason ?? null, u.causeKind ?? null,
    );
  }
  private totalsFrom(r: Row | undefined): UsageTotals {
    return {
      costUsd: (r?.cost as number) ?? 0,
      inputTokens: (r?.inp as number) ?? 0,
      outputTokens: (r?.out as number) ?? 0,
      cacheReadTokens: (r?.cr as number) ?? 0,
      cacheWriteTokens: (r?.cw as number) ?? 0,
      turns: (r?.n as number) ?? 0,
    };
  }
  usageTotals(where: { botId?: string; roomId?: string; causeId?: string; sinceMs?: number } = {}): UsageTotals {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (where.botId) { conds.push('bot_id=?'); params.push(where.botId); }
    if (where.roomId) { conds.push('room_id=?'); params.push(where.roomId); }
    if (where.causeId) { conds.push('cause_id=?'); params.push(where.causeId); }
    if (where.sinceMs) { conds.push('created_at>=?'); params.push(where.sinceMs); }
    const sql = 'SELECT ' + SUM + ' FROM usage' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    return this.totalsFrom(this.db.get(sql, ...params));
  }
  usageBreakdown(): UsageRow[] {
    return this.db.all('SELECT bot_id, room_id, ' + SUM + ' FROM usage GROUP BY bot_id, room_id').map((r) => ({
      botId: r.bot_id as string,
      roomId: r.room_id as string,
      ...this.totalsFrom(r),
    }));
  }

  // ---------- P8: usage by model / cause kind ----------
  /** Spend grouped by the model that ran or by what started the turn. Rows from before P8 group under ''. */
  usageBy(by: 'model' | 'causeKind'): UsageGroup[] {
    const col = by === 'model' ? 'model' : 'cause_kind';
    return this.db
      .all('SELECT COALESCE(' + col + ", '') k, " + SUM + ' FROM usage GROUP BY k ORDER BY cost DESC')
      .map((r) => ({ key: r.k as string, ...this.totalsFrom(r) }));
  }
  // ---------- P3: lane journal (services/FollowUp.ts) ----------
  journalAdd(e: Omit<LaneJournalRow, 'id' | 'attempts' | 'createdAt'> & { attempts?: number }): string {
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO lane_journal (id,bot_id,room_id,cause_id,hop,trigger_seq,run_id,note,attempts,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, e.botId, e.roomId, e.causeId, e.hop, e.triggerSeq, e.runId, e.note, e.attempts ?? 0, now(),
    );
    return id;
  }
  journalRemove(ids: string[]) {
    for (const id of ids) this.db.run('DELETE FROM lane_journal WHERE id=?', id);
  }
  /** Every row, oldest first, and empties the table: the caller re-enqueues what it still wants. */
  journalTakeAll(): LaneJournalRow[] {
    return this.db.tx(() => {
      const rows = this.db.all('SELECT * FROM lane_journal ORDER BY created_at, rowid').map((r) => ({
        id: r.id as string,
        botId: r.bot_id as string,
        roomId: r.room_id as string,
        causeId: r.cause_id as string,
        hop: r.hop as number,
        triggerSeq: r.trigger_seq as number,
        runId: (r.run_id as string) ?? null,
        note: (r.note as string) ?? null,
        attempts: r.attempts as number,
        createdAt: r.created_at as number,
      }));
      this.db.run('DELETE FROM lane_journal');
      return rows;
    });
  }
  /** Routine runs still `running`: their turn died with the previous hub process. */
  runningRuns(): { id: string; routineId: string }[] {
    return this.db.all<{ id: string; routine_id: string }>("SELECT id, routine_id FROM routine_runs WHERE status='running'")
      .map((r) => ({ id: r.id, routineId: r.routine_id }));
  }

  // ---------- P6: skill reflection ----------
  /** Every message one turn wrote (text and tool calls), in order. */
  messagesOfTurn(roomId: string, turnId: string): Message[] {
    return this.db
      .all('SELECT * FROM messages WHERE room_id=? AND turn_id=? ORDER BY seq', roomId, turnId)
      .map((r) => this.rowToMessage(r));
  }
}

/** One queued or running lane item (P3, `lane_journal`). */
export interface LaneJournalRow {
  id: string;
  botId: string;
  roomId: string;
  causeId: string;
  hop: number;
  triggerSeq: number;
  runId: string | null;
  note: string | null;
  attempts: number;
  createdAt: number;
}

/** Per-session token-efficiency state (migration 170); see Repos.getSessionState. */
export interface SessionState {
  /** The SDK's cumulative cost last reported for this session; null on a legacy row. */
  costTotal: number | null;
  /** Input tokens of the last top-level model call of the last turn; null = never measured. */
  contextTokens: number | null;
  /** When contextTokens was measured (ms). */
  contextAt: number | null;
  memorySnapshot: string | null;
  identitySnapshot: string | null;
  /** The hub's running room summary, written when the session rotates. */
  summary: string | null;
}
