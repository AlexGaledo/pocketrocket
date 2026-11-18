// node --test scripts/pc-runner
// Resume resolution and job handling, against real temp folders and stubbed hub / dialog / claude. The filesystem
// cases use Windows paths (the runner is Windows-only), so they are skipped elsewhere; the text builders run anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSessionFile, resolveResume, confirmInfoLines, confirmPayload, handleJob } from './jobs.mjs';
import { validateConfig } from './lib.mjs';

const WIN = process.platform === 'win32';
const win = { skip: !WIN && 'Windows paths and junctions' };
const SID = '11111111-2222-3333-4444-555555555555';
const SUB = 'aaaaaaaa-0000-0000-0000-000000000001';

/** A scratch world: projects dir (the "mirror" source), an allowed folder, a second allowed folder, and an outside one. */
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-jobs-test-')));
  const w = {
    root,
    projects: path.join(root, 'projects'),
    app: path.join(root, 'work', 'app'),
    appSub: path.join(root, 'work', 'app', 'packages', 'web'),
    notes: path.join(root, 'notes'),
    outside: path.join(root, 'outside'),
  };
  for (const d of [w.projects, w.app, w.appSub, w.notes, w.outside]) fs.mkdirSync(d, { recursive: true });
  w.config = (folders) => validateConfig({ folders: folders ?? { app: { path: w.app }, notes: { path: w.notes, allowedTools: ['Read'] } } }).config;
  /** Writes <projects>/<proj>/<id>.jsonl whose first line records `cwd` and whose first prompt is `title`. */
  w.session = (cwd, { id = SID, proj = 'p1', title = 'Fix the login bug' } = {}) => {
    fs.mkdirSync(path.join(w.projects, proj), { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u0', timestamp: '2026-11-10T10:00:00.000Z', cwd, sessionId: id, message: { role: 'user', content: title } },
      { type: 'assistant', uuid: 'u1', parentUuid: 'u0', timestamp: '2026-11-10T10:00:01.000Z', cwd, sessionId: id, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }] } },
    ];
    const file = path.join(w.projects, proj, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };
  w.done = () => fs.rmSync(root, { recursive: true, force: true });
  return w;
}

// ---------------------------------------------------------------------------------------------------------
test('resume: found, with the allowlist folder, cwd and title', win, async () => {
  const w = world();
  try {
    w.session(w.app);
    const r = await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.folderName, 'app');
    assert.equal(r.cwd, w.app);
    assert.equal(r.title, 'Fix the login bug');
    assert.equal(r.folder.path, w.app);
  } finally { w.done(); }
});

test('resume: a session cwd in a subfolder of an allowed folder is fine; the most specific folder wins', win, async () => {
  const w = world();
  try {
    w.session(w.appSub);
    const cfg = w.config();
    assert.equal((await resolveResume({ sessionId: SID, config: cfg, projectsDir: w.projects })).folderName, 'app');
    const nested = w.config({ app: { path: w.app }, web: { path: w.appSub, allowedTools: ['Read'] } });
    const r = await resolveResume({ sessionId: SID, config: nested, projectsDir: w.projects });
    assert.equal(r.folderName, 'web');
    assert.deepEqual(r.folder.allowedTools, ['Read']);
  } finally { w.done(); }
});

test('resume: session not found', win, async () => {
  const w = world();
  try {
    w.session(w.app, { id: SUB });
    const r = await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects });
    assert.equal(r.ok, false);
    assert.match(r.why, /not on this PC/);
    assert.equal(findSessionFile(path.join(w.root, 'nope'), SID), null);
  } finally { w.done(); }
});

