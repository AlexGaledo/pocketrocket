import { nanoid } from 'nanoid';
import type {
  Bot, Room, Message, Routine, RoutineRun, Skill, UsageTotals, UsageRow, MessageKind, AuthorType,
} from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

const now = () => Date.now();

const SUM =
  'COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens),0) inp, COALESCE(SUM(output_tokens),0) out, ' +
  'COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw, COUNT(*) n';

export class Repos {
  constructor(readonly db: Db) {}

  // ---------- bots ----------
  private rowToBot(r: Row): Bot {
    return {
      id: r.id as string,
      name: r.name as string,
      handle: r.handle as string,
      title: (r.title as string) ?? '',
      description: (r.description as string) ?? '',
      avatar: (r.avatar as string) || '🤖',
      model: r.model as string,
      allowedTools: JSON.parse((r.allowed_tools as string) || '[]'),
      maxBudgetUsd: r.max_budget_usd as number,
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
  createBot(b: Omit<Bot, 'id' | 'createdAt'>): Bot {
    const bot: Bot = { ...b, id: nanoid(10), createdAt: now() };
    this.db.run(
      'INSERT INTO bots (id,name,handle,title,description,avatar,model,allowed_tools,max_budget_usd,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      bot.id, bot.name, bot.handle, bot.title, bot.description, bot.avatar, bot.model,
      JSON.stringify(bot.allowedTools), bot.maxBudgetUsd, bot.createdAt,
    );
    return bot;
  }
  updateBot(id: string, patch: Partial<Omit<Bot, 'id' | 'createdAt'>>): Bot | undefined {
    const cur = this.getBot(id);
    if (!cur) return undefined;
    const b = { ...cur, ...patch };
    this.db.run(
      'UPDATE bots SET name=?,handle=?,title=?,description=?,avatar=?,model=?,allowed_tools=?,max_budget_usd=? WHERE id=?',
      b.name, b.handle, b.title, b.description, b.avatar, b.model, JSON.stringify(b.allowedTools), b.maxBudgetUsd, id,
    );
    return b;
  }
  deleteBot(id: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM bots WHERE id=?', id);
      this.db.run('DELETE FROM room_members WHERE bot_id=?', id);
      this.db.run('DELETE FROM sessions WHERE bot_id=?', id);
      this.db.run('DELETE FROM bot_skills WHERE bot_id=?', id);
      this.db.run('DELETE FROM routines WHERE bot_id=?', id);
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
    };
  }
  listRooms(): Room[] {
    return this.db.all('SELECT * FROM rooms ORDER BY created_at').map((r) => this.rowToRoom(r));
  }
  getRoom(id: string): Room | undefined {
    const r = this.db.get('SELECT * FROM rooms WHERE id=?', id);
    return r && this.rowToRoom(r);
  }
  createRoom(input: { kind: Room['kind']; name: string; memberIds: string[]; coordinatorBotId: string | null }): Room {
    const id = nanoid(10);
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO rooms (id,kind,name,coordinator_bot_id,created_at) VALUES (?,?,?,?,?)',
        id, input.kind, input.name, input.coordinatorBotId, now(),
      );
      for (const m of new Set(input.memberIds)) this.db.run('INSERT INTO room_members (room_id,bot_id) VALUES (?,?)', id, m);
    });
    return this.getRoom(id)!;
  }
  updateRoom(id: string, patch: Partial<{ name: string; memberIds: string[]; coordinatorBotId: string | null }>): Room | undefined {
    const cur = this.getRoom(id);
    if (!cur) return undefined;
    this.db.tx(() => {
      this.db.run(
        'UPDATE rooms SET name=?, coordinator_bot_id=? WHERE id=?',
        patch.name ?? cur.name,
        patch.coordinatorBotId === undefined ? cur.coordinatorBotId : patch.coordinatorBotId,
        id,
      );
      if (patch.memberIds) {
        this.db.run('DELETE FROM room_members WHERE room_id=?', id);
        for (const m of new Set(patch.memberIds)) this.db.run('INSERT INTO room_members (room_id,bot_id) VALUES (?,?)', id, m);
      }
    });
    return this.getRoom(id);
  }
  deleteRoom(id: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM rooms WHERE id=?', id);
      this.db.run('DELETE FROM room_members WHERE room_id=?', id);
      this.db.run('DELETE FROM messages WHERE room_id=?', id);
      this.db.run('DELETE FROM sessions WHERE room_id=?', id);
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
    };
  }
  insertMessage(m: Omit<Message, 'id' | 'seq' | 'createdAt'> & { id?: string }): Message {
    return this.db.tx(() => {
      const seq =
        this.db.get<{ s: number }>('SELECT COALESCE(MAX(seq),0)+1 AS s FROM messages WHERE room_id=?', m.roomId)?.s ?? 1;
      const msg: Message = { ...m, id: m.id ?? nanoid(12), seq, createdAt: now() };
      this.db.run(
        'INSERT INTO messages (id,room_id,seq,author_type,author_id,kind,text,payload,cause_id,hop,turn_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        msg.id, msg.roomId, msg.seq, msg.authorType, msg.authorId, msg.kind, msg.text,
        msg.payload ? JSON.stringify(msg.payload) : null, msg.causeId, msg.hop, msg.turnId, msg.createdAt,
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
  messagesAfter(roomId: string, seq: number): Message[] {
    return this.db
      .all('SELECT * FROM messages WHERE room_id=? AND seq>? ORDER BY seq', roomId, seq)
      .map((r) => this.rowToMessage(r));
  }
  maxSeq(roomId: string): number {
    return this.db.get<{ s: number }>('SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE room_id=?', roomId)?.s ?? 0;
  }

  // ---------- sessions ----------
  getSession(botId: string, roomId: string): { sdkSessionId: string | null; lastSeenSeq: number } {
    const r = this.db.get('SELECT * FROM sessions WHERE bot_id=? AND room_id=?', botId, roomId);
    return r
      ? { sdkSessionId: (r.sdk_session_id as string) ?? null, lastSeenSeq: r.last_seen_seq as number }
      : { sdkSessionId: null, lastSeenSeq: 0 };
  }
  saveSession(botId: string, roomId: string, patch: { sdkSessionId?: string | null; lastSeenSeq?: number }) {
    const cur = this.getSession(botId, roomId);
    const s = { ...cur, ...patch };
    this.db.run(
      'INSERT INTO sessions (bot_id,room_id,sdk_session_id,last_seen_seq,updated_at) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(bot_id,room_id) DO UPDATE SET sdk_session_id=excluded.sdk_session_id,last_seen_seq=excluded.last_seen_seq,updated_at=excluded.updated_at',
      botId, roomId, s.sdkSessionId, s.lastSeenSeq, now(),
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
    };
  }
  listRoutines(): Routine[] {
    return this.db.all('SELECT * FROM routines ORDER BY name').map((r) => this.rowToRoutine(r));
  }
  getRoutine(id: string): Routine | undefined {
    const r = this.db.get('SELECT * FROM routines WHERE id=?', id);
    return r && this.rowToRoutine(r);
  }
  createRoutine(i: Omit<Routine, 'id' | 'lastRunAt' | 'nextRunAt'>): Routine {
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO routines (id,bot_id,room_id,name,cron,prompt,enabled) VALUES (?,?,?,?,?,?,?)',
      id, i.botId, i.roomId, i.name, i.cron, i.prompt, i.enabled ? 1 : 0,
    );
    return this.getRoutine(id)!;
  }
  updateRoutine(id: string, patch: Partial<Routine>): Routine | undefined {
    const cur = this.getRoutine(id);
    if (!cur) return undefined;
    const r = { ...cur, ...patch };
    this.db.run(
      'UPDATE routines SET bot_id=?,room_id=?,name=?,cron=?,prompt=?,enabled=?,last_run_at=?,next_run_at=? WHERE id=?',
      r.botId, r.roomId, r.name, r.cron, r.prompt, r.enabled ? 1 : 0, r.lastRunAt, r.nextRunAt, id,
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
    };
  }
  listSkills(): Skill[] {
    return this.db.all('SELECT * FROM skills ORDER BY name').map((r) => this.rowToSkill(r));
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
  decideApproval(id: string, status: string) {
    this.db.run('UPDATE approvals SET status=?, decided_at=? WHERE id=?', status, now(), id);
  }

  // ---------- usage ----------
  recordUsage(u: {
    botId: string; roomId: string; turnId: string; causeId: string | null; costUsd: number; inputTokens: number;
    outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; modelUsage: unknown; durationMs: number;
  }) {
    this.db.run(
      'INSERT INTO usage (bot_id,room_id,turn_id,cause_id,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,model_usage,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      u.botId, u.roomId, u.turnId, u.causeId, u.costUsd, u.inputTokens, u.outputTokens, u.cacheReadTokens,
      u.cacheWriteTokens, JSON.stringify(u.modelUsage ?? null), u.durationMs, now(),
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
  usageTotals(where: { botId?: string; roomId?: string; causeId?: string } = {}): UsageTotals {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (where.botId) { conds.push('bot_id=?'); params.push(where.botId); }
    if (where.roomId) { conds.push('room_id=?'); params.push(where.roomId); }
    if (where.causeId) { conds.push('cause_id=?'); params.push(where.causeId); }
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
}
