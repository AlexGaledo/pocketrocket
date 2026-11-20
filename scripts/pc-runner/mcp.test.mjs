// node --test scripts/pc-runner
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, makeVerifier, repoNameFor, TOOLS, ON_VPS_WARNING } from './mcp.mjs';
import { tunnelOwnerCheck } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'a'.repeat(32);
const ROOMS = [
  { id: 'r1', name: 'Wika Dev', kind: 'group', project: { slug: 'wika', name: 'Wika' }, hasFolder: true },
  { id: 'r2', name: 'Ops', kind: 'group', project: null, hasFolder: false },
  { id: 'r3', name: 'ops', kind: 'dm', project: null, hasFolder: false },
];

// A stub hub on a random port. `routes` maps "METHOD /path" to (req, body) => [status, json].
let stub, port, seen, routes;
before(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const key = `${req.method} ${req.url.split('?')[0]}`;
      const h = routes[key];
      const [status, json] = h ? h(req, body) : [404, { error: 'no route' }];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  port = stub.address().port;
});
after(() => stub.close());

const baseRoutes = () => ({ 'GET /api/cc/rooms': () => [200, ROOMS] });
const mk = (extra = {}) => {
  seen = [];
  routes = baseRoutes();
  return createServer({
    loadConfig: () => ({ ok: true, config: { localPort: port } }),
    readToken: () => TOKEN,
    verify: async () => ({ ok: true }),
    repo: 'my-repo',
    env: {},
    ...extra,
  });
};
const call = async (server, name, args) => {
  const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { ...r.result, text: r.result.content?.[0]?.text };
};

test('handshake: initialize echoes a supported version, advertises tools, notification gets no reply', async () => {
  const s = mk();
  const r = await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }));
  const j = JSON.parse(r);
  assert.equal(j.id, 0);
  assert.equal(j.result.protocolVersion, '2024-11-05');
  assert.deepEqual(j.result.capabilities, { tools: {} });
  assert.equal(j.result.serverInfo.name, 'pocketrocket');
  const unknown = JSON.parse(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })));
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
  assert.equal(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  assert.deepEqual(JSON.parse(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }))).result, {});
});

test('framing: parse error, unknown method, blank lines, unknown tool', async () => {
  const s = mk();
  assert.equal(JSON.parse(await s.handleLine('{nope')).error.code, -32700);
  assert.equal(await s.handleLine('   '), null);
  assert.equal(JSON.parse(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list' }))).error.code, -32601);
  assert.equal(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'whatever/else' })), null);
  const r = JSON.parse(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } })));
  assert.equal(r.error.code, -32602);
  assert.equal(JSON.parse(await s.handleLine('[]')).error.code, -32600);
});

test('tools/list: exactly the eight tools with object schemas and the safe-write teaching', async () => {
  const s = mk();
  const r = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  assert.deepEqual(r.map((t) => t.name), ['list_rooms', 'read_room', 'post_to_room', 'read_state', 'read_file', 'write_file', 'log_decision', 'handoff']);
  for (const t of r) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
    for (const req of t.inputSchema.required ?? []) assert.ok(req in t.inputSchema.properties, `${t.name}.${req}`);
  }
  const w = TOOLS.find((t) => t.name === 'write_file');
  assert.deepEqual(w.inputSchema.required, ['room', 'path', 'text', 'base']);
  assert.match(w.description, /read_file/);
  assert.match(w.description, /merge/i);
  assert.match(w.description, /blindly/);
  assert.match(TOOLS.find((t) => t.name === 'log_decision').description, /append-only/);
});

