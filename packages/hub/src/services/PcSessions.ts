import {
  PC_ENTRY_TEXT_CAPS,
  PC_LIVE_MS,
  PC_MIRROR_MAX_BYTES,
  PC_MIRROR_RETENTION_DAYS,
  PC_SESSION_MAX_TEXT_BYTES,
  type PcEntry,
  type PcRepo,
  type PcSessionDetail,
  type PcSessionLink,
  type PcSessionMove,
  type PcSessionPut,
  type PcSessionSummary,
  type PcStoredEntry,
} from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import { events } from '../events.js';
import { redact } from '../providers/redact.js';

/**
 * The PC session mirror (spec docs/specs/claude-code-bridge.md 3.1). The runner on the owner's PC sends compact
 * entries of its Claude Code transcripts; this stores them for the owner's app.
 *
 * - Every text, title and path is run through `redact()` before it is stored, and capped again here whatever the
 *   runner claims to have done.
 * - A session holds at most 5 MB of entry text (more is dropped and the session flagged `truncated`), the whole
 *   mirror 400 MB and 90 days (`prune`, oldest `last_at` first).
 * - `offset` is the byte position in the source file the hub has consumed. A batch must start there: anything else
 *   is a stale resend and gets `{ conflict: true, offset }` so the runner resumes from the right place. A resent
 *   batch whose offset is right but whose uuids are known does not duplicate (unique on session + uuid).
 *
 * Visibility (layer 1): `api/pcSessions.ts` (owner routes) and the three read-only @persona tools (through this service) read
 * these tables. No other bot tool, history search, recall, room transcript or MCP route touches them; `pcSessions.test.ts` pins that.
 */

/** Longest a cut text may run past its cap: the " …[cut N chars]" tail the runner appends itself. */
const CUT_TAIL_ALLOWANCE = 40;
const DAY_MS = 24 * 60 * 60_000;
/** A session's `pc_session_updated` is sent at most this often. */
export const PC_EVENT_COALESCE_MS = 2000;

export interface PcSessionsOptions {
  now?: () => number;
  maxTotalBytes?: number;
  retentionDays?: number;
  maxSessionBytes?: number;
}

export type AppendResult =
  | { ok: true; offset: number; stored: number; truncated: boolean }
  | { ok: false; conflict: true; offset: number }
  | { ok: false; conflict: false; notFound: true };

type Row = Record<string, unknown>;

export class PcSessions {
  private now: () => number;
  private maxTotalBytes: number;
  private retentionMs: number;
  private maxSessionBytes: number;
  private pending = new Map<string, { lastSent: number; timer: NodeJS.Timeout | null; lastAt: number }>();
  /** Which project repos a session's repo belongs to (ProjectService.linksFor); set by the hub. Without it no session has links. */
  linker: ((repo: PcRepo | null) => PcSessionLink[]) | null = null;
  /** Bridge P6: where a moved session is (SessionMoves.summary); set by the hub. Without it no session has a move. */
  mover: ((id: string) => PcSessionMove | null) | null = null;
  /** Bridge P6: true while the session is moving, on the VPS or pulling (SessionMoves.locked). The runner reads it as `onVps`. */
  locked: ((id: string) => boolean) | null = null;

  constructor(private db: Db, opts: PcSessionsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxTotalBytes = opts.maxTotalBytes ?? PC_MIRROR_MAX_BYTES;
    this.retentionMs = (opts.retentionDays ?? PC_MIRROR_RETENTION_DAYS) * DAY_MS;
    this.maxSessionBytes = opts.maxSessionBytes ?? PC_SESSION_MAX_TEXT_BYTES;
  }

  /** Cancels pending event timers (shutdown). */
  stop(): void {
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
  }

  // ---- runner side ----

  /** `{ [id]: { offset } }` for every session the hub holds. */
  syncState(): Record<string, { offset: number; onVps: boolean }> {
    const out: Record<string, { offset: number; onVps: boolean }> = {};
    for (const r of this.db.all<Row>('SELECT id, offset FROM pc_sessions')) out[r.id as string] = { offset: r.offset as number, onVps: this.locked?.(r.id as string) ?? false };
    return out;
  }

