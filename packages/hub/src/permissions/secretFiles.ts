import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_PATH, DATA_DIR, HUB_TOKEN_PATH, INTEGRATIONS_PATH, PROJECTS_DIR, SECRETS_PATH, VAPID_PATH, VAULT_KEY_PATH,
} from '../config.js';
import { segments, tokenize } from './bashRules.js';

/**
 * The hub's key files, kept away from a bot's own file and shell tools in every approvals mode (a PreToolUse
 * deny in providers/claude.ts; bypass skips only canUseTool).
 *
 * Why it exists: bots run as the same OS user that owns DATA_DIR, and under approvals bypass `cat ../secrets.json`
 * from the workspace simply runs. Protected:
 * - in DATA_DIR: hub-token, secrets.json, mcp-servers.json, pc-runner.json, key-registry.json, account.json (the Supabase session),
 *   vapid.json (Web Push keys), vault.key and integrations.json (the integration vault), and anything under
 *   keys-disabled/;
 * - any `.env` / `.env.*` file under DATA_DIR/projects, except `.env.example` (and `.sample`, `.template`).
 *
 * Paths are resolved against the call's cwd and checked both as written and by realpath, so a symlink or
 * junction into DATA_DIR does not get around it. A Bash command is split the way bashRules.ts splits it, and
 * also on newlines, a lone `&`, `$(`, backticks and subshell parens; `cd` is followed across the pieces, quoted
 * arguments are searched for path-shaped words, and globs (`secrets*`, `.env*`, `../*.json`) are matched against
 * the protected names.
 *
 * Bash also has a backstop: with quotes and backslash escapes removed, a command whose text contains a hub key
 * file's name, or `keys-disabled`, is refused whatever its paths look like (so `f=hub-token; cat ../$f` and
 * `cat ~/../hub\-token` are caught). `.env` is not on that list, because the bare name turns up in ordinary
 * work (`cp .env.example .env`); project env files rely on the path checks alone.
 *
 * This raises the bar; it is not a wall. It reads the command line, and every bot is the same OS user, so a
 * command that assembles the name at run time gets past it: `h=hub; cat $h-token`, `python -c` with string
 * concatenation, a base64-decoded name, `find -exec`, a script the bot wrote to disk first. The real boundary for
 * those keys is not putting them where a bot's user can read them. What it does stop is the honest and the
 * casual read, and the obvious tricks.
 *
 * Apps keep working: `pnpm dev`, `npm test` and friends read `.env` inside their own process, which this never
 * sees; only a bot naming the file in its own tool call is refused. `node --env-file=.env` is let through for
 * the same reason. A recursive Grep over a project folder is not stopped, and may match inside a `.env` file.
 */

export const HUB_KEYS_MESSAGE = "That file holds the hub's keys. Bots don't read it; use the tools the room has.";
export const ENV_FILE_MESSAGE = "Env files hold the app's keys. Don't read or print them; run the app's own scripts instead.";

const isWin = process.platform === 'win32';
const HUB_FILES = [
  path.basename(HUB_TOKEN_PATH), path.basename(SECRETS_PATH), 'mcp-servers.json', 'pc-runner.json', 'key-registry.json',
  path.basename(ACCOUNT_PATH), path.basename(VAPID_PATH), path.basename(VAULT_KEY_PATH), path.basename(INTEGRATIONS_PATH),
];
const KEYS_DIR = 'keys-disabled';
const ENV_RE = /^\.env(\..+)?$/i;
const ENV_OK_RE = /^\.env\.(example|sample|template)(\..*)?$/i;
const WILDCARD = /[*?[\]{}]/;
/** Commands that read every file below a directory they are given. */
const RECURSIVE = new Set(['rg', 'ag', 'ack', 'tar', 'zip', '7z', 'rsync', 'scp']);
const RECURSIVE_WITH_FLAG = new Set(['grep', 'egrep', 'fgrep', 'cp']);

type Hit = 'hub' | 'env' | null;

/** Forward slashes, no trailing slash, lower case on Windows. */
function norm(p: string): string {
  let s = path.resolve(p).replace(/\\/g, '/');
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return isWin ? s.toLowerCase() : s;
}

