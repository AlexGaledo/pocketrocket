import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../config.js';
import { SCHEMA_SQL } from './schema.js';
import { MIGRATIONS, type Migration } from './migrations.js';

/*
 * Schema versions (P0 runner).
 *
 * On open: SCHEMA_SQL runs (CREATE ... IF NOT EXISTS), then every migration in `MIGRATIONS` whose version
 * is not yet in the `schema_version` table runs in version order, each in its own transaction with the row
 * that records it. Tracking is per version, so blocks that land out of order still run.
 *
 * Adding a migration (later phases):
 *   1. Use only your phase's block: P0 1-9, P1 10-19, P2 20-29, ... P9 90-99 (docs/specs/decisions.md).
 *   2. In db/migrations.ts, append a separated block:
 *        registerMigrations([10, 19], [
 *          { version: 10, name: 'computers table', up: (db) => db.exec('CREATE TABLE IF NOT EXISTS computers (...)') },
 *          { version: 11, name: 'bots.keep_awake', up: (db) => addColumnIfMissing(db, 'bots', 'keep_awake', 'INTEGER NOT NULL DEFAULT 0') },
 *        ]);
 *   3. Additive only. New columns (and indexes on them) go in a migration, not SCHEMA_SQL, because
 *      SCHEMA_SQL runs before migrations and cannot add a column to an existing table. A brand-new table
 *      may go in either place; `up` must be safe on a database where it already exists.
 *   4. Never edit or renumber a migration that has shipped.
 */
export { registerMigrations, addColumnIfMissing, hasColumn, type Migration } from './migrations.js';

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  constructor(file: string = DB_PATH, migrations: readonly Migration[] = MIGRATIONS) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    try {
      this.raw.exec(SCHEMA_SQL);
      this.migrate(migrations);
    } catch (e) {
      this.raw.close();
      throw e;
    }
  }

  /** Runs every migration not yet recorded in `schema_version` (see the header of this file). */
  private migrate(migrations: readonly Migration[]) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_version').map((r) => r.version));
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        m.up(this.raw);
        this.run('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Date.now());
      });
    }
  }

  /** Versions recorded in `schema_version`, ascending. */
  schemaVersions(): number[] {
    return this.all<{ version: number }>('SELECT version FROM schema_version ORDER BY version').map((r) => r.version);
  }
  run(sql: string, ...params: unknown[]) {
    return this.raw.prepare(sql).run(...(params as never[]));
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}