  /** Creates or updates a session's metadata and returns the resume offset (0 for a new one). */
  upsert(id: string, m: PcSessionPut): { offset: number } {
    const repoJson = m.repo ? JSON.stringify(cleanRepo(m.repo)) : null;
    const title = m.title ? redact(m.title) : null;
    const cwd = m.cwd ? redact(m.cwd) : null;
    const projectDir = redact(m.projectDir);
    const existing = this.db.get<Row>('SELECT offset, first_at FROM pc_sessions WHERE id = ?', id);
    if (!existing) {
      this.db.run(
        'INSERT INTO pc_sessions (id, parent_id, machine, project_dir, cwd, repo_json, title, first_at, last_at, offset, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)',
        id, m.parentId ?? null, m.machine, projectDir, cwd, repoJson, title, m.firstAt, m.lastAt, this.now(),
      );
      return { offset: 0 };
    }
    this.db.run(
      'UPDATE pc_sessions SET parent_id = ?, machine = ?, project_dir = ?, cwd = ?, repo_json = ?, title = COALESCE(?, title), first_at = MIN(first_at, ?), last_at = MAX(last_at, ?) WHERE id = ?',
      m.parentId ?? null, m.machine, projectDir, cwd, repoJson, title, m.firstAt, m.lastAt, id,
    );
    return { offset: existing.offset as number };
  }

  /** Stores a batch. See the class comment for the offset rule. */
  appendEntries(id: string, from: number, to: number, entries: readonly PcEntry[]): AppendResult {
    const s = this.db.get<Row>('SELECT offset FROM pc_sessions WHERE id = ?', id);
    if (!s) return { ok: false, conflict: false, notFound: true };
    const offset = s.offset as number;
    if (from !== offset) return { ok: false, conflict: true, offset };
    const r = this.store(id, entries, null, to);
    if (r.stored > 0) this.notify(id, r.lastAt);
    return { ok: true, offset: to, stored: r.stored, truncated: r.truncated };
  }

  /**
   * Bridge P6: entries the hub itself read from a session's file on the VPS. They are stored like the PC's (redacted,
   * capped) and marked with their machine; the PC's byte offset is not touched.
   */
  appendServerEntries(id: string, machine: string | null, entries: readonly PcEntry[]): { stored: number } | null {
    if (!this.db.get('SELECT 1 AS x FROM pc_sessions WHERE id = ?', id)) return null;
    const r = this.store(id, entries, machine, null);
    if (r.stored > 0) this.notify(id, r.lastAt);
    return { stored: r.stored };
  }

  /**
   * A batch for a session that is on the VPS: the offset rule applies as for appendEntries, but nothing is stored (the VPS
   * copy of the file is the live one) and the offset moves on so the runner does not resend it.
   */
  skipEntries(id: string, from: number, to: number): AppendResult {
    const s = this.db.get<Row>('SELECT offset FROM pc_sessions WHERE id = ?', id);
    if (!s) return { ok: false, conflict: false, notFound: true };
    if (from !== (s.offset as number)) return { ok: false, conflict: true, offset: s.offset as number };
    this.setOffset(id, to);
    return { ok: true, offset: to, stored: 0, truncated: false };
  }

  /** Moves the consumed-bytes mark without storing anything: the PC's appends to a session that is on the VPS are dropped, and a pull resets it to the pulled file's size. */
  setOffset(id: string, offset: number): void {
    this.db.run('UPDATE pc_sessions SET offset = ? WHERE id = ?', Math.max(0, Math.trunc(offset)), id);
  }

  /** Tells the app at once that this session changed (a move state change, a VPS turn starting or finishing). */
  touch(id: string): void {
    const r = this.db.get<{ last_at: number }>('SELECT last_at FROM pc_sessions WHERE id = ?', id);
    if (r) events.emitEvent({ type: 'pc_session_updated', id, lastAt: r.last_at });
  }

  private store(id: string, entries: readonly PcEntry[], machine: string | null, newOffset: number | null): { stored: number; truncated: boolean; lastAt: number } {
    const s = this.db.get<Row>('SELECT bytes, truncated, last_at FROM pc_sessions WHERE id = ?', id)!;
    let bytes = s.bytes as number;
    let truncated = (s.truncated as number) === 1;
    let lastAt = s.last_at as number;
    let stored = 0;
    this.db.tx(() => {
      let seq = this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM pc_session_entries WHERE session_id = ?', id)?.m ?? 0;
      const ins = this.db.raw.prepare(
        'INSERT OR IGNORE INTO pc_session_entries (session_id, seq, uuid, parent_uuid, at, kind, text, tool, is_error, is_sidechain, model, machine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const e of entries) {
        const text = capText(redact(e.text), PC_ENTRY_TEXT_CAPS[e.kind]);
        const size = Buffer.byteLength(text, 'utf8');
        if (bytes + size > this.maxSessionBytes) {
          truncated = true;
          continue;
        }
        const r = ins.run(
          id, seq + 1, e.uuid, e.parentUuid ?? null, Math.trunc(e.at), e.kind, text, e.tool ? redact(e.tool) : null,
          e.isError ? 1 : 0, e.isSidechain ? 1 : 0, e.model ?? null, machine,
        );
        if (Number(r.changes) === 0) continue; // a resent uuid
        seq++;
        stored++;
        bytes += size;
        if (e.at > lastAt) lastAt = Math.trunc(e.at);
      }
      this.db.run(
        'UPDATE pc_sessions SET offset = COALESCE(?, offset), bytes = ?, truncated = ?, last_at = ?, entry_count = (SELECT COUNT(*) FROM pc_session_entries WHERE session_id = ?) WHERE id = ?',
        newOffset, bytes, truncated ? 1 : 0, lastAt, id, id,
      );
    });
    return { stored, truncated, lastAt };
  }

