import fs from 'node:fs';
import path from 'node:path';

/**
 * The delete gate. Under `acceptEdits` the CLI approves `rm`, `rmdir` and `mv` inside the working roots by itself,
 * so neither canUseTool nor classifyBash ever sees them. This runs as a PreToolUse hook (providers/claude.ts) and
 * again inside classifyBash, because a hook's `ask` lands in the broker and must not be allowed back through there.
 *
 * - Anything that deletes always asks. So does a command whose name is only known at run time (`$CMD x`).
 * - `mv` asks only when it would replace something, or when the command line does not show whether it would.
 *
 * This reads a command line; it is not a sandbox. It cannot see inside a script, an interpreter's code or an alias.
 * Those are not auto-approved by the CLI, so they still reach classifyBash and raise its generic card.
 */

export interface GateHit {
  reason: string;
  /** It will destroy data, so approval rules never cover it. False when the command line just does not show. */
  danger: boolean;
}

interface Word {
  text: string;
  /** Holds an expansion (`$x`, `$(...)`, a glob, `~`), so `text` is not what the shell will really use. */
  dynamic: boolean;
}

const MAX_DEPTH = 4;
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred']);
/** Run the command named by a later argument. Their own options vary, so every later argument is tried. */
const WRAPPERS = new Set([
  'sudo', 'doas', 'su', 'command', 'builtin', 'exec', 'env', 'nice', 'ionice', 'nohup', 'timeout', 'stdbuf', 'setsid',
  'xargs', 'parallel', 'busybox', 'toybox', 'watch', 'flock', 'chroot', 'unshare', 'ssh',
]);
/** Run their string arguments as shell code. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish', 'eval']);
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', 'time', 'coproc', 'function']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Index of the `)` closing the `(` at `open`, skipping quotes; the end of `src` when it is unterminated. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '\\') i++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

/**
 * Splits a command line into simple commands. Substitutions (`$(...)`, backticks) become commands of their own,
 * and quoted text stays one word, so `grep "rm x" log` is not a delete but `r''m x` and `\rm x` are.
 */
function simpleCommands(src: string, depth = 0): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  let text = '';
  let started = false;
  let quoted = false;
  let dynamic = false;
  let dropNext = false; // The next word is a redirect target, not an argument.

  const endWord = () => {
    if (started) {
      if (dropNext) dropNext = false;
      else if (!quoted && (text === '{' || text === '}')) endCommand();
      else cur.push({ text, dynamic });
    }
    text = '';
    started = quoted = dynamic = false;
  };
  const endCommand = () => {
    text = '';
    started = quoted = dynamic = false;
    if (cur.length) out.push(cur);
    cur = [];
  };
  const finish = () => {
    endWord();
    dropNext = false;
    endCommand();
  };
  const nested = (inner: string) => {
    started = dynamic = true;
    if (depth < MAX_DEPTH) out.push(...simpleCommands(inner, depth + 1));
    else out.push([{ text: inner, dynamic: true }]); // Too deep to read: fails closed as a dynamic command.
  };
  /** `$...` at `i`, inside or outside double quotes. Returns the index after it. */
  const dollar = (i: number): number => {
    if (src[i + 1] === '(') {
      const end = closingParen(src, i + 1);
      nested(src.slice(i + 2, end));
      return end + 1;
    }
    started = dynamic = true;
    text += '$';
    return i + 1;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] !== '\n') {
        text += src[i + 1] ?? '';
        started = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      text += src.slice(i + 1, stop);
      started = quoted = true;
      i = stop + 1;
    } else if (c === '"') {
      started = quoted = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          text += src[i + 1] ?? '';
          i += 2;
        } else if (src[i] === '$') i = dollar(i);
        else if (src[i] === '`') {
          const end = src.indexOf('`', i + 1);
          const stop = end < 0 ? src.length : end;
          nested(src.slice(i + 1, stop));
          i = stop + 1;
        } else text += src[i++];
      }
      i++;
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end < 0 ? src.length : end;
      nested(src.slice(i + 1, stop));
      i = stop + 1;
    } else if (c === '$') {
      i = dollar(i);
    } else if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      finish();
      i++;
    } else if (c === '#' && !started) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (c === '<' || c === '>') {
      // `2>` is a redirect of fd 2, not the argument "2".
      if (/^\d+$/.test(text) && !quoted) text = '', started = false;
      endWord();
      while (src[i] === '<' || src[i] === '>' || src[i] === '&') i++;
      if (src[i] !== '(') dropNext = true;
    } else {
      if (c === '*' || c === '?' || (c === '[' && started && text !== '[') || (c === '~' && !started)) dynamic = true;
      // Brace expansion, as opposed to a `{` group or find's `{}`.
      if (c === '{' && src[i + 1] && !/[\s}]/.test(src[i + 1])) dynamic = true;
      text += c;
      started = true;
      i++;
    }
  }
  finish();
  return out;
}

