import path from 'node:path';
import fs from 'node:fs';

const isWin = process.platform === 'win32';

function canon(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? r.toLowerCase() : r;
}
function real(p: string): string | null {
  try {
    return canon(fs.realpathSync.native(path.resolve(p)));
  } catch {
    return null;
  }
}
/** Does an entry exist at `p` (a dangling symlink counts: lstat succeeds where existsSync fails)? */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a caller-supplied path, or return null for shapes that can never be resolved safely
 * (audit 2026-09-09, B5). `path.resolve` alone is not enough on Windows:
 * - `~/x` would resolve to `<cwd>/~/x`, i.e. *inside* the workspace, while every tool that expands `~`
 *   itself reads the user's home. Always foreign.
 * - `\\?\C:\x` and `\\?\UNC\...` bypass Win32 path normalization entirely; strip the prefix or reject.
 * - `\\server\share` (UNC) is a remote path, never inside a local root.
 * - `C:foo` is *drive-relative*: it resolves against the per-drive working directory, which the hub does
 *   not control and cannot predict. Rejecting it is the only safe answer.
 */
function normalizeInput(p: string): string | null {
  let s = p.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
  if (!s) return null;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return null;
  if (isWin) {
    if (/^\\\\[?.]\\UNC\\/i.test(s)) return null;
    s = s.replace(/^\\\\[?.]\\/, '');
    if (/^[\\/]{2}/.test(s)) return null;
    if (/^[A-Za-z]:[^\\/]/.test(s)) return null;
  } else if (/^[\\/]{2}/.test(s) && s.startsWith('//')) {
    // POSIX `//host/share` is implementation-defined; treat it like a UNC path.
    return null;
  }
  return s;
}

/** The nearest ancestor of `abs` that actually exists, plus the not-yet-created remainder below it. */
function nearestExisting(abs: string): { dir: string; rest: string } | null {
  const parts: string[] = [];
  let cur = abs;
  for (let i = 0; i < 4096; i++) {
    if (present(cur)) return { dir: cur, rest: parts.reverse().join(path.sep) };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    parts.push(path.basename(cur));
    cur = parent;
  }
  return null;
}

/**
 * True when `target` resolves inside (or equal to) one of `roots` — by BOTH its lexical form and its
 * realpath (audit 2026-09-09, B5).
 *
 * The old version ORed the two candidates and treated a missing realpath as "no opinion", so a junction or
 * symlink planted inside the workspace let a bot read and write anywhere: the lexical path was inside, and
 * that was enough. Now:
 * - the lexically resolved path must be inside, and
 * - if the entry exists, its realpath must be inside too (a dangling symlink fails realpath and is rejected);
 * - if it does not exist yet, the nearest existing ancestor is realpath'd and the would-be path rebuilt on
 *   top of it, so `<ws>/junction-to-C-drive/new.txt` is caught before the file is created.
 */
export function isInside(target: string, roots: string[], cwd?: string): boolean {
  const t = normalizeInput(target);
  if (t === null) return false;
  const abs = path.isAbsolute(t) ? t : path.resolve(cwd ?? process.cwd(), t);

  const rootSet = new Set<string>();
  for (const root of roots) {
    rootSet.add(canon(root));
    const rr = real(root);
    if (rr) rootSet.add(rr);
  }
  if (!rootSet.size) return false;
  const insideAny = (p: string): boolean => {
    const c = canon(p);
    for (const r of rootSet) if (c === r || c.startsWith(r + path.sep)) return true;
    return false;
  };

  if (!insideAny(abs)) return false;

  if (present(abs)) {
    const r = real(abs);
    return r !== null && insideAny(r);
  }
  const anc = nearestExisting(abs);
  if (!anc) return false;
  const rr = real(anc.dir);
  if (rr === null) return false;
  return insideAny(anc.rest ? path.join(rr, anc.rest) : rr);
}

const WILDCARD = /[*?[\]{}]/;

/**
 * The literal directory prefix of a glob: everything before the first wildcard, trimmed back to a directory.
 * `../../../` + a wildcard tail -> `../../..`; `src/` + a wildcard tail -> `src`; a bare `*.ts` -> null.
 */
export function globPrefix(pattern: string): string | null {
  const m = WILDCARD.exec(pattern);
  const head = m ? pattern.slice(0, m.index) : pattern;
  if (!head) return null;
  // A trailing separator means the head already names a directory; otherwise drop the partial basename.
  const dir = /[\\/]$/.test(head) ? head.replace(/[\\/]+$/, '') : m ? path.dirname(head) : head;
  if (!dir || dir === '.') return null;
  return dir;
}

/** A Grep `pattern` is a regex, not a path — only treat it as one when it clearly reaches out of the tree. */
function looksLikeEscapingPath(s: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(s) || /^[\\/~]/.test(s) || /^[A-Za-z]:[\\/]/.test(s);
}

/**
 * Extract path-like fields from a tool input.
 *
 * `Glob`/`Grep` also carry their scope inside the pattern (audit 2026-09-09, B13): before this,
 * a Grep whose `glob` was `../../../` plus a wildcard tail was checked as "no path at all" and ran
 * with no approval card. The literal directory prefix of `glob` (and of `Glob`'s own `pattern`, which is a
 * path glob rather than a regex) is now extracted and checked like any other path.
 */
export function pathsFromInput(toolName: string, input: Record<string, unknown>): string[] {
  const keys = ['file_path', 'path', 'notebook_path', 'directory', 'cwd'];
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length) out.push(v);
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const g = input.glob;
    if (typeof g === 'string' && g.length) {
      const p = globPrefix(g);
      if (p) out.push(p);
    }
    const pat = input.pattern;
    if (typeof pat === 'string' && pat.length && (toolName === 'Glob' || looksLikeEscapingPath(pat))) {
      const p = globPrefix(pat);
      if (p) out.push(p);
    }
    // No explicit scope at all: the tool searches the cwd, which the caller resolves to the workspace.
    if (!out.length) out.push('.');
  }
  return out;
}
