import { nanoid } from 'nanoid';
import type {
  Trigger, TriggerEvent, TriggerFire, TriggerFireStatus, TriggerInput, TriggerPollStatus, TriggerSource,
} from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

/** A stored event (P5). `payload` is the normalised TriggerEvent: ids and text, never request headers. */
export interface InboxRow {
  id: string;
  source: TriggerSource;
  pollKey: string;
  dedupeKey: string;
  event: TriggerEvent;
  status: 'new' | 'matched' | 'ignored';
  seenAt: number;
}

/** Cursor and schedule state of one poll stream. */
export interface CursorRow {
  key: string;
  source: TriggerSource;
  cursor: string | null;
  etag: string | null;
  lastPolledAt: number | null;
  nextPollAt: number | null;
  failures: number;
  lastError: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Rows behind triggers, the events inbox, fires and poll cursors (migrations 50–53). */
export class TriggerRepo {
  constructor(private db: Db) {}

  // ---------------------------------------------------------------- triggers
  private toTrigger(r: Row): Trigger {
    return {
      id: r.id as string, name: r.name as string, enabled: !!r.enabled, source: r.source as TriggerSource,
      filter: JSON.parse((r.filter_json as string) || '{}'), botId: r.bot_id as string, roomId: r.room_id as string,
      prompt: r.prompt as string, maxPerHour: r.max_per_hour as number, budgetUsd: r.budget_usd as number,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number, lastFiredAt: (r.last_fired_at as number) ?? null,
    };
  }
  list(): Trigger[] {
    return this.db.all('SELECT * FROM triggers ORDER BY created_at').map((r) => this.toTrigger(r));
  }
  get(id: string): Trigger | undefined {
    const r = this.db.get('SELECT * FROM triggers WHERE id=?', id);
    return r ? this.toTrigger(r) : undefined;
  }
  create(i: TriggerInput, now = Date.now()): Trigger {
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO triggers (id, name, enabled, source, filter_json, bot_id, room_id, prompt, max_per_hour, budget_usd, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, i.name, i.enabled ? 1 : 0, i.source, JSON.stringify(cleanFilter(i.filter)), i.botId, i.roomId, i.prompt, i.maxPerHour, i.budgetUsd, now, now,
    );
    return this.get(id)!;
  }
  update(id: string, p: Partial<TriggerInput>, now = Date.now()): Trigger | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const n = { ...cur, ...p, filter: p.filter ? cleanFilter(p.filter) : cur.filter };
    this.db.run(
      'UPDATE triggers SET name=?, enabled=?, source=?, filter_json=?, bot_id=?, room_id=?, prompt=?, max_per_hour=?, budget_usd=?, updated_at=? WHERE id=?',
      n.name, n.enabled ? 1 : 0, n.source, JSON.stringify(n.filter), n.botId, n.roomId, n.prompt, n.maxPerHour, n.budgetUsd, now, id,
    );
    return this.get(id);
  }
  delete(id: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM trigger_fires WHERE trigger_id=?', id);
      this.db.run('DELETE FROM triggers WHERE id=?', id);
    });
  }
  touchFired(id: string, at: number) {
    this.db.run('UPDATE triggers SET last_fired_at=? WHERE id=?', at, id);
  }

  // ---------------------------------------------------------------- inbox
  private toInbox(r: Row): InboxRow {
    return {
      id: r.id as string, source: r.source as TriggerSource, pollKey: r.poll_key as string, dedupeKey: r.dedupe_key as string,
      event: JSON.parse(r.payload as string), status: r.status as InboxRow['status'], seenAt: r.seen_at as number,
    };
  }
  /** Stores an event once. Returns the new row, or null when its dedupe key was seen before. */
  addEvent(pollKey: string, dedupeKey: string, event: TriggerEvent, now = Date.now()): InboxRow | null {
    const id = nanoid(12);
    const r = this.db.run(
      "INSERT INTO events_inbox (id, source, poll_key, dedupe_key, payload, status, seen_at) VALUES (?,?,?,?,?,'new',?) ON CONFLICT(dedupe_key) DO NOTHING",
      id, event.source, pollKey, dedupeKey, JSON.stringify(event), now,
    );
    if (!Number(r.changes)) return null;
    return { id, source: event.source, pollKey, dedupeKey, event, status: 'new', seenAt: now };
  }
  /** Events stored but never matched (the hub stopped in between). */
  pendingEvents(): InboxRow[] {
    return this.db.all("SELECT * FROM events_inbox WHERE status='new' ORDER BY seen_at").map((r) => this.toInbox(r));
  }
  markEvent(id: string, status: 'matched' | 'ignored', now = Date.now()) {
    this.db.run('UPDATE events_inbox SET status=?, processed_at=? WHERE id=?', status, now, id);
  }
  inboxCount(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events_inbox')?.n ?? 0;
  }
  /** Keep the inbox from growing forever; dedupe only needs to outlive a provider's replay window. */
  pruneInbox(olderThan: number): number {
    return Number(this.db.run("DELETE FROM events_inbox WHERE status != 'new' AND seen_at < ?", olderThan).changes);
  }

  // ---------------------------------------------------------------- fires
  private toFire(r: Row): TriggerFire {
    return {
      id: r.id as string, triggerId: r.trigger_id as string, eventId: (r.event_id as string) ?? null, title: (r.title as string) ?? '',
      status: r.status as TriggerFireStatus, note: (r.note as string) ?? null, messageId: (r.message_id as string) ?? null,
      costUsd: (r.cost_usd as number) ?? null, test: !!r.test, startedAt: r.started_at as number, endedAt: (r.ended_at as number) ?? null,
    };
  }
  addFire(f: { triggerId: string; eventId: string | null; title: string; status: TriggerFireStatus; note?: string | null; test?: boolean }, now = Date.now()): TriggerFire {
    const id = nanoid(10);
    const ended = f.status === 'running' ? null : now;
    this.db.run(
      'INSERT INTO trigger_fires (id, trigger_id, event_id, title, status, note, test, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, f.triggerId, f.eventId, f.title.slice(0, 200), f.status, f.note ?? null, f.test ? 1 : 0, now, ended,
    );
    return this.getFire(id)!;
  }
  getFire(id: string): TriggerFire | undefined {
    const r = this.db.get('SELECT * FROM trigger_fires WHERE id=?', id);
    return r ? this.toFire(r) : undefined;
  }
  setFireMessage(id: string, messageId: string) {
    this.db.run('UPDATE trigger_fires SET message_id=? WHERE id=?', messageId, id);
  }
  finishFire(id: string, status: TriggerFireStatus, costUsd: number | null, note: string | null = null, now = Date.now()) {
    this.db.run('UPDATE trigger_fires SET status=?, cost_usd=?, note=COALESCE(?, note), ended_at=? WHERE id=?', status, costUsd, note, now, id);
  }
  listFires(triggerId: string, limit = 20): TriggerFire[] {
    return this.db.all('SELECT * FROM trigger_fires WHERE trigger_id=? ORDER BY started_at DESC LIMIT ?', triggerId, limit).map((r) => this.toFire(r));
  }
  runningFires(): TriggerFire[] {
    return this.db.all("SELECT * FROM trigger_fires WHERE status='running'").map((r) => this.toFire(r));
  }
  /** Fires that started a turn (not skipped) in the last hour: the rate limit counts these. */
  firesLastHour(triggerId: string, now = Date.now()): number {
    return this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM trigger_fires WHERE trigger_id=? AND status != 'skipped' AND started_at >= ?", triggerId, now - HOUR,
    )?.n ?? 0;
  }
  /**
   * What this trigger's threads spent in the last 24 hours, read live from `usage` by cause, so the hops a
   * trigger turn causes count against the trigger too.
   */
  spentLastDay(triggerId: string, now = Date.now()): number {
    return this.db.get<{ c: number | null }>(
      'SELECT SUM(u.cost_usd) AS c FROM usage u JOIN trigger_fires f ON u.cause_id = f.message_id WHERE f.trigger_id=? AND f.started_at >= ?',
      triggerId, now - DAY,
    )?.c ?? 0;
  }

  // ---------------------------------------------------------------- cursors
  private toCursor(r: Row): CursorRow {
    return {
      key: r.key as string, source: r.source as TriggerSource, cursor: (r.cursor as string) ?? null, etag: (r.etag as string) ?? null,
      lastPolledAt: (r.last_polled_at as number) ?? null, nextPollAt: (r.next_poll_at as number) ?? null,
      failures: (r.failures as number) ?? 0, lastError: (r.last_error as string) ?? null,
    };
  }
  cursor(key: string): CursorRow | undefined {
    const r = this.db.get('SELECT * FROM trigger_cursors WHERE key=?', key);
    return r ? this.toCursor(r) : undefined;
  }
  cursors(): CursorRow[] {
    return this.db.all('SELECT * FROM trigger_cursors ORDER BY key').map((r) => this.toCursor(r));
  }
  saveCursor(c: CursorRow) {
    this.db.run(
      `INSERT INTO trigger_cursors (key, source, cursor, etag, last_polled_at, next_poll_at, failures, last_error) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET source=excluded.source, cursor=excluded.cursor, etag=excluded.etag, last_polled_at=excluded.last_polled_at,
       next_poll_at=excluded.next_poll_at, failures=excluded.failures, last_error=excluded.last_error`,
      c.key, c.source, c.cursor, c.etag, c.lastPolledAt, c.nextPollAt, c.failures, c.lastError,
    );
  }
  pollStatus(keys: string[]): TriggerPollStatus[] {
    const want = new Set(keys);
    return this.cursors().filter((c) => want.has(c.key)).map((c) => ({
      key: c.key, source: c.source, lastPolledAt: c.lastPolledAt, nextPollAt: c.nextPollAt, failures: c.failures, lastError: c.lastError,
    }));
  }
}

/** Drop empty filter values so "" never means "must contain nothing". */
function cleanFilter(f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f ?? {})) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  return out;
}
