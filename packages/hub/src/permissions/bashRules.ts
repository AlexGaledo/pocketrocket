import path from 'node:path';
import { isInside } from './pathRules.js';

export type BashVerdict = { verdict: 'allow' | 'ask'; danger: boolean; reason: string };

/**
 * Bash classification (rewritten for audit 2026-09-09, B3 + B4).
 *
 * `allow` means the command runs silently. That is a very strong statement, so the allowlist is now only
 * things that read: they cannot write a file, cannot reach the network, and — crucially — cannot execute
 * code the model just wrote. The old list included `node`, `python`, `bun`, `npx`, `npm run`, `awk`, `sed`,
 * `find` and `env`, every one of which is a general-purpose interpreter in disguise
 * (`node -e`, `awk 'BEGIN{system(...)}'`, `find -exec sh -c`, `npm run <script-the-bot-just-wrote>`), and it
 * only ever looked at *absolute* paths, so `cat ../secrets.json` was silently allowed even though DATA_DIR
 * is the workspace's parent.
 *
 * Everything not on the list still runs — it just shows the user an approval card first.
 */

/** Read-only commands that stay silent when every path they touch is inside the roots. */
const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'pwd', 'echo', 'wc', 'sort', 'uniq', 'tree',
]);
/** `git` is allowed only for these subcommands; everything else (push, reset, clean, checkout, ...) asks. */
const GIT_READ_ONLY = new Set(['status', 'log', 'diff']);
/** Anything that dumps the environment: the child env is filtered (providers/env.ts), but never silently. */
const ENV_DUMPERS = new Set(['env', 'printenv', 'set', 'export', 'Get-ChildItem env:', 'gci']);

/**
 * Interpreters and shell-outs. They are *not* dangerous per se — a bot legitimately runs the test suite —
 * but each one turns an arbitrary string into execution, so the human sees a card. Listed explicitly so the
 * approval card can say why rather than "not on the allowlist".
 */
const INTERPRETERS = new Set([
  'node', 'nodejs', 'tsx', 'ts-node', 'deno', 'bun', 'bunx', 'python', 'python2', 'python3', 'py', 'ruby',
  'perl', 'php', 'awk', 'gawk', 'mawk', 'sed', 'xargs', 'find', 'eval', 'source', '.', 'sh', 'bash', 'zsh',
  'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'npx', 'pnpx',
  'npm', 'pnpm', 'yarn', 'make', 'cargo', 'go', 'dotnet', 'java', 'docker', 'ssh', 'Invoke-Expression', 'iex',
]);

const DANGER: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/,
  /Remove-Item\b[^|;&]*-Recurse/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh)\b/i,
  /\bnpm\s+publish\b/i,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777/,
  /\bmkfs\b/,
];

/** Split a command line into pipeline/sequence segments. */
function segments(cmd: string): string[] {
  return cmd
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whitespace-split respecting single and double quotes; quotes are stripped from the token. */
export function tokenize(seg: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** `>file`, `>>file`, `2>file`, `<file` — returns the redirect target, or null when the token is not one. */
function redirectTarget(tok: string, next: string | undefined): { target: string | null; consumesNext: boolean } | null {
  const m = /^(\d*)(>>|>|<)(.*)$/.exec(tok);
  if (!m) return null;
  const rest = m[3];
  if (rest.startsWith('&')) return { target: null, consumesNext: false }; // 2>&1 and friends: fd duplication
  if (rest) return { target: rest, consumesNext: false };
  return { target: next ?? null, consumesNext: true };
}

const isFlag = (t: string) => t.startsWith('-') && t !== '-';

function baseName(cmd: string): string {
  const b = path.basename(cmd.replace(/\\/g, '/'));
  return process.platform === 'win32' ? b.replace(/\.(exe|cmd|bat|ps1)$/i, '') : b;
}

/**
 * Classify a shell command against the bot's roots.
 *
 * `allowedRoots[0]` is the workspace and doubles as the starting working directory: every relative token is
 * resolved against it, and a `cd` updates it for the segments that follow (audit 2026-09-09, B3 — before
 * this, only absolute paths were ever inspected).
 */
export function classifyBash(cmd: string, allowedRoots: string[] = []): BashVerdict {
  for (const d of DANGER) if (d.test(cmd)) return { verdict: 'ask', danger: true, reason: 'Dangerous pattern: ' + d.source };

  const segs = segments(cmd);
  if (!segs.length) return { verdict: 'ask', danger: false, reason: 'Empty command' };
  if (!allowedRoots.length) return { verdict: 'ask', danger: false, reason: 'No workspace roots configured' };

  let cwd = allowedRoots[0];
  const outside = (p: string) => !isInside(p, allowedRoots, cwd);

  for (const seg of segs) {
    const toks = tokenize(seg);
    if (!toks.length) continue;

    // Redirection targets are path-checked wherever they appear in the segment, and strip out of the
    // argument list so `> out.txt` is not also read as a positional path.
    const args: string[] = [];
    let redirected = false;
    for (let i = 0; i < toks.length; i++) {
      const r = redirectTarget(toks[i], toks[i + 1]);
      if (!r) {
        args.push(toks[i]);
        continue;
      }
      redirected = true;
      if (r.consumesNext) i++;
      if (r.target && outside(r.target)) {
        return { verdict: 'ask', danger: false, reason: 'Writes outside workspace: ' + r.target };
      }
    }
    if (!args.length) continue;

    const cmdName = baseName(args[0]);
    const rest = args.slice(1);

    if (cmdName === 'cd') {
      const target = rest.find((t) => !isFlag(t));
      if (!target) continue; // bare `cd` -> home, but nothing is read or written by it
      if (outside(target)) return { verdict: 'ask', danger: false, reason: 'cd outside workspace: ' + target };
      cwd = path.resolve(cwd, target);
      continue;
    }

    if (ENV_DUMPERS.has(cmdName) || ENV_DUMPERS.has(args[0])) {
      return { verdict: 'ask', danger: false, reason: 'Reads the process environment: ' + cmdName };
    }
    if (INTERPRETERS.has(cmdName) || INTERPRETERS.has(args[0])) {
      return { verdict: 'ask', danger: false, reason: 'Can execute arbitrary code: ' + cmdName };
    }
    if (cmdName === 'git') {
      const sub = rest.find((t) => !isFlag(t));
      if (!sub || !GIT_READ_ONLY.has(sub)) {
        return { verdict: 'ask', danger: false, reason: 'git ' + (sub ?? '(no subcommand)') + ' is not read-only' };
      }
    } else if (!READ_ONLY.has(cmdName)) {
      return { verdict: 'ask', danger: false, reason: 'Not on allowlist: ' + seg.slice(0, 60) };
    }
    // `echo` is only harmless while it prints; the moment it redirects it is a file write.
    if (cmdName === 'echo' && redirected) {
      return { verdict: 'ask', danger: false, reason: 'echo writes to a file' };
    }

    for (const t of rest) {
      if (isFlag(t)) continue;
      // grep/rg take the pattern first; a pattern that resolves inside the roots is harmless either way,
      // and one that escapes them (../../etc/passwd) is exactly what we want a card for.
      if (outside(t)) return { verdict: 'ask', danger: false, reason: 'References path outside workspace: ' + t };
    }
  }
  return { verdict: 'allow', danger: false, reason: 'Allowlisted' };
}
