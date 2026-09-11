import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROVIDER_IDS, type Approvals, type ProviderId } from '@pocketrocket/shared';

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
/** Explicit token from the environment (the desktop app sets one), or null when the hub must mint its own. */
// `|| null`, not `?? null`: an empty POCKETROCKET_TOKEN means "unset", never "no token required".
export const HUB_TOKEN = process.env.POCKETROCKET_TOKEN || null;
/**
 * `1` restores the old behaviour: mint a brand-new token on every start. Off by default because it made
 * every hub restart invalidate the token the UI was already holding, which is what the "paste the hub
 * token" panel kept appearing for.
 */
export const ROTATE_HUB_TOKEN = ['1', 'true', 'yes', 'on'].includes(String(process.env.POCKETROCKET_ROTATE_TOKEN ?? '').toLowerCase());
/** Where a self-minted token is written so local tooling (scripts/smoke.mjs) can find it. */
export const HUB_TOKEN_PATH = path.join(DATA_DIR, 'hub-token');

/**
 * Tighten a file to owner-only (audit 2026-09-09, B17). `writeFileSync({mode})` is ignored when the file
 * already exists, and on Windows the POSIX mode only ever sets the read-only attribute — the file still
 * inherits DATA_DIR's ACL. So: chmod always, and on Windows additionally drop inheritance and grant the
 * current user alone. Both are best-effort; a failure is never fatal.
 */
export function restrictFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* different filesystem semantics; the Windows ACL pass below is the real control there */
  }
  if (process.platform !== 'win32') return;
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    return;
  }
  if (!user) return;
  try {
    execFile('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { windowsHide: true }, () => undefined);
  } catch {
    /* icacls missing or refused: nothing else to try */
  }
}

/**
 * The hub is never unauthenticated (audit 2026-09-09, B3 / D3). `POCKETROCKET_TOKEN` wins when set;
 * otherwise a 128-bit token lives in `<DATA_DIR>/hub-token` (0600) where a human, `scripts/smoke.mjs` and
 * the desktop shell can all pick it up.
 *
 * That file is **reused** across restarts. It used to be re-minted every start so a token leaked into a log
 * died with the process — but a restart then silently invalidated the token the open UI was holding, and the
 * user got the "paste the hub token" panel after every deploy, `systemctl restart` and tsx-watch reload. The
 * token is loopback-only and 0600 on disk, so a stable value is the better trade; `POCKETROCKET_ROTATE_TOKEN=1`
 * brings the old behaviour back. Anything in the file that is not exactly 32 hex chars is ignored and replaced.
 */
export function ensureHubToken(): string {
  if (HUB_TOKEN) return HUB_TOKEN;
  if (!ROTATE_HUB_TOKEN) {
    try {
      const existing = fs.readFileSync(HUB_TOKEN_PATH, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(existing)) return existing;
    } catch {
      /* no readable token file yet: mint one below */
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HUB_TOKEN_PATH, token, { mode: 0o600 });
    restrictFile(HUB_TOKEN_PATH);
  } catch (e) {
    console.error('[pocketrocket] could not write ' + HUB_TOKEN_PATH + ': ' + String((e as Error).message ?? e));
  }
  return token;
}

/** OS account name, the fallback for settings.userName (the human's display name). */
export function osUserName(): string {
  try {
    return os.userInfo().username || 'you';
  } catch {
    return 'you';
  }
}

export const MAX_HOPS = Number(process.env.MAX_HOPS ?? 5);
/**
 * `POCKETROCKET_BYPASS_PERMISSIONS`, when set, pins the approvals setting and locks it in the UI:
 * `1`/`true`/`yes`/`on` → 'bypass' (no approval cards: the PermissionBroker allows everything, the Claude SDK
 * runs in `bypassPermissions`, `request_approval` is not offered, the Codex / Grok / OpenCode sandboxes open
 * up), any other value → 'ask'. Unset or empty → null, and `settings.approvals` decides, per turn.
 * Exported for tests.
 */
export function parseApprovalsEnv(raw: string | undefined): Approvals | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  // Anything unrecognised fails closed: a typo must never be what turns the approval cards off.
  return ['1', 'true', 'yes', 'on'].includes(v) ? 'bypass' : 'ask';
}
export const APPROVALS_ENV = parseApprovalsEnv(process.env.POCKETROCKET_BYPASS_PERMISSIONS);
/**
 * Providers this hub offers. v1 ships Claude only; the other adapters stay in the tree and come back for
 * development with `POCKETROCKET_PROVIDERS=claude,opencode`. Claude is always on (it is the default and the
 * fallback everything resolves to); unknown ids are ignored. Exported for tests.
 */
export function parseEnabledProviders(raw: string | undefined): ProviderId[] {
  const wanted = new Set(String(raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return PROVIDER_IDS.filter((id) => id === 'claude' || wanted.has(id));
}
export const ENABLED_PROVIDERS: readonly ProviderId[] = parseEnabledProviders(process.env.POCKETROCKET_PROVIDERS);
export const MAX_CONCURRENT_TURNS = Number(process.env.MAX_CONCURRENT_TURNS ?? 4);
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const CAUSE_COST_CAP_USD = Number(process.env.CAUSE_COST_CAP_USD ?? 5);
/**
 * Steps (model round trips) one run may take before the provider stops it.
 *
 * This is not the runaway-cost brake — `maxBudgetUsd` is, and it is enforced live inside the run — so this
 * only has to catch a loop that is cheap but endless. 40 was tuned for chat and is too tight for computer
 * use, where every navigate, snapshot, click and keystroke costs a step: reading a few pages and writing a
 * file can pass 50 on its own. Whatever is left over is picked up by MAX_TURN_CONTINUATIONS.
 */
export const MAX_TURNS_PER_QUERY = Number(process.env.MAX_TURNS_PER_QUERY ?? 80);
/**
 * How many times a turn that ran out of steps may be resumed to finish the job.
 *
 * Raising MAX_TURNS_PER_QUERY instead would let a runaway turn burn 3x the steps before anyone sees it.
 * A continuation is cheaper and safer: the session is resumed, so the model keeps its context, and every
 * hop is re-checked against the bot's per-turn budget and its abort signal before it starts. 0 disables.
 */
export const MAX_TURN_CONTINUATIONS = Number(process.env.MAX_TURN_CONTINUATIONS ?? 2);

export const VERSION: string = resolveVersion(here);

export const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');

// Optional PocketRocket account (Supabase Auth). Accounts are on only when both resolve to a value.
// Built-in project the app ships with; a publishable key is public by design. Filled in before release.
const BUILTIN_SUPABASE_URL = '';
const BUILTIN_SUPABASE_KEY = '';
export const SUPABASE_URL = process.env.POCKETROCKET_SUPABASE_URL || BUILTIN_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY = process.env.POCKETROCKET_SUPABASE_KEY || BUILTIN_SUPABASE_KEY;
/** The hub-held Supabase session (refresh token included), owner-only like secrets.json. Never under WORKSPACE_DIR. */
export const ACCOUNT_PATH = path.join(DATA_DIR, 'account.json');

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
