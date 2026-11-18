// node --test scripts/pc-runner
// Move and pull jobs (bridge P6) against real git: temp repos, temp bare "remotes" and a stub hub that speaks the
// upload/download routes over real HTTP. Never a real remote, never the owner's ~/.claude. The job-flow tests use
// Windows paths (resolveResume), so they are skipped elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleJob } from './jobs.mjs';
import { findGit, createMirror, httpRequester } from './mirror.mjs';
import { validateConfig, normaliseRemote, parseJob } from './lib.mjs';
import { makeGit, uploadBundleFile, uploadSessionFile, downloadBundleFile, downloadSessionFile } from './sync.mjs';
import { safeRelPath, replaceTranscript } from './move.mjs';

const GIT_PATH = findGit();
const win = { skip: (process.platform !== 'win32' && 'Windows paths') || (!GIT_PATH && 'git is not installed') };
const SID = '11111111-2222-3333-4444-555555555555';
const SID8 = '11111111';
const MACHINE = 'testbox';
const BRANCH = `wip/${MACHINE}/${SID8}`;
const REF = `refs/heads/${BRANCH}`;
const FAKE_ANT = 'sk-' + 'ant-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const norm = (u) => normaliseRemote(u) ?? `local:${String(u).replace(/\\/g, '/').toLowerCase()}`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = GIT_PATH ? makeGit(GIT_PATH) : null;

/** <root>/work/{app,lib} (each with its own bare origin and main pushed), <root>/projects (the transcripts), <root>/tmp. */
async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-test-')));
  const w = { root, work: path.join(root, 'work'), tmpRoot: path.join(root, 'tmp'), projects: path.join(root, 'projects'), repos: {} };
  for (const d of [w.work, w.tmpRoot, w.projects]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['app', 'lib']) {
    const remote = path.join(root, `${name}.git`), repo = path.join(w.work, name);
    await git(root, ['init', '--bare', '--quiet', '-b', 'main', remote]);
    await git(root, ['init', '--quiet', '-b', 'main', repo]);
    await git(repo, ['remote', 'add', 'origin', remote]);
    const r = { name, remote, repo, put: (rel, text) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }, sh: (args, o) => git(repo, args, o) };
    r.put('a.txt', `${name} one\n`);
    r.put('keep.txt', 'keep\n');
    r.put('gone.txt', 'gone soon\n');
    r.put('.gitignore', 'ignored.log\n');
    await r.sh(['add', '-A']);
    await r.sh(['commit', '-q', '-m', 'first']);
    await r.sh(['push', '-q', 'origin', 'main']);
    r.state = async () => ({
      head: (await r.sh(['rev-parse', 'HEAD'])).trim(),
      branches: (await r.sh(['for-each-ref', '--format=%(refname) %(objectname)'])).trim().split('\n').sort(),
      stash: await r.sh(['stash', 'list']),
      index: sha(fs.readFileSync(path.join(repo, '.git', 'index'))),
    });
    w.repos[name] = r;
  }
  w.done = () => fs.rmSync(root, { recursive: true, force: true });
  return w;
}

