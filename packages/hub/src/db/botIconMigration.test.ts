import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotInputSchema } from '@pocketrocket/shared';
import { Db } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { Repos } from './repos.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// Repos below writes today's columns, so the later rooms.avatar column is there; it does not touch what 100 rewrites.
const BEFORE = MIGRATIONS.filter((m) => m.version < 100 || m.version === 102);
const AVATARS: Record<string, string> = {
  plain: '🤖', compass: '🧭', search: '🔎', wrench: '🛠️', pen: '✍️', smile: '🙂', custom: '🛰️', text: 'QA', blank: '', kept: 'radar', proto: 'toString',
  'pocketrocket-support': '', 'data-engineer': '',
};
const EXPECTED: Record<string, string> = {
  plain: '', compass: 'compass', search: 'search', wrench: 'wrench', pen: 'pen', smile: 'smile', custom: '', text: '', blank: '', kept: 'radar', proto: '',
  'pocketrocket-support': 'shield', 'data-engineer': 'database',
};

/** A database as the last build left it: every older migration applied, bots, rooms and messages in it. */
function oldDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-icons-'));
  dirs.push(dir);
  const file = path.join(dir, 'pocketrocket.db');
  const db = new Db(file, BEFORE);
  const repos = new Repos(db);
  const ids: Record<string, string> = {};
  for (const [handle, avatar] of Object.entries(AVATARS)) {
    ids[handle] = repos.createBot({ name: handle, handle, title: '', description: 'x', avatar, model: 'm', allowedTools: ['Read'], maxBudgetUsd: 1 }).id;
  }
  const room = repos.createRoom({ kind: 'dm', name: 'r', memberIds: [ids.plain], coordinatorBotId: null });
  repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'system', text: 'added 🤖 plain', payload: null, causeId: null, hop: 0, turnId: null });
  db.raw.close();
  return { file, ids, roomId: room.id };
}
const avatars = (db: Db) => Object.fromEntries(new Repos(db).listBots().map((b) => [b.handle, b.avatar]));

describe('migration 100: bot avatars to icon keys', () => {
  it('rewrites an existing database and leaves everything else alone', () => {
    const { file, roomId } = oldDatabase();
    const db = new Db(file);
    expect(avatars(db)).toEqual(EXPECTED);
    expect(db.schemaVersions()).toContain(100);
    const repos = new Repos(db);
    expect(repos.listRooms().map((r) => r.id)).toEqual([roomId]);
    expect(repos.listMessages(roomId).map((m) => m.text)).toEqual(['added 🤖 plain']); // history stays as written
    db.raw.close();
  });

  it('runs once: a later reopen neither fails nor undoes a choice the owner made since', () => {
    const { file, ids } = oldDatabase();
    let db = new Db(file);
    const repos = new Repos(db);
    repos.updateBot(ids['data-engineer'], { avatar: '' });
    repos.updateBot(ids.plain, { avatar: 'atom' });
    const applied = db.schemaVersions();
    db.raw.close();
    db = new Db(file);
    expect(db.schemaVersions()).toEqual(applied);
    expect(avatars(db)).toEqual({ ...EXPECTED, 'data-engineer': '', plain: 'atom' });
    db.raw.close();
  });

  it('gives the same result when the body runs twice', () => {
    const { file } = oldDatabase();
    const db = new Db(file);
    MIGRATIONS.find((m) => m.version === 100)!.up(db.raw);
    expect(avatars(db)).toEqual(EXPECTED);
    db.raw.close();
  });
});

describe('BotInputSchema.avatar', () => {
  const base = { name: 'A', handle: 'aa' };
  it('keeps a key, and turns anything else into automatic', () => {
    expect(BotInputSchema.parse({ ...base, avatar: 'shield' }).avatar).toBe('shield');
    expect(BotInputSchema.parse({ ...base, avatar: '🤖' }).avatar).toBe('');
    expect(BotInputSchema.parse(base).avatar).toBe('');
  });
});
