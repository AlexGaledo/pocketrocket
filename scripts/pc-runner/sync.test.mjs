// node --test scripts/pc-runner
// Sync jobs against real git: temp repos and a temp bare "remote" only, never a real remote. The git-level tests run
// anywhere git is installed; the job-flow tests need Windows paths (resolveResume) and are skipped elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleJob } from './jobs.mjs';
import { findGit } from './mirror.mjs';
import { validateConfig, normaliseRemote } from './lib.mjs';
import {
  makeGit, sanitizeMachine, wipNames, assertWipRef, wipMessage, blockedPathReason, scanPatchText, snapshot, diffStats, scanRepo,
  pushWip, makeBundle, uploadBundleFile, sha256File, syncInfoLines, syncFileListText, SYNC_MAX_BUNDLE_BYTES,
} from './sync.mjs';

const GIT_PATH = findGit();
const noGit = { skip: !GIT_PATH && 'git is not installed' };
const win = { skip: (process.platform !== 'win32' && 'Windows paths') || (!GIT_PATH && 'git is not installed') };
const SID = '11111111-2222-3333-4444-555555555555';
const SID8 = '11111111';
const MACHINE = 'testbox';
const WIP = `refs/heads/wip/${MACHINE}/${SID8}`;
const REMOTE = 'https://example.test/org/app.git';
// Test remotes are local paths; they have no https form, so the tests compare a stand-in canonical form for those.
const norm = (u) => normaliseRemote(u) ?? `local:${String(u).replace(/\\/g, '/').toLowerCase()}`;

// Built at run time so this file holds no key-shaped text.
const FAKE_ANT = 'sk-' + 'ant-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const FAKE_PEM_LINE = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

const git = GIT_PATH ? makeGit(GIT_PATH) : null;