const config = (w) => () => validateConfig({ folders: { work: { path: w.work } } });
const sessionFile = (w) => path.join(w.projects, 'p1', `${SID}.jsonl`);
function writeSession(w, cwd = w.repos.app.repo) {
  fs.mkdirSync(path.join(w.projects, 'p1'), { recursive: true });
  const line = (n, o) => JSON.stringify({ uuid: `u${n}`, timestamp: `2026-11-10T10:00:0${n}.000Z`, cwd, sessionId: SID, ...o });
  fs.writeFileSync(sessionFile(w), [
    line(0, { type: 'user', message: { role: 'user', content: 'Fix the login bug' } }),
    line(1, { type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
}

/** A hub stand-in over real HTTP: stores uploads, serves downloads (with their sha256 headers), records requests. */
async function stubHub() {
  const h = { seen: [], bundles: {}, session: null, serve: { session: null, bundles: {}, noSha: false } };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      h.seen.push({ method: req.method, path: u.pathname, repo: u.searchParams.get('repo'), headers: req.headers, bytes: body.length, sha: sha(body) });
      if (req.method === 'POST' && u.pathname.endsWith('/bundle')) { h.bundles[u.searchParams.get('repo')] = body; res.end('{}'); return; }
      if (req.method === 'POST' && u.pathname.endsWith('/session')) { h.session = body; res.end('{}'); return; }
      if (req.method === 'GET' && u.pathname.endsWith('/session') && h.serve.session) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...(h.serve.noSha ? {} : { 'x-session-sha256': sha(h.serve.session) }) });
        res.end(h.serve.session); return;
      }
      if (req.method === 'GET' && u.pathname.endsWith('/bundle') && h.serve.bundles[u.searchParams.get('repo')]) {
        const b = h.serve.bundles[u.searchParams.get('repo')];
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-bundle-sha256': sha(b) });
        res.end(b); return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  h.baseUrl = `http://127.0.0.1:${server.address().port}`;
  h.close = () => server.close();
  return h;
}

function deps(w, hub, over = {}) {
  const posted = [], dialogs = [], held = new Set(), released = [];
  const net = { baseUrl: hub.baseUrl, token: 'tok-123456789012345', jobId: 'job_m1' };
  const d = {
    log: () => {}, loadConfig: config(w), projectsDir: () => w.projects, claudePath: 'C:\\claude\\claude.exe', mcpDefinitions: () => ({}),
    confirm: async (p) => { dialogs.push(p); return true; },
    startJob: async () => {}, run: async () => { throw new Error('move and pull must not start claude'); },
    postResult: async (id, r) => { posted.push({ id, r }); },
    git, gitPath: GIT_PATH, machine: MACHINE, normalise: norm,
    makeTmp: () => fs.mkdtempSync(path.join(w.tmpRoot, 'job-')),
    uploadBundle: (id, file, query) => uploadBundleFile({ ...net, jobId: id, file, query }),
    uploadSession: (id, file) => uploadSessionFile({ ...net, jobId: id, file }),
    downloadSession: (id, dest) => downloadSessionFile({ ...net, jobId: id, dest }),
    downloadBundle: (id, repo, dest) => downloadBundleFile({ ...net, jobId: id, query: { repo }, dest }),
    holdSession: (id) => held.add(id), releaseSession: (id) => released.push(id), isOnVps: (id) => held.has(id),
    ...over,
  };
  return { d, posted, dialogs, held, released };
}

const spec = (r, over = {}) => ({ project: 'wika', repo: r.name, remote: r.remote, mode: 'bundle', protected: ['main'], ...over });
const moveJob = (w, repos, over = {}) => ({ id: 'job_m1', mode: 'move', origin: 'owner', sessionId: SID, move: { room: null, repos: repos.map((n) => spec(w.repos[n])) }, ...over });

// ---------------------------------------------------------------------------------------------------------
test('parseJob: move and pull need a session and a valid spec, no prompt; old modes are unchanged', () => {
  const r = { project: 'wika', repo: 'app', remote: 'https://example.test/o/app.git', mode: 'bundle' };
  const mv = parseJob({ id: 'a', mode: 'move', sessionId: SID, move: { room: 'dev', repos: [r] } });
  assert.equal(mv.mode, 'move');
  assert.equal(mv.move.repos[0].repo, 'app');
  assert.equal(mv.move.room, 'dev');
  assert.equal(mv.prompt, '');
  const pl = parseJob({ id: 'b', mode: 'pull', sessionId: SID, pull: { repos: [{ project: 'wika', repo: 'app', remote: r.remote, branch: BRANCH, baseCommit: 'a'.repeat(40) }] } });
  assert.equal(pl.pull.repos[0].branch, BRANCH);
  assert.equal(pl.pull.repos[0].mode, null);
  assert.equal(parseJob({ id: 'c', mode: 'move', sessionId: SID }), null);
  assert.equal(parseJob({ id: 'c', mode: 'move', move: { repos: [r] } }), null, 'a move names a session');
  for (const bad of [{ branch: 'main' }, { branch: '../x' }, { baseCommit: 'main' }, { baseCommit: '--x' }]) {
    assert.equal(parseJob({ id: 'd', mode: 'pull', sessionId: SID, pull: { repos: [{ project: 'wika', repo: 'app', remote: r.remote, branch: BRANCH, baseCommit: 'a'.repeat(40), ...bad }] } }), null);
  }
  assert.equal(parseJob({ id: 'e', mode: 'resume', sessionId: SID, prompt: 'x', onVps: true }).onVps, true);
  assert.equal(parseJob({ id: 'e', mode: 'resume', sessionId: SID, prompt: 'x' }).onVps, false);
  assert.equal(parseJob({ id: 'f', folder: 'work', prompt: 'hi' }).mode, 'new');
  assert.equal(parseJob({ id: 'g', mode: 'new', folder: 'work', prompt: ' ' }), null);
});

test('safeRelPath: only plain repo-relative paths outside .git', () => {
  for (const ok of ['a.txt', 'src/a/b.js', 'dir with space/x']) assert.equal(safeRelPath(ok), true, ok);
  for (const bad of ['', '../x', 'a/../b', '/etc/passwd', 'C:\\x', '.git/config', '.GIT/hooks/x', 'a//b', './a', 'a\0b']) assert.equal(safeRelPath(bad), false, JSON.stringify(bad));
});

// ---------------------------------------------------------------------------------------------------------
test('move: two repos and the session go up with the right routes and headers; one dialog; owner state untouched; session held', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    writeSession(w);
    w.repos.app.put('a.txt', 'app one\nedited\n');
    w.repos.lib.put('new.txt', 'n\n');
    const before = { app: await w.repos.app.state(), lib: await w.repos.lib.state() };
    const sessionBytes = fs.readFileSync(sessionFile(w));
    const t = deps(w, hub);
    await handleJob(t.d, moveJob(w, ['app', 'lib']));

    assert.equal(t.dialogs.length, 1, 'one dialog for the whole move');
    const lines = t.dialogs[0].infoLines.join('\n');
    assert.match(lines, /^MOVE: /m);
    assert.match(lines, /Session: Fix the login bug/);
    assert.match(lines, /- app \(project wika\)/);
    assert.match(lines, /- lib \(project wika\)/);
    assert.equal(t.dialogs[0].mode, 'move');
    assert.match(t.dialogs[0].prompt, /\[app\]\na\.txt/);
    assert.match(t.dialogs[0].prompt, /\[lib\]\nnew\.txt/);

    const posts = hub.seen.filter((q) => q.method === 'POST');
    assert.deepEqual(posts.map((q) => [q.path, q.repo]), [['/api/pc-runner/jobs/job_m1/bundle', 'app'], ['/api/pc-runner/jobs/job_m1/bundle', 'lib'], ['/api/pc-runner/jobs/job_m1/session', null]]);
    for (const q of posts) {
      assert.equal(q.headers.authorization, 'Bearer tok-123456789012345');
      assert.equal(q.headers['content-type'], 'application/octet-stream');
      assert.equal(q.headers['content-length'], String(q.bytes));
    }
    assert.equal(posts[0].headers['x-bundle-sha256'], posts[0].sha);
    assert.equal(posts[2].headers['x-session-sha256'], sha(sessionBytes));
    assert.ok(hub.session.equals(sessionBytes));

    const r = t.posted[0].r;
    assert.equal(r.ok, true, r.output);
    assert.deepEqual(r.move.repos.map((x) => [x.repo, x.branch]), [['app', BRANCH], ['lib', BRANCH]]);
    assert.match(r.move.repos[0].commit, /^[0-9a-f]{40}$/);
    assert.equal(r.move.sessionBytes, sessionBytes.length);
    assert.equal(r.resolvedFolder, 'work');
    assert.deepEqual([...t.held], [SID]);
    assert.deepEqual({ app: await w.repos.app.state(), lib: await w.repos.lib.state() }, before);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);
  } finally { hub.close(); w.done(); }
});

