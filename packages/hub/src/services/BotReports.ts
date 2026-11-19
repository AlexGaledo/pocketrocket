import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { DATA_DIR } from '../config.js';
import type { Db } from '../db/db.js';

export const REPORT_KINDS = ['captcha', 'login', 'blocked', 'other'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const MAX_REPORTS_PER_HOUR = 10;
export const MAX_FEEDBACK_BYTES = 2000;

export interface BotReport {
  id: string; botId: string; roomId: string | null; kind: ReportKind; site: string; reason: string;
  status: 'pending' | 'resolved' | 'dismissed'; createdAt: number;
}
export class ReportLimited extends Error {}

/**
 * G5: what a bot says about itself. A blocked-site report is a row the owner can review; feedback is appended to a
 * local file. Both are rate limited per bot and stay on this machine.
 */
export class BotReports {
  constructor(private db: Db, private file: string = path.join(DATA_DIR, 'feedback.jsonl'), private now: () => number = Date.now) {}

  private limit(botId: string, type: 'blocked' | 'feedback') {
    const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bot_reports WHERE bot_id=? AND type=? AND created_at>?', botId, type, this.now() - 3_600_000)?.n ?? 0;
    if (n >= MAX_REPORTS_PER_HOUR) throw new ReportLimited('Rate limit: at most ' + MAX_REPORTS_PER_HOUR + ' of these per hour. Try again later.');
  }

  reportBlocked(botId: string, roomId: string, i: { site: string; reason: string; kind: ReportKind }): BotReport {
    this.limit(botId, 'blocked');
    const id = nanoid(10);
    this.db.run("INSERT INTO bot_reports (id,bot_id,room_id,type,kind,site,reason,status,created_at) VALUES (?,?,?,'blocked',?,?,?,'pending',?)", id, botId, roomId, i.kind, i.site, i.reason, this.now());
    return this.getReport(id)!;
  }
  private rowToReport(r: Record<string, unknown>): BotReport {
    return { id: r.id as string, botId: r.bot_id as string, roomId: (r.room_id as string) ?? null, kind: r.kind as ReportKind, site: (r.site as string) ?? '', reason: (r.reason as string) ?? '', status: r.status as BotReport['status'], createdAt: r.created_at as number };
  }
  getReport(id: string): BotReport | undefined {
    const r = this.db.get("SELECT * FROM bot_reports WHERE id=? AND type='blocked'", id);
    return r && this.rowToReport(r);
  }
  listReports(status?: BotReport['status']): BotReport[] {
    return this.db
      .all("SELECT * FROM bot_reports WHERE type='blocked'" + (status ? ' AND status=?' : '') + ' ORDER BY created_at DESC LIMIT 200', ...(status ? [status] : []))
      .map((r) => this.rowToReport(r));
  }
  setStatus(id: string, status: 'resolved' | 'dismissed' | 'pending'): BotReport | undefined {
    this.db.run("UPDATE bot_reports SET status=? WHERE id=? AND type='blocked'", status, id);
    return this.getReport(id);
  }

  addFeedback(botId: string, text: string): void {
    this.limit(botId, 'feedback');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ at: this.now(), botId, text }) + '\n');
    this.db.run("INSERT INTO bot_reports (id,bot_id,type,status,created_at) VALUES (?,?,'feedback','resolved',?)", nanoid(10), botId, this.now());
  }
  /** Newest last, at most `limit` entries. */
  readFeedback(limit = 200): { at: number; botId: string; text: string }[] {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out: { at: number; botId: string; text: string }[] = [];
    for (const l of raw.split('\n')) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* torn line */ }
    }
    return out.slice(-Math.min(limit, 1000));
  }
}
