import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The hub package directory — the one holding `package.json` and `node_modules`.
 *
 * From source this file is `<hub>/src/config.ts`, so the package dir is one level up.
 * In the esbuild bundle everything collapses into `<hub>/hub.mjs`, so it is `here` itself.
 * Pick whichever candidate actually has `node_modules`; fall back to the parent (the
 * source layout) when neither does, e.g. when tests run before an install.
 *
 * Exported for tests.
 */
export function resolveHubDir(from: string, exists: (p: string) => boolean = fs.existsSync): string {
  for (const dir of [from, path.resolve(from, '..')]) {
    if (exists(path.join(dir, 'node_modules'))) return dir;
  }
  return path.resolve(from, '..');
}

/**
 * Version from the nearest `package.json`: `<here>/package.json` (bundle layout, written by
 * `pnpm deploy`) before `<here>/../package.json` (source layout). Exported for tests.
 */
export function resolveVersion(
  from: string,
  read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string {
  for (const dir of [from, path.resolve(from, '..')]) {
    try {
      const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0-unknown';
}

// src/config.ts or dist/config.js -> packages/hub -> packages -> repo root.
// Only used for the dev-mode defaults below; the desktop app always sets
// POCKETROCKET_DATA and POCKETROCKET_WEB_DIST explicitly.
export const ROOT_DIR = path.resolve(here, '..', '..', '..');

export const DATA_DIR = process.env.POCKETROCKET_DATA ? path.resolve(process.env.POCKETROCKET_DATA) : path.join(ROOT_DIR, 'data');
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');
export const BOTS_DIR = path.join(DATA_DIR, 'bots');
export const SKILLS_DIR = path.join(DATA_DIR, 'skills');
export const DB_PATH = path.join(DATA_DIR, 'pocketrocket.db');
export const WEB_DIST = process.env.POCKETROCKET_WEB_DIST
  ? path.resolve(process.env.POCKETROCKET_WEB_DIST)
  : path.join(ROOT_DIR, 'packages', 'web', 'dist');

export const CLAUDE_EXE =
  process.env.CLAUDE_EXE ??
  (process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : path.join(os.homedir(), '.local', 'bin', 'claude'));

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 7788);
/** When set, every /api/* call (except GET /api/health) needs `Authorization: Bearer <token>` and /ws needs ?token=. */
export const HUB_TOKEN = process.env.POCKETROCKET_TOKEN ?? null;

/** OS account name, the fallback for settings.userName (the human's display name). */
export function osUserName(): string {
  try {
    return os.userInfo().username || 'you';
  } catch {
    return 'you';
  }
}

export const MAX_HOPS = Number(process.env.MAX_HOPS ?? 5);
export const MAX_CONCURRENT_TURNS = Number(process.env.MAX_CONCURRENT_TURNS ?? 4);
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const CAUSE_COST_CAP_USD = Number(process.env.CAUSE_COST_CAP_USD ?? 5);
export const MAX_TURNS_PER_QUERY = 40;

export const VERSION: string = resolveVersion(here);

export const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');

export const USER_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

// Screen (virtual browser on the computer): noVNC served by websockify, Chromium CDP for bots.
export const HUB_DIR = resolveHubDir(here);
export const SCREEN_URL = process.env.SCREEN_URL ?? 'http://127.0.0.1:6080';
export const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
export const PLAYWRIGHT_MCP_CLI = path.join(HUB_DIR, 'node_modules', '@playwright', 'mcp', 'cli.js');
// Desktop tool (computer use on the virtual display): needs xdotool + scrot on Linux.
export const SCREEN_DISPLAY = process.env.SCREEN_DISPLAY ?? ':99';
export const DESKTOP_HOME = path.join(DATA_DIR, 'desktop-home');
export const DESKTOP_AVAILABLE =
  process.platform === 'linux' && fs.existsSync('/usr/bin/xdotool') && fs.existsSync('/usr/bin/scrot');

export function botHome(botId: string) {
  return path.join(BOTS_DIR, botId);
}
export function botPluginDir(botId: string) {
  return path.join(botHome(botId), 'plugin');
}

export function ensureDirs() {
  for (const d of [DATA_DIR, WORKSPACE_DIR, BOTS_DIR, SKILLS_DIR]) fs.mkdirSync(d, { recursive: true });
}

// Legacy migration: copy claudebot.db (and -wal/-shm) to pocketrocket.db if the old
// file exists and the new one hasn't been created yet. Old files are left in place.
export function migrateLegacyDb() {
  const legacyPath = path.join(DATA_DIR, 'claudebot.db');
  if (fs.existsSync(DB_PATH) || !fs.existsSync(legacyPath)) return;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = legacyPath + suffix;
    const dest = DB_PATH + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  }
  console.log('migrated legacy claudebot.db -> pocketrocket.db');
}
