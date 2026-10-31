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
// P8 (80–89): model router and usage. Which model ran each turn, why the router picked it, and what kind of
// cause started it, on the usage row (for the Usage tab) and on the bot's messages (for the chat chip).
registerMigrations([80, 89], [
  { version: 80, name: 'usage.model', up: (db) => addColumnIfMissing(db, 'usage', 'model', 'TEXT') },
  { version: 81, name: 'usage.route_reason', up: (db) => addColumnIfMissing(db, 'usage', 'route_reason', 'TEXT') },
  {
    version: 82,
    name: 'usage.cause_kind',
    up: (db) => {
      addColumnIfMissing(db, 'usage', 'cause_kind', 'TEXT');
      // Best-effort backfill so old spend shows up in the breakdown: memory passes have `mem-` turn ids, bot
      // hops wrote messages with hop > 0, routines and user messages are told apart by the cause message.
      db.exec(`UPDATE usage SET cause_kind = CASE
        WHEN turn_id LIKE 'mem-%' THEN 'memory'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.turn_id = usage.turn_id AND m.hop > 0) THEN 'bot'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = usage.cause_id AND m.kind = 'routine') THEN 'routine'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = usage.cause_id AND m.author_type = 'user') THEN 'user'
      END WHERE cause_kind IS NULL`);
      // And the model, from the provider's own per-model report: the one that cost the most.
      db.exec(`UPDATE usage SET model = (
        SELECT j.key FROM json_each(usage.model_usage) j
        ORDER BY COALESCE(json_extract(j.value, '$.costUSD'), json_extract(j.value, '$.costUsd'), 0) DESC LIMIT 1
      ) WHERE model IS NULL AND model_usage IS NOT NULL AND json_valid(model_usage) AND json_type(model_usage) = 'object'`);
    },
  },
  { version: 83, name: 'messages.model', up: (db) => addColumnIfMissing(db, 'messages', 'model', 'TEXT') },
  { version: 84, name: 'messages.model_reason', up: (db) => addColumnIfMissing(db, 'messages', 'model_reason', 'TEXT') },
]);