test('room resolution: id, case-insensitive name, ambiguity, unknown; list is cached', async () => {
  const s = mk();
  routes['GET /api/cc/rooms/r1/messages'] = () => [200, { messages: [{ seq: 4, at: '2026-11-18T10:00:00Z', author: 'Maya', text: 'hello' }] }];
  const byId = await call(s, 'read_room', { room: 'r1' });
  assert.match(byId.text, /\[4\] 2026-11-18 10:00Z Maya: hello/);
  const byName = await call(s, 'read_room', { room: 'WIKA dev' });
  assert.ok(!byName.isError);
  assert.equal(seen.filter((x) => x.url === '/api/cc/rooms').length, 1, 'rooms fetched once, then cached');

  const amb = await call(s, 'read_room', { room: 'OPS' });
  assert.equal(amb.isError, true);
  assert.match(amb.text, /More than one room/);
  assert.match(amb.text, /r2/);
  assert.match(amb.text, /r3/);

  const none = await call(s, 'read_room', { room: 'nope' });
  assert.equal(none.isError, true);
  assert.match(none.text, /No room "nope"/);
  assert.match(none.text, /Wika Dev \(r1\)/);
});

test('requests carry the token, the repo and the session headers', async () => {
  const s = mk({ env: { CLAUDE_SESSION_ID: 'sess-123' } });
  routes['POST /api/cc/rooms/r2/messages'] = () => [200, { ok: true, id: 'm9' }];
  const r = await call(s, 'post_to_room', { room: 'r2', text: 'hi' });
  assert.match(r.text, /Posted to Ops/);
  const post = seen.find((x) => x.method === 'POST');
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(post.headers['x-cc-repo'], 'my-repo');
  assert.equal(post.headers['x-cc-session'], 'sess-123');
  assert.deepEqual(post.body, { text: 'hi' });

  const s2 = mk();
  routes['POST /api/cc/rooms/r2/messages'] = () => [200, { ok: true, id: 'm9' }];
  await call(s2, 'post_to_room', { room: 'r2', text: 'hi' });
  assert.equal(seen.find((x) => x.method === 'POST').headers['x-cc-session'], undefined);
});

test('write_file: success shows the new hash; 409 returns the current text and says to merge and retry', async () => {
  const s = mk();
  routes['GET /api/cc/rooms/r1/files/text'] = () => [200, { path: 'current.md', text: 'v1', hash: 'h1', rev: 1 }];
  const rd = await call(s, 'read_file', { room: 'r1', path: 'current.md' });
  assert.match(rd.text, /hash: h1/);
  assert.match(rd.text, /base=h1/);
  assert.match(seen.at(-1).url, /path=current\.md/);

  routes['POST /api/cc/rooms/r1/files/text'] = (_q, b) => (b.base === 'h1'
    ? [200, { ok: true, path: 'current.md', hash: 'h2', rev: 2 }]
    : [409, { error: 'stale', current: { text: 'someone else wrote this', hash: 'h9', rev: 7 } }]);
  const ok = await call(s, 'write_file', { room: 'r1', path: 'current.md', text: 'v2', base: 'h1', sources: ['a.md'] });
  assert.ok(!ok.isError);
  assert.match(ok.text, /new hash: h2/);
  assert.deepEqual(seen.at(-1).body, { path: 'current.md', text: 'v2', base: 'h1', sources: ['a.md'] });

  const bad = await call(s, 'write_file', { room: 'r1', path: 'current.md', text: 'v3', base: 'h-old' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /CONFLICT/);
  assert.match(bad.text, /someone else wrote this/);
  assert.match(bad.text, /base=h9/);
  assert.match(bad.text, /Do not overwrite blindly/);

  const missing = await call(s, 'write_file', { room: 'r1', path: 'current.md', text: 'x' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /`base` is required/);
});

test('read_state, log_decision and handoff format readable text', async () => {
  const s = mk();
  routes['GET /api/cc/rooms/r1/state'] = () => [200, {
    room: { name: 'Wika Dev' }, project: { slug: 'wika', name: 'Wika' },
    current: { path: 'current.md', text: 'plan', hash: 'h1', rev: 3 }, decisions: [{ id: 'd1', title: 'Use Expo', at: '2026-11-17T08:00:00Z', by: 'Alex' }],
  }];
  routes['POST /api/cc/rooms/r1/decision'] = () => [200, { ok: true, id: 'd2', rev: 4 }];
  routes['POST /api/cc/rooms/r1/handoff'] = () => [200, { ok: true, id: 'h5' }];
  const st = await call(s, 'read_state', { room: 'r1' });
  assert.match(st.text, /Project: Wika/);
  assert.match(st.text, /hash: h1/);
  assert.match(st.text, /\[d1\] Use Expo/);
  const dec = await call(s, 'log_decision', { room: 'r1', title: 'T', text: 'why', supersedes: 'd1' });
  assert.match(dec.text, /as d2/);
  assert.equal(seen.at(-1).body.supersedes, 'd1');
  const ho = await call(s, 'handoff', { room: 'r1', to: 'maya', task: 'do it', context: 'ctx' });
  assert.match(ho.text, /Handoff to maya/);
  assert.deepEqual(seen.at(-1).body, { to: 'maya', task: 'do it', context: 'ctx' });
});

test('other hub errors become isError results with the hub message', async () => {
  const s = mk();
  routes['GET /api/cc/rooms/r1/files/text'] = () => [404, { error: 'no such file' }];
  const r = await call(s, 'read_file', { room: 'r1', path: 'x.md' });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 404.*no such file/);
});

test('runner off: connection refused on localPort says to turn the runner on', async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const s = mk({ loadConfig: () => ({ ok: true, config: { localPort: deadPort } }) });
  const r = await call(s, 'list_rooms', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /runner is not running/);
  assert.match(r.text, /Toki Runner ON/);
  assert.ok(!r.text.includes(TOKEN));
});

