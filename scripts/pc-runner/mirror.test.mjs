// node --test scripts/pc-runner
// Fixtures are small, hand-made lines shaped like Claude Code's JSONL; none of the content is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  CAPS, mapLine, scrubCap, summarizeToolInput, titleFromEntry, pathInfo, isExcluded, iterLines, scanHead, makeRepoInfo,
  createMirror, httpRequester,
} from './mirror.mjs';
import { scrub } from './scrub.mjs';
import { scrub as importScrub } from '../context-import.mjs';
import { validateConfig } from './lib.mjs';

const SID = '11111111-2222-3333-4444-555555555555';
const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();
const base = (n, extra = {}) => ({ uuid: `u${n}`, parentUuid: n ? `u${n - 1}` : null, isSidechain: false, timestamp: ts(n), cwd: 'C:\\work\\demo', sessionId: SID, ...extra });
const user = (n, content, extra) => ({ ...base(n, extra), type: 'user', message: { role: 'user', content } });
const asst = (n, content, extra) => ({ ...base(n, extra), type: 'assistant', message: { role: 'assistant', model: 'claude-test-1', content } });
const jl = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

// ---------------------------------------------------------------------------------------------------------
test('mapper: every entry kind, tool name from the matching tool_use id, sidechain flag', () => {
  const ctx = { toolNames: new Map() };
  const u = mapLine(user(0, 'fix the login bug'), ctx);
  assert.deepEqual(u, [{ uuid: 'u0', parentUuid: null, at: T0, kind: 'user', text: 'fix the login bug' }]);

  const a = mapLine(asst(1, [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git status', description: 'x' } }, { type: 'text', text: 'Done.' }]), ctx);
  assert.deepEqual(a.map((e) => [e.kind, e.text, e.tool]), [['assistant', 'Looking.', undefined], ['tool_use', 'git status', 'Bash'], ['assistant', 'Done.', undefined]]);
  assert.deepEqual(a.map((e) => e.uuid), ['u1', 'u1:1', 'u1:2']);
  assert.equal(a[0].model, 'claude-test-1');
  assert.equal(a[0].at, T0 + 1000);

  const r = mapLine(user(2, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'On branch main', is_error: false }, { type: 'tool_result', tool_use_id: 'nope', content: [{ type: 'text', text: 'boom' }], is_error: true }]), ctx);
  assert.deepEqual(r.map((e) => [e.kind, e.tool, e.text, e.isError]), [['tool_result', 'Bash', 'On branch main', false], ['tool_result', undefined, 'boom', true]]);

  const sum = mapLine({ ...user(3, 'Summary of the earlier work'), isCompactSummary: true }, ctx);
  assert.equal(sum[0].kind, 'summary');
  const legacy = mapLine({ type: 'summary', summary: 'Old style summary', leafUuid: 'leaf9' }, ctx);
  assert.deepEqual([legacy[0].kind, legacy[0].uuid, legacy[0].text], ['summary', 'summary-leaf9', 'Old style summary']);

  const side = mapLine(asst(4, [{ type: 'text', text: 'from a subagent' }], { isSidechain: true }), ctx);
  assert.equal(side[0].isSidechain, true);
});

test('mapper: skipped line types and injected text', () => {
  const ctx = { toolNames: new Map() };
  for (const type of ['mode', 'permission-mode', 'session-owner', 'atis-latch', 'last-prompt', 'file-history-snapshot', 'attachment', 'system', 'queue-operation', 'ai-title', 'api-request', 'cost-state']) {
    assert.deepEqual(mapLine({ ...base(1), type, content: 'x', attachment: { type: 'hook_success' } }, ctx), [], type);
  }
  assert.deepEqual(mapLine({ ...user(1, 'meta text'), isMeta: true }, ctx), []);
  assert.deepEqual(mapLine(user(1, '<local-command-caveat>Caveat: ignore</local-command-caveat>'), ctx), []);
  assert.deepEqual(mapLine(user(1, '<system-reminder>be nice</system-reminder>'), ctx), []);
  assert.deepEqual(mapLine(user(1, [{ type: 'text', text: '<system-reminder>x</system-reminder>' }]), ctx), []);
  assert.equal(mapLine(user(1, 'hello <system-reminder>secret hint</system-reminder> there'), ctx)[0].text, 'hello  there');
  assert.deepEqual(mapLine(asst(1, [{ type: 'thinking', thinking: 'only thinking' }]), ctx), []);
  assert.deepEqual(mapLine({ ...asst(1, [{ type: 'text', text: 'No response requested.' }]), message: { model: '<synthetic>', content: [{ type: 'text', text: 'x' }] } }, ctx), []);
  assert.deepEqual(mapLine(null, ctx), []);
  // a user message that is only tool results does not also produce an empty user entry
  assert.deepEqual(mapLine(user(1, [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]), ctx).map((e) => e.kind), ['tool_result']);
});

test('caps: each kind has its limit and the cut notice counts what was dropped', () => {
  const ctx = { toolNames: new Map() };
  const long = (n) => 'abcd'.repeat(Math.ceil(n / 4)).slice(0, n);
  const u = mapLine(user(0, long(9000)), ctx)[0];
  assert.equal(u.text.length, CAPS.text + ` \u2026[cut ${9000 - CAPS.text} chars]`.length);
  assert.ok(u.text.endsWith(` \u2026[cut ${9000 - CAPS.text} chars]`));
  const tu = mapLine(asst(1, [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: long(1000) } }]), ctx)[0];
  assert.ok(tu.text.endsWith(' \u2026[cut 600 chars]'));
  const tr = mapLine(user(2, [{ type: 'tool_result', tool_use_id: 'x', content: long(50_000) }]), ctx)[0];
  assert.ok(tr.text.endsWith(` \u2026[cut ${50_000 - CAPS.toolResult} chars]`));
  const sm = mapLine({ type: 'summary', summary: long(3000), leafUuid: 'l' }, ctx)[0];
  assert.ok(sm.text.endsWith(' \u2026[cut 1000 chars]'));
  assert.equal(scrubCap('short', 100), 'short');
  assert.equal(summarizeToolInput('Read', { file_path: 'C:\\a\\b.ts', offset: 5 }), 'C:\\a\\b.ts');
  assert.equal(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
  assert.equal(summarizeToolInput('mcp__x__y', { a: 1 }), '{"a":1}');
});

