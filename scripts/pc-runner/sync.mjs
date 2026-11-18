// Sync jobs: copy a session's repo to the server as a work-in-progress snapshot, after a secret scan.
// The git and network pieces live here so node:test can drive them against temp repos and a stub hub; jobs.mjs
// (handleSync) holds the job flow. Importing this file has no side effects.
//
// What it never does: touch the owner's working tree, index, HEAD, branches or stash. The snapshot is built in a
// temporary index file (GIT_INDEX_FILE), turned into a commit with write-tree + commit-tree, and nothing but that
// commit's objects land in the repo. The only ref it ever pushes is refs/heads/wip/<machine>/<sid8>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { gitHardenedEnv, GIT_FORCED_CONFIG } from './lib.mjs';
import { findSecretShape } from './scrub.mjs';

export const SYNC_MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const MAX_SCAN_COMMITS = 500;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_FINDINGS = 30;
const MAX_LISTED_FILES = 200;

// ---------------------------------------------------------------------------------------------------------
// Names

/** The machine part of the wip branch: the host name, lower-cased, [a-z0-9-] only, at most 30 characters. */
export function sanitizeMachine(hostname) {
  const m = String(hostname ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  return m || 'pc';
}

/** The first 8 characters of a session id, or null when it has fewer or an odd one. */
export function sidPrefix(sessionId) {
  const s = typeof sessionId === 'string' ? sessionId.slice(0, 8) : '';
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7}$/.test(s) ? s : null;
}

/** { branch: 'wip/<machine>/<sid8>', ref: 'refs/heads/wip/<machine>/<sid8>' }, or null when the session id is unusable. */
export function wipNames(machine, sessionId) {
  const sid8 = sidPrefix(sessionId);
  if (!sid8) return null;
  const branch = `wip/${sanitizeMachine(machine)}/${sid8}`;
  return { branch, ref: `refs/heads/${branch}` };
}

/** Throws unless `ref` is exactly the one wip ref this machine and session may push. Called right before every push. */
export function assertWipRef(ref, machine, sessionId) {
  const want = wipNames(machine, sessionId);
  if (!want || ref !== want.ref || !/^refs\/heads\/wip\/[a-z0-9-]+\/[A-Za-z0-9_-]{8}$/.test(ref)) {
    throw new Error(`refusing to push ${JSON.stringify(String(ref).slice(0, 80))}: only ${want ? want.ref : 'a wip/<machine>/<session> branch'} may be pushed`);
  }
}

/** The commit message: one line, no control characters. */
export function wipMessage(title, sessionId) {
  const t = String(title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
  return `wip: ${t} (${sessionId})`;
}

// ---------------------------------------------------------------------------------------------------------
// Scan rules (paths)

/** Why a file path must never be synced, or null. Matches on the file name, case-insensitively. */
export function blockedPathReason(file) {
  const base = String(file).split(/[\\/]/).pop().toLowerCase();
  if (base === '.env.example') return null;
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env_') || base === '.envrc') return 'an environment file (.env*)';
  if (/\.(pem|p8|p12|key|keystore)$/.test(base)) return `a key or certificate file (*.${base.split('.').pop()})`;
  if (base.startsWith('id_rsa')) return 'an SSH private key (id_rsa*)';
  return null;
}

/**
 * Scans `git log -p` output (-U0, one "@@commit <sha>" line per commit): only added lines are looked at. Returns
 * finding strings such as "src/a.js: looks like an API key (sk-)", never the secret itself.
 */
export function scanPatchText(text) {
  const found = new Set();
  let file = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6).replace(/\t.*$/, '').replace(/\r$/, '') : null; continue; }
    if (line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('@@')) continue;
    if (line[0] !== '+' || !file) continue;
    const why = findSecretShape(line.slice(1));
    if (why) found.add(`${file}: looks like ${why}`);
  }
  return [...found];
}

// ---------------------------------------------------------------------------------------------------------
// git

