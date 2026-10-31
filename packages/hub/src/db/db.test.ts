import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db, hasColumn, type Migration } from './db.js';
import { MIGRATIONS, registerMigrations } from './migrations.js';
import { SCHEMA_SQL } from './schema.js';

const dirs: string[] = [];
function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-db-'));
  dirs.push(d);
  return path.join(d, 'pocketrocket.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The bots/sessions tables as the earliest hub created them (no provider, no auto-memory columns). */
const PRE_AUTOMEMORY_SQL = `
CREATE TABLE bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT UNIQUE NOT NULL, title TEXT DEFAULT '',
  description TEXT DEFAULT '', avatar TEXT DEFAULT '', model TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]', max_budget_usd REAL NOT NULL DEFAULT 2.0, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  bot_id TEXT NOT NULL, room_id TEXT NOT NULL, sdk_session_id TEXT, last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER, PRIMARY KEY (bot_id, room_id)
);`;

const P0_VERSIONS = MIGRATIONS.filter((m) => m.version <= 9).map((m) => m.version);

describe('Db migrations', () => {
  it('creates a fresh database at the latest version', () => {
    const db = new Db(tmpFile());
    expect(db.schemaVersions()).toEqual(MIGRATIONS.map((m) => m.version));
    expect(P0_VERSIONS).toEqual([1, 2, 3]);
    expect(hasColumn(db.raw, 'bots', 'auto_memory_every')).toBe(true);
    db.raw.close();
  });

  it('upgrades a v0.2 database (no schema_version table) and keeps its data', () => {
    const file = tmpFile();
    const old = new DatabaseSync(file);
    old.exec(SCHEMA_SQL); // v0.2.0 shipped exactly this schema, without a version table
    old.prepare("INSERT INTO bots (id, name, handle, model, created_at, auto_memory) VALUES ('b1', 'Ada', 'ada', 'opus', 1, 0)").run();
    old.close();

    const db = new Db(file);
    expect(db.schemaVersions()).toEqual(MIGRATIONS.map((m) => m.version));
    expect(db.get<{ name: string; auto_memory: number }>("SELECT name, auto_memory FROM bots WHERE id = 'b1'")).toEqual({ name: 'Ada', auto_memory: 0 });
    db.raw.close();
    // Reopening runs nothing again.
    const again = new Db(file);
    expect(again.all('SELECT * FROM schema_version')).toHaveLength(MIGRATIONS.length);
    again.raw.close();
  });

  it('adds the columns an older database is missing', () => {
    const file = tmpFile();
    const old = new DatabaseSync(file);
    old.exec(PRE_AUTOMEMORY_SQL);
    old.prepare("INSERT INTO bots (id, name, handle, model, created_at) VALUES ('b1', 'Ada', 'ada', 'opus', 1)").run();
    old.close();

    const db = new Db(file);
    expect(hasColumn(db.raw, 'sessions', 'provider')).toBe(true);
    expect(db.get("SELECT auto_memory, auto_memory_every FROM bots WHERE id = 'b1'")).toEqual({ auto_memory: 1, auto_memory_every: 10 });
    db.raw.close();
  });

  it('runs a later block even when a higher version is already applied, and rolls back a failing one', () => {
    const file = tmpFile();
    const later: Migration = { version: 30, name: 't30', up: (r) => r.exec('CREATE TABLE IF NOT EXISTS t30 (x)') };
    new Db(file, [...MIGRATIONS, later]).raw.close();
    const earlier: Migration = { version: 10, name: 't10', up: (r) => r.exec('CREATE TABLE IF NOT EXISTS t10 (x)') };
    const broken: Migration = { version: 11, name: 'broken', up: (r) => { r.exec('CREATE TABLE t11 (x)'); throw new Error('boom'); } };
    expect(() => new Db(file, [...MIGRATIONS, later, earlier, broken])).toThrow('boom');
    const db = new Db(file, [...MIGRATIONS, later, earlier]);
    expect(db.schemaVersions()).toEqual([...P0_VERSIONS, 10, 30]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 't11'")).toBeUndefined();
    db.raw.close();
  });

  it('rejects versions outside the block or registered twice', () => {
    const noop = () => undefined;
    expect(() => registerMigrations([10, 19], [{ version: 20, name: 'x', up: noop }])).toThrow(/outside its block/);
    expect(() => registerMigrations([1, 9], [{ version: 1, name: 'x', up: noop }])).toThrow(/twice/);
  });
});
