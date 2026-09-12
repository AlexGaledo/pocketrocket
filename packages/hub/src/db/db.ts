import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../config.js';
import { SCHEMA_SQL } from './schema.js';

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  constructor(file: string = DB_PATH) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec(SCHEMA_SQL);
    this.migrate();
  }

  /** Additive column migrations for databases created by an older schema. */
  private migrate() {
    const cols = (table: string) =>
      (this.raw.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map((c) => c.name);
    if (!cols('sessions').includes('provider')) this.raw.exec('ALTER TABLE sessions ADD COLUMN provider TEXT');
    const botCols = cols('bots');
    if (!botCols.includes('auto_memory')) this.raw.exec('ALTER TABLE bots ADD COLUMN auto_memory INTEGER NOT NULL DEFAULT 1');
    if (!botCols.includes('auto_memory_every')) this.raw.exec('ALTER TABLE bots ADD COLUMN auto_memory_every INTEGER NOT NULL DEFAULT 10');
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
