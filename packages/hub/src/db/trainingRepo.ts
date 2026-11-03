import { nanoid } from 'nanoid';
import { TURN_FAILURE_BEHAVIOUR, type TrainingProposal, type TrainingStatus } from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

/** Most rows one evidence query reads, per source. The evidence cap is far smaller. */
const EVIDENCE_ROWS = 200;

export type StoredTrainingProposal = TrainingProposal & {
  headingAdded: boolean;
  /** The description just before this rule was approved. A record: undo does not restore it. */
  descriptionBefore: string | null;
  /** Blocked only because the verifier never judged it. */
  retry: boolean;
};

export interface DeclinedApproval { toolName: string; toolInput: string; reason: string; status: 'deny' | 'timeout'; at: number }
export interface FailedTurn { text: string; at: number }
export interface OwnerReply { botText: string; text: string; at: number }

/** Storage for the bot training pilot, in a file of its own like db/skillVersions.ts. */
export class TrainingRepo {
  constructor(private db: Db, private now: () => number = Date.now) {}

  config(botId: string): { enabled: boolean; lastRunAt: number | null; windowStart: number | null } {
    const r = this.db.get('SELECT * FROM training_config WHERE bot_id=?', botId);
    return { enabled: !!r?.enabled, lastRunAt: (r?.last_run_at as number) ?? null, windowStart: (r?.window_start as number) ?? null };
  }
  /** Switching on starts the evidence window now, so nothing from before opt-in or from while it was off is read. */
  setEnabled(botId: string, enabled: boolean) {
    this.db.run(
      'INSERT INTO training_config (bot_id,enabled,window_start) VALUES (?,?,?) ON CONFLICT(bot_id) DO UPDATE SET ' +
        'window_start=CASE WHEN enabled=0 AND excluded.enabled=1 THEN excluded.window_start ELSE window_start END, enabled=excluded.enabled',
      botId, enabled ? 1 : 0, this.now(),
    );
  }
  setLastRun(botId: string, at: number) {
    this.db.run('UPDATE training_config SET last_run_at=? WHERE bot_id=?', at, botId);
  }
  enabledBotIds(): string[] {
    return this.db.all<{ bot_id: string }>('SELECT bot_id FROM training_config WHERE enabled=1 ORDER BY bot_id').map((r) => r.bot_id);
  }

  private toProposal(r: Row): StoredTrainingProposal {
    return {
      id: r.id as string,
      botId: r.bot_id as string,
      status: r.status as TrainingStatus,
      rule: r.rule as string,
      reason: r.reason as string,
      evidenceSummary: r.evidence_summary as string,
      verifierNote: r.verifier_note as string,
      descriptionBefore: (r.description_before as string) ?? null,
      createdAt: r.created_at as number,
      decidedAt: (r.decided_at as number) ?? null,
      undoneAt: (r.undone_at as number) ?? null,
      headingAdded: !!r.heading_added,
      retry: !!r.retry,
    };
  }
  /** Newest first. */
  list(botId: string): StoredTrainingProposal[] {
    return this.db.all('SELECT * FROM training_proposals WHERE bot_id=? ORDER BY created_at DESC, rowid DESC', botId).map((r) => this.toProposal(r));
  }
  get(id: string): StoredTrainingProposal | undefined {
    const r = this.db.get('SELECT * FROM training_proposals WHERE id=?', id);
    return r && this.toProposal(r);
  }
  pendingCount(botId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM training_proposals WHERE bot_id=? AND status='pending'", botId)?.n ?? 0;
  }
  insert(p: { botId: string; status: 'pending' | 'blocked'; rule: string; reason: string; evidenceSummary: string; verifierNote: string; retry?: boolean }): StoredTrainingProposal {
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO training_proposals (id,bot_id,status,rule,reason,evidence_summary,verifier_note,retry,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, p.botId, p.status, p.rule, p.reason, p.evidenceSummary, p.verifierNote, p.retry ? 1 : 0, this.now(),
    );
    return this.get(id)!;
  }
  markApproved(id: string, descriptionBefore: string, headingAdded: boolean) {
    this.db.run("UPDATE training_proposals SET status='approved', decided_at=?, description_before=?, heading_added=? WHERE id=?", this.now(), descriptionBefore, headingAdded ? 1 : 0, id);
  }
  markRejected(id: string) {
    this.db.run("UPDATE training_proposals SET status='rejected', decided_at=? WHERE id=?", this.now(), id);
  }
  markUndone(id: string) {
    this.db.run("UPDATE training_proposals SET status='undone', undone_at=?, heading_added=0 WHERE id=?", this.now(), id);
  }
  /** The owner removed this rule's old line and now approved it again: the new row is the one that counts. */
  supersede(botId: string, rule: string, keepId: string) {
    this.db.run("UPDATE training_proposals SET status='undone', undone_at=?, heading_added=0 WHERE bot_id=? AND rule=? AND status='approved' AND id<>?", this.now(), botId, rule, keepId);
  }
  /** A finished pass replaces rows that were only waiting for a retry. */
  clearRetries(botId: string) {
    this.db.run('DELETE FROM training_proposals WHERE bot_id=? AND retry=1', botId);
  }
  /** The heading outlives the rule that added it: another approved rule of this bot takes over owning it. */
  passHeading(botId: string, fromId: string) {
    this.db.run(
      "UPDATE training_proposals SET heading_added=1 WHERE id=(SELECT id FROM training_proposals WHERE bot_id=? AND status='approved' AND id<>? ORDER BY created_at DESC, rowid DESC LIMIT 1)",
      botId, fromId,
    );
  }
  /** What this bot's training passes spent since `since` (epoch ms), read from the usage table. */
  spend(botId: string, since: number): number {
    return this.db.get<{ c: number }>("SELECT COALESCE(SUM(cost_usd),0) c FROM usage WHERE bot_id=? AND cause_kind='training' AND created_at>=?", botId, since)?.c ?? 0;
  }
  prune(botIds: string[]) {
    const keep = new Set(botIds);
    for (const r of this.db.all<{ bot_id: string }>('SELECT bot_id FROM training_config UNION SELECT bot_id FROM training_proposals')) {
      if (keep.has(r.bot_id)) continue;
      this.db.run('DELETE FROM training_config WHERE bot_id=?', r.bot_id);
      this.db.run('DELETE FROM training_proposals WHERE bot_id=?', r.bot_id);
    }
  }