/** realpath of `abs`, or of its nearest existing ancestor with the rest rebuilt on top; null when nothing resolves. */
function realish(abs: string): string | null {
  const rest: string[] = [];
  let cur = abs;
  for (let i = 0; i < 4096; i++) {
    try {
      const r = fs.realpathSync.native(cur);
      return rest.length ? path.join(r, ...rest.reverse()) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

/** Both spellings of a path: as written and by realpath (deduplicated). */
function forms(abs: string): string[] {
  const out = [norm(abs)];
  const r = realish(abs);
  if (r) {
    const n = norm(r);
    if (n !== out[0]) out.push(n);
  }
  return out;
}

const within = (n: string, dir: string) => n === dir || n.startsWith(dir.endsWith('/') ? dir : dir + '/');

interface Layout {
  files: string[];
  keysDirs: string[];
  projectsDirs: string[];
  dataDirs: string[];
}

function layout(dataDir: string): Layout {
  const projects = path.resolve(dataDir) === path.resolve(DATA_DIR) ? PROJECTS_DIR : path.join(dataDir, 'projects');
  return {
    files: HUB_FILES.flatMap((f) => forms(path.join(dataDir, f))),
    keysDirs: forms(path.join(dataDir, KEYS_DIR)),
    projectsDirs: forms(projects),
    dataDirs: forms(dataDir),
  };
}

const isEnvName = (base: string) => ENV_RE.test(base) && !ENV_OK_RE.test(base);

function classifyPath(abs: string, l: Layout): Hit {
  for (const n of forms(abs)) {
    if (l.files.includes(n)) return 'hub';
    if (l.keysDirs.some((k) => within(n, k))) return 'hub';
    if (l.projectsDirs.some((p) => n !== p && within(n, p)) && isEnvName(n.slice(n.lastIndexOf('/') + 1))) return 'env';
  }
  return null;
}

/** A directory a recursive read would search, which holds the hub's key files (DATA_DIR or above it). */
function holdsHubFiles(abs: string, l: Layout): boolean {
  return forms(abs).some((n) => l.dataDirs.some((d) => within(d, n)) || l.keysDirs.some((k) => within(n, k)));
}

/** Shell-style glob to a regex over normalized paths. `*` and `?` stay inside one segment; `**` crosses them. */
function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else { re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; }
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1);
      if (end < 0) re += '\\{';
      else { re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|\\]/g, '\\$&')).join('|') + ')'; i = end; }
    } else re += c.replace(/[.+^$()|\\\]}]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', isWin ? 'i' : '');
}

function classifyGlob(absGlob: string, l: Layout): Hit {
  for (const n of forms(absGlob)) {
    const cut = n.lastIndexOf('/');
    const dir = n.slice(0, cut) || '/';
    const last = n.slice(cut + 1);
    const full = globRe(n);
    if (l.files.some((f) => full.test(f))) return 'hub';
    const dirRe = globRe(dir);
    if (l.keysDirs.some((k) => full.test(k) || dirRe.test(k) || (!WILDCARD.test(dir) && within(dir, k)))) return 'hub';
    // Like the shell, a wildcard does not match a leading dot: only a pattern that starts with `.` reaches `.env`.
    const lastRe = globRe(last);
    if (last.startsWith('.') && ['.env', '.env.local', '.env.production'].some((e) => lastRe.test(e))) {
      const underProjects = l.projectsDirs.some((p) =>
        WILDCARD.test(dir) ? dirRe.test(p) || dirRe.test(p + '/app') || dirRe.test(p + '/app/sub') : within(dir, p));
      if (underProjects) return 'env';
    }
  }
  return null;
}

function classify(word: string, cwd: string, l: Layout): Hit {
  let w = word.trim();
  if (!w || w.startsWith('$')) return null;
  if (w === '~' || w.startsWith('~/') || w.startsWith('~\\')) w = path.join(os.homedir(), w.slice(1));
  const abs = path.resolve(cwd, w);
  return WILDCARD.test(w) ? classifyGlob(abs, l) : classifyPath(abs, l);
}

function message(hit: Exclude<Hit, null>): string {
  return hit === 'hub' ? HUB_KEYS_MESSAGE : ENV_FILE_MESSAGE;
}

