import fs from 'node:fs';
import path from 'node:path';

/**
 * Folders under data/bots/ whose bot no longer exists. Older hub versions deleted the bot row but left
 * `data/bots/<id>/` (memory, notes, plugin copy) on disk; every delete path removes it now, but the leftovers
 * stay until `scripts/prune-orphan-bot-dirs.mjs` moves them to data/trash/. Only directories are counted, and
 * only names shaped like a bot id, so nothing else that lives in data/bots is ever reported.
 * The same rule is in that script (plain .mjs, it cannot import this file); keep the two in step.
 */
export const BOT_ID_DIR = /^[A-Za-z0-9_-]{6,64}$/;

export function findOrphanBotDirs(botsDir: string, botIds: Iterable<string>): string[] {
  const live = new Set(botIds);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(botsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && BOT_ID_DIR.test(e.name) && !live.has(e.name))
    .map((e) => e.name)
    .sort();
}

/** Startup check: logs how many orphan folders there are, never touches them. Returns the count. */
export function reportOrphanBotDirs(botsDir: string, botIds: Iterable<string>, log: (s: string) => void = console.log): number {
  const n = findOrphanBotDirs(botsDir, botIds).length;
  if (n) log('[bots] ' + n + ' folder' + (n === 1 ? '' : 's') + ' in ' + botsDir + ' belong to no bot; run `node scripts/prune-orphan-bot-dirs.mjs` to review and move them to data/trash');
  return n;
}