test('scrub: same rules as context-import, applied to texts, tool input and the title', () => {
  assert.equal(scrub, importScrub); // one shared implementation, not a copy
  const key = 'sk-ant-abcdefghijklmnopqrstuvwx';
  const ctx = { toolNames: new Map() };
  const u = mapLine(user(0, `use ${key} and mail bob@example.com or 0917 123 4567`), ctx)[0];
  assert.ok(!u.text.includes(key) && !u.text.includes('bob@example.com') && !u.text.includes('0917 123'));
  assert.match(u.text, /\[email\]/);
  assert.ok(!titleFromEntry(u).includes(key));
  const tu = mapLine(asst(1, [{ type: 'tool_use', id: 'y', name: 'Bash', input: { command: `curl -H "Authorization: Bearer abcdefghijklmnop" ${key}` } }]), ctx)[0];
  assert.ok(!tu.text.includes('abcdefghijklmnop') && !tu.text.includes(key));
  const tr = mapLine(user(2, [{ type: 'tool_result', tool_use_id: 'y', content: 'API_KEY=hunter2hunter2\npassword: swordfish' }]), ctx)[0];
  assert.ok(!tr.text.includes('hunter2') && !tr.text.includes('swordfish'));
});

test('title: first real prompt, collapsed, capped at 120; not a slash command wrapper', () => {
  const ctx = { toolNames: new Map() };
  const e = (c) => mapLine(user(0, c), ctx)[0];
  assert.equal(titleFromEntry(e('  fix   the\nbug ')), 'fix the bug');
  assert.equal(titleFromEntry(e('x'.repeat(300))).length, 120);
  assert.equal(titleFromEntry(e('<command-name>/clear</command-name>')), null);
  assert.equal(titleFromEntry(e('[Request interrupted by user]')), null);
  assert.equal(titleFromEntry(mapLine(asst(1, [{ type: 'text', text: 'hi' }]), ctx)[0]), null);
});

