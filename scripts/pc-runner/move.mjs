// Move and pull jobs (bridge phase 6): move a session to the VPS so the SAME conversation continues there, and pull it
// back. handleJob (jobs.mjs) dispatches here; the helpers are exported so node:test can drive them against temp repos.
// Importing this file has no side effects.
//
//   move  snapshot + scan EVERY repo first (a blocked scan refuses without asking), one dialog for the whole move, then a
//         bundle per repo (nothing is pushed to any remote) and the session transcript, streamed to the hub.
//   pull  download the session and one bundle per repo, verify everything, one dialog, then: fetch the work into ONLY
//         refs/heads/wip/<machine>/<sid8> of the owner's repo (through a throwaway bare repo), write the server's final
//         files into the working folder when it still equals what was moved (uncommitted edits; HEAD, branches and the
//         real index file are never touched), else leave the folder alone. Last, replace the transcript, keeping a backup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, normaliseRemote, CONFIRM_TIMEOUT_MS } from './lib.mjs';
import { iterLines } from './mirror.mjs';
import {
  makeGit, repoToplevel, originUrls, snapshot, diffStats, scanRepo, makeBundle, wipNames, assertWipRef, syncFileListText,
  SYNC_MAX_BUNDLE_BYTES, SESSION_MAX_BYTES,
} from './sync.mjs';

const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MAX_RAW = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------
// Finding the PC repos

/**
 * Finds the local repo for each spec. Candidates: the session's own repo and the repo each allowlisted folder is in. A
 * candidate must lie inside an allowlisted folder (real paths) and its origin (fetch AND push URL) must be the spec's
 * remote. Returns { repos: [{ spec, top, urls }] } or { error }.
 */
export async function findRepos({ git, config, resume, specs, normalise = normaliseRemote }) {
  const tops = new Set();
  const dirs = [resume.cwd];
  for (const f of Object.values(config?.folders ?? {})) {
    dirs.push(f.path);
    try { // a folder that holds repos side by side: its direct sub-folders that are repos are candidates too
      for (const k of fs.readdirSync(f.path, { withFileTypes: true }).slice(0, 200)) {
        if (k.isDirectory() && fs.existsSync(path.join(f.path, k.name, '.git'))) dirs.push(path.join(f.path, k.name));
      }
    } catch { /* not readable */ }
  }
  for (const dir of dirs) {
    const t0 = await repoToplevel(git, dir);
    const t = t0 && realOf(t0);
    if (t) tops.add(t);
  }
  const folders = Object.values(config?.folders ?? {}).map((f) => realOf(f.path)).filter(Boolean);
  const usable = [...tops].filter((t) => folders.some((f) => isInside(t, f)));
  const found = [];
  for (const spec of specs) {
    const want = normalise(spec.remote);
    if (!want) return { error: `The remote of ${spec.repo} is not a URL this runner recognises; refused.` };
    let hit = null;
    for (const top of usable) {
      let urls;
      try { urls = await originUrls(git, top); } catch { continue; }
      if (normalise(urls.fetchUrl) === want && normalise(urls.pushUrl) === want) { hit = { spec, top, urls, want }; break; }
    }
    if (!hit) {
      const reaches = [...tops].some((t) => !usable.includes(t));
      return { error: `No repo on this PC inside your allowlist has "${spec.repo}" (${want}) as its origin${reaches ? ' (a repo that reaches outside an allowlist folder does not count; allow the whole repo folder in config.json)' : ''}; refused.` };
    }
    found.push(hit);
  }
  return { repos: found };
}

// ---------------------------------------------------------------------------------------------------------
// Working-tree helpers (pull)

/** The tree id of the working folder as a snapshot would see it, built in a temporary index. The real index is untouched. */
export async function workingTreeId({ git, top, tmp }) {
  const env = { GIT_INDEX_FILE: path.join(tmp, 'wt-index') };
  await git(top, ['read-tree', 'HEAD'], { env });
  await git(top, ['add', '-A'], { env, timeoutMs: 180_000 });
  return (await git(top, ['write-tree'], { env })).trim();
}

/** A repo-relative path that is safe to delete: no dot segments, not absolute, never under .git. */
export function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split(/[\\/]/);
  if (segs.some((s) => !s || s === '.' || s === '..')) return false;
  return segs[0].toLowerCase() !== '.git';
}