  // ---- owner side ----

  list(o: { repo?: string; q?: string; limit?: number; before?: number; project?: string } = {}): PcSessionSummary[] {
    const where: string[] = ['(s.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM pc_sessions p WHERE p.id = s.parent_id))'];
    const args: unknown[] = [];
    if (o.repo) {
      where.push("LOWER(COALESCE(json_extract(s.repo_json, '$.name'), '')) = LOWER(?)");
      args.push(o.repo);
    }
    if (o.q) {
      const like = '%' + o.q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      where.push(
        "(s.title LIKE ? ESCAPE '\\' OR s.cwd LIKE ? ESCAPE '\\' OR json_extract(s.repo_json, '$.name') LIKE ? ESCAPE '\\')",
      );
      args.push(like, like, like);
    }
    if (o.before !== undefined && Number.isFinite(o.before)) {
      where.push('s.last_at < ?');
      args.push(o.before);
    }
    const limit = Math.max(1, Math.min(200, Math.trunc(o.limit ?? 50)));
    // Links are computed at read, so a project filter reads wider than `limit` and cuts after.
    const rows = this.db.all<Row>('SELECT s.* FROM pc_sessions s WHERE ' + where.join(' AND ') + ' ORDER BY s.last_at DESC, s.id LIMIT ?', ...args, o.project ? 2000 : limit);
    const all = rows.map((r) => this.summary(r));
    return o.project ? all.filter((s) => s.links.some((l) => l.project === o.project)).slice(0, limit) : all;
  }

  get(id: string): PcSessionDetail | null {
    const r = this.db.get<Row>('SELECT * FROM pc_sessions WHERE id = ?', id);
    if (!r) return null;
    const children = this.db
      .all<Row>('SELECT * FROM pc_sessions WHERE parent_id = ? ORDER BY first_at, id', id)
      .map((c) => this.summary(c));
    return { ...this.summary(r), children };
  }

  /** Entries with `seq > after`, ascending; `more` when another page follows. Null for an unknown session. */
  entries(id: string, after = 0, limit = 200): { entries: PcStoredEntry[]; more: boolean } | null {
    if (!this.db.get('SELECT 1 AS x FROM pc_sessions WHERE id = ?', id)) return null;
    const n = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.all<Row>(
      'SELECT * FROM pc_session_entries WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      id, Math.max(0, Math.trunc(after)), n + 1,
    );
    return { entries: rows.slice(0, n).map(toEntry), more: rows.length > n };
  }

  /** Deletes the session and its subagent children. False when it was not there. */
  delete(id: string): boolean {
    if (!this.db.get('SELECT 1 AS x FROM pc_sessions WHERE id = ?', id)) return false;
    this.db.tx(() => this.deleteTree(id, true));
    return true;
  }

  /**
   * Drops sessions past the retention window, then the oldest (by `last_at`) until the whole mirror is under its byte
   * cap. A session goes with its children. Returns how many sessions were removed.
   */
  prune(): { removed: number } {
    let removed = 0;
    this.db.tx(() => {
      const cutoff = this.now() - this.retentionMs;
      for (const r of this.db.all<{ id: string }>('SELECT id FROM pc_sessions WHERE last_at < ?', cutoff)) {
        if (this.db.get('SELECT 1 AS x FROM pc_sessions WHERE id = ?', r.id)) removed += this.deleteTree(r.id);
      }
      let total = this.db.get<{ t: number | null }>('SELECT SUM(bytes) AS t FROM pc_sessions')?.t ?? 0;
      while (total > this.maxTotalBytes) {
        const oldest = this.db.get<{ id: string }>('SELECT id FROM pc_sessions ORDER BY last_at, id LIMIT 1');
        if (!oldest) break;
        removed += this.deleteTree(oldest.id);
        total = this.db.get<{ t: number | null }>('SELECT SUM(bytes) AS t FROM pc_sessions')?.t ?? 0;
      }
    });
    return { removed };
  }