test('move: a blocked scan in any repo refuses without a dialog and uploads nothing', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    writeSession(w);
    w.repos.lib.put('src/k.js', `const k = '${FAKE_ANT}';\n`);
    const t = deps(w, hub);
    await handleJob(t.d, moveJob(w, ['app', 'lib']));
    assert.equal(t.dialogs.length, 0);
    assert.equal(hub.seen.length, 0);
    const r = t.posted[0].r;
    assert.equal(r.ok, false);
    assert.equal(r.refusedLocally, true);
    assert.match(r.output, /Move blocked/);
    assert.match(r.output, /\[lib\]/);
    assert.ok(!r.output.includes('a1B2c3D4'));
    assert.equal(t.held.size, 0);
  } finally { hub.close(); w.done(); }
});

test('move: refusals (wip-branch repo, no repos, unknown origin, already on the VPS, Refuse) send nothing', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    writeSession(w);
    const t = deps(w, hub);
    const j = moveJob(w, ['app']);
    await handleJob(t.d, { ...j, move: { room: null, repos: [spec(w.repos.app, { mode: 'wip-branch' })] } });
    assert.match(t.posted.at(-1).r.output, /bundle repos only/);
    await handleJob(t.d, { ...j, move: { room: null, repos: [] } });
    assert.match(t.posted.at(-1).r.output, /at least one/);
    await handleJob(t.d, { ...j, move: { room: null, repos: [spec(w.repos.app, { remote: 'git@github.com:someone/else.git' })] } });
    assert.match(t.posted.at(-1).r.output, /No repo on this PC/);
    t.held.add(SID);
    await handleJob(t.d, j);
    assert.match(t.posted.at(-1).r.output, /already on the VPS/);
    const t2 = deps(w, hub, { confirm: async () => false });
    await handleJob(t2.d, j);
    assert.match(t2.posted[0].r.output, /Refused on the PC/);
    assert.equal(hub.seen.length, 0);
    assert.equal(t.dialogs.length, 0);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);
  } finally { hub.close(); w.done(); }
});