/**
 * Brings the working folder from `baseTree` to `finalTree` as uncommitted edits: deletes the removed files, writes the
 * added and changed ones with checkout-index from a TEMPORARY index file. HEAD, branches and the real index are never
 * touched. Returns { applied: true, files } or { applied: false, why } (nothing changed in that case).
 */
export async function applyTree({ git, top, tmp, baseTree, finalTree }) {
  const raw = await git(top, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', baseTree, finalTree], { maxBuffer: MAX_RAW });
  const parts = raw.split('\0');
  const del = [], put = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]);
    if (!m) continue;
    const file = parts[++i];
    if (m[1] === '160000' || m[2] === '160000') return { applied: false, why: `a submodule (${file}) changed on the server, which a pull does not apply` };
    if (!safeRelPath(file)) return { applied: false, why: `the server's tree has a path this runner will not write (${JSON.stringify(String(file).slice(0, 80))})` };
    (m[3] === 'D' ? del : put).push(file);
  }
  const realTop = realOf(top);
  for (const f of del) { // deletions first: a file may become a folder or the other way round
    const abs = path.join(top, f);
    const parent = realOf(path.dirname(abs));
    if (!parent || !isInside(parent, realTop)) continue; // a link leads out of the repo: leave it
    try { if (!fs.lstatSync(abs).isDirectory()) fs.unlinkSync(abs); } catch { /* already gone */ }
    for (let dir = path.dirname(abs); isInside(dir, realTop) && path.resolve(dir) !== path.resolve(realTop); dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { break; } // only empty folders go
    }
  }
  if (put.length) {
    const env = { GIT_INDEX_FILE: path.join(tmp, 'apply-index') };
    await git(top, ['read-tree', finalTree], { env });
    await git(top, ['checkout-index', '-f', '-q', '-z', '--stdin'], { env, input: put.join('\0') + '\0', timeoutMs: 180_000 });
  }
  return { applied: true, files: del.length + put.length };
}

// ---------------------------------------------------------------------------------------------------------
// Transcript helpers

/**
 * Checks a downloaded transcript: every non-empty line is a JSON object, and every `cwd` it records sits inside one of
 * `roots` (the PC repos and the session's own folder), so a wrong file cannot make Claude work somewhere else.
 * Returns { lines } or throws.
 */
