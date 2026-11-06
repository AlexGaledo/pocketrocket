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
/** Uploaded pictures. Outside WORKSPACE_DIR and BOTS_DIR, so it is in no bot's roots. */
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const DB_PATH = path.join(DATA_DIR, 'pocketrocket.db');
/** The owner's routing rules. No bot may write it (`permissions/readOnlyRoots.ts`). */
export const ROUTING_PATH = path.join(DATA_DIR, 'routing.md');
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
    // The token is never logged, so this file is the only way to learn a minted one.
    console.error('[pocketrocket] could not write ' + HUB_TOKEN_PATH + ': ' + String((e as Error).message ?? e) + '. Nobody can sign in until that is fixed or POCKETROCKET_TOKEN is set.');
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
/**
 * POCKETROCKET_NO_SPEND_CAPS=1: for a server on a flat subscription, where these dollar figures are notional and only
 * stop work. Turns off the per-reply, per-request, trigger and training budgets. Not the step, hop or rate limits: those
 * stop loops, not spending. Never set it with an API key, where the dollars are real.
 */
export const spendCapsOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
  ['1', 'true', 'yes', 'on'].includes(String(env.POCKETROCKET_NO_SPEND_CAPS ?? '').trim().toLowerCase());
export const causeCostCap = (env: NodeJS.ProcessEnv = process.env): number =>
  spendCapsOff(env) ? Infinity : Number(env.CAUSE_COST_CAP_USD ?? 5);
export const CAUSE_COST_CAP_USD = causeCostCap();
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
// Built-in project the app ships with; a publishable key is public by design (RLS guards the data).
const BUILTIN_SUPABASE_URL = 'https://aihkfrbjqalcvfurstor.supabase.co';
const BUILTIN_SUPABASE_KEY = 'sb_publishable_I8mIenc7yM9Mq1aQDaVNWw_0k2qX1Kz';
export const SUPABASE_URL = process.env.POCKETROCKET_SUPABASE_URL || BUILTIN_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY = process.env.POCKETROCKET_SUPABASE_KEY || BUILTIN_SUPABASE_KEY;
// Supabase's built-in mailer only delivers to the project's own team, so email sign-in stays off (OAuth only)
// until the project has its own SMTP sender; `1` turns it on.
export const ACCOUNT_EMAIL = ['1', 'true', 'yes', 'on'].includes(String(process.env.POCKETROCKET_ACCOUNT_EMAIL ?? '').toLowerCase());
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

// ---- P7: knowledge repo ----
/** Where settings.knowledgeRepo is cloned (git URL) or linked (local folder). Read-only to every bot. */
export const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
/** Minutes between background `git pull --ff-only` runs of the knowledge clone. 0 turns the timer off. */
export const KNOWLEDGE_SYNC_MINUTES = Number(process.env.KNOWLEDGE_SYNC_MINUTES ?? 60);
// ---------------------------------------------------------------------------------------------------
// P1: per-bot computers (services/ComputerManager.ts). Each bot that uses Browser or Desktop gets its own
// display, Chromium profile and CDP/VNC ports — same uid, so this is NOT isolation between bots.

/** Root of every bot's computer: `<COMPUTERS_DIR>/<botId>/{home,browser,files,recordings}`. */
export const COMPUTERS_DIR = path.join(DATA_DIR, 'computers');
export function computerDir(botId: string) {
  return path.join(COMPUTERS_DIR, botId);
}
/** The bot's own disk on its computer (Desktop, Downloads). `~/Shared` on that desktop is WORKSPACE_DIR. */
export function computerFilesDir(botId: string) {
  return path.join(computerDir(botId), 'files');
}
const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const posInt = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};
/**
 * Per-bot computers are opt-in by environment (`deploy/setup-vps.sh` sets `POCKETROCKET_COMPUTERS=1` in the
 * hub unit) and Linux-only. Off, every bot shares the one legacy screen exactly as before.
 */
