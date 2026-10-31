import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned schema migrations. See the header of `db.ts` for how phases add theirs.
 *
 * A migration runs once per database, in version order, inside a transaction together with the
 * `schema_version` row that records it. "Applied" is tracked per version, not as a high-water mark,
 * so blocks merged out of order (P3's 30s before P1's 10s) still run on a database that already has
 * the later ones.
 */
export interface Migration {
  /** Unique, inside the phase's reserved block (P0 1–9, P1 10–19, … P9 90–99). */
  version: number;
  /** Short description, stored in `schema_version.name`. */
  name: string;
  /** Additive only: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN, backfills. Never drop or rename. */
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [];

/**
 * Registers one phase's migrations. `block` is the phase's reserved version range (inclusive), e.g.
 * `[10, 19]` for P1; every version must fall inside it and be unused.
 */
export function registerMigrations(block: readonly [number, number], list: readonly Migration[]): void {
  const [lo, hi] = block;
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version < lo || m.version > hi) {
      throw new Error(`migration ${m.version} (${m.name}) is outside its block ${lo}-${hi}`);
    }
    if (MIGRATIONS.some((x) => x.version === m.version)) throw new Error(`migration version ${m.version} is registered twice`);
    MIGRATIONS.push(m);
  }
  MIGRATIONS.sort((a, b) => a.version - b.version);
}

/** True when `table` has a column named `column`. */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * `ALTER TABLE <table> ADD COLUMN <column> <ddl>` unless the column already exists (a fresh database
 * gets it from SCHEMA_SQL, an old one from this).
 */
export function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
}

// ---------------------------------------------------------------------------------------------------
// P0 (1–9): the ad-hoc column checks that predate the runner. SCHEMA_SQL already creates these
// columns on a fresh database, so on one they are recorded without changing anything.
registerMigrations([1, 9], [
  { version: 1, name: 'sessions.provider', up: (db) => addColumnIfMissing(db, 'sessions', 'provider', 'TEXT') },
  { version: 2, name: 'bots.auto_memory', up: (db) => addColumnIfMissing(db, 'bots', 'auto_memory', 'INTEGER NOT NULL DEFAULT 1') },
  { version: 3, name: 'bots.auto_memory_every', up: (db) => addColumnIfMissing(db, 'bots', 'auto_memory_every', 'INTEGER NOT NULL DEFAULT 10') },
]);

// Later phases: append one clearly separated block per phase below, e.g.
//   // P1 (10–19): per-bot computers
//   registerMigrations([10, 19], [{ version: 10, name: 'computers table', up: (db) => db.exec('CREATE TABLE IF NOT EXISTS computers (...)') }]);
// or keep the list in its own file (importing only `type Migration` from here) and register it here.

// ---------------------------------------------------------------------------------------------------
// P3 (30–39): routines v2 and proactive follow-up.
registerMigrations([30, 39], [
  // One-shot routines: epoch ms the routine fires at once; NULL for a cron routine.
  { version: 30, name: 'routines.once_at', up: (db) => addColumnIfMissing(db, 'routines', 'once_at', 'INTEGER') },
  // Lane items queued or running, so a hub restart can resume them (services/FollowUp.ts). A row lives from
  // enqueue until its turn settles; `attempts` counts restarts it was resumed across, so a turn that kills
  // the hub is resumed once, not forever.
  {
    version: 31,
    name: 'lane_journal table',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS lane_journal (' +
          'id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, cause_id TEXT NOT NULL, hop INTEGER NOT NULL, ' +
          'trigger_seq INTEGER NOT NULL, run_id TEXT, note TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
      ),
  },
]);
