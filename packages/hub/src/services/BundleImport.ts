import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import { vpsPathOk } from '@pocketrocket/shared';

/**
 * The hub's half of a bundle sync (bridge P5). The PC uploads a git bundle of a session's snapshot commit; the hub
 * checks size and hash while the bytes stream to disk, verifies it with git, and fetches it into the project's VPS copy
 * on one branch, `wip/<machine>/<session>`. It never touches another branch or the working tree, and never runs anything
 * the bundle could carry:
 *
 *   - git runs with a clean environment (no hub token, no user or system config) and every config that can start a
 *     program is overridden on the command line (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, no credential
 *     helper, no `ext::` transport), so a hook or fsmonitor planted in the VPS repo's own `.git` never runs;
 *   - objects are fsck'd on fetch (`fetch.fsckObjects`);
 *   - a new copy starts from `git init` with an empty template (no sample hooks);
 *   - a VPS path that leaves the project folder (by `..`, a symlink or a `.git` file pointing elsewhere) is refused.
 */

export class BundleError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const GIT_TIMEOUT_MS = 120_000;
const NULL_DEVICE = '/dev/null';

/** Config git must not take from the repo's own `.git/config` or any other layer: everything that can run a program. */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  'core.hooksPath=' + NULL_DEVICE,
  'core.fsmonitor=false',
  'core.sshCommand=false',
  'core.askPass=',
  'credential.helper=',
  'protocol.ext.allow=never',
  'fetch.fsckObjects=true',
  'transfer.fsckObjects=true',
  'gc.auto=0',
  'maintenance.auto=false',
];

/** A scrubbed environment for git: it finds itself and a temp HOME, and nothing else, least of all POCKETROCKET_TOKEN. */
export function hardenedGitEnv(home: string): NodeJS.ProcessEnv {
  const keep = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.some((n) => n.toLowerCase() === k.toLowerCase())) env[k] = v;
  env.HOME = home;
  env.USERPROFILE = home;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = NULL_DEVICE;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_ASKPASS = 'echo';
  return env;
}

