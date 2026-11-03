import { nanoid } from 'nanoid';
import type { TrainingProposal, TrainingStatus } from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

/** Most rows one evidence query reads, per source. The evidence cap is far smaller. */
const EVIDENCE_ROWS = 200;

export type StoredTrainingProposal = TrainingProposal & { headingAdded: boolean };

export interface DeclinedApproval { roomId: string; toolName: string; toolInput: string; reason: string; status: 'deny' | 'timeout'; at: number }
export interface FailedTurn { roomId: string; text: string; at: number }
export interface OwnerReply { botText: string; text: string; at: number }

/** Storage for the bot training pilot, in a file of its own like db/skillVersions.ts. */
export class TrainingRepo {
  constructor(private db: Db, private now: () => number = Date.now) {}

  config(botId: string): { enabled: boolean; lastRunAt: number | null } {
    const r = this.db.get('SELECT * FROM training_config WHERE bot_id=?', botId);
    return { enabled: !!r?.enabled, lastRunAt: (r?.last_run_at as number) ?? null };
  }
  setEnabled(botId: string, enabled: boolean) {
    this.db.run(
      'INSERT INTO training_config (bot_id,enabled) VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET enabled=excluded.enabled',
      botId, enabled ? 1 : 0,
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
  insert(p: { botId: string; status: 'pending' | 'blocked'; rule: string; reason: string; evidenceSummary: string; verifierNote: string }): StoredTrainingProposal {
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO training_proposals (id,bot_id,status,rule,reason,evidence_summary,verifier_note,created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, p.botId, p.status, p.rule, p.reason, p.evidenceSummary, p.verifierNote, this.now(),
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

  // ---- evidence, always a window (since, until] ----
  /** Cards the owner denied or that timed out. `expired` is left out: that is the hub restarting, not the bot failing. */
  declinedApprovals(botId: string, since: number, until: number): DeclinedApproval[] {
    return this.db.all<{ room_id: string; tool_name: string; tool_input: string | null; reason: string | null; status: 'deny' | 'timeout'; decided_at: number }>(
      "SELECT room_id, tool_name, tool_input, reason, status, decided_at FROM approvals WHERE bot_id=? AND status IN ('deny','timeout') AND decided_at>? AND decided_at<=? ORDER BY decided_at DESC LIMIT ?",
      botId, since, until, EVIDENCE_ROWS,
    ).map((r) => ({ roomId: r.room_id, toolName: r.tool_name, toolInput: r.tool_input ?? '', reason: r.reason ?? '', status: r.status, at: r.decided_at }));
  }
  /** The note BotRunner posts when a turn ends in an error: `<name> turn ended: <error>`. */
  failedTurns(botId: string, since: number, until: number): FailedTurn[] {
    return this.db.all<{ room_id: string; text: string; created_at: number }>(
      "SELECT room_id, text, created_at FROM messages WHERE author_type='system' AND author_id=? AND kind='system' AND turn_id IS NOT NULL AND text LIKE '% turn ended: %' AND created_at>? AND created_at<=? ORDER BY created_at DESC LIMIT ?",
      botId, since, until, EVIDENCE_ROWS,
    ).map((r) => ({ roomId: r.room_id, text: r.text, at: r.created_at }));
  }
  /** The owner's messages in one room whose last non-owner message was this bot's, with that message. */
  ownerReplies(roomId: string, botId: string, since: number, until: number): OwnerReply[] {
    return this.db.all<{ text: string; created_at: number; prev_type: string | null; prev_author: string | null; prev_text: string | null }>(
      'SELECT m.text, m.created_at, p.author_type prev_type, p.author_id prev_author, p.text prev_text FROM messages m ' +
        "LEFT JOIN messages p ON p.room_id=m.room_id AND p.seq=(SELECT MAX(x.seq) FROM messages x WHERE x.room_id=m.room_id AND x.seq<m.seq AND x.author_type<>'user' AND x.kind IN ('text','handoff','routine','trigger')) " +
        "WHERE m.room_id=? AND m.author_type='user' AND m.kind='text' AND m.created_at>? AND m.created_at<=? ORDER BY m.seq DESC LIMIT ?",
      roomId, since, until, EVIDENCE_ROWS,
    )
      .filter((r) => r.prev_type === 'bot' && r.prev_author === botId)
      .map((r) => ({ botText: r.prev_text ?? '', text: r.text, at: r.created_at }));
  }
}