test('move: a failed upload is reported as failed, the session is not held, temp files are removed', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    writeSession(w);
    const t = deps(w, hub, { uploadSession: async () => { throw new Error('session upload -> HTTP 413'); } });
    await handleJob(t.d, moveJob(w, ['app']));
    const r = t.posted[0].r;
    assert.equal(r.ok, false);
    assert.match(r.output, /HTTP 413/);
    assert.equal(t.held.size, 0);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);
  } finally { hub.close(); w.done(); }
});

// ---------------------------------------------------------------------------------------------------------
// Pull. The VPS is simulated: its repo is made from the bundle the move uploaded, edited and committed on the wip branch.

/** Runs a move, then plays the VPS: edits, commits, and loads the hub's download routes. Returns the move result. */
async function moveAndWork(w, hub, { edit = true, repos = ['app'] } = {}) {
  writeSession(w);
  w.repos.app.put('a.txt', 'app one\nmoved wip\n');
  const t = deps(w, hub);
  await handleJob(t.d, moveJob(w, repos));
  const mv = t.posted[0].r;
  assert.equal(mv.ok, true, mv.output);
  const lines = fs.readFileSync(sessionFile(w), 'utf8');
  hub.serve.session = Buffer.from(lines + JSON.stringify({ uuid: 'u2', timestamp: '2026-11-10T10:00:09.000Z', cwd: w.repos.app.repo, type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done on the VPS' }] } }) + '\n');
  for (const n of repos) {
    const vps = path.join(w.root, `vps-${n}`);
    const bundleFile = path.join(w.root, `in-${n}.bundle`);
    fs.writeFileSync(bundleFile, hub.bundles[n]);
    await git(w.root, ['init', '--quiet', '-b', 'tmp', vps]);
    await git(vps, ['fetch', '-q', bundleFile, `+${REF}:${REF}`]);
    await git(vps, ['checkout', '-q', BRANCH]);
    if (edit) {
      fs.writeFileSync(path.join(vps, 'a.txt'), `${n} one\nmoved wip\nfrom the vps\n`);
      fs.rmSync(path.join(vps, 'gone.txt'));
      fs.mkdirSync(path.join(vps, 'new', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(vps, 'new', 'deep', 'b.txt'), 'brand new\n');
      await git(vps, ['add', '-A']);
      await git(vps, ['commit', '-q', '-m', 'PocketRocket offload: work']);
    }
    const out = path.join(w.root, `out-${n}.bundle`);
    await git(vps, ['bundle', 'create', out, REF]);
    hub.serve.bundles[n] = fs.readFileSync(out);
  }
  hub.seen.length = 0;
  return mv;
}
const pullJob = (w, mv, repos = ['app'], over = {}) => ({
  id: 'job_p1', mode: 'pull', origin: 'owner', sessionId: SID,
  pull: { repos: repos.map((n) => ({ ...spec(w.repos[n]), mode: undefined, branch: BRANCH, baseCommit: mv.move.repos.find((r) => r.repo === n).commit })) }, ...over,
});

test('pull: tree unchanged -> wip branch fetched, working files become the VPS tree, HEAD/branches/index file untouched, transcript replaced with a backup', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    const mv = await moveAndWork(w, hub);
    const app = w.repos.app;
    const before = await app.state();
    const oldSession = fs.readFileSync(sessionFile(w));
    const t = deps(w, hub);
    await handleJob(t.d, pullJob(w, mv));

    const r = t.posted[0].r;
    assert.equal(r.ok, true, r.output);
    assert.equal(r.pull.repos[0].applied, true);
    assert.equal(r.pull.repos[0].repo, 'app');
    assert.match(r.pull.repos[0].commit, /^[0-9a-f]{40}$/);
    assert.equal(r.pull.sessionBytes, hub.serve.session.length);

    const after = await app.state();
    assert.equal(after.head, before.head, 'HEAD did not move');
    assert.equal(after.index, before.index, 'the real index file is byte-identical');
    assert.equal(after.stash, before.stash);
    const wipRefs = after.branches.filter((b) => b.includes('/wip/'));
    assert.equal(wipRefs.length, 1);
    assert.ok(wipRefs[0].startsWith(`${REF} `));
    assert.deepEqual(after.branches.filter((b) => !b.includes('/wip/')), before.branches, 'no other branch or ref changed');
    assert.equal(wipRefs[0].split(' ')[1], r.pull.repos[0].commit);
    assert.equal(await app.sh(['symbolic-ref', '--short', 'HEAD']).then((s) => s.trim()), 'main');

    assert.equal(fs.readFileSync(path.join(app.repo, 'a.txt'), 'utf8'), 'app one\nmoved wip\nfrom the vps\n');
    assert.equal(fs.existsSync(path.join(app.repo, 'gone.txt')), false);
    assert.equal(fs.readFileSync(path.join(app.repo, 'new', 'deep', 'b.txt'), 'utf8'), 'brand new\n');
    assert.equal(fs.readFileSync(path.join(app.repo, 'keep.txt'), 'utf8'), 'keep\n');
    // Uncommitted: git sees them as edits against HEAD
    const status = await app.sh(['status', '--porcelain']);
    assert.match(status, /a\.txt/);
    assert.match(status, /gone\.txt/);
    assert.match(status, /new\//);

    assert.ok(fs.readFileSync(sessionFile(w)).equals(hub.serve.session));
    assert.ok(fs.readFileSync(`${sessionFile(w)}.pocketrocket-bak`).equals(oldSession));
    assert.deepEqual(fs.readdirSync(path.join(w.projects, 'p1')).sort(), [`${SID}.jsonl`, `${SID}.jsonl.pocketrocket-bak`]);
    assert.deepEqual(t.released, [SID]);
    assert.equal(t.dialogs.length, 1);
    const lines = t.dialogs[0].infoLines.join('\n');
    assert.match(lines, /^PULL: /m);
    assert.match(lines, /1 new line/);
    assert.match(lines, /3 files changed on the server/);
    assert.match(lines, /unchanged since the move/);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);
    // the requests: session first, then the bundle for that repo, with the token
    assert.deepEqual(hub.seen.map((q) => [q.method, q.path, q.repo]), [['GET', '/api/pc-runner/jobs/job_p1/session', null], ['GET', '/api/pc-runner/jobs/job_p1/bundle', 'app']]);
  } finally { hub.close(); w.done(); }
});

test('pull: tree changed since the move -> folder left alone, branch still fetched, transcript still replaced, result says applied: false', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    const mv = await moveAndWork(w, hub);
    const app = w.repos.app;
    app.put('a.txt', 'app one\nmoved wip\nOWNER KEPT EDITING\n');
    const before = await app.state();
    const t = deps(w, hub);
    await handleJob(t.d, pullJob(w, mv));
    const r = t.posted[0].r;
    assert.equal(r.ok, true, r.output);
    assert.equal(r.pull.repos[0].applied, false);
    assert.match(r.output, /left alone/);
    assert.match(r.output, new RegExp(`wip/${MACHINE}/${SID8}`));
    assert.match(t.dialogs[0].infoLines.join('\n'), /Your folder changed since the move\./);
    assert.equal(fs.readFileSync(path.join(app.repo, 'a.txt'), 'utf8'), 'app one\nmoved wip\nOWNER KEPT EDITING\n');
    assert.equal(fs.existsSync(path.join(app.repo, 'gone.txt')), true);
    assert.equal(fs.existsSync(path.join(app.repo, 'new')), false);
    const after = await app.state();
    assert.equal(after.head, before.head);
    assert.equal(after.index, before.index);
    assert.equal(after.branches.filter((b) => b.includes('/wip/')).length, 1, 'the VPS work is on the wip branch');
    assert.ok(fs.readFileSync(sessionFile(w)).equals(hub.serve.session));
    assert.ok(fs.existsSync(`${sessionFile(w)}.pocketrocket-bak`));
  } finally { hub.close(); w.done(); }
});