/** The caller's hardened git environment plus a few more forced settings that matter when committing and pushing. */
export function syncGitEnv(baseEnv, extra = {}) {
  const env = gitHardenedEnv(baseEnv);
  const more = [['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['push.gpgSign', 'false'], ['core.quotePath', 'false']];
  let n = GIT_FORCED_CONFIG.length;
  for (const [k, v] of more) { env[`GIT_CONFIG_KEY_${n}`] = k; env[`GIT_CONFIG_VALUE_${n}`] = v; n++; }
  env.GIT_CONFIG_COUNT = String(n);
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'PocketRocket', GIT_AUTHOR_EMAIL: 'pocketrocket@localhost',
    GIT_COMMITTER_NAME: 'PocketRocket', GIT_COMMITTER_EMAIL: 'pocketrocket@localhost',
  }, extra);
  return env;
}

/** Removes credentials from a URL-looking string before it goes into an error or a log. */
const clean = (s) => String(s).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');

/**
 * A git runner: git(cwd, args, { env, input, timeoutMs, maxBuffer }) -> stdout string. `-C <cwd>` is added; git is
 * the absolute path given, never a shell string, and runs from the temp folder so no repo's own files are "current".
 */
export function makeGit(gitPath, baseEnv = process.env) {
  return (cwd, args, { env = {}, input, timeoutMs = 60_000, maxBuffer = 8 * 1024 * 1024 } = {}) => new Promise((resolve, reject) => {
    const child = execFile(gitPath, ['-C', cwd, ...args], { env: syncGitEnv(baseEnv, env), cwd: os.tmpdir(), timeout: timeoutMs, windowsHide: true, maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(`git ${args[0]} failed: ${clean(String(stderr || err.message)).trim().slice(-400)}`);
          e.code = err.code; e.stderr = clean(String(stderr ?? ''));
          return reject(e);
        }
        resolve(String(stdout));
      });
    if (input !== undefined) child.stdin.end(input); else child.stdin?.end();
  });
}

/** The repo's top folder for `cwd`, or null. */
export async function repoToplevel(git, cwd) {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null; } catch { return null; }
}

/** The URLs `origin` fetches from and pushes to, as git resolves them (insteadOf / pushInsteadOf applied). */
export async function originUrls(git, top) {
  const fetchUrl = (await git(top, ['remote', 'get-url', 'origin'])).trim();
  const pushUrl = (await git(top, ['remote', 'get-url', '--push', 'origin'])).trim();
  return { fetchUrl, pushUrl };
}

/**
 * Builds the snapshot commit without touching the owner's repo state: a fresh index file in `tmp` starts from HEAD,
 * `add -A` puts in everything not ignored (edits, deletions and untracked files) and the tree becomes a commit on top
 * of HEAD. Returns { commit, head, tree }. The caller deletes `tmp`.
 */