test('no token or a failed tunnel proof: nothing is sent', async () => {
  let s = mk({ readToken: () => null });
  let r = await call(s, 'list_rooms', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /not paired/);
  s = mk({ verify: async () => ({ ok: false, message: 'Another program is listening' }) });
  r = await call(s, 'list_rooms', {});
  assert.equal(r.isError, true);
  assert.equal(seen.length, 0);
});

test('tunnelOwnerCheck: only the runner\'s own ssh child may hold the port', () => {
  const procs = { 100: { ppid: 1, name: 'node.exe', cmd: 'node "C:\\x\\runner.mjs" run' }, 200: { ppid: 100, name: 'ssh.exe', cmd: 'ssh -N' }, 300: { ppid: 1, name: 'node.exe', cmd: 'node evil.js' } };
  assert.deepEqual(tunnelOwnerCheck({ listeners: [{ pid: 200 }, { pid: 200 }], procs, runnerPid: 100 }), { ok: true });
  assert.equal(tunnelOwnerCheck({ listeners: [{ pid: 300 }], procs, runnerPid: 100 }).reason, 'squatted');
  assert.equal(tunnelOwnerCheck({ listeners: [{ pid: 200 }, { pid: 300 }], procs, runnerPid: 100 }).reason, 'squatted');
  assert.equal(tunnelOwnerCheck({ listeners: [], procs, runnerPid: 100 }).reason, 'tunnel-down');
  assert.equal(tunnelOwnerCheck({ listeners: [{ pid: 200 }], procs, runnerPid: null }).reason, 'runner-off');
  assert.equal(tunnelOwnerCheck({ listeners: [{ pid: 200 }], procs: { ...procs, 100: { ppid: 1, name: 'node.exe', cmd: 'node other.js' } }, runnerPid: 100 }).reason, 'runner-off');
  // an ssh that is not the runner's child (pid reuse, someone else's tunnel) is a squatter
  assert.equal(tunnelOwnerCheck({ listeners: [{ pid: 200 }], procs: { ...procs, 200: { ppid: 5, name: 'ssh.exe', cmd: '' } }, runnerPid: 100 }).reason, 'squatted');
});

test('makeVerifier maps the check to messages and caches a success briefly', async () => {
  let t = 0;
  let runs = 0;
  const procs = { 100: { ppid: 1, name: 'node.exe', cmd: 'node runner.mjs run' }, 200: { ppid: 100, name: 'ssh.exe', cmd: '' } };
  const v = makeVerifier({ getPort: () => 7789, now: () => t, runnerPid: () => 100, listeners: () => { runs++; return [{ pid: 200 }]; }, procs: () => procs });
  assert.deepEqual(await v(), { ok: true });
  assert.deepEqual(await v(), { ok: true });
  assert.equal(runs, 1);
  t = 60_000;
  await v();
  assert.equal(runs, 2);
  const off = makeVerifier({ getPort: () => 7789, runnerPid: () => null, listeners: () => [], procs: () => ({}) });
  assert.match((await off()).message, /not running/);
  const squat = makeVerifier({ getPort: () => 7789, runnerPid: () => 100, listeners: () => [{ pid: 999 }], procs: () => ({ ...procs, 999: { ppid: 1, name: 'node.exe', cmd: '' } }) });
  assert.match((await squat()).message, /Another program/);
  const boom = makeVerifier({ getPort: () => 7789, runnerPid: () => 100, listeners: () => { throw new Error('ps failed'); }, procs: () => ({}) });
  assert.match((await boom()).message, /refusing to send/);
});