test('pull: refuses before touching anything when the download cannot be verified, the branch is another one, or the transcript is wrong', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    const mv = await moveAndWork(w, hub);
    const app = w.repos.app;
    const before = await app.state();
    const old = fs.readFileSync(sessionFile(w));
    const run = async (job, over = {}) => { const t = deps(w, hub, over); await handleJob(t.d, job); return t; };

    hub.serve.noSha = true;
    let t = await run(pullJob(w, mv));
    assert.match(t.posted[0].r.output, /cannot be verified/);
    hub.serve.noSha = false;

    const j = pullJob(w, mv);
    j.pull.repos[0].branch = 'wip/other/12345678';
    t = await run(j);
    assert.match(t.posted[0].r.output, /only ever writes that one branch/);

    const good = hub.serve.session;
    hub.serve.session = Buffer.from('not json at all\n');
    t = await run(pullJob(w, mv));
    assert.match(t.posted[0].r.output, /not JSON/);
    hub.serve.session = Buffer.from(JSON.stringify({ type: 'user', cwd: 'C:\\somewhere\\else', message: { role: 'user', content: 'x' } }) + '\n');
    t = await run(pullJob(w, mv));
    assert.match(t.posted[0].r.output, /outside your repos/);
    hub.serve.session = good;

    hub.serve.bundles.app = Buffer.from('garbage');
    t = await run(pullJob(w, mv));
    assert.match(t.posted[0].r.output, /cannot be used/);

    t = await run(pullJob(w, mv), { confirm: async () => false });
    assert.match(t.posted[0].r.output, /cannot be used|Refused on the PC/);

    for (const q of [t]) assert.equal(q.dialogs.length <= 1, true);
    assert.deepEqual(await app.state(), before);
    assert.ok(fs.readFileSync(sessionFile(w)).equals(old));
    assert.equal(fs.existsSync(`${sessionFile(w)}.pocketrocket-bak`), false);
    assert.deepEqual(fs.readdirSync(w.tmpRoot), []);
  } finally { hub.close(); w.done(); }
});