// ---------------------------------------------------------------------------------------------------------
test('paths and subagent ids', () => {
  const root = path.join('C:\\', 'proj');
  assert.deepEqual(pathInfo(root, path.join(root, 'dirA', `${SID}.jsonl`)), { projectDir: 'dirA', id: SID, parentId: null });
  assert.deepEqual(pathInfo(root, path.join(root, 'dirA', SID, 'subagents', 'agent-ab12.jsonl')), { projectDir: 'dirA', id: `${SID}:agent-ab12`, parentId: SID });
  assert.equal(pathInfo(root, path.join(root, 'dirA', SID, 'tool-results', 'x.jsonl')), null);
  assert.equal(pathInfo(root, path.join(root, 'dirA', SID, 'subagents', 'deep', 'x.jsonl')), null);
  assert.equal(pathInfo(root, path.join(root, 'dirA', 'notes.txt')), null);
  assert.equal(pathInfo(root, path.join('C:\\', 'elsewhere', 'a.jsonl')), null);
});

test('exclude: case-insensitive prefixes on a folder boundary, globs, projects dir name', () => {
  const ex = (p, s) => isExcluded(p, s);
  assert.equal(ex(['C:\\Work\\Private'], { cwd: 'c:\\work\\private' }), true);
  assert.equal(ex(['C:\\Work\\Private'], { cwd: 'c:/work/private/sub/deeper' }), true);
  assert.equal(ex(['C:\\Work\\Private'], { cwd: 'C:\\work\\private2' }), false);
  assert.equal(ex(['C:\\work\\acme*'], { cwd: 'C:\\work\\acme-site' }), true);
  assert.equal(ex(['*-secret-*'], { cwd: 'C:\\x\\my-secret-notes' }), true);
  assert.equal(ex(['*-secret-*'], { cwd: 'C:\\x\\public' }), false);
  assert.equal(ex(['C--Users-alex-private'], { cwd: null, projectDir: 'C--Users-alex-private-stuff' }), true);
  assert.equal(ex(['C--Users-alex-private'], { cwd: 'D:\\a', projectDir: 'C--Users-bob' }), false);
  assert.equal(ex([], { cwd: 'C:\\a' }), false);
  assert.equal(ex(['a.b'], { cwd: 'C:\\aXb' }), false); // a dot is a dot, not a wildcard
});

