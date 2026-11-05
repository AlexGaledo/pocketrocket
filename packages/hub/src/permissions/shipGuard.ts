import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Bots with this skill attached get the check below, so the owner turns it on per bot by attaching the skill. */
export const SHIP_GUARD_SKILL = 'safe-shipping';

const ALWAYS_PROTECTED = new Set(['main', 'master']);
/** Flags of `git push` that take a separate value, which must not be read as the remote or a branch. */
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
/** Commands that run another command, which hides a push from the parsing below. */
const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'eval', 'xargs', 'env', 'sudo', 'nohup', 'time']);

export interface GitInfo {
  /** The checked out branch, or null when it cannot be told, as on a detached HEAD or outside a repo. */
  currentBranch: (dir: string) => string | null;
  /** The remote's default branch, when the repo knows it. */
  defaultBranch: (dir: string) => string | null;
}

const git = (dir: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};
const realGit: GitInfo = {
  currentBranch: (dir) => git(dir, 'symbolic-ref', '--short', 'HEAD'),
  defaultBranch: (dir) => git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') ?? null,
};

const clean = (t: string) => t.replace(/^['"(]+|['")]+$/g, '');
const REFUSED = 'Pushing to the default branch is blocked for this bot. Push a branch and open a pull request for the owner to review.';

/**
 * Stops a bot pushing to the default branch or merging a pull request. Written rules alone failed this: told to
 * "get it shipped", bots pushed to main in every test run. It reads the command text, so it stops ordinary use, not a
 * bot set on getting around it, and only Claude turns run it.
 */
export function defaultBranchPushDenied(command: string, cwd: string, info: GitInfo = realGit): string | null {
  let dir = cwd;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).map(clean).filter(Boolean);
    while (tokens[0] && /^\w+=/.test(tokens[0])) tokens.shift();
    if (!tokens.length) continue;

    if (tokens[0] === 'cd' && tokens[1]) { dir = path.resolve(dir, tokens[1]); continue; }
    if (tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'merge') return 'Merging a pull request is left to the owner. Open it and say it is ready.';
    if (WRAPPERS.has(tokens[0]) && /\bgit\b.*\bpush\b/.test(segment)) return 'Run git push as a plain command, not inside ' + tokens[0] + ', so it can be checked.';
    if (tokens[0] !== 'git') continue;

    // Options before the subcommand.
    let i = 1;
    let at = dir;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (tokens[i] === '-C') { at = path.resolve(dir, tokens[i + 1] ?? '.'); i += 2; }
      else if (tokens[i] === '-c' || tokens[i] === '--git-dir' || tokens[i] === '--work-tree') i += 2;
      else i += 1;
    }
    if (tokens[i] !== 'push') continue;

    const args = tokens.slice(i + 1);
    const positional: string[] = [];
    for (let a = 0; a < args.length; a++) {
      if (args[a] === '--all' || args[a] === '--mirror') return REFUSED;
      if (PUSH_VALUE_FLAGS.has(args[a])) { a += 1; continue; }
      if (!args[a].startsWith('-')) positional.push(args[a]);
    }

    const current = info.currentBranch(at);
    const protectedNames = new Set(ALWAYS_PROTECTED);
    const remoteDefault = info.defaultBranch(at);
    if (remoteDefault) protectedNames.add(remoteDefault);

    const refs = positional.slice(1);
    if (!refs.length) {
      if (current === null) return 'Could not tell which branch this would push. Name it: git push origin <branch>.';
      if (protectedNames.has(current)) return REFUSED;
      continue;
    }
    for (const ref of refs) {
      const spec = ref.replace(/^\+/, '');
      let target = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
      target = target.replace(/^refs\/heads\//, '');
      if (target === 'HEAD') {
        if (current === null) return 'Could not tell which branch this would push. Name it: git push origin <branch>.';
        target = current;
      }
      if (protectedNames.has(target)) return REFUSED;
    }
  }
  return null;
}