test('pull: two repos, one changed since the move -> the unchanged one is applied, the other left alone', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    w.repos.lib.put('a.txt', 'lib one\nmoved\n');
    const mv = await moveAndWork(w, hub, { repos: ['app', 'lib'] });
    w.repos.lib.put('keep.txt', 'owner changed this\n');
    const t = deps(w, hub);
    await handleJob(t.d, pullJob(w, mv, ['app', 'lib']));
    const r = t.posted[0].r;
    assert.equal(r.ok, true, r.output);
    assert.deepEqual(r.pull.repos.map((x) => [x.repo, x.applied]), [['app', true], ['lib', false]]);
    assert.equal(fs.readFileSync(path.join(w.repos.app.repo, 'a.txt'), 'utf8'), 'app one\nmoved wip\nfrom the vps\n');
    assert.equal(fs.readFileSync(path.join(w.repos.lib.repo, 'keep.txt'), 'utf8'), 'owner changed this\n');
    assert.equal(fs.existsSync(path.join(w.repos.lib.repo, 'gone.txt')), true);
  } finally { hub.close(); w.done(); }
});

test('pull: a VPS with no file changes applies trivially (applied: true) and still replaces the transcript', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    const mv = await moveAndWork(w, hub, { edit: false });
    const t = deps(w, hub);
    await handleJob(t.d, pullJob(w, mv));
    const r = t.posted[0].r;
    assert.equal(r.ok, true, r.output);
    assert.equal(r.pull.repos[0].applied, true);
    assert.equal(fs.readFileSync(path.join(w.repos.app.repo, 'a.txt'), 'utf8'), 'app one\nmoved wip\n');
  } finally { hub.close(); w.done(); }
});