export async function validateTranscript(file, roots) {
  let lines = 0;
  for await (const { line } of iterLines(file, 0)) {
    if (line === null) throw new Error('the transcript has a line that is too long');
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { throw new Error('the transcript has a line that is not JSON'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('the transcript has a line that is not an object');
    if (typeof o.cwd === 'string' && o.cwd && !roots.some((r) => isInside(path.win32.resolve(o.cwd), r) || isInside(o.cwd, r))) {
      throw new Error('the transcript records a working folder outside your repos');
    }
    lines++;
  }
  if (!lines) throw new Error('the transcript is empty');
  return { lines };
}

async function countLines(file) {
  let n = 0;
  for await (const { line } of iterLines(file, 0)) if (line === null || line.trim()) n++;
  return n;
}

/** Writes `from` over `target`, first copying the old `target` to `<target>.pocketrocket-bak` (not .jsonl: Claude ignores it). */
export async function replaceTranscript(target, from) {
  const bak = `${target}.pocketrocket-bak`;
  const staged = `${target}.pocketrocket-new`;
  fs.copyFileSync(target, bak);
  fs.copyFileSync(from, staged);
  let last;
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(staged, target); return bak; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  fs.rmSync(staged, { force: true });
  throw new Error(`could not replace the transcript (${last?.code || last?.message}); the old one is untouched`);
}

// ---------------------------------------------------------------------------------------------------------
// Dialog text

const baseLines = (job) => [`Bot: @${job.bot.handle}`, `Room: ${job.room.name}`];

export function moveInfoLines({ job, resume, folderName, folder, items, sessionBytes }) {
  const lines = baseLines(job);
  lines.push('MOVE: send this session and its repos to the server; the SAME conversation continues there (Claude is not started on this PC)');
  lines.push(`Session: ${resume?.title || '(untitled)'}  (${kb(sessionBytes)})`);
  lines.push(`Working folder: ${resume?.cwd ?? '?'}`);
  lines.push(`Allowlist folder: ${folderName}  (${folder.path})`);
  lines.push(`Repos (${items.length}), each sent as a bundle to the server; nothing is pushed to any remote:`);
  for (const it of items) {
    lines.push(`  - ${it.spec.repo} (project ${it.spec.project}), origin ${it.want}`);
    lines.push(`    ${plural(it.stats.files, 'changed file')}, +${it.stats.additions} -${it.stats.deletions} lines against HEAD; scan clean (${plural(it.scan.commits, 'commit')}, ${plural(it.scan.files, 'file')} checked for keys and secret files)`);
  }
  lines.push('While it is on the server, this PC will refuse to resume it. Pull it back from PocketRocket when you want it here again.');
  return lines;
}

export function moveFileListText(items) {
  return items.map((it) => `[${it.spec.repo}]\n${syncFileListText(it.stats)}`).join('\n\n');
}

export function pullInfoLines({ job, resume, folderName, folder, items, newLines, oldBytes, newBytes, backupName }) {
  const lines = baseLines(job);
  lines.push('PULL: bring this session back from the server (Claude is not started)');
  lines.push(`Session: ${resume?.title || '(untitled)'}`);
  lines.push(`Working folder: ${resume?.cwd ?? '?'}`);
  lines.push(`Allowlist folder: ${folderName}  (${folder.path})`);
  lines.push(`Transcript: ${plural(newLines, 'new line')} (${kb(oldBytes)} -> ${kb(newBytes)}); the current one is kept as ${backupName}`);
  lines.push(`Repos (${items.length}):`);
  for (const it of items) {
    lines.push(`  - ${it.spec.repo} (project ${it.spec.project}): branch ${it.spec.branch}, ${plural(it.commits, 'commit')}, ${plural(it.stats.files, 'file')} changed on the server (+${it.stats.additions} -${it.stats.deletions})`);
    lines.push(it.canApply
      ? '    Your folder is unchanged since the move: the server\'s files are written into it as uncommitted edits (HEAD, branches and the index are not touched).'
      : `    ${it.reason} Your folder is left alone; the server's work is on branch ${it.spec.branch} for you to merge.`);
  }
  return lines;
}

export function pullFileListText(items) {
  return items.map((it) => `[${it.spec.repo}]\n${syncFileListText(it.stats)}`).join('\n\n');
}

const dialog = (d, job, resume, mode, infoLines, prompt) => d.confirm({
  infoLines, handle: job.bot.handle, room: job.room.name, folderName: resume.folderName, folderPath: resume.folder.path,
  mode, prompt, tools: [], mcpServers: [], runsCode: false, timeoutSec: CONFIRM_TIMEOUT_MS / 1000,
});

// ---------------------------------------------------------------------------------------------------------
// Shared setup

/** git, machine, wip names and the resolved session for a move or pull job; or { fail } (a reason to refuse). */
async function setup(d, job, config, setResolved, h) {
  const machine = d.machine ?? os.hostname();
  const names = wipNames(machine, job.sessionId);
  if (!names) return { fail: 'This session id is too short or odd to name a wip branch; refused.' };
  const git = d.git ?? (d.gitPath ? makeGit(d.gitPath) : null);
  if (!git) return { fail: 'git was not found on this PC (it must be on PATH); refused.' };
  const resume = await h.resolveResume({ sessionId: job.sessionId, config, projectsDir: d.projectsDir?.(config) });
  if (!resume.ok) return { fail: resume.why };
  setResolved(resume.folderName);
  const sessionFile = h.findSessionFile(h.projectsDir, job.sessionId);
  if (!sessionFile) return { fail: `Session ${job.sessionId.slice(0, 60)} is not on this PC (no transcript for it).` };
  return { machine, names, git, resume, sessionFile };
}

// ---------------------------------------------------------------------------------------------------------
// Move

/**
 * A move job. Deps beyond handleJob's: git/gitPath, machine, normalise, makeTmp, uploadBundle(jobId, file, { repo }),
 * uploadSession(jobId, file), holdSession(sessionId). `h` = { resolveResume, findSessionFile, projectsDir } from jobs.mjs.
 */
export async function handleMove(d, job, config, refuse, setResolved, h) {
  const specs = job.move.repos;
  if (!specs.length) return refuse('A move needs at least one linked repo; refused.');
  if (specs.some((s) => s.mode !== 'bundle')) return refuse('A move supports bundle repos only; refused.');
  if (new Set(specs.map((s) => s.repo)).size !== specs.length) return refuse('The move names the same repo twice; refused.');
  if (d.isOnVps?.(job.sessionId)) return refuse('This session is already on the VPS; pull it back before moving it again.');
  const s = await setup(d, job, config, setResolved, h);
  if (s.fail) return refuse(s.fail);
  const { machine, names, git, resume, sessionFile } = s;
  const normalise = d.normalise ?? normaliseRemote;

  const sessionBytes = (() => { try { return fs.statSync(sessionFile).size; } catch { return 0; } })();
  if (!sessionBytes) return refuse('The session transcript is empty or unreadable; refused.');
  if (sessionBytes > SESSION_MAX_BYTES) return refuse(`The session transcript is ${(sessionBytes / 1048576).toFixed(1)} MB; the limit is ${SESSION_MAX_BYTES / 1048576} MB. Start fresh or trim it first.`);

  const found = await findRepos({ git, config, resume, specs, normalise });
  if (found.error) return refuse(found.error);

  const tmp = d.makeTmp ? d.makeTmp() : fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-'));
  try {
    const items = [];
    for (const [i, f] of found.repos.entries()) {
      const sub = path.join(tmp, `r${i}`);
      fs.mkdirSync(sub);
      try {
        const snap = await snapshot({ git, top: f.top, tmp: sub, title: resume.title, sessionId: job.sessionId });
        const stats = await diffStats({ git, top: f.top, head: snap.head, commit: snap.commit });
        const scan = await scanRepo({ git, top: f.top, commit: snap.commit });
        items.push({ ...f, i, sub, snap, stats, scan });
      } catch (e) { return refuse(`Could not snapshot ${f.spec.repo}: ${e.message}`); }
    }
    d.log('move_scanned', { jobId: job.id, repos: items.map((it) => ({ repo: it.spec.repo, files: it.stats.files, blocked: it.scan.blocked, findings: it.scan.findings.length })) });

    // A blocked scan is refused without asking, for the whole move: nothing the owner could approve makes it safe.
    const blocked = items.filter((it) => it.scan.blocked);
    if (blocked.length) {
      const output = `Move blocked: the scan found things that must not leave this PC.\n${blocked.map((it) => `[${it.spec.repo}]\n${it.scan.findings.join('\n')}`).join('\n')}`;
      d.log('job_refused_locally', { jobId: job.id, why: 'move scan blocked' });
      await d.postResult(job.id, { ok: false, refusedLocally: true, output, resolvedFolder: resume.folderName, move: { repos: items.map((it) => ({ repo: it.spec.repo, commit: it.snap.commit, branch: names.branch, scan: { blocked: it.scan.blocked, findings: it.scan.findings } })), sessionBytes: 0 } });
      return;
    }

    const approved = await dialog(d, job, resume, 'move',
      moveInfoLines({ job, resume, folderName: resume.folderName, folder: resume.folder, items, sessionBytes }), moveFileListText(items));
    if (!approved) return refuse('Refused on the PC (Refuse pressed, dialog closed, or no answer in 10 minutes).');
    d.log('job_approved_locally', { jobId: job.id });
    try { await d.startJob(job.id); } catch (e) { d.log('job_start_failed', { jobId: job.id, error: e.message }); return; }

    const started = Date.now();
    const move = { repos: [], sessionBytes: 0 };
    let output;
    try {
      if (!d.uploadBundle || !d.uploadSession) throw new Error('this runner cannot upload');
      for (const it of items) {
        const b = await makeBundle({ git, top: it.top, tmp: it.sub, commit: it.snap.commit, machine, sessionId: job.sessionId, jobId: `${job.id}-${it.i}` });
        if (b.bytes > SYNC_MAX_BUNDLE_BYTES) throw new Error(`the bundle of ${it.spec.repo} is ${(b.bytes / 1048576).toFixed(1)} MB; the limit is ${SYNC_MAX_BUNDLE_BYTES / 1048576} MB`);
        await d.uploadBundle(job.id, b.file, { repo: it.spec.repo });
        // toplevel: the hub swaps this PC prefix for the VPS worktree in the session file (and back on pull).
        move.repos.push({ repo: it.spec.repo, commit: it.snap.commit, branch: b.branch, bundleBytes: b.bytes, toplevel: it.top });
      }
      // A copy, so a transcript that grows while it uploads cannot disagree with its own hash and length.
      const copy = path.join(tmp, 'session.jsonl');
      fs.copyFileSync(sessionFile, copy);
      await d.uploadSession(job.id, copy);
      move.sessionBytes = fs.statSync(copy).size;
      d.holdSession?.(job.sessionId);
      output = `Moved to the server: ${plural(move.repos.length, 'repo')} (${move.repos.map((r) => `${r.repo} ${r.commit.slice(0, 10)}`).join(', ')}) and the session (${kb(move.sessionBytes)}).`;
    } catch (e) {
      d.log('job_finished', { jobId: job.id, ok: false, durationMs: Date.now() - started, error: e.message });
      await d.postResult(job.id, { ok: false, output: `Move failed: ${e.message}`, resolvedFolder: resume.folderName, durationMs: Date.now() - started, move });
      return;
    }
    d.log('job_finished', { jobId: job.id, ok: true, durationMs: Date.now() - started, outputBytes: Buffer.byteLength(output) });
    await d.postResult(job.id, { ok: true, output, resolvedFolder: resume.folderName, durationMs: Date.now() - started, move });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pull

const tryGit = async (git, cwd, args, opts) => { try { return await git(cwd, args, opts); } catch { return null; } };

/**
 * A pull job. Deps beyond handleJob's: git/gitPath, machine, normalise, makeTmp, downloadSession(jobId, dest),
 * downloadBundle(jobId, repo, dest) (both verify the hub's sha256), releaseSession(sessionId). `h` as for moves.
 */
export async function handlePull(d, job, config, refuse, setResolved, h) {
  const specs = job.pull.repos;
  if (!specs.length) return refuse('A pull needs at least one repo; refused.');
  if (new Set(specs.map((s) => s.repo)).size !== specs.length) return refuse('The pull names the same repo twice; refused.');
  const s = await setup(d, job, config, setResolved, h);
  if (s.fail) return refuse(s.fail);
  const { names, git, resume, sessionFile } = s;
  const normalise = d.normalise ?? normaliseRemote;
  if (specs.some((r) => r.branch !== names.branch)) return refuse(`The hub named a branch other than ${names.branch}; a pull only ever writes that one branch. Refused.`);
  if (!d.downloadSession || !d.downloadBundle) return refuse('This runner cannot download; refused.');

  const found = await findRepos({ git, config, resume, specs, normalise });
  if (found.error) return refuse(found.error);

  const tmp = d.makeTmp ? d.makeTmp() : fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pull-'));
  try {
    // 1. Download and verify everything; nothing on this PC is changed yet except the throwaway folders.
    const roots = [realOf(resume.cwd) ?? resume.cwd, ...found.repos.map((f) => f.top)];
    const newSession = path.join(tmp, 'session.jsonl');
    let transcript;
    try {
      await d.downloadSession(job.id, newSession);
      transcript = await validateTranscript(newSession, roots);
    } catch (e) { return refuse(`The session from the server cannot be used: ${e.message}`); }
    const items = [];
    for (const [i, f] of found.repos.entries()) {
      const sub = path.join(tmp, `r${i}`);
      fs.mkdirSync(sub);
      try {
        const bundle = path.join(sub, 'in.bundle');
        await d.downloadBundle(job.id, f.spec.repo, bundle);
        // A throwaway bare repo that borrows the owner's objects: the bundle is checked and unpacked here, not in the owner's repo.
        const bare = path.join(sub, 'bare.git');
        await git(sub, ['init', '--bare', '--quiet', bare]);
        const common = (await git(f.top, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
        fs.writeFileSync(path.join(bare, 'objects', 'info', 'alternates'), path.join(common, 'objects') + '\n');
        await git(bare, ['bundle', 'verify', bundle]);
        const ref = `refs/heads/${f.spec.branch}`;
        assertWipRef(ref, s.machine, job.sessionId);
        await git(bare, ['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--', bundle, `+${ref}:${ref}`], { timeoutMs: 180_000 });
        const tip = (await git(bare, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
        const base = f.spec.baseCommit;
        if (await tryGit(git, bare, ['cat-file', '-e', `${base}^{commit}`]) === null) throw new Error('the bundle does not contain the commit that was moved');
        const descends = await tryGit(git, bare, ['merge-base', '--is-ancestor', base, tip]) !== null;
        const stats = await diffStats({ git, top: bare, head: base, commit: tip });
        const commits = Number((await git(bare, ['rev-list', '--count', `${base}..${tip}`])).trim()) || 0;
        const baseTree = (await git(bare, ['rev-parse', `${base}^{tree}`])).trim();
        const finalTree = (await git(bare, ['rev-parse', `${tip}^{tree}`])).trim();
        const nowTree = await workingTreeId({ git, top: f.top, tmp: sub });
        let canApply = true, reason = '';
        if (!descends) { canApply = false; reason = 'The server\'s branch does not continue from what was moved.'; }
        else if (nowTree !== baseTree) { canApply = false; reason = 'Your folder changed since the move.'; }
        items.push({ ...f, i, sub, bare, tip, base, stats, commits, baseTree, finalTree, canApply, reason });
      } catch (e) { return refuse(`The bundle for ${f.spec.repo} cannot be used: ${e.message}`); }
    }

    const oldBytes = fs.statSync(sessionFile).size;
    const oldLines = await countLines(sessionFile);
    const approved = await dialog(d, job, resume, 'pull',
      pullInfoLines({ job, resume, folderName: resume.folderName, folder: resume.folder, items, newLines: Math.max(0, transcript.lines - oldLines), oldBytes, newBytes: fs.statSync(newSession).size, backupName: `${path.basename(sessionFile)}.pocketrocket-bak` }),
      pullFileListText(items));
    if (!approved) return refuse('Refused on the PC (Refuse pressed, dialog closed, or no answer in 10 minutes).');
    d.log('job_approved_locally', { jobId: job.id });
    try { await d.startJob(job.id); } catch (e) { d.log('job_start_failed', { jobId: job.id, error: e.message }); return; }

    // 2. Do it. Branches first (harmless), then the working folders, then the transcript.
    const started = Date.now();
    const pull = { repos: [], sessionBytes: 0 };
    const notes = [];
    try {
      for (const it of items) {
        const ref = `refs/heads/${it.spec.branch}`;
        assertWipRef(ref, s.machine, job.sessionId);
        await git(it.top, ['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', it.bare, `+${ref}:${ref}`], { timeoutMs: 180_000 });
      }
      for (const it of items) {
        let applied = false, note = it.reason;
        if (it.canApply) {
          if (it.baseTree === it.finalTree) { applied = true; note = 'no file changes on the server'; }
          else {
            const r = await applyTree({ git, top: it.top, tmp: it.sub, baseTree: it.baseTree, finalTree: it.finalTree });
            applied = r.applied;
            note = r.applied ? `${plural(r.files, 'file')} written as uncommitted changes` : r.why;
          }
        }
        pull.repos.push({ repo: it.spec.repo, commit: it.tip, applied, note });
        notes.push(applied ? `${it.spec.repo}: ${note}.` : `${it.spec.repo}: ${note} Your folder was left alone; the VPS work is on branch ${it.spec.branch} - merge it yourself.`);
      }
      const bak = await replaceTranscript(sessionFile, newSession);
      pull.sessionBytes = fs.statSync(sessionFile).size;
      d.releaseSession?.(job.sessionId);
      notes.push(`Session transcript replaced (${kb(pull.sessionBytes)}); the old one is kept as ${path.basename(bak)}.`);
    } catch (e) {
      d.log('job_finished', { jobId: job.id, ok: false, durationMs: Date.now() - started, error: e.message });
      await d.postResult(job.id, { ok: false, output: `Pull failed: ${e.message}${notes.length ? `\n${notes.join('\n')}` : ''}`, resolvedFolder: resume.folderName, durationMs: Date.now() - started, pull });
      return;
    }
    const output = notes.join('\n');
    d.log('job_finished', { jobId: job.id, ok: true, durationMs: Date.now() - started, outputBytes: Buffer.byteLength(output) });
    await d.postResult(job.id, { ok: true, output, resolvedFolder: resume.folderName, durationMs: Date.now() - started, pull });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