test('config: mirror keys validate and default', () => {
  const d = validateConfig({ folders: {} }).config;
  assert.deepEqual([d.mirror, d.mirrorBackfillDays, d.mirrorExclude, d.claudeProjectsDir], [true, 14, [], null]);
  const g = validateConfig({ folders: {}, mirror: false, mirrorBackfillDays: 3, mirrorExclude: ['C:\\a*'], claudeProjectsDir: 'D:\\p' });
  assert.equal(g.ok, true);
  for (const bad of [{ mirror: 'yes' }, { mirrorBackfillDays: -1 }, { mirrorBackfillDays: 1.5 }, { mirrorExclude: 'x' }, { mirrorExclude: [''] }, { mirrorExclude: [5] }, { claudeProjectsDir: 'rel\\dir' }]) {
    assert.equal(validateConfig({ folders: {}, ...bad }).ok, false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------------------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mirror-test-'));

test('iterLines: only complete lines, byte offsets, resume, oversized line skipped', async () => {
  const dir = tmp();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, 'one\ntwo\r\nthr');
  const got = [];
  for await (const l of iterLines(f, 0, { chunk: 4 })) got.push([l.line, l.end]);
  assert.deepEqual(got, [['one', 4], ['two', 9]]); // "thr" has no newline yet: it waits
  fs.appendFileSync(f, 'ee\n');
  const more = [];
  for await (const l of iterLines(f, 9, { chunk: 4 })) more.push([l.line, l.end]);
  assert.deepEqual(more, [['three', 15]]);
  // multi-byte text: offsets count bytes
  fs.writeFileSync(f, '\u00e9\u00e9\nx\n');
  const mb = [];
  for await (const l of iterLines(f, 0, { chunk: 3 })) mb.push([l.line, l.end]);
  assert.deepEqual(mb, [['\u00e9\u00e9', 5], ['x', 7]]);
  fs.writeFileSync(f, `${'z'.repeat(50)}\nok\n`);
  const big = [];
  for await (const l of iterLines(f, 0, { chunk: 8, maxLine: 20 })) big.push([l.line, l.end]);
  assert.deepEqual(big, [[null, 51], ['ok', 54]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanHead: cwd, first time and title without reading the whole file', async () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, jl({ type: 'mode', mode: 'x' }, user(0, '<system-reminder>r</system-reminder>', { isMeta: true }), user(1, 'build the thing'), asst(2, [{ type: 'text', text: 'ok' }])));
  const m = await scanHead(f);
  assert.deepEqual(m, { cwd: 'C:\\work\\demo', firstAt: T0, title: 'build the thing' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repo info: git facts cached per cwd, missing folder and non-repo give null, remote scrubbed', async () => {
  let calls = 0;
  const git = async (cwd, args) => {
    calls++;
    const k = args.join(' ');
    return { 'rev-parse --show-toplevel': 'C:/work/demo', 'remote get-url origin': 'https://user:pw12345@github.com/o/demo.git', 'symbolic-ref --short -q HEAD': 'main', 'rev-parse HEAD': 'abc123' }[k] ?? null;
  };
  const info = makeRepoInfo({ git, exists: (d) => d !== 'C:\\gone' });
  const r = await info('C:\\work\\demo');
  assert.equal(r.name, 'demo');
  assert.equal(r.branch, 'main');
  assert.equal(r.head, 'abc123');
  assert.ok(!r.remote.includes('pw12345'));
  const n = calls;
  await info('C:\\work\\demo');
  assert.equal(calls, n);
  assert.equal(await info('C:\\gone'), null);
  assert.equal(await info(null), null);
  assert.equal(await makeRepoInfo({ git: async () => null, exists: () => true })('C:\\x'), null);
});

// ---------------------------------------------------------------------------------------------------------
// Stub hub: the contract's sync / PUT / POST entries, with offset bookkeeping and a 409 when `from` is wrong.

async function stubHub(opts = {}) {
  const sessions = {}; // id -> { offset, meta, entries[], posts }
  const log = [];
  const hub = { sessions, log, fail409Once: false, failNext: 0, rejectEmpty: false, token: 'a'.repeat(32) };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${hub.token}`) return send(401, { error: 'no' });
      const url = new URL(req.url, 'http://x');
      const m = /^\/api\/pc-sessions(?:\/([^/]+))?(\/entries)?$/.exec(url.pathname);
      if (!m) return send(404, {});
      const id = m[1] && decodeURIComponent(m[1]);
      log.push(`${req.method} ${m[1] ? (m[2] ? ':id/entries' : ':id') : 'x'}`);
      if (hub.failNext > 0) { hub.failNext--; return send(503, { error: 'down' }); }
      const b = body ? JSON.parse(body) : null;
      if (req.method === 'GET' && id === 'sync') return send(200, { sessions: Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, { offset: v.offset }])) });
      if (req.method === 'GET' && id === undefined) return send(404, {});
      if (req.method === 'PUT' && id && hub.gone?.has(id)) return send(410, { error: 'deleted' });
      if (req.method === 'PUT' && id) {
        sessions[id] ??= { offset: 0, entries: [], posts: [] };
        sessions[id].meta = b;
        return send(200, { ok: true, offset: sessions[id].offset });
      }
      if (req.method === 'POST' && id && m[2]) {
        const s = sessions[id];
        if (!s) return send(404, { error: 'unknown' });
        if (hub.rejectEmpty && !b.entries.length) return send(400, { error: 'empty' });
        if (hub.fail409Once) { hub.fail409Once = false; return send(409, { error: 'offset', offset: s.offset }); }
        if (b.from !== s.offset) return send(409, { error: 'offset', offset: s.offset });
        s.entries.push(...b.entries);
        s.posts.push({ from: b.from, to: b.to, n: b.entries.length, bytes: Buffer.byteLength(body) });
        s.offset = b.to;
        return send(200, { ok: true, offset: b.to, stored: b.entries.length, truncated: false });
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hub.url = `http://127.0.0.1:${server.address().port}`;
  hub.close = () => server.close();
  return hub;
}

function rig(hub, root, over = {}) {
  const cfg = { mirror: true, mirrorBackfillDays: 14, mirrorExclude: [], claudeProjectsDir: root, ...over.cfg };
  const logs = [];
  let paused = false;
  const m = createMirror({
    getConfig: () => cfg,
    request: httpRequester({ baseUrl: hub.url, token: hub.token, guard: over.guard }),
    isPaused: () => paused,
    log: (e, f) => logs.push([e, f]),
    machine: 'TEST-PC',
    git: async () => null,
    pollMs: 20,
    ...over.opts,
  });
  return { m, cfg, logs, pause: (v) => { paused = v; } };
}

function setup() {
  const root = tmp();
  const put = (dir, name, text, ageDays = 0) => {
    const f = path.join(root, dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    const t = new Date(Date.now() - ageDays * 86_400_000);
    fs.utimesSync(f, t, t);
    return f;
  };
  return { root, put, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const SIMPLE = () => jl(user(0, 'hello'), asst(1, [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a.ts' } }]), user(2, [{ type: 'tool_result', tool_use_id: 't', content: 'file' }]));

test('mirror: backfill window, subagent ids, metadata, offsets advance to the end of the file', async () => {
  const hub = await stubHub();
  const s = setup();
  const SID2 = '99999999-2222-3333-4444-555555555555';
  const f = s.put('dirA', `${SID}.jsonl`, SIMPLE());
  s.put('dirA', `${SID}/subagents/agent-x1.jsonl`, jl(user(0, 'sub task', { isSidechain: true })));
  s.put('dirA', `${SID}/tool-results/big.jsonl`, jl(user(0, 'must not be mirrored')));
  s.put('dirA', `${SID2}.jsonl`, SIMPLE(), 40); // older than 14 days: not backfilled
  const { m, logs } = rig(hub, s.root);
  await m.pass({ full: true });
  assert.deepEqual(Object.keys(hub.sessions).sort(), [SID, `${SID}:agent-x1`].sort());
  const main = hub.sessions[SID];
  assert.deepEqual(main.entries.map((e) => e.kind), ['user', 'assistant', 'tool_use', 'tool_result']);
  assert.equal(main.entries[3].tool, 'Read');
  assert.equal(main.offset, fs.statSync(f).size);
  assert.deepEqual([main.meta.machine, main.meta.projectDir, main.meta.cwd, main.meta.title, main.meta.parentId], ['TEST-PC', 'dirA', 'C:\\work\\demo', 'hello', null]);
  assert.equal(main.meta.firstAt, T0);
  const sub = hub.sessions[`${SID}:agent-x1`];
  assert.equal(sub.meta.parentId, SID);
  assert.equal(sub.entries[0].isSidechain, true);
  assert.deepEqual(logs.filter(([e]) => e === 'mirror_backfill').map(([, f2]) => f2.sessions), [2]);
  assert.ok(!JSON.stringify(logs).includes('hello'), 'no entry text in the log');
  // nothing new: a second pass sends nothing
  const before = hub.log.length;
  await m.pass({ full: true });
  assert.equal(hub.log.filter((l, i) => i >= before && l.startsWith('POST')).length, 0);
  m.stop(); hub.close(); s.done();
});

test('mirror: a partial trailing line waits for its newline, then goes out once', async () => {
  const hub = await stubHub();
  const s = setup();
  const full = jl(user(0, 'first'));
  const second = JSON.stringify(user(1, 'second'));
  const f = s.put('dirA', `${SID}.jsonl`, full + second.slice(0, 30));
  const { m } = rig(hub, s.root);
  await m.pass({ full: true });
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['first']);
  assert.equal(hub.sessions[SID].offset, Buffer.byteLength(full));
  fs.appendFileSync(f, second.slice(30) + '\n');
  await m.pass();
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['first', 'second']);
  m.stop(); hub.close(); s.done();
});

test('mirror: resumes from the hub offset after a restart and never resends', async () => {
  const hub = await stubHub();
  const s = setup();
  const f = s.put('dirA', `${SID}.jsonl`, jl(user(0, 'one'), user(1, 'two')));
  const a = rig(hub, s.root);
  await a.m.pass({ full: true });
  a.m.stop();
  fs.appendFileSync(f, jl(user(2, 'three')));
  const b = rig(hub, s.root); // a new process: only the hub remembers
  await b.m.pass();
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['one', 'two', 'three']);
  assert.equal(hub.sessions[SID].posts.length, 2);
  assert.equal(hub.sessions[SID].meta.title, 'one'); // title recovered from the head even though we resumed mid-file
  b.m.stop(); hub.close(); s.done();
});

test('mirror: 409 resyncs from the offset the hub names', async () => {
  const hub = await stubHub();
  const s = setup();
  s.put('dirA', `${SID}.jsonl`, jl(user(0, 'one'), user(1, 'two'), user(2, 'three')));
  hub.fail409Once = true;
  const { m, logs } = rig(hub, s.root);
  await m.pass({ full: true });
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['one', 'two', 'three']);
  assert.ok(logs.some(([e]) => e === 'mirror_resync'));
  // hub is ahead of us (another copy of the file was already consumed): the runner follows the hub's number
  hub.sessions[SID].offset = 0; hub.sessions[SID].entries = [];
  fs.appendFileSync(path.join(s.root, 'dirA', `${SID}.jsonl`), jl(user(3, 'four')));
  await m.pass();
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['one', 'two', 'three', 'four']);
  m.stop(); hub.close(); s.done();
});

test('mirror: batches stay within 500 entries and 900 KB', async () => {
  const hub = await stubHub();
  const s = setup();
  const lines = [];
  for (let i = 0; i < 1200; i++) lines.push(user(i, `message ${i}`));
  s.put('dirA', `${SID}.jsonl`, jl(...lines));
  const bigSid = '77777777-2222-3333-4444-555555555555';
  const big = [];
  for (let i = 0; i < 300; i++) big.push(user(i, 'y'.repeat(7000)));
  s.put('dirA', `${bigSid}.jsonl`, jl(...big));
  const { m } = rig(hub, s.root);
  await m.pass({ full: true });
  const p1 = hub.sessions[SID].posts;
  assert.equal(hub.sessions[SID].entries.length, 1200);
  assert.ok(p1.length >= 3 && p1.every((p) => p.n <= 500));
  const p2 = hub.sessions[bigSid].posts;
  assert.equal(hub.sessions[bigSid].entries.length, 300);
  assert.ok(p2.length >= 3 && p2.every((p) => p.bytes <= 900 * 1024 + 2048), JSON.stringify(p2.map((p) => p.bytes)));
  m.stop(); hub.close(); s.done();
});

test('mirror: exclude matches cwd and projects dir name; excluded files are never PUT', async () => {
  const hub = await stubHub();
  const s = setup();
  const id = (n) => `${n}0000000-2222-3333-4444-555555555555`;
  s.put('dirA', `${id(1)}.jsonl`, jl(user(0, 'public one')));
  s.put('dirSecretStuff', `${id(2)}.jsonl`, jl(user(0, 'by dir name')));
  s.put('dirB', `${id(3)}.jsonl`, jl(user(0, 'by cwd', { cwd: 'C:\\clients\\acme\\site' })));
  const { m } = rig(hub, s.root, { cfg: { mirrorExclude: ['dirSecret*', 'c:\\clients\\acme'] } });
  await m.pass({ full: true });
  assert.deepEqual(Object.keys(hub.sessions), [id(1)]);
  assert.equal(hub.log.filter((l) => l === 'PUT :id').length, 1);
  m.stop(); hub.close(); s.done();
});

test('mirror: old file already known to the hub is resumed when it grows; unknown old file stays out', async () => {
  const hub = await stubHub();
  const s = setup();
  const f = s.put('dirA', `${SID}.jsonl`, jl(user(0, 'old')), 60);
  hub.sessions[SID] = { offset: fs.statSync(f).size, entries: [], posts: [] };
  const other = '88888888-2222-3333-4444-555555555555';
  s.put('dirA', `${other}.jsonl`, jl(user(0, 'ancient')), 60);
  const { m } = rig(hub, s.root);
  await m.pass({ full: true });
  assert.deepEqual(hub.sessions[SID].entries, []);
  assert.ok(!hub.sessions[other]);
  fs.appendFileSync(f, jl(user(1, 'new')));
  const t = new Date(); fs.utimesSync(f, t, t);
  await m.pass({ full: true });
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['new']);
  m.stop(); hub.close(); s.done();
});

test('mirror: a file that shrank is logged and skipped, not resent', async () => {
  const hub = await stubHub();
  const s = setup();
  const f = s.put('dirA', `${SID}.jsonl`, jl(user(0, 'one'), user(1, 'two')));
  const { m, logs } = rig(hub, s.root);
  await m.pass({ full: true });
  fs.writeFileSync(f, jl(user(0, 'rewritten')));
  await m.pass({ full: true });
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['one', 'two']);
  assert.ok(logs.some(([e]) => e === 'mirror_file_shrunk'));
  m.stop(); hub.close(); s.done();
});

test('mirror: paused and mirror:false send nothing, not even a sync; resuming picks up', async () => {
  const hub = await stubHub();
  const s = setup();
  s.put('dirA', `${SID}.jsonl`, SIMPLE());
  const r = rig(hub, s.root);
  r.pause(true);
  assert.deepEqual(await r.m.pass({ full: true }), { skipped: true });
  r.pause(false);
  r.cfg.mirror = false;
  assert.deepEqual(await r.m.pass({ full: true }), { skipped: true });
  assert.deepEqual(hub.log, []);
  r.cfg.mirror = true;
  await r.m.pass({ full: true });
  assert.equal(hub.sessions[SID].entries.length, 4);
  r.m.stop(); hub.close(); s.done();
});

test('mirror: network errors throw (the loop backs off) and the retry loses nothing', async () => {
  const hub = await stubHub();
  const s = setup();
  s.put('dirA', `${SID}.jsonl`, SIMPLE());
  const { m } = rig(hub, s.root);
  hub.failNext = 1; // the sync call fails
  await assert.rejects(m.pass({ full: true }), (e) => e.network === true);
  hub.failNext = 2; // sync ok? no: sync fails first, so burn it, then PUT fails
  await assert.rejects(m.pass({ full: true }));
  await assert.rejects(m.pass({ full: true }));
  await m.pass({ full: true });
  assert.equal(hub.sessions[SID].entries.length, 4);
  m.stop(); hub.close(); s.done();
});

test('mirror: the request guard keeps the token off the wire until the tunnel is verified', async () => {
  const hub = await stubHub();
  const s = setup();
  s.put('dirA', `${SID}.jsonl`, SIMPLE());
  let verified = false;
  const guard = () => { if (!verified) throw Object.assign(new Error('tunnel not verified; nothing sent'), { network: true }); };
  const { m } = rig(hub, s.root, { over: undefined, guard });
  await assert.rejects(m.pass({ full: true }), /not verified/);
  assert.deepEqual(hub.log, []);
  verified = true;
  await m.pass({ full: true });
  assert.equal(hub.sessions[SID].entries.length, 4);
  m.stop(); hub.close(); s.done();
});

test('mirror: hub that refuses empty batches still lets skipped-only files advance without looping', async () => {
  const hub = await stubHub();
  hub.rejectEmpty = true;
  const s = setup();
  s.put('dirA', `${SID}.jsonl`, jl({ type: 'mode', mode: 'x', sessionId: SID, timestamp: ts(0) }, { type: 'file-history-snapshot', messageId: 'm' }));
  const { m } = rig(hub, s.root);
  await m.pass({ full: true });
  await m.pass({ full: true });
  assert.equal(hub.sessions[SID].entries.length, 0);
  m.stop(); hub.close(); s.done();
});

test('mirror: loop start/stop with the file watcher and poll picks up appended lines', async () => {
  const hub = await stubHub();
  const s = setup();
  const f = s.put('dirA', `${SID}.jsonl`, jl(user(0, 'one')));
  const { m } = rig(hub, s.root);
  m.start();
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); };
  await until(() => hub.sessions[SID]?.entries.length === 1);
  fs.appendFileSync(f, jl(user(1, 'two')));
  await until(() => hub.sessions[SID]?.entries.length === 2);
  assert.deepEqual(hub.sessions[SID].entries.map((e) => e.text), ['one', 'two']);
  m.stop();
  hub.close(); s.done();
});

test('real-shaped repo info lands in the session PUT', async () => {
  const hub = await stubHub();
  const s = setup();
  s.put('dirA', `${SID}.jsonl`, jl(user(0, 'hello')));
  const git = async (cwd, args) => ({ 'rev-parse --show-toplevel': 'C:/work/demo', 'remote get-url origin': 'git@github.com:o/demo.git', 'symbolic-ref --short -q HEAD': 'feat', 'rev-parse HEAD': 'deadbeef' }[args.join(' ')] ?? null);
  const { m } = rig(hub, s.root, { opts: { git } });
  // makeRepoInfo checks the folder exists; C:\work\demo does not here, so expect null, then a real folder
  await m.pass({ full: true });
  assert.equal(hub.sessions[SID].meta.repo, null);
  m.stop(); hub.close(); s.done();
});

test('mirror: a session deleted in Toki (410) is not sent again', async () => {
  const hub = await stubHub();
  hub.gone = new Set([SID]);
  const s = setup();
  s.put('dirA', `${SID}.jsonl`, jl(user(0, 'one')));
  const { m, logs } = rig(hub, s.root);
  await m.pass({ full: true });
  fs.appendFileSync(path.join(s.root, 'dirA', `${SID}.jsonl`), jl(user(1, 'two')));
  await m.pass({ full: true });
  assert.equal(hub.sessions[SID], undefined);
  assert.equal(hub.log.filter((l) => l === 'POST :id/entries').length, 0);
  assert.equal(hub.log.filter((l) => l === 'PUT :id').length, 1);
  assert.ok(logs.some(([e]) => e === 'mirror_session_deleted'));
  m.stop(); hub.close(); s.done();
});