test('repoNameFor uses the git top-level, else the folder name', () => {
  assert.equal(repoNameFor('C:\\code\\app\\src', () => ({ status: 0, stdout: 'C:/code/app\n' })), 'app');
  assert.equal(repoNameFor('C:\\code\\notes', () => ({ status: 128, stdout: '' })), 'notes');
  assert.equal(repoNameFor('C:\\code\\notes', () => { throw new Error('no git'); }), 'notes');
});

test('real process over stdio: newline-delimited framing end to end, stderr only for logs', async () => {
  seen = [];
  routes = { ...baseRoutes() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mcp-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sshAlias: 'crm-agency', localPort: port, folders: { x: { path: 'C:\\x' } } }));
    fs.writeFileSync(path.join(dir, 'token'), TOKEN);
    const child = spawn(process.execPath, [path.join(HERE, 'mcp.mjs')], {
      cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, POCKETROCKET_RUNNER_DIR: dir, POCKETROCKET_RUNNER_NO_TUNNEL: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\r\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_rooms', arguments: {} } }) + '\n');
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines.find((l) => l.id === 1).result.protocolVersion, '2025-06-18');
    assert.match(lines.find((l) => l.id === 2).result.content[0].text, /Wika Dev \[r1\]/);
    assert.match(seen[0].headers['x-cc-repo'], /^[ -~]+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------
// Bridge P6: the session lock warning
test('lock: a session on the VPS gets a warning line on every tool result (success and error); a local one does not', async () => {
  for (const [state, warned] of [['on-vps', true], ['moving', true], ['pulling', true], ['local', false]]) {
    const s = mk({ env: { CLAUDE_SESSION_ID: 'sess-1' } });
    routes['GET /api/cc/session-state'] = () => [200, { state }];
    const ok = await call(s, 'list_rooms', {});
    assert.equal(ok.text.includes(ON_VPS_WARNING), warned, state);
    assert.match(ok.text, /Wika Dev/);
    const bad = await call(s, 'read_room', { room: 'nope' });
    assert.equal(bad.isError, true);
    assert.equal(bad.text.includes(ON_VPS_WARNING), warned, `${state} (error result)`);
    assert.equal(seen.filter((q) => q.url === '/api/cc/session-state').length, 1, 'asked once, then cached');
    assert.equal(seen.find((q) => q.url === '/api/cc/session-state').headers['x-cc-session'], 'sess-1');
  }
  assert.match(ON_VPS_WARNING, /on the VPS; pull it back before continuing/);
});

test('lock: no session id means no lookup; an older hub (404) or an unreachable runner means no warning', async () => {
  let s = mk({ env: {} });
  routes['GET /api/cc/session-state'] = () => [200, { state: 'on-vps' }];
  const r = await call(s, 'list_rooms', {});
  assert.equal(r.text.includes(ON_VPS_WARNING), false);
  assert.equal(seen.some((q) => q.url === '/api/cc/session-state'), false);

  s = mk({ env: { CLAUDE_SESSION_ID: 'sess-2' } }); // no route: 404
  assert.equal((await call(s, 'list_rooms', {})).text.includes(ON_VPS_WARNING), false);

  s = mk({ env: { CLAUDE_SESSION_ID: 'sess-3' }, verify: async () => ({ ok: false, message: 'runner off' }) });
  const off = await call(s, 'list_rooms', {});
  assert.equal(off.isError, true);
  assert.equal(off.text, 'runner off');
});