export async function snapshot({ git, top, tmp, title, sessionId }) {
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  let head;
  try { head = (await git(top, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(); } catch { throw new Error('this repo has no commits yet, so there is nothing to snapshot on top of'); }
  await git(top, ['read-tree', 'HEAD'], { env });
  await git(top, ['add', '-A'], { env, timeoutMs: 180_000 });
  const tree = (await git(top, ['write-tree'], { env })).trim();
  const commit = (await git(top, ['commit-tree', tree, '-p', head, '-m', wipMessage(title, sessionId)], { env })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('git did not return a commit id');
  return { commit, head, tree };
}

/** Size of the snapshot against HEAD: { files, additions, deletions, list } (list capped, `more` counts the rest). */
export async function diffStats({ git, top, head, commit }) {
  const out = await git(top, ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', head, commit]);
  let files = 0, additions = 0, deletions = 0;
  const list = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (!m) continue;
    files++;
    if (m[1] !== '-') additions += Number(m[1]);
    if (m[2] !== '-') deletions += Number(m[2]);
    if (list.length < MAX_LISTED_FILES) list.push(m[3]);
  }
  return { files, additions, deletions, list, more: Math.max(0, files - list.length) };
}

/**
 * The pre-push scan. It covers everything the push would add to the remote: the snapshot commit plus any commits
 * that are not on origin yet (`<commit> --not --remotes=origin`). Paths are checked by name; added lines by shape.
 * A scan that cannot finish (too many commits, too much text, git failing) blocks. Returns
 * { blocked, findings: string[], commits, files }.
 */
export async function scanRepo({ git, top, commit }) {
  const range = [commit, '--not', '--remotes=origin'];
  const fail = (why) => ({ blocked: true, findings: [why], commits: 0, files: 0 });
  let commits;
  try { commits = Number((await git(top, ['rev-list', '--count', ...range])).trim()); } catch (e) { return fail(`scan failed: ${e.message}`); }
  if (!Number.isInteger(commits)) return fail('scan failed: could not count the commits to push');
  if (commits > MAX_SCAN_COMMITS) return fail(`${commits} commits are not on origin yet (the scan covers ${MAX_SCAN_COMMITS}); push them with your normal workflow first`);
  const findings = new Set();
  let names, patch;
  try {
    names = await git(top, ['log', '--no-merges', '--no-renames', '--name-only', '-z', '--format=', '--diff-filter=d', ...range], { maxBuffer: MAX_SCAN_BYTES });
    patch = await git(top, ['log', '--no-merges', '--no-renames', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--format=@@commit %H', ...range], { maxBuffer: MAX_SCAN_BYTES });
  } catch (e) {
    return fail(e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'the changes are too large to scan, so nothing was sent' : `scan failed: ${e.message}`);
  }
  const paths = [...new Set(names.split('\0').filter(Boolean))];
  for (const p of paths) { const why = blockedPathReason(p); if (why) findings.add(`${p}: is ${why}`); }
  for (const f of scanPatchText(patch)) findings.add(f);
  const all = [...findings];
  const shown = all.slice(0, MAX_FINDINGS);
  if (all.length > MAX_FINDINGS) shown.push(`... and ${all.length - MAX_FINDINGS} more`);
  return { blocked: all.length > 0, findings: shown, commits, files: paths.length };
}

/**
 * Pushes `commit` to the one wip ref, with a lease on exactly that ref (the value read from the remote a moment ago,
 * or "must not exist yet"). The refspec is built here and asserted; no other ref can be named. `url` is the push URL
 * handleSync already matched against the project's remote; the push runs from a scratch repo (see below) so the
 * owner's repo gets no remote-tracking ref. ssh runs in BatchMode.
 */
export async function pushWip({ git, top, url, commit, machine, sessionId }) {
  const names = wipNames(machine, sessionId);
  if (!names) throw new Error('the session id cannot name a wip branch');
  const { ref } = names;
  assertWipRef(ref, machine, sessionId);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('not a commit id');
  const env = { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  if (typeof url !== 'string' || !url.trim() || url.startsWith('-')) throw new Error('no remote URL to push to');
  // Push from a throwaway bare repo that borrows the owner's objects (alternates), not from the owner's repo: newer
  // git (seen on 2.5x) matches a pushed URL to the configured remote with that URL and then writes a remote-tracking
  // ref into the owner's repo. The scratch repo has no remotes, so nothing is written back anywhere.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-push-'));
  try {
    const bare = path.join(scratch, 'push-src.git');
    await git(scratch, ['init', '--bare', '--quiet', bare]);
    const common = (await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    fs.writeFileSync(path.join(bare, 'objects', 'info', 'alternates'), path.join(common, 'objects') + '\n');
    await git(bare, ['update-ref', ref, commit]);
    const listed = (await git(bare, ['ls-remote', '--refs', '--', url, ref], { env, timeoutMs: 60_000 })).trim();
    const have = /^([0-9a-f]{40,64})\s+(\S+)$/m.exec(listed);
    const expect = have && have[2] === ref ? have[1] : '';
    await git(bare, ['push', '--no-verify', `--force-with-lease=${ref}:${expect}`, '--', url, `${ref}:${ref}`], { env, timeoutMs: 180_000 });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { branch: names.branch, ref };
}

/**
 * A bundle of the snapshot commit (its full history), written to `<tmp>/<jobId>.bundle`. git can only bundle refs, and
 * the owner's repo must get none, so the commit is pushed into a throwaway bare repo under `tmp` and bundled from there.
 * Returns { file, bytes, branch }.
 */
export async function makeBundle({ git, top, tmp, commit, machine, sessionId, jobId }) {
  const names = wipNames(machine, sessionId);
  if (!names) throw new Error('the session id cannot name a wip branch');
  assertWipRef(names.ref, machine, sessionId);
  const bare = path.join(tmp, 'bundle-src.git');
  await git(tmp, ['init', '--bare', '--quiet', bare]);
  await git(top, ['push', '--no-verify', bare, `${commit}:${names.ref}`], { timeoutMs: 180_000 });
  const file = path.join(tmp, `${String(jobId).replace(/[^A-Za-z0-9_-]/g, '_')}.bundle`);
  await git(bare, ['bundle', 'create', file, names.ref], { timeoutMs: 180_000 });
  return { file, bytes: fs.statSync(file).size, branch: names.branch };
}

// ---------------------------------------------------------------------------------------------------------
// Upload

/** sha256 of a file, streamed. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Streams `file` to POST <baseUrl>/api/pc-runner/jobs/<id>/bundle as application/octet-stream with Content-Length and
 * x-bundle-sha256, bearer token as for every runner request. `guard()` throws unless the tunnel is verified (the token
 * goes nowhere else). The size cap is checked before anything is sent. Resolves { status } for a 2xx; throws otherwise.
 */
export async function uploadBundleFile({ baseUrl, token, jobId, file, guard = () => {}, maxBytes = SYNC_MAX_BUNDLE_BYTES, timeoutMs = 15 * 60_000 }) {
  const bytes = fs.statSync(file).size;
  if (bytes > maxBytes) throw new Error(`the bundle is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB`);
  if (bytes === 0) throw new Error('the bundle is empty');
  const sha = await sha256File(file);
  guard();
  const url = new URL(`${baseUrl}/api/pc-runner/jobs/${encodeURIComponent(jobId)}/bundle`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', timeout: timeoutMs,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes), 'x-bundle-sha256': sha },
    }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve({ status: res.statusCode, bytes, sha256: sha }) : reject(new Error(`bundle upload -> HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('bundle upload timed out')));
    req.on('error', (e) => reject(new Error(`bundle upload failed: ${e.code || e.message}`)));
    fs.createReadStream(file).on('error', (e) => req.destroy(e)).pipe(req);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Dialog text

/**
 * The lines the Run / Refuse dialog shows for a sync job. `repo` is { name, remote (credential-free), mode }, `names`
 * is wipNames(), `stats` is diffStats(), `scan` is scanRepo().
 */
export function syncInfoLines({ job, resume, folderName, folder, remote, names, stats, scan }) {
  const spec = job.sync;
  const lines = [`Bot: @${job.bot.handle}`, `Room: ${job.room.name}`];
  lines.push('SYNC: copy this session\'s repo to the server (Claude is not started)');
  lines.push(`Repo: ${spec.repo}  (project ${spec.project})`);
  lines.push(`Remote: ${remote}`);
  lines.push(`Mode: ${spec.mode === 'bundle' ? 'bundle' : 'push a work-in-progress branch'}`);
  lines.push(spec.mode === 'bundle'
    ? 'Target: bundle to the server (nothing is pushed to the remote)'
    : `Target: branch ${names.branch} on the remote (never main or any other branch)`);
  lines.push(`Changes: ${stats.files} file${stats.files === 1 ? '' : 's'}, +${stats.additions} -${stats.deletions} lines against HEAD (edits and untracked files; ignored files are left out)`);
  lines.push(scan.blocked ? `Scan: BLOCKED (${scan.findings.length} finding${scan.findings.length === 1 ? '' : 's'})`
    : `Scan: clean (${scan.commits} commit${scan.commits === 1 ? '' : 's'}, ${scan.files} file${scan.files === 1 ? '' : 's'} checked for keys and secret files)`);
  lines.push(`Session: ${resume?.title || '(untitled)'}`);
  lines.push(`Working folder: ${resume?.cwd ?? '?'}`);
  lines.push(`Allowlist folder: ${folderName}  (${folder.path})`);
  return lines;
}

/** The dialog's big box for a sync job: the changed files, so the owner sees what leaves this PC. */
export function syncFileListText(stats) {
  if (!stats.list.length) return '(no changes against HEAD: only the commits you already have are involved)';
  return stats.list.join('\n') + (stats.more ? `\n... and ${stats.more} more` : '');
}