export const COMPUTERS_ENABLED = process.platform === 'linux' && truthy(process.env.POCKETROCKET_COMPUTERS);
/** No fixed limit by default (one per slot): memory decides, see ComputerManager.start. Set it to cap them anyway. */
export const MAX_RUNNING_COMPUTERS = posInt(process.env.MAX_RUNNING_COMPUTERS, 99);
export const COMPUTER_IDLE_MIN = posInt(process.env.COMPUTER_IDLE_MIN, 30);
/** Soft disk quota per bot computer. Warned at 80%, refused to start at 100%. */
export const COMPUTER_QUOTA_BYTES = posInt(process.env.COMPUTER_QUOTA_GB, 10) * 1024 ** 3;

/**
 * Folders a bot's file tools may touch without an approval card: the shared workspace, its private home, when
 * per-bot computers are on its own computer disk (where its Chromium downloads land) and, given the room it is
 * replying in, that room's file folder. Without a room no room folder is open.
 */
export function botRoots(botId: string, roomId?: string): string[] {
  return [WORKSPACE_DIR, botHome(botId), ...(COMPUTERS_ENABLED ? [computerFilesDir(botId)] : []), ...(roomId ? roomRoots(botId, roomId) : [])];
}

/** Shared project folders, outside the workspace so that being in the project's room is what opens one. */
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
/** File folders of group rooms with no project, `<ROOMS_DIR>/<roomId>/`. Made the first time one is needed. */
export const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
/** A direct chat's file folder: a subfolder of the bot's home, so its memory and notes stay out of the Files panel. */
export function botFilesDir(botId: string) {
  return path.join(botHome(botId), 'files');
}
let roomRoots: (botId: string, roomId: string) => string[] = () => [];
/** Set by createHub, which owns the database that says which folder a room uses. */
export function setRoomRootsResolver(fn: (botId: string, roomId: string) => string[]) {
  roomRoots = fn;
}

// P4: integrations. Tokens live AES-256-GCM encrypted in integrations.json; the key in vault.key (0600),
// which deploy/backup.sh leaves out of every archive so a leaked backup holds no usable token.
export const VAULT_KEY_PATH = path.join(DATA_DIR, 'vault.key');
export const INTEGRATIONS_PATH = path.join(DATA_DIR, 'integrations.json');

// ---------------------------------------------------------------------------------------------------
// P9: phone, devices, push.
/**
 * Hostnames (comma or space separated) the hub also answers to, besides loopback, e.g.
 * `POCKETROCKET_ALLOWED_HOSTS=myhub.tail1234.ts.net`. Off by default (decision Q9). A listed host is only
 * accepted on a request that reached the hub over HTTPS through a proxy on this machine (Tailscale Serve
 * sets `X-Forwarded-Proto: https` and connects from loopback); the hub itself still binds 127.0.0.1 only.
 * Anything that is not a plain DNS name (a scheme, a port, a wildcard, an IP literal, a loopback name) is
 * dropped with a warning rather than widening the check.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const h of String(raw ?? '').split(/[\s,]+/)) {
    const v = h.trim().toLowerCase().replace(/\.$/, '');
    if (!v) continue;
    const ok = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v)
      && !/^[0-9.]+$/.test(v) && v !== 'localhost' && !v.endsWith('.localhost');
    if (!ok) {
      console.warn('[pocketrocket] POCKETROCKET_ALLOWED_HOSTS: ignoring ' + JSON.stringify(h) + ' (expected a hostname like myhub.tail1234.ts.net)');
      continue;
    }
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
export const ALLOWED_HOSTS: readonly string[] = parseAllowedHosts(process.env.POCKETROCKET_ALLOWED_HOSTS);
/** VAPID key pair for Web Push (P9), minted locally on first use. 0600, like hub-token. */
export const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');
/** VAPID `sub` claim. Apple wants a mailto: or https: URL here; it is sent to the push service, never to a bot. */
export const PUSH_SUBJECT = process.env.POCKETROCKET_PUSH_SUBJECT || 'https://github.com/AlexGaledo/pocketrocket';