function commandName(w: Word): string {
  return path.posix.basename(w.text.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
}

function withoutPrefixes(words: Word[]): Word[] {
  let at = 0;
  while (at < words.length && (KEYWORDS.has(words[at].text) || ASSIGNMENT.test(words[at].text))) at++;
  return words.slice(at);
}

/** Why this simple command deletes something, or null. */
function deletion(raw: Word[], depth = 0, isCommand = true): GateHit | null {
  const words = withoutPrefixes(raw);
  if (!words.length || depth > MAX_DEPTH) return null;
  const first = words[0];
  if (first.dynamic) return isCommand ? { reason: 'Command name is only known at run time: ' + first.text.slice(0, 60), danger: false } : null;
  const name = commandName(first);
  const args = words.slice(1);
  if (DELETERS.has(name)) return { reason: 'Deletes files: ' + words.map((w) => w.text).join(' ').slice(0, 80), danger: true };
  const anySuffix = (from: Word[]): GateHit | null => {
    for (let k = 0; k < from.length; k++) {
      // Past the first word this may just be an argument (`{}`, `"$f"`), so an expansion there proves nothing.
      const hit = deletion(from.slice(k), depth + 1, k === 0);
      if (hit) return hit;
    }
    return null;
  };
  if (name === 'find') {
    if (args.some((w) => w.text === '-delete')) return { reason: 'Deletes files: find -delete', danger: true };
    const exec = args.findIndex((w) => /^-(exec|execdir|ok|okdir)$/.test(w.text));
    return exec < 0 ? null : anySuffix(args.slice(exec + 1));
  }
  if (name === 'command' && /^-[vV]$/.test(args[0]?.text ?? '')) return null;
  if (WRAPPERS.has(name)) return anySuffix(args);
  if (SHELLS.has(name)) {
    for (const a of args) {
      if (a.text.startsWith('-')) continue;
      for (const inner of simpleCommands(a.text, depth + 1)) {
        const hit = deletion(inner, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Why this `mv` may replace something, or null when the command line shows it will not. */
function mvOverwrite(args: Word[], cwd: string | null, moved: Set<string>): GateHit | null {
  const paths: Word[] = [];
  let target: Word | undefined;
  let noClobber = false;
  let noTargetDir = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w.dynamic || !w.text.startsWith('-') || w.text === '-') {
      paths.push(w);
    } else if (w.text === '--') {
      paths.push(...args.slice(i + 1));
      break;
    } else if (w.text.startsWith('--')) {
      const [opt, value] = w.text.slice(2).split(/=(.*)/s);
      if (opt === 'no-clobber') noClobber = true;
      else if (opt === 'force') noClobber = false;
      else if (opt === 'no-target-directory') noTargetDir = true;
      else if (opt === 'target-directory') target = value ? { text: value, dynamic: false } : args[++i];
      else if (opt === 'suffix' && value === undefined) i++;
    } else {
      for (let k = 1; k < w.text.length; k++) {
        const f = w.text[k];
        if (f === 'n') noClobber = true;
        else if (f === 'f') noClobber = false;
        else if (f === 'T') noTargetDir = true;
        else if (f === 't' || f === 'S') {
          const rest = w.text.slice(k + 1);
          const value = rest ? { text: rest, dynamic: w.dynamic } : args[++i];
          if (f === 't') target = value;
          break;
        }
      }
    }
  }
  if (noClobber) return null;
  const toDir = !!target;
  if (!target) target = paths.pop();
  if (!target || !paths.length) return null; // mv only prints a usage error.

  const unknown = (w: Word): GateHit => ({ reason: 'Cannot tell whether this mv overwrites a file: ' + w.text, danger: false });
  const overwrites = (what: string): GateHit => ({ reason: 'mv overwrites an existing file: ' + what, danger: true });
  const resolve = (w: Word): string | null => {
    if (w.dynamic) return null;
    if (path.isAbsolute(w.text)) return path.resolve(w.text);
    return cwd === null ? null : path.resolve(cwd, w.text);
  };
  const dest = resolve(target);
  if (dest === null) return unknown(target);
  const taken = (p: string) => moved.has(p) || !!fs.lstatSync(p, { throwIfNoEntry: false });
  const isDir = !noTargetDir && (toDir || !!fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory());
  if (!isDir) {
    if (taken(dest)) return overwrites(target.text);
    moved.add(dest);
    return null;
  }
  for (const src of paths) {
    if (src.dynamic) return unknown(src);
    const into = path.join(dest, path.basename(src.text.replace(/\\/g, '/')));
    if (taken(into)) return overwrites(into);
    moved.add(into);
  }
  return null;
}

/** Why this shell command must raise a card, or null. `cwd` is where the command starts. */
export function deleteGate(command: string, cwd: string): GateHit | null {
  let dir: string | null = cwd;
  const moved = new Set<string>();
  for (const raw of simpleCommands(command)) {
    const words = withoutPrefixes(raw);
    if (!words.length) continue;
    const del = deletion(words);
    if (del) return del;
    const name = commandName(words[0]);
    const args = words.slice(1);
    if (name === 'cd') {
      const to = args.find((w) => w.dynamic || !w.text.startsWith('-'));
      dir = !to || to.dynamic ? null : path.isAbsolute(to.text) ? to.text : dir === null ? null : path.resolve(dir, to.text);
    } else if (name === 'pushd' || name === 'popd') {
      dir = null;
    } else if (name === 'mv') {
      const hit = mvOverwrite(args, dir, moved);
      if (hit) return hit;
    }
  }
  return null;
}
