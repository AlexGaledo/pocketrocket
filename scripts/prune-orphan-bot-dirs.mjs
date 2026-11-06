#!/usr/bin/env node
// Finds data/bots/<id> folders whose bot no longer exists and, with --apply, moves them to
// data/trash/bots-<date>/ (nothing is deleted; remove that folder yourself once you are sure).
//
//   node scripts/prune-orphan-bot-dirs.mjs                 dry run: list what would move
//   node scripts/prune-orphan-bot-dirs.mjs --apply         move them
//   node scripts/prune-orphan-bot-dirs.mjs --data <dir>    another data folder (default: POCKETROCKET_DATA or ./data)
//
// On the server run it as the service user, so the moved folders keep their owner:
//   sudo -u pocketrocket node scripts/prune-orphan-bot-dirs.mjs
// The hub may keep running: it only reads the bots table, and a folder with a bot row is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Same rule as packages/hub/src/services/orphanBotDirs.ts (BOT_ID_DIR); orphanBotDirs.test.ts checks they match.
export const BOT_ID_DIR = /^[A-Za-z0-9_-]{6,64}$/;

/** Folder names in `botsDir` shaped like a bot id with no row in `botIds`, sorted. */
export function findOrphanBotDirs(botsDir, botIds) {
  const live = new Set(botIds);
  let entries;
  try {
    entries = fs.readdirSync(botsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && BOT_ID_DIR.test(e.name) && !live.has(e.name)).map((e) => e.name).sort();
}

/** Bot ids in the hub database, or null when there is no database (or no bots table) at that path. */
export async function readBotIds(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare('SELECT id FROM bots').all().map((r) => String(r.id));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Moves each orphan to `<dataDir>/trash/bots-<date>/<id>` (a suffix when that exists). Returns the moves made. */
export function moveToTrash(dataDir, names, date = new Date().toISOString().slice(0, 10)) {
  const trash = path.join(dataDir, 'trash', 'bots-' + date);
  fs.mkdirSync(trash, { recursive: true });
  const moved = [];
  for (const name of names) {
    let to = path.join(trash, name);
    for (let i = 2; fs.existsSync(to); i++) to = path.join(trash, name + '-' + i);
    fs.renameSync(path.join(dataDir, 'bots', name), to);
    moved.push({ name, to });
  }
  return moved;
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const at = argv.indexOf('--data');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : process.env.POCKETROCKET_DATA || path.join(root, 'data'));
  const dbFile = path.join(dataDir, 'pocketrocket.db');
  const ids = await readBotIds(dbFile);
  if (ids === null) {
    console.error('No hub database with a bots table at ' + dbFile + '. Pass --data <dir>.');
    return 1;
  }
  const orphans = findOrphanBotDirs(path.join(dataDir, 'bots'), ids);
  console.log(ids.length + ' bot(s) in the database, ' + orphans.length + ' folder(s) in ' + path.join(dataDir, 'bots') + ' with no bot.');
  for (const n of orphans) console.log('  ' + n);
  if (!orphans.length) return 0;
  if (!apply) {
    console.log('Dry run: nothing moved. Run again with --apply to move them to ' + path.join(dataDir, 'trash') + '.');
    return 0;
  }
  // An empty bots table next to bot folders usually means the wrong database, not that every bot was deleted.
  if (!ids.length && !force) {
    console.error('The database has no bots at all, so every folder looks orphaned. Check --data, or add --force.');
    return 1;
  }
  const moved = moveToTrash(dataDir, orphans);
  console.log('Moved ' + moved.length + ' folder(s) to ' + path.dirname(moved[0].to) + '.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
