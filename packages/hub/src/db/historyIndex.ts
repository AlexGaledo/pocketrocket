import type { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.js';

/** Rows the migration indexes itself; a larger history finishes in the background (see {@link startHistoryBackfill}). */
export const MIGRATION_BACKFILL_ROWS = 20_000;
const BACKFILL_BATCH = 2_000;

/**
 * Indexes one bounded batch of messages that existed when the index was created. Triggers keep newer rows in sync,
 * so the backfill only covers rowid <= `upto`. Returns true while more remains. Safe to repeat or to run on a
 * row a trigger already indexed.
 */
export function backfillMessagesFts(raw: DatabaseSync, batch = BACKFILL_BATCH, inTx = false): boolean {
  const st = raw.prepare("SELECT next_rowid AS n, upto AS u FROM fts_backfill WHERE name='messages'").get() as { n: number; u: number } | undefined;
  if (!st) return false;
  const rows = raw
    .prepare('SELECT rowid AS r, text FROM messages WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?')
    .all(st.n, st.u, batch) as { r: number; text: string }[];
  const has = raw.prepare('SELECT 1 FROM messages_fts WHERE rowid=?');
  const ins = raw.prepare('INSERT INTO messages_fts (rowid, text) VALUES (?, ?)');
  if (!inTx) raw.exec('BEGIN');
  try {
    for (const m of rows) if (!has.get(m.r)) ins.run(m.r, m.text ?? '');
    const next = rows.length ? rows[rows.length - 1].r : st.u;
    raw.prepare("UPDATE fts_backfill SET next_rowid=? WHERE name='messages'").run(rows.length < batch ? st.u : next);
    if (!inTx) raw.exec('COMMIT');
  } catch (e) {
    if (!inTx) raw.exec('ROLLBACK');
    throw e;
  }
  return rows.length >= batch && rows[rows.length - 1].r < st.u;
}

/** Finishes a backfill the migration left over, a batch per tick so the event loop stays free. Returns a stop function. */
export function startHistoryBackfill(db: Db): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    timer = null;
    if (stopped) return;
    try {
      if (backfillMessagesFts(db.raw)) timer = setTimeout(tick, 10);
    } catch {
      /* database closed or busy: the index stays partial, search still works on what is indexed */
    }
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/** Turns free text into an FTS5 query: every word quoted, joined with AND. Empty when there is nothing to search. */
export function ftsQuery(q: string): string {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1).slice(0, 12);
  return words.map((w) => '"' + w + '"').join(' ');
}

export interface HistoryHit { id: string; roomId: string; roomName: string; seq: number; authorType: string; authorId: string | null; createdAt: number; snippet: string }

/** Full-text search of message text inside `roomIds` only. Newest relevance first. */
export function searchHistory(db: Db, o: { query: string; roomIds: readonly string[]; limit: number }): HistoryHit[] {
  const match = ftsQuery(o.query);
  if (!match || !o.roomIds.length) return [];
  const marks = o.roomIds.map(() => '?').join(',');
  return db.all<{ id: string; room_id: string; room_name: string; seq: number; author_type: string; author_id: string | null; created_at: number; snip: string }>(
    "SELECT m.id, m.room_id, r.name AS room_name, m.seq, m.author_type, m.author_id, m.created_at, snippet(messages_fts, 0, '', '', '...', 24) AS snip " +
      'FROM messages_fts f JOIN messages m ON m.rowid=f.rowid JOIN rooms r ON r.id=m.room_id ' +
      "WHERE messages_fts MATCH ? AND m.room_id IN (" + marks + ") AND m.kind IN ('text','handoff','routine','trigger') " +
      'ORDER BY bm25(messages_fts) LIMIT ?',
    match, ...o.roomIds, Math.max(1, Math.min(o.limit, 50)),
  ).map((r) => ({ id: r.id, roomId: r.room_id, roomName: r.room_name, seq: r.seq, authorType: r.author_type, authorId: r.author_id, createdAt: r.created_at, snippet: r.snip }));
}
