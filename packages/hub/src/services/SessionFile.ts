import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

/**
 * Pure helpers for moving a Claude Code session file between the PC and the VPS (bridge P6).
 *
 * The .jsonl records the working directory on every line (`cwd`) and the files tools touched (`file_path`, `path`,
 * `notebook_path` in a tool_use input). A session resumed in another folder needs those to name the new folder, so the hub
 * swaps ONE prefix, the repo's toplevel on the PC for the worktree on the VPS, and swaps it back on the way home. Only
 * those fields change. Everything else on the line, and every line that holds no such field, stays byte for byte.
 */

/** Fields in a tool_use `input` that hold a path. */
const INPUT_PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;

const isWindowsStyle = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p) || (p.includes('\\') && !p.includes('/'));
const stripTrailingSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p) || p;

/**
 * `value` with the leading path `from` replaced by `to`, or `value` itself when it is not inside `from`. `from` has to end
 * at a separator (or the end of `value`), so `/a/app` never matches `/a/app2`. The tail's separators follow `to`'s style, so
 * `C:\\repo\\src\\a.ts` becomes `/work/wt/src/a.ts` and back. A Windows `from` matches without regard to case.
 */
export function swapPrefix(value: string, from: string, to: string): string {
  const f = stripTrailingSep(from);
  const t = stripTrailingSep(to);
  if (!f || !t || value.length < f.length) return value;
  const win = isWindowsStyle(f);
  const head = value.slice(0, f.length);
  if (win ? head.toLowerCase() !== f.toLowerCase() : head !== f) return value;
  const tail = value.slice(f.length);
  if (tail !== '' && tail[0] !== '/' && tail[0] !== '\\') return value;
  // Only a path in the same style as `from` can be inside it: `C:\\repo` does not match a POSIX string and vice versa.
  const toWin = isWindowsStyle(t);
  if (win === toWin) return t + tail;
  return t + (toWin ? tail.replace(/\//g, '\\') : tail.replace(/\\/g, '/'));
}

/** One JSONL line with its path fields swapped. A line that holds none, or is not JSON, is returned unchanged (same string). */
export function rewriteLine(line: string, from: string, to: string): string {
  // Cheap exit for the common line: nothing in it can start with `from`.
  const needle = JSON.stringify(stripTrailingSep(from)).slice(1, -1);
  if (!line.toLowerCase().includes(needle.toLowerCase())) return line;
  let o: unknown;
  try { o = JSON.parse(line); } catch { return line; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return line;
  const rec = o as Record<string, unknown>;
  let changed = false;
  const swap = (holder: Record<string, unknown>, field: string) => {
    const v = holder[field];
    if (typeof v !== 'string') return;
    const n = swapPrefix(v, from, to);
    if (n !== v) { holder[field] = n; changed = true; }
  };
  swap(rec, 'cwd');
  const message = rec.message;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : undefined;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      if (block.type !== 'tool_use' || !block.input || typeof block.input !== 'object') continue;
      for (const f of INPUT_PATH_FIELDS) swap(block.input as Record<string, unknown>, f);
    }
  }
  return changed ? JSON.stringify(rec) : line;
}

/** The whole file's text, line by line (`\n`). The trailing newline, blank lines and line count are kept. */
export function rewriteSessionText(text: string, from: string, to: string): string {
  return text.split('\n').map((l) => rewriteLine(l, from, to)).join('\n');
}

/**
 * Rewrites `src` into `dest` without holding the file in memory, and returns what was written (bytes, sha256). Lines are
 * split on `\n` only, as the CLI writes them.
 */
export async function rewriteSessionFile(src: string, dest: string, from: string, to: string): Promise<{ bytes: number; sha256: string; lines: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest, { flags: 'w', mode: 0o600 });
  const hash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  const write = async (s: string) => {
    const buf = Buffer.from(s, 'utf8');
    hash.update(buf);
    bytes += buf.length;
    if (!out.write(buf)) await once(out, 'drain');
  };
  try {
    let rest = '';
    for await (const chunk of fs.createReadStream(src, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
      rest += chunk;
      const cut = rest.lastIndexOf('\n');
      if (cut < 0) continue;
      const part = rest.slice(0, cut);
      rest = rest.slice(cut + 1);
      const lns = part.split('\n');
      lines += lns.length;
      await write(lns.map((l) => rewriteLine(l, from, to)).join('\n') + '\n');
    }
    if (rest) {
      lines++;
      await write(rewriteLine(rest, from, to));
    }
  } catch (e) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw e;
  }
  out.end();
  await once(out, 'finish');
  return { bytes, sha256: hash.digest('hex'), lines };
}

// ---------------------------------------------------------------------------------------------------------
// Where the Claude CLI keeps a session

/** The CLI's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/** The CLI stores a session under `projects/<cwd with every non-alphanumeric character as '-'>`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** The CLI shortens a longer name with a hash of its own; the hub does not guess that and refuses such a worktree instead. */
export const MAX_ENCODED_PROJECT_DIR = 200;

/** `<config>/projects/<encoded cwd>/<sessionId>.jsonl`: the file `claude --resume <id>` finds from `cwd`. Throws for a name the CLI would hash. */
export function sessionFilePath(cwd: string, sessionId: string, configDir: string = claudeConfigDir()): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new Error('Not a session id');
  const dir = encodeProjectDir(path.resolve(cwd));
  if (dir.length > MAX_ENCODED_PROJECT_DIR) throw new Error('The worktree path is too long for the Claude CLI to find the session again.');
  return path.join(configDir, 'projects', dir, sessionId + '.jsonl');
}

/** Used by the tests: true when `cwd` has a project folder under `configDir` (what a real CLI run leaves behind). */
export function projectDirExists(cwd: string, configDir: string = claudeConfigDir()): boolean {
  try { return fs.statSync(path.join(configDir, 'projects', encodeProjectDir(cwd))).isDirectory(); } catch { return false; }
}