test('resume: subagent ids and path-shaped ids are refused, and never looked up', win, async () => {
  const w = world();
  try {
    // A real subagent transcript on disk: <projects>/p1/<parent>/subagents/<agent>.jsonl
    fs.mkdirSync(path.join(w.projects, 'p1', SID, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(w.projects, 'p1', SID, 'subagents', 'agent-1.jsonl'), JSON.stringify({ cwd: w.app }) + '\n');
    for (const id of [`${SID}:agent-1`, '..', '../p1/x', `p1\\${SID}`, '', null, undefined, 7, `${SID}.jsonl\0`]) {
      const r = await resolveResume({ sessionId: id, config: w.config(), projectsDir: w.projects });
      assert.equal(r.ok, false, JSON.stringify(id));
      assert.match(r.why, /not a session id/, JSON.stringify(id));
    }
  } finally { w.done(); }
});

test('resume: cwd outside every allowed folder is refused', win, async () => {
  const w = world();
  try {
    w.session(w.outside);
    const r = await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects });
    assert.equal(r.ok, false);
    assert.match(r.why, /not inside any folder in this PC's allowlist/);
    // A sibling whose name merely starts like an allowed folder is outside too.
    const sib = path.join(w.root, 'work', 'app-evil');
    fs.mkdirSync(sib);
    w.session(sib);
    assert.equal((await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects })).ok, false);
  } finally { w.done(); }
});