  // ---- evidence, always a window (since, until], only from the bot's current rooms, filtered before the LIMIT ----
  /**
   * Cards the owner denied, and cards that timed out. A `deny` no person gave (the turn was stopped or the hub shut
   * down) and `expired` (the hub restarted) say nothing about the bot.
   */
  declinedApprovals(botId: string, since: number, until: number): DeclinedApproval[] {
    return this.db.all<{ tool_name: string; tool_input: string | null; reason: string | null; status: 'deny' | 'timeout'; decided_at: number }>(
      'SELECT tool_name, tool_input, reason, status, decided_at FROM approvals ' +
        "WHERE bot_id=? AND (status='timeout' OR (status='deny' AND decided_by='owner')) AND decided_at>? AND decided_at<=? " +
        'AND room_id IN (SELECT room_id FROM room_members WHERE bot_id=?) ORDER BY decided_at DESC LIMIT ?',
      botId, since, until, botId, EVIDENCE_ROWS,
    ).map((r) => ({ toolName: r.tool_name, toolInput: r.tool_input ?? '', reason: r.reason ?? '', status: r.status, at: r.decided_at }));
  }
  /** Notes marked by agent/turnFailure.ts as a failure of the bot's own making. */
  failedTurns(botId: string, since: number, until: number): FailedTurn[] {
    return this.db.all<{ text: string; created_at: number }>(
      "SELECT text, created_at FROM messages WHERE author_type='system' AND author_id=? AND kind='system' AND json_extract(payload, '$.turnFailure')=? " +
        'AND created_at>? AND created_at<=? AND room_id IN (SELECT room_id FROM room_members WHERE bot_id=?) ORDER BY created_at DESC LIMIT ?',
      botId, TURN_FAILURE_BEHAVIOUR, since, until, botId, EVIDENCE_ROWS,
    ).map((r) => ({ text: r.text, at: r.created_at }));
  }
  /** The owner's messages in one room whose last non-owner message was this bot's, with that message. */
  ownerReplies(roomId: string, botId: string, since: number, until: number): OwnerReply[] {
    return this.db.all<{ text: string; created_at: number; prev_text: string | null }>(
      'SELECT m.text, m.created_at, p.text prev_text FROM messages m ' +
        "JOIN messages p ON p.room_id=m.room_id AND p.seq=(SELECT MAX(x.seq) FROM messages x WHERE x.room_id=m.room_id AND x.seq<m.seq AND x.author_type<>'user' AND x.kind IN ('text','handoff','routine','trigger')) " +
        "WHERE m.room_id=? AND m.author_type='user' AND m.kind='text' AND m.created_at>? AND m.created_at<=? AND p.author_type='bot' AND p.author_id=? ORDER BY m.seq DESC LIMIT ?",
      roomId, since, until, botId, EVIDENCE_ROWS,
    ).map((r) => ({ botText: r.prev_text ?? '', text: r.text, at: r.created_at }));
  }
}