test('replaceTranscript: keeps the old file as .pocketrocket-bak next to it and leaves nothing else behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-rt-'));
  try {
    const target = path.join(dir, `${SID}.jsonl`), from = path.join(dir, 'new');
    fs.writeFileSync(target, 'old\n'); fs.writeFileSync(from, 'new\n');
    await replaceTranscript(target, from);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
    assert.equal(fs.readFileSync(`${target}.pocketrocket-bak`, 'utf8'), 'old\n');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['new', `${SID}.jsonl`, `${SID}.jsonl.pocketrocket-bak`].sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// Transfer helpers

test('download: verifies the hub\'s sha256, the size cap, and the tunnel guard; a bad download leaves no file', async () => {
  const hub = await stubHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-dl-'));
  try {
    const data = crypto.randomBytes(5000);
    hub.serve.session = data;
    const dest = path.join(dir, 's');
    const base = { baseUrl: hub.baseUrl, token: 't', jobId: 'j', dest };
    const r = await downloadSessionFile(base);
    assert.equal(r.bytes, 5000);
    assert.ok(fs.readFileSync(dest).equals(data));
    fs.rmSync(dest);
    await assert.rejects(downloadSessionFile({ ...base, guard: () => { throw new Error('tunnel not verified; nothing sent'); } }), /tunnel not verified/);
    const n = hub.seen.length;
    await assert.rejects(downloadSessionFile({ ...base, maxBytes: 100 }), /limit/);
    assert.equal(fs.existsSync(dest), false);
    hub.serve.noSha = true;
    await assert.rejects(downloadSessionFile(base), /cannot be verified/);
    hub.serve.noSha = false;
    hub.serve.session = null;
    await assert.rejects(downloadSessionFile(base), /HTTP 404/);
    assert.ok(hub.seen.length > n);
    assert.equal(fs.existsSync(dest), false);
  } finally { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upload: the session goes up with x-session-sha256 and a 100 MB cap; bundles carry ?repo=', async () => {
  const hub = await stubHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-up-'));
  try {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, Buffer.alloc(2048, 7));
    await uploadSessionFile({ baseUrl: hub.baseUrl, token: 't', jobId: 'j1', file });
    assert.equal(hub.seen[0].path, '/api/pc-runner/jobs/j1/session');
    assert.equal(hub.seen[0].headers['x-session-sha256'], sha(Buffer.alloc(2048, 7)));
    await assert.rejects(uploadSessionFile({ baseUrl: hub.baseUrl, token: 't', jobId: 'j1', file, maxBytes: 100 }), /limit is/);
    await uploadBundleFile({ baseUrl: hub.baseUrl, token: 't', jobId: 'j1', file, query: { repo: 'my app' } });
    assert.equal(hub.seen.at(-1).repo, 'my app');
    assert.equal(hub.seen.length, 2);
  } finally { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// The lock

test('lock: resume is refused when the hub says onVps, or when this runner moved it itself; other resumes still run', win, async () => {
  const w = await world();
  const hub = await stubHub();
  try {
    writeSession(w);
    const ran = [];
    const resume = { id: 'job_r1', mode: 'resume', origin: 'owner', sessionId: SID, prompt: 'continue please' };
    let t = deps(w, hub, { run: async (j) => { ran.push(j); return { ok: true, output: 'done' }; } });
    await handleJob(t.d, { ...resume, onVps: true });
    assert.equal(t.dialogs.length, 0);
    assert.equal(ran.length, 0);
    assert.equal(t.posted[0].r.refusedLocally, true);
    assert.match(t.posted[0].r.output, /on the VPS; pull it back/);

    t = deps(w, hub, { run: async (j) => { ran.push(j); return { ok: true, output: 'done' }; } });
    t.held.add(SID);
    await handleJob(t.d, resume);
    assert.match(t.posted[0].r.output, /on the VPS/);
    assert.equal(ran.length, 0);

    t = deps(w, hub, { run: async (j) => { ran.push(j); return { ok: true, output: 'done' }; } });
    await handleJob(t.d, resume);
    assert.equal(ran.length, 1, 'not on the VPS: the resume runs as before');
    assert.equal(t.posted[0].r.ok, true);
  } finally { hub.close(); w.done(); }
});

test('lock: the mirror does not ship PC appends to a session that is on the VPS, and ships again after release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-mirror-'));
  const posts = [];
  const sessions = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const u = req.url.replace('/api/pc-sessions', '');
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && u === '/sync') return res.end(JSON.stringify({ sessions: Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, { offset: v.offset, ...(v.onVps ? { onVps: true } : {}) }])) }));
      const id = decodeURIComponent(u.split('/')[1]);
      if (req.method === 'PUT') { sessions[id] ??= { offset: 0 }; return res.end(JSON.stringify({ offset: sessions[id].offset, ...(sessions[id].onVps ? { onVps: true } : {}) })); }
      posts.push({ id, n: body.entries.length });
      sessions[id].offset = body.to;
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const file = path.join(root, 'proj', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (n, text) => JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.now() - 1000 + n).toISOString(), cwd: 'C:\\work\\demo', sessionId: SID, message: { role: 'user', content: text } }) + '\n';
    fs.writeFileSync(file, line(0, 'hello'));
    const logs = [];
    const m = createMirror({
      getConfig: () => ({ mirror: true, mirrorBackfillDays: 14, mirrorExclude: [], claudeProjectsDir: root }),
      request: httpRequester({ baseUrl: url, token: 't' }), log: (e) => logs.push(e), machine: 'TEST-PC', git: async () => null, pollMs: 20,
    });
    await m.pass({ full: true });
    assert.deepEqual(posts.map((p) => p.n), [1]);

    m.hold(SID);
    assert.equal(m.isHeld(SID), true);
    fs.appendFileSync(file, line(1, 'typed on the PC while it is on the VPS'));
    await m.pass({ full: true });
    await m.pass({ full: false });
    assert.deepEqual(posts.map((p) => p.n), [1], 'nothing shipped while on the VPS');
    assert.ok(logs.includes('mirror_session_on_vps'));

    m.release(SID);
    await m.pass({ full: true });
    assert.deepEqual(posts.map((p) => p.n), [1, 1], 'after the pull the new tail is shipped');
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }

  // A fresh runner learns it from the hub: GET /sync flags the session, so nothing is adopted or shipped.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-mirror2-'));
  const posts2 = [];
  const server2 = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ sessions: { [SID]: { offset: 0, onVps: true } } }));
      if (req.method === 'PUT') return res.end(JSON.stringify({ offset: 0, onVps: true }));
      posts2.push(req.url); res.end('{}');
    });
  });
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  try {
    const file = path.join(root2, 'proj', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u0', timestamp: new Date().toISOString(), cwd: 'C:\\work\\demo', message: { role: 'user', content: 'hi' } }) + '\n');
    const m = createMirror({
      getConfig: () => ({ mirror: true, mirrorBackfillDays: 14, mirrorExclude: [], claudeProjectsDir: root2 }),
      request: httpRequester({ baseUrl: `http://127.0.0.1:${server2.address().port}`, token: 't' }), machine: 'T', git: async () => null,
    });
    await m.pass({ full: true });
    assert.equal(m.isHeld(SID), true);
    assert.deepEqual(posts2, []);
  } finally { server2.close(); fs.rmSync(root2, { recursive: true, force: true }); }
});