test('resume: cwd missing from disk, or not recorded, is refused with a reason', win, async () => {
  const w = world();
  try {
    const gone = path.join(w.app, 'deleted-later');
    w.session(gone);
    let r = await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects });
    assert.equal(r.ok, false);
    assert.match(r.why, /no longer exists/);

    fs.writeFileSync(path.join(w.projects, 'p1', `${SID}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    r = await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects });
    assert.equal(r.ok, false);
    assert.match(r.why, /does not record a local working folder/);

    for (const bad of ['relative\\dir', '\\\\server\\share\\x']) {
      w.session(bad);
      assert.equal((await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects })).ok, false, bad);
    }
  } finally { w.done(); }
});

test('resume: a ".." in the recorded cwd cannot climb out of the allowed folder', win, async () => {
  const w = world();
  try {
    w.session(path.join(w.app, '..', '..', 'outside'));
    const r = await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects });
    assert.equal(r.ok, false);
    // ... while a ".." that stays inside is fine.
    w.session(path.join(w.app, 'packages', '..', 'packages', 'web'));
    assert.equal((await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects })).ok, true);
  } finally { w.done(); }
});

test('resume: a junction inside the allowed folder that leads outside is refused', win, async () => {
  const w = world();
  try {
    const link = path.join(w.app, 'sneaky');
    fs.symlinkSync(w.outside, link, 'junction');
    w.session(link);
    const r = await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects });
    assert.equal(r.ok, false);
    assert.match(r.why, /not inside any folder/);
  } finally { w.done(); }
});

test('resume: a junction outside that leads into the allowed folder is refused too (the written path must be inside)', win, async () => {
  const w = world();
  try {
    const link = path.join(w.outside, 'door');
    fs.symlinkSync(w.app, link, 'junction');
    w.session(link);
    assert.equal((await resolveResume({ sessionId: SID, config: w.config(), projectsDir: w.projects })).ok, false);
  } finally { w.done(); }
});

test('resume: a transcript that is a link to a file elsewhere is not a session', win, async () => {
  const w = world();
  try {
    const real = path.join(w.outside, 'x.jsonl');
    fs.writeFileSync(real, JSON.stringify({ cwd: w.app }) + '\n');
    fs.mkdirSync(path.join(w.projects, 'p1'), { recursive: true });
    try { fs.symlinkSync(real, path.join(w.projects, 'p1', `${SID}.jsonl`), 'file'); } catch { return; } // file symlinks need a privilege
    assert.equal(findSessionFile(w.projects, SID), null);
  } finally { w.done(); }
});

test('resume: the allowlist match ignores case (Windows paths)', win, async () => {
  const w = world();
  try {
    w.session(w.appSub.toLowerCase());
    const cfg = w.config({ app: { path: w.app.toUpperCase().replace(/^([A-Z]):/, '$1:') } });
    const r = await resolveResume({ sessionId: SID, config: cfg, projectsDir: w.projects });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.folderName, 'app');
  } finally { w.done(); }
});

// ---------------------------------------------------------------------------------------------------------
const job = (extra = {}) => ({ id: 'j1', mode: 'resume', sessionId: SID, bot: { handle: 'persona' }, room: { id: 'r1', name: 'Homeroom' }, prompt: 'carry on', ...extra });
const folderObj = { path: 'C:\\work\\app', allowedTools: ['Read', 'Edit', 'Bash(git status:*)'], mcpServers: [] };

test('confirm dialog text for a resume job names the mode, the session title and the working folder', () => {
  const lines = confirmInfoLines({ ...job(), mode: 'resume', bot: { handle: 'persona' }, room: { name: 'Homeroom' } }, 'app', folderObj, { cwd: 'C:\\work\\app\\packages\\web', title: 'Fix the login bug' });
  const text = lines.join('\n');
  assert.match(text, /Mode: RESUME an existing Claude Code session/);
  assert.match(text, /Session: Fix the login bug/);
  assert.match(text, new RegExp(`Session id: ${SID}`));
  assert.ok(text.includes('Working folder: C:\\work\\app\\packages\\web'));
  assert.ok(text.includes('Allowlist folder: app  (C:\\work\\app)'));
  assert.match(text, /Bot: @persona/);
  assert.match(text, /Room: Homeroom/);
  assert.match(confirmInfoLines({ ...job(), bot: { handle: 'a' }, room: { name: 'r' } }, 'app', folderObj, { cwd: 'C:\\x', title: null }).join('\n'), /Session: \(untitled\)/);
});

test('confirm dialog text for a new job says new session and the folder', () => {
  const text = confirmInfoLines({ mode: 'new', bot: { handle: 'dev' }, room: { name: 'Room' } }, 'app', folderObj).join('\n');
  assert.match(text, /Mode: start a new session/);
  assert.ok(text.includes('Folder: app  (C:\\work\\app)'));
  assert.doesNotMatch(text, /Session/);
});

test('confirm payload is plain data: lines, tools, prompt, mode, code warning', () => {
  const p = confirmPayload({ ...job(), mode: 'resume', bot: { handle: 'persona' }, room: { name: 'Homeroom' } }, 'app', folderObj, { cwd: 'C:\\work\\app', title: 't' });
  assert.equal(p.mode, 'resume');
  assert.equal(p.prompt, 'carry on');
  assert.deepEqual(p.tools, folderObj.allowedTools);
  assert.equal(p.runsCode, true);
  assert.ok(Array.isArray(p.infoLines));
  assert.doesNotThrow(() => JSON.stringify(p));
});

// ---------------------------------------------------------------------------------------------------------
/** A stub hub + dialog + claude around handleJob. */
function stubs(w, over = {}) {
  const s = { logs: [], posted: [], started: [], confirms: [], runs: [] };
  s.deps = {
    log: (e, f) => s.logs.push([e, f]),
    claudePath: 'C:\\tools\\claude\\claude.exe',
    loadConfig: () => ({ ok: true, config: w.config() }),
    mcpDefinitions: () => ({}),
    projectsDir: () => w.projects,
    confirm: async (p) => { s.confirms.push(p); return over.approve ?? true; },
    startJob: async (id) => { s.started.push(id); if (over.startFails) throw new Error('HTTP 409'); },
    run: async (j) => { s.runs.push(j); return over.runResult ?? { ok: true, output: 'done', costUsd: 0.01, durationMs: 5, sessionId: j.resumeSessionId }; },
    postResult: async (id, r) => { s.posted.push([id, r]); return true; },
  };
  return s;
}

test('handleJob: a resume job runs in the session cwd, resumes that id, and the result carries resolvedFolder', win, async () => {
  const w = world();
  try {
    w.session(w.appSub);
    const s = stubs(w);
    await handleJob(s.deps, job());
    assert.equal(s.runs.length, 1);
    assert.equal(s.runs[0].cwd, w.appSub);
    assert.equal(s.runs[0].resumeSessionId, SID);
    assert.equal(s.runs[0].folder.path, w.app);
    assert.equal(s.runs[0].prompt, 'carry on');
    assert.match(s.confirms[0].infoLines.join('\n'), /Fix the login bug/);
    assert.deepEqual(s.started, ['j1']);
    assert.equal(s.posted.length, 1);
    assert.deepEqual(s.posted[0], ['j1', { ok: true, output: 'done', costUsd: 0.01, durationMs: 5, resolvedFolder: 'app' }]);
  } finally { w.done(); }
});

test('handleJob: if claude ever forks the session, the result says so with newSessionId', win, async () => {
  const w = world();
  try {
    w.session(w.app);
    const s = stubs(w, { runResult: { ok: true, output: 'x', sessionId: 'bbbbbbbb-0000-0000-0000-000000000002' } });
    await handleJob(s.deps, job());
    assert.equal(s.posted[0][1].newSessionId, 'bbbbbbbb-0000-0000-0000-000000000002');
    assert.equal(s.posted[0][1].resolvedFolder, 'app');
  } finally { w.done(); }
});

test('handleJob: an old-style job (no mode, folder name) still runs as new in the folder, without resume fields', win, async () => {
  const w = world();
  try {
    const s = stubs(w);
    await handleJob(s.deps, { id: 'j9', bot: { handle: 'dev' }, room: { id: 'r', name: 'Room' }, folder: 'app', prompt: 'look around' });
    assert.equal(s.runs.length, 1);
    assert.equal(s.runs[0].cwd, w.app);
    assert.equal(s.runs[0].resumeSessionId, undefined);
    assert.match(s.confirms[0].infoLines.join('\n'), /Mode: start a new session/);
    assert.deepEqual(s.posted[0], ['j9', { ok: true, output: 'done', costUsd: 0.01, durationMs: 5 }]);
    assert.equal('resolvedFolder' in s.posted[0][1], false);
  } finally { w.done(); }
});

test('handleJob: refusals are posted as refusedLocally and nothing runs', win, async () => {
  const w = world();
  try {
    // resume of an unknown session
    let s = stubs(w);
    await handleJob(s.deps, job());
    assert.equal(s.runs.length, 0);
    assert.equal(s.confirms.length, 0, 'no dialog for a job that cannot run');
    assert.equal(s.posted[0][1].refusedLocally, true);
    assert.match(s.posted[0][1].output, /not on this PC/);

    // resume whose cwd is outside
    w.session(w.outside);
    s = stubs(w);
    await handleJob(s.deps, job());
    assert.equal(s.runs.length, 0);
    assert.match(s.posted[0][1].output, /allowlist/);

    // Refuse pressed in the dialog: the result still names the resolved folder
    w.session(w.app);
    s = stubs(w, { approve: false });
    await handleJob(s.deps, job());
    assert.equal(s.runs.length, 0);
    assert.equal(s.posted[0][1].refusedLocally, true);
    assert.equal(s.posted[0][1].resolvedFolder, 'app');

    // new job in a folder that is not allowlisted
    s = stubs(w);
    await handleJob(s.deps, { id: 'j3', mode: 'new', folder: 'secrets', prompt: 'p', bot: { handle: 'dev' }, room: { name: 'r' } });
    assert.match(s.posted[0][1].output, /not in this PC's allowlist/);
  } finally { w.done(); }
});

test('handleJob: the hub refusing the start (cancelled) means nothing runs and nothing is posted', win, async () => {
  const w = world();
  try {
    w.session(w.app);
    const s = stubs(w, { startFails: true });
    await handleJob(s.deps, job());
    assert.equal(s.runs.length, 0);
    assert.equal(s.posted.length, 0);
  } finally { w.done(); }
});

test('handleJob: a malformed job is logged and dropped', async () => {
  const s = { logs: [], posted: [] };
  await handleJob({ log: (e) => s.logs.push(e), postResult: async () => s.posted.push(1) }, { id: 'x', mode: 'resume', prompt: 'p' });
  assert.deepEqual(s.logs, ['job_malformed']);
  assert.equal(s.posted.length, 0);
});
