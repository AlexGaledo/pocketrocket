import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { BOT_ID_DIR, findOrphanBotDirs, reportOrphanBotDirs } from './orphanBotDirs.js';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/prune-orphan-bot-dirs.mjs');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function botsDir(names: string[], files: string[] = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-orphans-'));
  dirs.push(d);
  for (const n of names) fs.mkdirSync(path.join(d, n));
  for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
  return d;
}

describe('findOrphanBotDirs', () => {
  it('lists folders with no bot row, sorted', () => {
    const d = botsDir(['liveBot0001', 'goneBot0002', 'aGoneBot003']);
    expect(findOrphanBotDirs(d, ['liveBot0001'])).toEqual(['aGoneBot003', 'goneBot0002']);
    expect(findOrphanBotDirs(d, ['liveBot0001', 'goneBot0002', 'aGoneBot003'])).toEqual([]);
  });

  it('ignores files and names that are not bot ids', () => {
    const d = botsDir(['.trash', 'has space', 'ok_id-1234'], ['strayFile01']);
    expect(findOrphanBotDirs(d, [])).toEqual(['ok_id-1234']);
  });

  it('is empty when the folder does not exist', () => {
    expect(findOrphanBotDirs(path.join(os.tmpdir(), 'prc-none-' + Date.now()), [])).toEqual([]);
  });

  it('reports the count once, and says nothing when there are none', () => {
    const d = botsDir(['goneBot0002', 'goneBot0003']);
    const logs: string[] = [];
    expect(reportOrphanBotDirs(d, [], (s) => logs.push(s))).toBe(2);
    expect(logs).toEqual([expect.stringContaining('2 folders')]);
    expect(reportOrphanBotDirs(d, ['goneBot0002', 'goneBot0003'], (s) => logs.push(s))).toBe(0);
    expect(logs).toHaveLength(1);
  });
});

describe('scripts/prune-orphan-bot-dirs.mjs', () => {
  it('uses the same bot-id rule as the hub', async () => {
    const mod = (await import(pathToFileURL(script).href)) as { BOT_ID_DIR: RegExp };
    expect(mod.BOT_ID_DIR.source).toBe(BOT_ID_DIR.source);
  });

  function dataDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-prune-'));
    dirs.push(d);
    const db = new Db(path.join(d, 'pocketrocket.db'));
    const bot = new Repos(db).createBot({ name: 'Ann', handle: 'ann', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    db.raw.close();
    for (const n of [bot.id, 'goneBot0001', 'goneBot0002']) {
      fs.mkdirSync(path.join(d, 'bots', n), { recursive: true });
      fs.writeFileSync(path.join(d, 'bots', n, 'memory.md'), n);
    }
    return { d, bot };
  }
  const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('only lists by default and moves nothing', () => {
    const { d, bot } = dataDir();
    const out = run('--data', d);
    expect(out).toContain('2 folder(s)');
    expect(out).toContain('goneBot0001');
    expect(out).toContain('Dry run');
    expect(fs.readdirSync(path.join(d, 'bots')).sort()).toEqual([bot.id, 'goneBot0001', 'goneBot0002'].sort());
  });

  it('with --apply moves orphans into data/trash/bots-<date>/ and leaves live bots', () => {
    const { d, bot } = dataDir();
    run('--data', d, '--apply');
    expect(fs.readdirSync(path.join(d, 'bots'))).toEqual([bot.id]);
    const [day] = fs.readdirSync(path.join(d, 'trash'));
    expect(day).toMatch(/^bots-\d{4}-\d{2}-\d{2}$/);
    expect(fs.readdirSync(path.join(d, 'trash', day)).sort()).toEqual(['goneBot0001', 'goneBot0002']);
    expect(fs.readFileSync(path.join(d, 'trash', day, 'goneBot0001', 'memory.md'), 'utf8')).toBe('goneBot0001');
  });

  it('refuses to run without a database', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-prune-'));
    dirs.push(d);
    expect(() => run('--data', d, '--apply')).toThrow();
  });
});