/** A scratch world: <root>/work/app (a repo whose origin is the bare <root>/remote.git, with main pushed). */
async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sync-test-')));
  const w = { root, remote: path.join(root, 'remote.git'), work: path.join(root, 'work'), repo: path.join(root, 'work', 'app'), tmpRoot: path.join(root, 'tmp'), projects: path.join(root, 'projects') };
  for (const d of [w.work, w.tmpRoot, w.projects]) fs.mkdirSync(d, { recursive: true });
  await git(root, ['init', '--bare', '--quiet', '-b', 'main', w.remote]);
  await git(root, ['init', '--quiet', '-b', 'main', w.repo]);
  await git(w.repo, ['remote', 'add', 'origin', w.remote]);
  const put = (rel, text) => { const f = path.join(w.repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  w.put = put;
  put('a.txt', 'one\n');
  put('keep.txt', 'keep\n');
  put('gone.txt', 'gone soon\n');
  put('.gitignore', 'ignored.log\n');
  await git(w.repo, ['add', '-A']);
  await git(w.repo, ['commit', '-q', '-m', 'first']);
  await git(w.repo, ['push', '-q', 'origin', 'main']);
  w.sh = (args, opts) => git(w.repo, args, opts);
  /** Everything about the owner's repo state a sync must not change. */
  w.state = async () => ({
    status: await w.sh(['status', '--porcelain=v1', '-z', '--ignored']),
    head: (await w.sh(['rev-parse', 'HEAD'])).trim(),
    branches: await w.sh(['branch', '-a', '-vv']),
    refs: await w.sh(['for-each-ref']),
    stash: await w.sh(['stash', 'list']),
    index: crypto.createHash('sha256').update(fs.readFileSync(path.join(w.repo, '.git', 'index'))).digest('hex'),
    a: fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'),
  });
  w.remoteRefs = async () => (await git(w.remote, ['for-each-ref', '--format=%(refname) %(objectname)'])).trim().split('\n').filter(Boolean);
  w.done = () => fs.rmSync(root, { recursive: true, force: true });
  return w;
}

/** Snapshot + scan like handleSync does, in a fresh temp folder. */
async function snapAndScan(w) {
  const tmp = fs.mkdtempSync(path.join(w.tmpRoot, 't-'));
  try {
    const snap = await snapshot({ git, top: w.repo, tmp, title: 'A title', sessionId: SID });
    return { snap, scan: await scanRepo({ git, top: w.repo, commit: snap.commit }) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

test('names: machine sanitising, wip branch names, and the push assertion', () => {
  assert.equal(sanitizeMachine('DESKTOP-ABC_1.local'), 'desktop-abc-1-local');
  assert.equal(sanitizeMachine('  --Alex PC--  '), 'alex-pc');
  assert.equal(sanitizeMachine('???'), 'pc');
  assert.equal(sanitizeMachine('a'.repeat(80)).length, 30);
  assert.deepEqual(wipNames('Test Box', SID), { branch: 'wip/test-box/11111111', ref: 'refs/heads/wip/test-box/11111111' });
  assert.equal(wipNames(MACHINE, 'short'), null);
  assert.equal(wipNames(MACHINE, '../../x/yyyy'), null);
  assert.doesNotThrow(() => assertWipRef(WIP, MACHINE, SID));
  for (const bad of ['refs/heads/main', 'refs/heads/master', 'refs/heads/staging', 'main', 'refs/tags/v1', `+${WIP}`, `${WIP}:refs/heads/main`,
    `refs/heads/wip/${MACHINE}/22222222`, `refs/heads/wip/other/${SID8}`, `refs/heads/wip/${MACHINE}/${SID8}/x`, 'refs/heads/wip/testbox/../main', '', undefined]) {
    assert.throws(() => assertWipRef(bad, MACHINE, SID), /refusing to push/, String(bad));
  }
  assert.equal(wipMessage('Fix\nthe  bug\u0000', SID), `wip: Fix the bug (${SID})`);
  assert.equal(wipMessage('', SID), `wip: untitled (${SID})`);
});

test('scan rules for paths', () => {
  for (const p of ['.env', 'app/.env', '.env.local', '.env.production', 'x/.ENV', '.envrc', 'cert.pem', 'k/AuthKey_X.p8', 'a.p12', 'server.key', 'id_rsa', 'id_rsa.pub', 'release.keystore']) {
    assert.ok(blockedPathReason(p), p);
  }
  for (const p of ['.env.example', 'sub/.env.example', 'README.md', 'src/environment.ts', 'keyboard.ts', 'monkey.js', 'idea.txt']) assert.equal(blockedPathReason(p), null, p);
});

test('scan rules for added lines: shapes are found, the finding never repeats the secret', () => {
  const patch = [
    '@@commit abc', 'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -0,0 +1,3 @@',
    `+const k = "${FAKE_ANT}";`, '+const ok = skeletonLoaderComponentWithLongName;', '+// bearer authentication is documented here',
    `-removed ${FAKE_ANT}`,
    'diff --git a/k.txt b/k.txt', '--- /dev/null', '+++ b/k.txt', '@@ -0,0 +1 @@', `+${FAKE_PEM_LINE}`,
    'diff --git a/gone b/gone', '--- a/gone', '+++ /dev/null', '@@ -1 +0,0 @@', `-${FAKE_ANT}`,
  ].join('\n');
  const f = scanPatchText(patch);
  assert.deepEqual(f, ['src/a.js: looks like an API key (sk-)', 'k.txt: looks like a private key block']);
  for (const line of ['+AKIA' + 'ABCDEFGHIJKLMNOP', '+ghp_' + 'a'.repeat(30), '+token xoxb-' + '1234567890-abc', '+x eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(12) + '.' + 'c'.repeat(12)]) {
    assert.equal(scanPatchText(`+++ b/f\n${line}`).length, 1, line);
  }
  assert.equal(scanPatchText('+++ b/f\n+const a = 1;\n+password = "hunter2"\n+mail me@example.com').length, 0);
  assert.ok(!JSON.stringify(f).includes('a1B2c3D4'));
});

test('dialog text builder: SYNC, repo, remote, mode, target, size, scan', () => {
  const job = { bot: { handle: 'owner' }, room: { name: '(from the app)' }, sync: { project: 'wika', repo: 'app', remote: REMOTE, mode: 'wip-branch', protected: [] } };
  const base = { job, resume: { title: 'Fix login', cwd: 'C:\\w\\app' }, folderName: 'work', folder: { path: 'C:\\w' }, remote: 'https://example.test/org/app', names: wipNames(MACHINE, SID) };
  const stats = { files: 14, additions: 230, deletions: 41, list: ['a.js', 'b.js'], more: 12 };
  const text = syncInfoLines({ ...base, stats, scan: { blocked: false, findings: [], commits: 3, files: 14 } }).join('\n');
  assert.match(text, /^SYNC: /m);
  assert.match(text, /^Repo: app {2}\(project wika\)$/m);
  assert.match(text, /^Remote: https:\/\/example\.test\/org\/app$/m);
  assert.match(text, /^Mode: push a work-in-progress branch$/m);
  assert.match(text, /^Target: branch wip\/testbox\/11111111 on the remote \(never main or any other branch\)$/m);
  assert.match(text, /^Changes: 14 files, \+230 -41 lines/m);
  assert.match(text, /^Scan: clean \(3 commits, 14 files checked/m);
  assert.match(text, /Session: Fix login/);
  const bundle = syncInfoLines({ ...base, job: { ...job, sync: { ...job.sync, mode: 'bundle' } }, stats: { ...stats, files: 1 }, scan: { blocked: true, findings: ['x'], commits: 1, files: 1 } }).join('\n');
  assert.match(bundle, /^Mode: bundle$/m);
  assert.match(bundle, /^Target: bundle to the server \(nothing is pushed to the remote\)$/m);
  assert.match(bundle, /^Changes: 1 file, /m);
  assert.match(bundle, /^Scan: BLOCKED \(1 finding\)$/m);
  assert.doesNotMatch(bundle, /wip\/testbox/);
  assert.equal(syncFileListText(stats), 'a.js\nb.js\n... and 12 more');
  assert.match(syncFileListText({ files: 0, list: [], more: 0 }), /no changes/);
});

// ---------------------------------------------------------------------------------------------------------
// Snapshot and scan against real repos

test('snapshot: includes edits, deletions and untracked files; the owner\'s repo state is byte-identical', noGit, async () => {
  const w = await world();
  try {
    w.put('a.txt', 'one\nchanged\n');
    w.put('new/untracked.txt', 'brand new\n');
    w.put('ignored.log', 'noise\n');
    fs.rmSync(path.join(w.repo, 'gone.txt'));
    await w.sh(['add', 'keep.txt']); // a staged (unchanged) path is fine; the index must still be exactly as it was
    w.put('keep.txt', 'keep\nstaged-then-edited\n');
    await w.sh(['add', 'keep.txt']);
    w.put('keep.txt', 'keep\nstaged-then-edited\nunstaged too\n');
    await w.sh(['stash', 'list']);
    const before = await w.state();
    const { snap, scan } = await snapAndScan(w);
    const after = await w.state();
    assert.deepEqual(after, before, 'status, HEAD, branches, refs, stash, index file and working file are all unchanged');

    const files = (await w.sh(['ls-tree', '-r', '--name-only', snap.commit])).trim().split('\n').sort();
    assert.deepEqual(files, ['.gitignore', 'a.txt', 'keep.txt', 'new/untracked.txt']);
    assert.equal(await w.sh(['show', `${snap.commit}:a.txt`]), 'one\nchanged\n');
    assert.equal(await w.sh(['show', `${snap.commit}:keep.txt`]), 'keep\nstaged-then-edited\nunstaged too\n');
    assert.equal((await w.sh(['rev-parse', `${snap.commit}^`])).trim(), before.head, 'the snapshot sits on top of HEAD');
    assert.match(await w.sh(['log', '-1', '--format=%s', snap.commit]), /^wip: A title \(1111/);
    assert.equal(scan.blocked, false, scan.findings.join('; '));
    const stats = await diffStats({ git, top: w.repo, head: snap.head, commit: snap.commit });
    assert.equal(stats.files, 4); // a.txt, gone.txt (deleted), keep.txt, new/untracked.txt
    assert.ok(stats.additions >= 4 && stats.deletions >= 1);
    assert.ok(stats.list.includes('new/untracked.txt'));
  } finally { w.done(); }
});

test('snapshot: a repo with no commits is refused with a reason', noGit, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sync-test-'));
  try {
    await git(root, ['init', '--quiet', '-b', 'main', path.join(root, 'r')]);
    await assert.rejects(snapshot({ git, top: path.join(root, 'r'), tmp: root, title: 't', sessionId: SID }), /no commits/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scan: blocks .env, *.pem, an sk-ant key and a private key block; allows .env.example', noGit, async () => {
  const cases = [
    ['.env file', () => ['.env', 'DEBUG=1\n'], /\.env: is an environment file/],
    ['nested .env.local', () => ['deep/dir/.env.local', 'X=1\n'], /\.env\.local: is an environment file/],
    ['pem file', () => ['certs/server.pem', 'not even a real cert\n'], /server\.pem: is a key or certificate file/],
    ['sk-ant key', () => ['src/config.js', `export const key = '${FAKE_ANT}';\n`], /src\/config\.js: looks like an API key \(sk-\)/],
    ['private key block', () => ['notes.txt', `${FAKE_PEM_LINE}\nMIIE\n`], /notes\.txt: looks like a private key block/],
  ];
  for (const [name, make, re] of cases) {
    const w = await world();
    try {
      const [rel, text] = make();
      w.put(rel, text); // untracked and not ignored: the snapshot includes it
      const { scan } = await snapAndScan(w);
      assert.equal(scan.blocked, true, name);
      assert.match(scan.findings.join('\n'), re, name);
      assert.ok(!scan.findings.join('\n').includes('a1B2c3D4'), 'the finding never repeats the key');
    } finally { w.done(); }
  }
  const w = await world();
  try {
    w.put('.env.example', 'API_URL=\nTOKEN=\n');
    w.put('src/index.js', 'export const answer = 42;\n');
    const { scan } = await snapAndScan(w);
    assert.equal(scan.blocked, false, scan.findings.join('; '));
    assert.ok(scan.files >= 2);
  } finally { w.done(); }
});

test('scan: a key committed earlier and removed since is still caught (it would travel in history), and an ignored .env is not', noGit, async () => {
  const w = await world();
  try {
    w.put('leak.js', `const k = '${FAKE_ANT}';\n`);
    await w.sh(['add', 'leak.js']);
    await w.sh(['commit', '-q', '-m', 'oops']);
    fs.rmSync(path.join(w.repo, 'leak.js'));
    await w.sh(['add', '-A']);
    await w.sh(['commit', '-q', '-m', 'remove it']);
    const { scan } = await snapAndScan(w);
    assert.equal(scan.blocked, true);
    assert.match(scan.findings.join('\n'), /leak\.js: looks like an API key/);
  } finally { w.done(); }
  const w2 = await world();
  try {
    w2.put('.gitignore', 'ignored.log\n.env\n');
    w2.put('.env', 'SECRET=1\n');
    const { snap, scan } = await snapAndScan(w2);
    assert.equal(scan.blocked, false, scan.findings.join('; '));
    assert.ok(!(await w2.sh(['ls-tree', '-r', '--name-only', snap.commit])).includes('.env\n'), 'an ignored .env is never in the snapshot');
  } finally { w2.done(); }
});

test('push: lands only on the wip ref; main and everything else on the remote stay as they were', noGit, async () => {
  const w = await world();
  try {
    const mainBefore = (await w.remoteRefs()).find((l) => l.startsWith('refs/heads/main '));
    w.put('a.txt', 'one\nwip edit\n');
    const before = await w.state();
    const { snap } = await snapAndScan(w);
    const r = await pushWip({ git, top: w.repo, url: w.remote, commit: snap.commit, machine: MACHINE, sessionId: SID });
    assert.equal(r.branch, `wip/${MACHINE}/${SID8}`);
    const refs = await w.remoteRefs();
    assert.deepEqual(refs.map((l) => l.split(' ')[0]).sort(), ['refs/heads/main', WIP]);
    assert.equal(refs.find((l) => l.startsWith('refs/heads/main ')), mainBefore);
    assert.equal(refs.find((l) => l.startsWith(`${WIP} `)), `${WIP} ${snap.commit}`);
    assert.deepEqual(await w.state(), before, 'pushing did not touch the owner\'s repo (no new local refs either)');

    // A second sync of the same session moves the wip ref (lease on that ref only).
    w.put('a.txt', 'one\nwip edit 2\n');
    const second = await snapAndScan(w);
    await pushWip({ git, top: w.repo, url: w.remote, commit: second.snap.commit, machine: MACHINE, sessionId: SID });
    assert.equal((await w.remoteRefs()).find((l) => l.startsWith(`${WIP} `)), `${WIP} ${second.snap.commit}`);
  } finally { w.done(); }
});

test('push: another ref cannot be named, whatever the machine or session id', noGit, async () => {
  const w = await world();
  try {
    const { snap } = await snapAndScan(w);
    for (const sid of ['main', '../../../x', 'refs/heads/main', 'x']) {
      await assert.rejects(pushWip({ git, top: w.repo, url: w.remote, commit: snap.commit, machine: MACHINE, sessionId: sid }), /wip branch|refusing/);
    }
    await assert.rejects(pushWip({ git, top: w.repo, url: w.remote, commit: 'main', machine: MACHINE, sessionId: SID }), /not a commit id/);
    await assert.rejects(pushWip({ git, top: w.repo, url: w.remote, commit: '--delete', machine: MACHINE, sessionId: SID }), /not a commit id/);
    assert.deepEqual((await w.remoteRefs()).map((l) => l.split(' ')[0]), ['refs/heads/main']);
  } finally { w.done(); }
});

test('bundle: created from the snapshot without adding refs to the owner\'s repo; verifies and holds the wip ref', noGit, async () => {
  const w = await world();
  try {
    w.put('a.txt', 'one\nbundle me\n');
    w.put('new.txt', 'n\n');
    const before = await w.state();
    const tmp = fs.mkdtempSync(path.join(w.tmpRoot, 'b-'));
    const { snap } = await snapAndScan(w);
    const b = await makeBundle({ git, top: w.repo, tmp, commit: snap.commit, machine: MACHINE, sessionId: SID, jobId: 'job_1' });
    assert.equal(b.branch, `wip/${MACHINE}/${SID8}`);
    assert.equal(path.basename(b.file), 'job_1.bundle');
    assert.ok(b.bytes > 0 && b.bytes < SYNC_MAX_BUNDLE_BYTES);
    await git(w.repo, ['bundle', 'verify', b.file]);
    const heads = await git(w.repo, ['bundle', 'list-heads', b.file]);
    assert.equal(heads.trim(), `${snap.commit} ${WIP}`);
    assert.deepEqual(await w.state(), before);
    // The bundle really contains the snapshot: clone it elsewhere and look.
    const clone = path.join(w.root, 'clone');
    await git(w.root, ['clone', '-q', '--branch', b.branch, b.file, clone]);
    assert.equal(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8'), 'one\nbundle me\n');
    assert.ok(fs.existsSync(path.join(clone, 'new.txt')));
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally { w.done(); }
});

// ---------------------------------------------------------------------------------------------------------
// Upload to a stub hub

/** A hub stand-in that records every request and answers `status`. */
function stubHub(status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = status; res.end('{}'); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ seen, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test('upload: streams the file with Content-Length, x-bundle-sha256, the token, and the right path', async () => {
  const hub = await stubHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sync-up-'));
  try {
    const file = path.join(dir, 'x.bundle');
    const data = crypto.randomBytes(300_000);
    fs.writeFileSync(file, data);
    const r = await uploadBundleFile({ baseUrl: hub.baseUrl, token: 'tok-123456789012345', jobId: 'job_9', file });
    assert.equal(r.status, 200);
    assert.equal(hub.seen.length, 1);
    const q = hub.seen[0];
    assert.equal(q.method, 'POST');
    assert.equal(q.url, '/api/pc-runner/jobs/job_9/bundle');
    assert.equal(q.headers['content-type'], 'application/octet-stream');
    assert.equal(q.headers['content-length'], String(data.length));
    assert.equal(q.headers['transfer-encoding'], undefined);
    assert.equal(q.headers.authorization, 'Bearer tok-123456789012345');
    assert.equal(q.headers['x-bundle-sha256'], crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(q.headers['x-bundle-sha256'], await sha256File(file));
    assert.ok(q.body.equals(data));
  } finally { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upload: the size cap is enforced before anything is sent; an unverified tunnel sends nothing; a hub refusal is an error', async () => {
  const hub = await stubHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sync-up-'));
  try {
    const file = path.join(dir, 'x.bundle');
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
    await assert.rejects(uploadBundleFile({ baseUrl: hub.baseUrl, token: 't', jobId: 'j', file, maxBytes: 2047 }), /limit is/);
    await uploadBundleFile({ baseUrl: hub.baseUrl, token: 't', jobId: 'j', file: file, maxBytes: 2048 }); // exactly at the cap is fine
    assert.equal(hub.seen.length, 1);
    await assert.rejects(uploadBundleFile({ baseUrl: hub.baseUrl, token: 't', jobId: 'j', file, guard: () => { throw new Error('tunnel not verified; nothing sent'); } }), /tunnel not verified/);
    assert.equal(hub.seen.length, 1, 'neither the oversize file nor the unverified call reached the hub');
    fs.writeFileSync(file, '');
    await assert.rejects(uploadBundleFile({ baseUrl: hub.baseUrl, token: 't', jobId: 'j', file }), /empty/);
    assert.equal(SYNC_MAX_BUNDLE_BYTES, 200 * 1024 * 1024);
  } finally { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  const hub413 = await stubHub(413);
  try {
    const f = path.join(os.tmpdir(), `pr-sync-413-${process.pid}.bundle`);
    fs.writeFileSync(f, 'abc');
    await assert.rejects(uploadBundleFile({ baseUrl: hub413.baseUrl, token: 't', jobId: 'j', file: f }), /HTTP 413/);
    fs.rmSync(f, { force: true });
  } finally { hub413.close(); }
});

// ---------------------------------------------------------------------------------------------------------
// The whole job, through handleJob (Windows: the session lookup uses Windows paths)

/** Writes the session transcript whose recorded cwd is the repo. */
function writeSession(w, cwd = w.repo) {
  fs.mkdirSync(path.join(w.projects, 'p1'), { recursive: true });
  const line = { type: 'user', uuid: 'u0', timestamp: '2026-11-10T10:00:00.000Z', cwd, sessionId: SID, message: { role: 'user', content: 'Fix the login bug' } };
  fs.writeFileSync(path.join(w.projects, 'p1', `${SID}.jsonl`), JSON.stringify(line) + '\n');
}

function deps(w, over = {}) {
  const log = [], posted = [], dialogs = [], uploads = [];
  const d = {
    log: (event, f) => log.push({ event, ...f }),
    loadConfig: () => validateConfig({ folders: { work: { path: w.work } } }),
    projectsDir: () => w.projects,
    claudePath: 'C:\\claude\\claude.exe',
    mcpDefinitions: () => ({}),
    confirm: async (payload) => { dialogs.push(payload); return true; },
    startJob: async () => {},
    run: async () => { throw new Error('sync must not start claude'); },
    postResult: async (id, r) => { posted.push({ id, r }); },
    git, gitPath: GIT_PATH, machine: MACHINE, normalise: norm,
    makeTmp: () => fs.mkdtempSync(path.join(w.tmpRoot, 'job-')),
    uploadBundle: async (id, file) => { uploads.push({ id, file, exists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 }); },
    ...over,
  };
  return { d, log, posted, dialogs, uploads };
}
const syncJob = (w, over = {}, spec = {}) => ({
  id: 'job_sync1', mode: 'sync', origin: 'owner', sessionId: SID,
  sync: { project: 'wika', repo: 'app', remote: w.remote, mode: 'wip-branch', protected: ['main'], ...spec }, ...over,
});

test('job: wip-branch sync scans, asks (dialog shows SYNC, repo, remote, mode, branch, size, scan), pushes, cleans up', win, async () => {
  const w = await world();
  try {
    writeSession(w);
    w.put('a.txt', 'one\nedited\n');
    w.put('new.txt', 'n\n');
    const before = await w.state();
    const t = deps(w);
    await handleJob(t.d, syncJob(w));
    assert.equal(t.dialogs.length, 1);
    const lines = t.dialogs[0].infoLines.join('\n');
    assert.match(lines, /^SYNC: /m);
    assert.match(lines, /^Repo: app {2}\(project wika\)$/m);
    assert.match(lines, /^Remote: local:/m);
    assert.match(lines, /^Mode: push a work-in-progress branch$/m);
    assert.match(lines, new RegExp(`^Target: branch wip/${MACHINE}/${SID8} on the remote`, 'm'));
    assert.match(lines, /^Changes: 2 files, \+2 -0 lines/m);
    assert.match(lines, /^Scan: clean/m);
    assert.equal(t.dialogs[0].mode, 'sync');
    assert.deepEqual(t.dialogs[0].tools, []);
    assert.match(t.dialogs[0].prompt, /a\.txt\nnew\.txt/);
    assert.equal(t.posted.length, 1);
    const r = t.posted[0].r;
    assert.equal(r.ok, true, r.output);
    assert.equal(r.sync.mode, 'wip-branch');
    assert.equal(r.sync.branch, `wip/${MACHINE}/${SID8}`);
    assert.match(r.sync.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(r.sync.scan, { blocked: false, findings: [] });
    assert.equal(r.resolvedFolder, 'work');
    assert.equal((await w.remoteRefs()).find((l) => l.startsWith(`${WIP} `)), `${WIP} ${r.sync.commit}`);
    assert.deepEqual(await w.state(), before);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), [], 'temp index files are removed');
  } finally { w.done(); }
});

test('job: a blocked scan refuses without asking and pushes nothing', win, async () => {
  const w = await world();
  try {
    writeSession(w);
    w.put('.env', 'TOKEN=abc\n');
    w.put('src/k.js', `const k = '${FAKE_ANT}';\n`);
    const t = deps(w);
    await handleJob(t.d, syncJob(w));
    assert.equal(t.dialogs.length, 0, 'the owner is not asked about something that cannot be approved');
    assert.equal(t.posted.length, 1);
    const r = t.posted[0].r;
    assert.equal(r.ok, false);
    assert.equal(r.refusedLocally, true);
    assert.equal(r.sync.scan.blocked, true);
    assert.ok(r.sync.scan.findings.some((f) => /\.env: is an environment file/.test(f)));
    assert.ok(r.sync.scan.findings.some((f) => /src\/k\.js: looks like an API key/.test(f)));
    assert.equal(r.sync.branch, undefined);
    assert.match(r.output, /Sync blocked/);
    assert.ok(!r.output.includes('a1B2c3D4'));
    assert.deepEqual((await w.remoteRefs()).map((l) => l.split(' ')[0]), ['refs/heads/main']);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);
  } finally { w.done(); }
});

test('job: an origin that is not the project\'s remote is refused before any snapshot or dialog', win, async () => {
  const w = await world();
  try {
    writeSession(w);
    const t = deps(w);
    await handleJob(t.d, syncJob(w, {}, { remote: 'git@github.com:someone/else.git' }));
    assert.equal(t.dialogs.length, 0);
    assert.equal(t.posted.length, 1);
    assert.equal(t.posted[0].r.ok, false);
    assert.equal(t.posted[0].r.refusedLocally, true);
    assert.match(t.posted[0].r.output, /not the project repo's remote/);
    assert.deepEqual((await w.remoteRefs()).map((l) => l.split(' ')[0]), ['refs/heads/main']);
    // A push URL that points elsewhere is a mismatch too, even when the fetch URL matches.
    await w.sh(['remote', 'set-url', '--push', 'origin', path.join(w.root, 'elsewhere.git')]);
    const t2 = deps(w);
    await handleJob(t2.d, syncJob(w));
    assert.equal(t2.dialogs.length, 0);
    assert.match(t2.posted[0].r.output, /not the project repo's remote/);
  } finally { w.done(); }
});

test('job: Refuse on the PC pushes nothing; a session outside the allowlist, or a repo wider than it, is refused', win, async () => {
  const w = await world();
  try {
    writeSession(w);
    const t = deps(w, { confirm: async () => false });
    await handleJob(t.d, syncJob(w));
    assert.equal(t.posted[0].r.refusedLocally, true);
    assert.match(t.posted[0].r.output, /Refused on the PC/);
    assert.deepEqual((await w.remoteRefs()).map((l) => l.split(' ')[0]), ['refs/heads/main']);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);

    // allowlist is a subfolder of the repo: the repo reaches outside it
    fs.mkdirSync(path.join(w.repo, 'sub'));
    const t2 = deps(w, { loadConfig: () => validateConfig({ folders: { sub: { path: path.join(w.repo, 'sub') } } }) });
    writeSession(w, path.join(w.repo, 'sub'));
    await handleJob(t2.d, syncJob(w));
    assert.equal(t2.dialogs.length, 0);
    assert.match(t2.posted[0].r.output, /reaches outside the allowlist folder/);

    // session folder not inside any allowlist folder
    const t3 = deps(w, { loadConfig: () => validateConfig({ folders: { other: { path: path.join(w.root, 'projects') } } }) });
    writeSession(w);
    await handleJob(t3.d, syncJob(w));
    assert.match(t3.posted[0].r.output, /not inside any folder in this PC's allowlist/);
    assert.deepEqual((await w.remoteRefs()).map((l) => l.split(' ')[0]), ['refs/heads/main']);
  } finally { w.done(); }
});

test('job: bundle mode builds a bundle, uploads it through the hub hook, reports bytes, pushes nothing, cleans up', win, async () => {
  const w = await world();
  try {
    writeSession(w);
    w.put('a.txt', 'one\nbundle\n');
    const before = await w.state();
    const t = deps(w);
    await handleJob(t.d, syncJob(w, {}, { mode: 'bundle' }));
    assert.match(t.dialogs[0].infoLines.join('\n'), /^Target: bundle to the server \(nothing is pushed to the remote\)$/m);
    assert.equal(t.uploads.length, 1);
    assert.equal(t.uploads[0].id, 'job_sync1');
    assert.equal(t.uploads[0].exists, true);
    const r = t.posted[0].r;
    assert.equal(r.ok, true, r.output);
    assert.equal(r.sync.mode, 'bundle');
    assert.equal(r.sync.bundleBytes, t.uploads[0].bytes);
    assert.ok(r.sync.bundleBytes > 0);
    assert.equal(r.sync.branch, `wip/${MACHINE}/${SID8}`);
    assert.deepEqual((await w.remoteRefs()).map((l) => l.split(' ')[0]), ['refs/heads/main'], 'bundle mode never pushes to the remote');
    assert.deepEqual(await w.state(), before);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), [], 'the bundle file is removed after the upload');
  } finally { w.done(); }
});

test('job: a failed upload is reported as a failed sync and the bundle is still cleaned up', win, async () => {
  const w = await world();
  try {
    writeSession(w);
    const t = deps(w, { uploadBundle: async () => { throw new Error('bundle upload -> HTTP 413'); } });
    await handleJob(t.d, syncJob(w, {}, { mode: 'bundle' }));
    assert.equal(t.posted[0].r.ok, false);
    assert.match(t.posted[0].r.output, /HTTP 413/);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);
  } finally { w.done(); }
});

test('job: old job modes are unaffected (no sync fields needed, a prompt is still required)', win, async () => {
  const w = await world();
  try {
    const ran = [];
    const t = deps(w, { run: async (j) => { ran.push(j); return { ok: true, output: 'done' }; } });
    await handleJob(t.d, { id: 'j1', folder: 'work', prompt: 'hello' });
    assert.equal(ran.length, 1);
    assert.equal(t.dialogs[0].mode, 'new');
    assert.equal(t.posted[0].r.sync, undefined);
    assert.equal(t.posted[0].r.ok, true);
    const t2 = deps(w);
    await handleJob(t2.d, { id: 'j2', mode: 'new', folder: 'work', prompt: '   ' });
    assert.equal(t2.posted.length, 0, 'a new job with no prompt is still malformed');
    await handleJob(t2.d, { id: 'j3', mode: 'sync', sessionId: SID, sync: { project: 'x', repo: 'a', remote: 'r', mode: 'push-anything' } });
    assert.equal(t2.posted.length, 0, 'a sync job with an unknown mode is malformed');
  } finally { w.done(); }
});