/** Runs git hardened. Resolves with stdout; rejects with a short, scrubbed message. */
export function hardenedGit(cwd: string, args: string[], home: string): Promise<string> {
  const full = [...HARDENED_GIT_CONFIG.flatMap((c) => ['-c', c]), ...args];
  return new Promise((resolve, reject) => {
    execFile('git', full, { cwd, env: hardenedGitEnv(home), timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (e, stdout, stderr) => {
      if (e) {
        const msg = String(stderr || e.message).replace(/\s+/g, ' ').trim().slice(0, 300);
        reject(new BundleError(400, 'git ' + args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ') + ' failed: ' + msg));
      } else resolve(String(stdout));
    });
  });
}

/** The nearest ancestor of `p` that exists, resolved through symlinks. */
function realNearest(p: string): string {
  let cur = p;
  for (;;) {
    try { return fs.realpathSync(cur); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

const inside = (root: string, p: string, allowSame = false) => {
  const rel = path.relative(root, p);
  return (allowSame || rel !== '') && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** `<projectDir>/<vps>`, refused when `vps` is not a plain relative path or anything on the way is a link out of the project. */
export function vpsDir(projectDir: string, vps: string): string {
  if (!vpsPathOk(vps)) throw new BundleError(400, 'The repo\'s vps path is not a plain relative folder.');
  const root = path.resolve(projectDir);
  const target = path.resolve(root, ...vps.split('/'));
  if (!inside(root, target)) throw new BundleError(400, 'The repo\'s vps path leaves the project folder.');
  if (!inside(realNearest(root), realNearest(target), true)) throw new BundleError(400, 'The repo\'s vps folder resolves outside the project folder.');
  return target;
}

/** Where an uploaded bundle waits for its import. */
export function incomingPath(projectDir: string, vps: string, jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new BundleError(400, 'Bad job id');
  return path.join(vpsDir(projectDir, vps), '.incoming', jobId + '.bundle');
}

export type ReceiveResult = { ok: true; bytes: number } | { ok: false; status: number; error: string };

/**
 * Streams the request body to `file`, counting and hashing as it goes, never holding more than a chunk in memory. Fails
 * when more than `expectBytes` arrive, when fewer do, or when the sha256 differs. The partial file is removed on failure.
 */
export async function receiveToFile(req: IncomingMessage, file: string, o: { expectBytes: number; sha256: string; /** What it is, for the error text. Default 'bundle'. */ what?: string; header?: string }): Promise<ReceiveResult> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > o.expectBytes) return cb(new BundleError(413, 'More bytes than Content-Length'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (e) {
    fs.rmSync(file, { force: true });
    if (e instanceof BundleError) return { ok: false, status: e.status, error: e.message };
    return { ok: false, status: 400, error: 'The upload was cut off' };
  }
  if (bytes !== o.expectBytes) {
    fs.rmSync(file, { force: true });
    return { ok: false, status: 400, error: 'Received ' + bytes + ' bytes but Content-Length said ' + o.expectBytes };
  }
  if (hash.digest('hex') !== o.sha256.toLowerCase()) {
    fs.rmSync(file, { force: true });
    return { ok: false, status: 400, error: 'The ' + (o.what ?? 'bundle') + ' does not match ' + (o.header ?? 'x-bundle-sha256') };
  }
  return { ok: true, bytes };
}

/**
 * Verifies `bundleFile` and fetches its single ref into `branch` of the repo at `<projectDir>/<vps>`, creating that repo
 * if there is none. Returns the commit the branch now points at. Only `refs/heads/<branch>` is written.
 */
export async function importBundle(o: { projectDir: string; vps: string; bundleFile: string; branch: string }): Promise<{ commit: string }> {
  if (!/^wip\/[a-z0-9_-]{1,30}\/[a-z0-9]{1,8}$/.test(o.branch)) throw new BundleError(400, 'Not a wip branch name');
  const dir = vpsDir(o.projectDir, o.vps);
  fs.mkdirSync(dir, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-bundle-'));
  try {
    const gitDir = path.join(dir, '.git');
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(gitDir); } catch { /* no repo yet */ }
    if (!st) {
      const template = path.join(scratch, 'template');
      fs.mkdirSync(template);
      await hardenedGit(dir, ['init', '-q', '--template=' + template], scratch);
    } else if (!st.isDirectory() || st.isSymbolicLink()) {
      // A `.git` file or link can point anywhere.
      throw new BundleError(400, 'The VPS copy\'s .git is not a plain folder.');
    }
    await hardenedGit(dir, ['bundle', 'verify', o.bundleFile], scratch);
    const heads = (await hardenedGit(dir, ['bundle', 'list-heads', o.bundleFile], scratch)).split('\n').map((l) => l.trim()).filter(Boolean);
    if (heads.length !== 1) throw new BundleError(400, 'The bundle must hold exactly one ref (it has ' + heads.length + ').');
    const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(heads[0]);
    if (!m) throw new BundleError(400, 'Unreadable bundle ref.');
    const ref = m[2];
    const head = await hardenedGit(dir, ['symbolic-ref', '-q', 'HEAD'], scratch).catch(() => '');
    if (head.trim() === 'refs/heads/' + o.branch) throw new BundleError(409, o.branch + ' is checked out in the VPS copy; check out another branch first.');
    await hardenedGit(dir, ['fetch', '--no-tags', '--no-write-fetch-head', '-q', '--', o.bundleFile, '+' + ref + ':refs/heads/' + o.branch], scratch);
    const commit = (await hardenedGit(dir, ['rev-parse', '--verify', 'refs/heads/' + o.branch], scratch)).trim();
    if (commit !== m[1]) throw new BundleError(400, 'The fetched branch does not match the bundle.');
    return { commit };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
