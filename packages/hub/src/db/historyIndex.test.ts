import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { Repos } from './repos.js';
import { backfillMessagesFts, ftsQuery, searchHistory } from './historyIndex.js';

const mem = () => new Repos(new Db(':memory:'));
const say = (repos: Repos, roomId: string, text: string) =>
  repos.insertMessage({ roomId, authorType: 'user', authorId: null, kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null });
const room = (repos: Repos, name = 'R') => repos.createRoom({ kind: 'group', name, memberIds: [], coordinatorBotId: null });
const ftsCount = (repos: Repos) => repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages_fts')!.n;

describe('messages_fts (G2)', () => {
  it('registers tasks, the index and reports in block 200-209', () => {
    const v = new Db(':memory:').schemaVersions();
    expect(v).toEqual(expect.arrayContaining([200, 201, 202]));
  });

  it('follows insert, update and delete', () => {
    const repos = mem();
    const r = room(repos);
    const m = say(repos, r.id, 'the quarterly invoices are late');
    const find = (q: string) => searchHistory(repos.db, { query: q, roomIds: [r.id], limit: 10 }).map((h) => h.id);
    expect(find('invoice')).toEqual([m.id]); // porter stemming
    repos.updateMessage(m.id, { text: 'payroll discussion only' });
    expect(find('invoices')).toEqual([]);
    expect(find('payroll')).toEqual([m.id]);
    repos.db.run('DELETE FROM messages WHERE id=?', m.id);
    expect(find('payroll')).toEqual([]);
    expect(ftsCount(repos)).toBe(0);
  });

  it('only searches the rooms it is given', () => {
    const repos = mem();
    const a = room(repos, 'A');
    const b = room(repos, 'B');
    say(repos, a.id, 'secret launch plan');
    say(repos, b.id, 'secret launch dates');
    const hits = searchHistory(repos.db, { query: 'launch', roomIds: [a.id], limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].roomName).toBe('A');
    expect(searchHistory(repos.db, { query: 'launch', roomIds: [], limit: 10 })).toEqual([]);
  });

  it('treats FTS syntax in the query as plain words', () => {
    expect(ftsQuery('foo" OR bar* NEAR(x)')).toBe('"foo" "or" "bar" "near"');
    const repos = mem();
    const r = room(repos);
    say(repos, r.id, 'hello world');
    expect(() => searchHistory(repos.db, { query: '"" AND (', roomIds: [r.id], limit: 5 })).not.toThrow();
  });

  it('upgrades an existing database: old messages are backfilled, in bounded batches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-fts-'));
    const file = path.join(dir, 'hub.db');
    try {
      const old = new Db(file, MIGRATIONS.filter((m) => m.version < 200));
      const orepos = new Repos(old);
      const r = room(orepos);
      for (let i = 0; i < 25; i++) say(orepos, r.id, 'legacy message number ' + i + ' about zebras');
      expect(old.schemaVersions()).not.toContain(201);
      old.raw.close();

      const db = new Db(file);
      const repos = new Repos(db);
      expect(db.schemaVersions()).toContain(201);
      expect(ftsCount(repos)).toBe(25);
      expect(searchHistory(db, { query: 'zebra', roomIds: [r.id], limit: 50 })).toHaveLength(25);
      db.raw.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfill proceeds a batch at a time and tolerates rows a trigger already indexed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-fts-'));
    const file = path.join(dir, 'hub.db');
    try {
      const old = new Db(file, MIGRATIONS.filter((m) => m.version < 201));
      const orepos = new Repos(old);
      const r = room(orepos);
      for (let i = 0; i < 10; i++) say(orepos, r.id, 'old note ' + i);
      old.raw.close();
      const db = new Db(file, MIGRATIONS.filter((m) => m.version < 201 || m.version === 201));
      // The migration batch is large, so shrink the work: reset the cursor and clear the index to replay in small batches.
      db.run('DELETE FROM messages_fts');
      db.run("UPDATE fts_backfill SET next_rowid=0 WHERE name='messages'");
      const repos = new Repos(db);
      repos.updateMessage(repos.listMessages(r.id)[0].id, { text: 'old note edited' }); // trigger indexes this one early
      let rounds = 0;
      while (backfillMessagesFts(db.raw, 3)) rounds++;
      expect(rounds).toBeGreaterThanOrEqual(2);
      expect(ftsCount(repos)).toBe(10);
      expect(backfillMessagesFts(db.raw, 3)).toBe(false);
      db.raw.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
