import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db, hasColumn } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { Repos } from './repos.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A database as the last build left it: bots, rooms, members and messages, and no `rooms.avatar`. */
function oldDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-roomav-'));
  dirs.push(dir);
  const file = path.join(dir, 'pocketrocket.db');
  const db = new Db(file, MIGRATIONS.filter((m) => m.version < 102));
  expect(hasColumn(db.raw, 'rooms', 'avatar')).toBe(false);
  const bot = db.raw.prepare("INSERT INTO bots (id,name,handle,model,created_at,avatar) VALUES ('b1','A','aa','m',1,'radar')");
  bot.run();
  db.raw.prepare("INSERT INTO rooms (id,kind,name,coordinator_bot_id,created_at,chat_model) VALUES ('r1','group','crew','b1',1,'claude-opus-5')").run();
  db.raw.prepare("INSERT INTO room_members (room_id,bot_id) VALUES ('r1','b1')").run();
  db.raw.prepare("INSERT INTO messages (id,room_id,seq,author_type,kind,text,created_at) VALUES ('m1','r1',1,'user','text','hi',1)").run();
  db.raw.close();
  return file;
}

describe('migration 102: rooms.avatar', () => {
  it('adds the column on an existing database and leaves everything else alone', () => {
    const file = oldDatabase();
    const db = new Db(file);
    expect(db.schemaVersions()).toContain(102);
    const repos = new Repos(db);
    const room = repos.getRoom('r1')!;
    expect(room).toMatchObject({ name: 'crew', avatar: '', coordinatorBotId: 'b1', chatModel: 'claude-opus-5', memberIds: ['b1'] });
    expect(repos.getBot('b1')!.avatar).toBe('radar');
    expect(repos.listMessages('r1').map((m) => m.text)).toEqual(['hi']);
    db.raw.close();
  });

  it('runs once; a reopen keeps what was stored since', () => {
    const file = oldDatabase();
    let db = new Db(file);
    new Repos(db).updateRoom('r1', { avatar: 'rocket' });
    const applied = db.schemaVersions();
    db.raw.close();
    db = new Db(file);
    expect(db.schemaVersions()).toEqual(applied);
    expect(new Repos(db).getRoom('r1')!.avatar).toBe('rocket');
    db.raw.close();
  });

  it('is safe when the column is already there, and a long reference fits bots.avatar', () => {
    const file = oldDatabase();
    const db = new Db(file);
    MIGRATIONS.find((m) => m.version === 102)!.up(db.raw);
    const ref = 'img:' + 'a'.repeat(64);
    const repos = new Repos(db);
    repos.updateBot('b1', { avatar: ref });
    expect(repos.getBot('b1')!.avatar).toBe(ref);
    db.raw.close();
  });

  it('a fresh database gets it too', () => {
    const db = new Db(':memory:');
    expect(hasColumn(db.raw, 'rooms', 'avatar')).toBe(true);
    expect(new Repos(db).createRoom({ kind: 'group', name: 'n', memberIds: [], coordinatorBotId: null }).avatar).toBe('');
    db.raw.close();
  });
});