  // ---- internals ----

  /**
   * Whether the runner may (re)create this session. An owner delete holds for good; a prune holds until the session
   * shows activity newer than the prune, so a resumed old session comes back but an untouched one does not churn.
   */
  refused(id: string, lastAt: number): boolean {
    const t = this.db.get<{ deleted_at: number; by_owner: number }>('SELECT deleted_at, by_owner FROM pc_session_tombstones WHERE id = ?', id);
    if (!t) return false;
    if (t.by_owner || lastAt <= t.deleted_at) return true;
    this.db.run('DELETE FROM pc_session_tombstones WHERE id = ?', id);
    return false;
  }

  private deleteTree(id: string, byOwner = false): number {
    const ids = [id, ...this.db.all<{ id: string }>('SELECT id FROM pc_sessions WHERE parent_id = ?', id).map((c) => c.id)];
    const at = this.now();
    for (const x of ids) {
      this.db.run('DELETE FROM pc_session_entries WHERE session_id = ?', x);
      this.db.run('DELETE FROM pc_sessions WHERE id = ?', x);
      this.db.run(
        'INSERT INTO pc_session_tombstones (id, deleted_at, by_owner) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, by_owner = MAX(by_owner, excluded.by_owner)',
        x, at, byOwner ? 1 : 0,
      );
    }
    return ids.length;
  }

  private summary(r: Row): PcSessionSummary {
    let repo: PcRepo | null = null;
    try { repo = r.repo_json ? (JSON.parse(r.repo_json as string) as PcRepo) : null; } catch { /* hand-edited row */ }
    const lastAt = r.last_at as number;
    return {
      id: r.id as string,
      parentId: (r.parent_id as string) ?? null,
      machine: r.machine as string,
      projectDir: r.project_dir as string,
      cwd: (r.cwd as string) ?? null,
      repo,
      title: (r.title as string) ?? null,
      firstAt: r.first_at as number,
      lastAt,
      entryCount: r.entry_count as number,
      bytes: r.bytes as number,
      truncated: (r.truncated as number) === 1,
      status: this.now() - lastAt <= PC_LIVE_MS ? 'live' : 'ended',
      links: this.linker ? this.linker(repo) : [],
      move: this.mover ? this.mover(r.id as string) : null,
    };
  }

  /** One `pc_session_updated` per session per 2 s: the first goes out at once, the rest collapse into one at the end. */
  private notify(id: string, lastAt: number): void {
    const t = Date.now();
    const p = this.pending.get(id) ?? { lastSent: 0, timer: null, lastAt };
    p.lastAt = lastAt;
    this.pending.set(id, p);
    if (p.timer) return;
    const wait = p.lastSent + PC_EVENT_COALESCE_MS - t;
    if (wait <= 0) {
      p.lastSent = t;
      events.emitEvent({ type: 'pc_session_updated', id, lastAt });
      return;
    }
    p.timer = setTimeout(() => {
      p.timer = null;
      p.lastSent = Date.now();
      events.emitEvent({ type: 'pc_session_updated', id, lastAt: p.lastAt });
    }, wait);
    p.timer.unref();
  }
}

function toEntry(r: Row): PcStoredEntry {
  const e: PcStoredEntry = {
    seq: r.seq as number,
    uuid: r.uuid as string,
    parentUuid: (r.parent_uuid as string) ?? null,
    at: r.at as number,
    kind: r.kind as PcEntry['kind'],
    text: r.text as string,
  };
  if (r.tool) e.tool = r.tool as string;
  if (r.is_error) e.isError = true;
  if (r.is_sidechain) e.isSidechain = true;
  if (r.model) e.model = r.model as string;
  if (r.machine) e.machine = r.machine as string;
  return e;
}

/** Cuts text to `cap` characters (plus the marker) unless the runner already did. */
export function capText(text: string, cap: number): string {
  if (text.length <= cap + CUT_TAIL_ALLOWANCE) return text;
  return text.slice(0, cap) + ' …[cut ' + (text.length - cap) + ' chars]';
}

/** A remote URL can carry credentials (`https://user:token@host/...`); keep the host and path only. */
function cleanRepo(r: PcRepo): PcRepo {
  return {
    name: redact(r.name),
    remote: r.remote ? redact(r.remote.replace(/\/\/[^/@\s]*@/, '//')) : null,
    branch: r.branch ? redact(r.branch) : null,
    head: r.head ? redact(r.head) : null,
  };
}