/** Path-shaped words inside one shell token, so `open('../secrets.json')` and `--file=x` are looked at too. */
function wordsOf(tok: string): string[] {
  const out = new Set([tok]);
  for (const w of tok.split(/[\s=(),;'"`<>|&]+/)) if (w) out.add(w);
  return [...out];
}

/**
 * The command text with quotes and backslash escapes removed (outside single quotes, a backslash keeps the next
 * character literally), so `hub\-token`, `"secr"'ets.json'` and `hub''-token` read as the names they spell.
 */
function unescapeShell(cmd: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\' && i + 1 < cmd.length) out += cmd[++i];
      else out += c;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { out += cmd[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    out += c;
  }
  return out;
}

/** Names that no Bash command may contain at all, however it is built. Not `.env`: see `bashAccess`. */
const BACKSTOP_NAMES = [...HUB_FILES, KEYS_DIR].map((n) => n.toLowerCase());

/**
 * Splits off what the shell would run as separate commands, beyond what `segments` knows: newlines, a lone `&`
 * (not `&&`, `2>&1` or `&>`), command substitution and subshells. Each becomes a `;` so `cd` inside one is seen.
 */
function shellPieces(cmd: string): string {
  return cmd.replace(/\r?\n/g, ';').replace(/(?<![&<>|])&(?![&>])/g, ';').replace(/\$\(|[`()]/g, ';');
}

function bashAccess(cmd: string, startCwd: string, l: Layout): Hit {
  // Backstop: the path checks below follow what the command line shows, and shell syntax has many ways to hide a
  // path from them. Any command whose text, unescaped, names a hub key file or keys-disabled is refused outright.
  // `.env` is left to the path checks: matching the bare name would block ordinary `cp .env.example .env` work.
  // Known gap: a name assembled at run time (`h=hub; cat $h-token`) still passes this; see the file comment.
  const flat = unescapeShell(cmd);
  if (BACKSTOP_NAMES.some((n) => flat.toLowerCase().includes(n))) return 'hub';
  // As written (Windows backslash paths) and unescaped (`.e\nv`); either one naming a guarded path is enough.
  for (const text of new Set([cmd, flat])) {
    const hit = bashPathAccess(shellPieces(text), startCwd, l);
    if (hit) return hit;
  }
  return null;
}

function bashPathAccess(cmd: string, startCwd: string, l: Layout): Hit {
  let cwd = startCwd;
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg);
    if (!toks.length) continue;
    const name = path.basename(toks[0].replace(/\\/g, '/'));
    if ((name === 'cd' || name === 'pushd') && toks.length <= 2) {
      const t = toks[1];
      if (!t || t === '~') cwd = os.homedir();
      else if (t.startsWith('~/')) cwd = path.join(os.homedir(), t.slice(2));
      else if (!t.startsWith('-') && !t.startsWith('$')) cwd = path.resolve(cwd, t);
      continue;
    }
    const recursive = RECURSIVE.has(name) ||
      (RECURSIVE_WITH_FLAG.has(name) && toks.some((t) => /^-[a-zA-Z]*[rRa]/.test(t) || t === '--recursive' || t === '--archive'));
    if (recursive && toks.length === 1 && holdsHubFiles(cwd, l)) return 'hub';
    for (let i = 1; i < toks.length; i++) {
      let tok = toks[i];
      // The app reads its own env file; that is the point of `node --env-file=.env server.js`.
      if (tok === '--env-file' || tok === '--env-file-if-exists') { i++; continue; }
      if (/^--env-file(-if-exists)?=/.test(tok)) continue;
      const redirect = /^\d*(>>|>|<)(.*)$/.exec(tok);
      if (redirect) {
        if (redirect[2].startsWith('&')) continue;
        tok = redirect[2] || toks[++i] || '';
      }
      for (const w of wordsOf(tok)) {
        if (w.startsWith('-')) continue;
        const hit = classify(w, cwd, l);
        if (hit) return hit;
        if (recursive && holdsHubFiles(path.resolve(cwd, w), l)) return 'hub';
      }
    }
    // `grep -r KEY` with no directory searches the cwd.
    if (recursive && name !== 'cp' && holdsHubFiles(cwd, l) && toks.slice(1).filter((t) => !t.startsWith('-')).length <= 1) return 'hub';
  }
  return null;
}

/**
 * Why this tool call may not touch the hub's key files or a project's env file, or null. `dataDir` is for
 * tests; the hub uses DATA_DIR.
 */
export function secretFileAccess(toolName: string, input: Record<string, unknown>, cwd: string, dataDir: string = DATA_DIR): string | null {
  const l = layout(dataDir);
  const str = (v: unknown) => (typeof v === 'string' && v.length ? v : null);
  let hit: Hit = null;

  if (toolName === 'Bash') {
    hit = bashAccess(String(input.command ?? ''), cwd, l);
  } else if (toolName === 'Glob' || toolName === 'Grep') {
    const base = path.resolve(cwd, str(input.path) ?? '.');
    hit = classifyPath(base, l);
    const pattern = toolName === 'Glob' ? str(input.pattern) : str(input.glob);
    if (!hit && pattern) hit = classify(pattern, base, l);
    // Grep reads every file below its path: refuse a search that would cover DATA_DIR itself.
    if (!hit && toolName === 'Grep' && holdsHubFiles(base, l)) hit = 'hub';
  } else if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    for (const k of ['file_path', 'notebook_path', 'path']) {
      const v = str(input[k]);
      if (v && (hit = classify(v, cwd, l))) break;
    }
  }
  return hit ? message(hit) : null;
}
