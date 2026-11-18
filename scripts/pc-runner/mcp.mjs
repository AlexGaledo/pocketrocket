#!/usr/bin/env node
// PocketRocket MCP server for Claude Code on this PC. Plain Node, no packages: newline-delimited JSON-RPC on
// stdin/stdout (MCP stdio transport); everything else goes to stderr. Add it once with:
//   claude mcp add --scope user pocketrocket -- "%LOCALAPPDATA%\PocketRocketRunner\mcp.cmd"
// It talks to the hub through the runner's SSH tunnel (127.0.0.1:<localPort>) with the runner's token, and only
// after proving the tunnel is the runner's own ssh process. It never starts ssh itself: turn the runner ON.
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitHardenedEnv, tunnelOwnerCheck } from './lib.mjs';
import { loadConfig, readToken, readRunnerPid, listenersOn, processInfo } from './local.mjs';

const SERVER_INFO = { name: 'pocketrocket', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ROOMS_TTL_MS = 30_000;
const VERIFY_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;

const SAFE_FLOW = 'Safe flow for shared files: read_file (or read_state) first, then write_file with the hash you read as `base`.';

const str = (description) => ({ type: 'string', description });
const ROOM = str('Room id, or the room name (case-insensitive). Use list_rooms to see them.');

export const TOOLS = [
  {
    name: 'list_rooms',
    description: 'List the PocketRocket rooms you are in: id, name, kind, linked project, and whether the room has a shared folder. Start here if you do not know the room.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_room',
    description: 'Read recent messages of a room, oldest first. Page back with `before` (the smallest seq you already have).',
    inputSchema: {
      type: 'object', required: ['room'], additionalProperties: false,
      properties: { room: ROOM, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many messages (default 30).' }, before: { type: 'integer', description: 'Only messages older than this seq.' } },
    },
  },
  {
    name: 'post_to_room',
    description: 'Post a message to a room as the owner working through Claude Code. The bots in the room will see it. Keep it short and say what you need.',
    inputSchema: { type: 'object', required: ['room', 'text'], additionalProperties: false, properties: { room: ROOM, text: str('The message.') } },
  },
  {
    name: 'read_state',
    description: `Read a room's state header: its project, the current.md (path, hash, rev, text) and the recent decisions. Read this before you change shared files. ${SAFE_FLOW}`,
    inputSchema: { type: 'object', required: ['room'], additionalProperties: false, properties: { room: ROOM } },
  },
  {
    name: 'read_file',
    description: `Read a text file in the room's shared folder. Returns the text, its hash and rev. Remember the hash: write_file needs it as \`base\`. ${SAFE_FLOW}`,
    inputSchema: { type: 'object', required: ['room', 'path'], additionalProperties: false, properties: { room: ROOM, path: str('File path inside the room folder, e.g. current.md.') } },
  },
  {
    name: 'write_file',
    description: `Replace a text file in the room's shared folder with \`text\`. \`base\` MUST be the hash from your latest read_file/read_state of this file. ${SAFE_FLOW} `
      + 'If someone changed the file since, the write is refused with a conflict and you get the current text and hash: merge your change into that text and call write_file again with the NEW hash. '
      + 'Never retry with the old hash and never overwrite blindly; other bots and the owner write to these files. Pass `sources` (what you based the change on, e.g. file paths or URLs) when you can.',
    inputSchema: {
      type: 'object', required: ['room', 'path', 'text', 'base'], additionalProperties: false,
      properties: { room: ROOM, path: str('File path inside the room folder.'), text: str('The full new text of the file.'), base: str('Hash returned by the read you based this on.'), sources: { type: 'array', items: { type: 'string' }, description: 'What this change is based on.' } },
    },
  },
  {
    name: 'log_decision',
    description: 'Append a decision to the room project\'s decision log. The log is append-only: you cannot edit or delete entries. To change an earlier decision, log a new one and name the old one in `supersedes` (its id from read_state).',
    inputSchema: {
      type: 'object', required: ['room', 'title', 'text'], additionalProperties: false,
      properties: { room: ROOM, title: str('Short title.'), text: str('What was decided and why.'), supersedes: str('Id of the decision this replaces.'), sources: { type: 'array', items: { type: 'string' }, description: 'Evidence the decision rests on.' } },
    },
  },
  {
    name: 'handoff',
    description: 'Hand a task to a bot or person in a room: who it is for, the task, and the context they need (they cannot see this terminal session).',
    inputSchema: { type: 'object', required: ['room', 'to', 'task'], additionalProperties: false, properties: { room: ROOM, to: str('Bot handle or name to hand over to.'), task: str('What needs doing.'), context: str('Background, file paths, what you already tried.') } },
  },
];

const RUNNER_OFF = 'The PocketRocket runner is not running on this PC. Ask the owner to turn it on (Desktop shortcut "PocketRocket Runner ON"), then try again.';

/** A failure the tool reports to the model as an error result (isError), not a protocol error. */
class ToolError extends Error {}

const clean = (s, max = 100) => String(s ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);

/** basename of the git top-level of `cwd`, else basename of `cwd`. Git runs with the runner's hardened environment. */
export function repoNameFor(cwd, run = spawnSync) {
  try {
    const r = run('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, env: gitHardenedEnv(process.env) });
    const top = r?.status === 0 ? String(r.stdout).trim() : '';
    if (top) return clean(path.win32.basename(top.replace(/\//g, '\\')));
  } catch { /* not a repo, or no git */ }
  return clean(path.win32.basename(path.win32.resolve(cwd)) || path.basename(cwd));
}

const fmtTime = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at ?? '') : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
};

/** Default tunnel proof: see tunnelOwnerCheck. Result cached briefly so a burst of tool calls costs one PowerShell run. */
export function makeVerifier({ getPort, now = Date.now, listeners = listenersOn, procs = processInfo, runnerPid = readRunnerPid } = {}) {
  let okUntil = 0;
  return async () => {
    if (now() < okUntil) return { ok: true };
    const port = getPort();
    const pid = runnerPid();
    let ls = [];
    let info = {};
    try {
      ls = listeners(port);
      info = procs([...(pid ? [pid] : []), ...ls.map((l) => l.pid)]);
    } catch (e) {
      return { ok: false, message: `Could not check who owns port ${port} (${e.message}); refusing to send anything.` };
    }
    const r = tunnelOwnerCheck({ listeners: ls, procs: info, runnerPid: pid });
    if (r.ok) { okUntil = now() + VERIFY_TTL_MS; return { ok: true }; }
    if (r.reason === 'runner-off') return { ok: false, message: RUNNER_OFF };
    if (r.reason === 'tunnel-down') return { ok: false, message: 'The runner is on but its tunnel to the server is not up yet. Wait a few seconds and try again; if it stays down, turn the runner OFF and ON.' };
    return { ok: false, message: `Another program is listening on 127.0.0.1:${port}, not the runner's tunnel. Nothing was sent. Turn the runner OFF, close that program, and turn it ON again.` };
  };
}

/**
 * Builds the MCP server. `deps` (all optional, for tests): loadConfig, readToken, verify, fetch, env, cwd, repo, now.
 * Returns { handle(message) -> response | null, handleLine(line) -> string | null }.
 */
export function createServer(deps = {}) {
  const d = {
    loadConfig, readToken, fetch: globalThis.fetch, env: process.env, cwd: () => process.cwd(), now: Date.now, ...deps,
  };
  const verify = d.verify ?? makeVerifier({ getPort: () => d.loadConfig().config?.localPort });
  const repo = d.repo ?? repoNameFor(d.cwd());
  let roomsCache = null;

  async function hub(method, p, body) {
    const cfg = d.loadConfig();
    if (!cfg.ok) throw new ToolError('The PocketRocket runner config is invalid: ' + cfg.errors.join('; '));
    const token = d.readToken();
    if (!token) throw new ToolError('The PocketRocket runner is not paired on this PC (no token). Ask the owner to run: node runner.mjs pair');
    const v = d.env.POCKETROCKET_RUNNER_NO_TUNNEL === '1' ? { ok: true } : await verify();
    if (!v.ok) throw new ToolError(v.message);
    const session = clean(d.env.CLAUDE_SESSION_ID, 200);
    const headers = { authorization: `Bearer ${token}`, 'x-cc-repo': repo, ...(session ? { 'x-cc-session': session } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
    let res;
    try {
      res = await d.fetch(`http://127.0.0.1:${cfg.config.localPort}/api/cc${p}`, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      if ((e?.cause?.code ?? e?.code) === 'ECONNREFUSED') throw new ToolError(RUNNER_OFF);
      throw new ToolError(`Could not reach PocketRocket (${e?.cause?.code ?? e?.name ?? 'network error'}). Is the runner on and connected?`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text };
  }

  /** hub() plus the common failure mapping; returns the JSON body of a 2xx. */
  async function hubOk(method, p, body) {
    const r = await hub(method, p, body);
    if (r.status >= 200 && r.status < 300) return r.json ?? {};
    throw new ToolError(`PocketRocket refused it (HTTP ${r.status}): ${r.json?.error ?? (clean(r.text, 200) || 'no detail')}`);
  }

  async function rooms(force = false) {
    if (!force && roomsCache && d.now() - roomsCache.at < ROOMS_TTL_MS) return roomsCache.list;
    const list = await hubOk('GET', '/rooms');
    if (!Array.isArray(list)) throw new ToolError('Unexpected answer from PocketRocket for the room list.');
    roomsCache = { at: d.now(), list };
    return list;
  }

  async function resolveRoom(ref) {
    if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('`room` is required: a room id or name (see list_rooms).');
    const want = ref.trim();
    const find = (list) => {
      const byId = list.find((r) => r.id === want);
      if (byId) return [byId];
      return list.filter((r) => String(r.name).toLowerCase() === want.toLowerCase());
    };
    let hits = find(await rooms());
    if (!hits.length) hits = find(await rooms(true)); // maybe a room created since the cache
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new ToolError(`More than one room is called "${want}". Use one of these ids: ` + hits.map((r) => `${r.id} (${r.name}${r.project ? `, project ${r.project.name}` : ''})`).join('; '));
    throw new ToolError(`No room "${want}". Rooms: ` + ((await rooms()).map((r) => `${r.name} (${r.id})`).join('; ') || 'none'));
  }

  const need = (a, key) => {
    if (typeof a[key] !== 'string' || (key !== 'base' && !a[key].trim())) throw new ToolError(`\`${key}\` is required (text).`);
    return a[key];
  };
  const opt = (a, key) => (typeof a[key] === 'string' && a[key].trim() ? a[key] : undefined);
  const optList = (a, key) => (Array.isArray(a[key]) ? a[key].filter((x) => typeof x === 'string').slice(0, 50) : undefined);
  const enc = encodeURIComponent;
  const fileLine = (f) => `path: ${f.path}\nhash: ${f.hash}\nrev: ${f.rev}`;

  const impl = {
    async list_rooms() {
      const list = await rooms(true);
      if (!list.length) return 'You are not in any rooms.';
      return list.map((r) => `- ${r.name} [${r.id}] ${r.kind}${r.project ? `, project ${r.project.name} (${r.project.slug})` : ''}${r.hasFolder ? ', has shared folder' : ''}`).join('\n');
    },
    async read_room(a) {
      const room = await resolveRoom(a.room);
      const q = new URLSearchParams();
      if (Number.isInteger(a.limit)) q.set('limit', String(a.limit));
      if (Number.isInteger(a.before)) q.set('before', String(a.before));
      const qs = q.toString();
      const r = await hubOk('GET', `/rooms/${enc(room.id)}/messages${qs ? `?${qs}` : ''}`);
      const ms = Array.isArray(r.messages) ? r.messages : [];
      if (!ms.length) return `No messages in ${room.name}.`;
      return `Room ${room.name} (${ms.length} messages, oldest first; page back with before=${ms[0].seq}):\n\n` + ms.map((m) => `[${m.seq}] ${fmtTime(m.at)} ${m.author}: ${m.text}`).join('\n\n');
    },
    async post_to_room(a) {
      const room = await resolveRoom(a.room);
      const r = await hubOk('POST', `/rooms/${enc(room.id)}/messages`, { text: need(a, 'text') });
      return `Posted to ${room.name}${r.id ? ` (message ${r.id})` : ''}.`;
    },
    async read_state(a) {
      const room = await resolveRoom(a.room);
      const s = await hubOk('GET', `/rooms/${enc(room.id)}/state`);
      const lines = [`Room: ${s.room?.name ?? room.name}`, `Project: ${s.project ? `${s.project.name ?? s.project.slug}` : 'none'}`];
      if (s.current) lines.push('', `current.md  (${fileLine(s.current)})`, '---', s.current.text, '---');
      else lines.push('', 'No current.md yet.');
      const ds = Array.isArray(s.decisions) ? s.decisions : [];
      lines.push('', ds.length ? 'Decisions (newest last):\n' + ds.map((x) => `- [${x.id}] ${x.title} (${fmtTime(x.at)}, by ${x.by})`).join('\n') : 'No decisions logged.');
      lines.push('', 'To change current.md use write_file with base = the hash above.');
      return lines.join('\n');
    },
    async read_file(a) {
      const room = await resolveRoom(a.room);
      const f = await hubOk('GET', `/rooms/${enc(room.id)}/files/text?path=${enc(need(a, 'path'))}`);
      return `${fileLine(f)}\n---\n${f.text}\n---\nTo change it, call write_file with base=${f.hash}.`;
    },
    async write_file(a) {
      const room = await resolveRoom(a.room);
      const p = need(a, 'path');
      const base = need(a, 'base');
      const r = await hub('POST', `/rooms/${enc(room.id)}/files/text`, { path: p, text: need(a, 'text'), base, sources: optList(a, 'sources') });
      if (r.status === 409) {
        const c = r.json?.current ?? {};
        throw new ToolError(`CONFLICT: ${p} changed since you read it (your base was ${base}). Nothing was written.\n`
          + `Current version: hash ${c.hash}, rev ${c.rev}.\n---\n${c.text ?? ''}\n---\n`
          + `Merge your change into this current text, then call write_file again with base=${c.hash}. Do not overwrite blindly and do not reuse the old hash.`);
      }
      if (r.status < 200 || r.status >= 300) throw new ToolError(`PocketRocket refused the write (HTTP ${r.status}): ${r.json?.error ?? clean(r.text, 200)}`);
      return `Written ${r.json?.path ?? p}.\nnew hash: ${r.json?.hash}\nrev: ${r.json?.rev}\nUse this hash as base for your next write to this file.`;
    },
    async log_decision(a) {
      const room = await resolveRoom(a.room);
      const r = await hubOk('POST', `/rooms/${enc(room.id)}/decision`, { title: need(a, 'title'), text: need(a, 'text'), supersedes: opt(a, 'supersedes'), sources: optList(a, 'sources') });
      return `Decision logged${r.id ? ` as ${r.id}` : ''}${r.rev !== undefined ? ` (rev ${r.rev})` : ''}. The log is append-only; to change it later, log a new decision that supersedes this one.`;
    },
    async handoff(a) {
      const room = await resolveRoom(a.room);
      const r = await hubOk('POST', `/rooms/${enc(room.id)}/handoff`, { to: need(a, 'to'), task: need(a, 'task'), context: opt(a, 'context') });
      return `Handoff to ${a.to} posted in ${room.name}${r.id ? ` (${r.id})` : ''}.`;
    },
  };

  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') return fail(msg?.id ?? null, -32600, 'Invalid Request');
    const isNote = msg.id === undefined || msg.id === null;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply(msg.id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'Reads and posts to PocketRocket rooms and edits their shared files. Read a file (read_file/read_state) before write_file and pass its hash as base; on a conflict, merge and retry with the new hash.',
        });
      }
      case 'ping': return isNote ? null : reply(msg.id, {});
      case 'tools/list': return isNote ? null : reply(msg.id, { tools: TOOLS });
      case 'tools/call': {
        if (isNote) return null;
        const name = msg.params?.name;
        const fn = Object.hasOwn(impl, name) ? impl[name] : null;
        if (!fn) return fail(msg.id, -32602, `Unknown tool: ${String(name).slice(0, 60)}`);
        const a = msg.params?.arguments;
        try {
          const text = await fn(a && typeof a === 'object' && !Array.isArray(a) ? a : {});
          return reply(msg.id, { content: [{ type: 'text', text }] });
        } catch (e) {
          if (!(e instanceof ToolError)) process.stderr.write(`pocketrocket-mcp: ${name} failed: ${e?.message}\n`);
          return reply(msg.id, { isError: true, content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Unexpected error in ${name}: ${e?.message}` }] });
        }
      }
      default:
        if (isNote) return null; // notifications/initialized, notifications/cancelled, ...
        return fail(msg.id, -32601, `Method not found: ${msg.method.slice(0, 60)}`);
    }
  }

  /** One input line -> the line to write (or null). */
  async function handleLine(line) {
    if (!line.trim()) return null;
    let msg;
    try { msg = JSON.parse(line); } catch { return JSON.stringify(fail(null, -32700, 'Parse error')); }
    const out = await handle(msg);
    return out ? JSON.stringify(out) : null;
  }

  return { handle, handleLine };
}

/** Wires a server to stdin/stdout. Resolves when stdin closes and every request has been answered. */
export async function serve(server, input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of rl) {
    const p = server.handleLine(line)
      .then((out) => { if (out) output.write(out + '\n'); })
      .catch((e) => process.stderr.write(`pocketrocket-mcp: ${e?.message}\n`));
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write('pocketrocket-mcp: ready (talks to PocketRocket through the runner tunnel)\n');
  await serve(createServer());
}
