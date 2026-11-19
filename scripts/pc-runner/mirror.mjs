// PC session mirror: copies this PC's Claude Code transcripts (~/.claude/projects/**.jsonl) to the hub as compact,
// scrubbed ENTRIES, so the owner can read them in PocketRocket. Imported by runner.mjs; importing has no side effects.
//
//   * mapLine / capText / summarizeToolInput / pathInfo / isExcluded / iterLines are pure or file-local and tested.
//   * createMirror() is the tailer: backfill, resume from the hub's offsets, live watch, batching, 409 resync.
//
// Privacy: every entry text and the title go through scrub() (same rules as context-import) before they leave
// this PC, and the hub redacts again. Log lines carry counts and error text, never entry text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { scrub } from './scrub.mjs';
import { gitHardenedEnv, backoffMs } from './lib.mjs';

export const CAPS = Object.freeze({ text: 8000, toolUse: 400, toolResult: 1000, summary: 2000, title: 120 });
export const BATCH_MAX_ENTRIES = 500;
export const BATCH_MAX_BYTES = 900 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024; // a longer JSONL line (a pasted blob) is skipped, never held in memory
const HEAD_SCAN_BYTES = 2 * 1024 * 1024;
const TOOL_NAMES_MAX = 5000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------------------------------------
// Text

/** Scrubs, then caps with " ...[cut N chars]". Only the head of a huge text is scrubbed (cost stays bounded). */
export function scrubCap(text, max) {
  const raw = typeof text === 'string' ? text : '';
  const head = raw.length > max * 3 ? raw.slice(0, max * 3) : raw;
  const clean = scrub(head).text;
  const total = clean.length + (raw.length - head.length);
  if (total <= max) return clean;
  return `${clean.slice(0, max)} …[cut ${total - max} chars]`;
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/** The short input summary a tool_use entry carries: the command, path, pattern, url or query. */
export function summarizeToolInput(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  let s;
  for (const k of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path', 'skill']) {
    if (typeof i[k] === 'string' && i[k]) { s = i[k]; break; }
  }
  if (s === undefined) { try { s = JSON.stringify(i) ?? ''; } catch { s = ''; } }
  else if ((name === 'Grep' || name === 'Glob') && typeof i.path === 'string' && i.path && s !== i.path) s += ` in ${i.path}`;
  return scrubCap(s, CAPS.toolUse);
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

/** User text minus injected system reminders; '' when nothing a person wrote is left. */
function userText(raw) {
  const t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t) return '';
  if (/^<(local-command-caveat|local-command-stdout|local-command-stderr)>/.test(t)) return '';
  return t;
}

/** A prompt a person typed, for the title: not a slash-command wrapper, not an interrupt marker. */
function isRealPrompt(text) {
  return !!text && !/^<(command-|local-command)/.test(text) && !/^\[Request interrupted/.test(text);
}

// ---------------------------------------------------------------------------------------------------------
// JSONL line -> entries

/**
 * Maps one parsed JSONL line to 0..n entries. `ctx.toolNames` (Map tool_use id -> name) is filled by tool_use blocks and
 * read by later tool_result blocks. `ctx.lineKey` names a line that has no uuid; `ctx.fallbackAt` is its time then.
 */
export function mapLine(o, ctx = {}) {
  if (!o || typeof o !== 'object') return [];
  const toolNames = ctx.toolNames ?? new Map();
  const at = Date.parse(o.timestamp) || ctx.fallbackAt || 0;
  const base = typeof o.uuid === 'string' && o.uuid ? o.uuid : `L${ctx.lineKey ?? at}`;
  const out = [];
  const add = (e) => {
    const entry = { uuid: out.length ? `${base}:${out.length}` : base, parentUuid: typeof o.parentUuid === 'string' ? o.parentUuid : null, at, ...e };
    if (o.isSidechain === true) entry.isSidechain = true;
    out.push(entry);
  };

  if (o.type === 'summary') {
    if (typeof o.summary !== 'string' || !o.summary.trim()) return [];
    const key = typeof o.leafUuid === 'string' && o.leafUuid ? o.leafUuid : crypto.createHash('sha1').update(o.summary).digest('hex').slice(0, 16);
    out.push({ uuid: `summary-${key}`, parentUuid: null, at, kind: 'summary', text: scrubCap(o.summary, CAPS.summary) });
    return out;
  }

  const content = o.message?.content;
  if (o.type === 'user') {
    if (o.isMeta === true) return [];
    if (o.isCompactSummary === true) {
      const t = blockText(content);
      return t.trim() ? [{ uuid: base, parentUuid: null, at, kind: 'summary', text: scrubCap(t, CAPS.summary) }] : [];
    }
    if (typeof content === 'string') {
      const t = userText(content);
      if (t) add({ kind: 'user', text: scrubCap(t, CAPS.text) });
      return out;
    }
    if (!Array.isArray(content)) return [];
    const texts = [];
    for (const b of content) {
      if (b?.type === 'tool_result') {
        const tool = typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) : undefined;
        add({ kind: 'tool_result', ...(tool ? { tool } : {}), text: scrubCap(blockText(b.content), CAPS.toolResult), isError: b.is_error === true });
      } else if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    const t = userText(texts.join('\n'));
    if (t) add({ kind: 'user', text: scrubCap(t, CAPS.text) });
    return out;
  }

  if (o.type === 'assistant') {
    if (!Array.isArray(content)) return [];
    const model = typeof o.message?.model === 'string' && o.message.model !== '<synthetic>' ? o.message.model : undefined;
    if (o.message?.model === '<synthetic>') return [];
    const extra = model ? { model } : {};
    let pending = [];
    const flush = () => {
      const t = pending.join('\n').trim();
      pending = [];
      if (t) add({ kind: 'assistant', text: scrubCap(t, CAPS.text), ...extra });
    };
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') pending.push(b.text);
      else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        flush();
        if (typeof b.id === 'string') {
          toolNames.set(b.id, b.name);
          if (toolNames.size > TOOL_NAMES_MAX) toolNames.delete(toolNames.keys().next().value);
        }
        add({ kind: 'tool_use', tool: b.name, text: summarizeToolInput(b.name, b.input), ...extra });
      }
      // thinking / redacted_thinking and anything else: skipped
    }
    flush();
    return out;
  }
  return []; // mode, permission-mode, attachment, system, file-history-*, queue-operation, ai-title, ...: not mirrored
}

/** First real user prompt as a title, scrubbed and capped to 120 characters. */
export function titleFromEntry(e) {
  if (e.kind !== 'user' || !isRealPrompt(e.text)) return null;
  const t = oneLine(e.text);
  return t ? (t.length > CAPS.title ? t.slice(0, CAPS.title - 1) + '\u2026' : t) : null;
}

// ---------------------------------------------------------------------------------------------------------
// Paths, exclusion

/** Which session a file under the projects dir is: main transcript, subagent transcript, or null (tool-results, other). */
export function pathInfo(projectsDir, file) {
  const parts = path.relative(projectsDir, file).split(/[\\/]/);
  if (parts.some((p) => !p || p === '..' || p === 'tool-results')) return null;
  const base = (n) => n.replace(/\.jsonl$/i, '');
  if (parts.length === 2 && /\.jsonl$/i.test(parts[1]) && ID_RE.test(base(parts[1]))) return { projectDir: parts[0], id: base(parts[1]), parentId: null };
  if (parts.length === 4 && parts[2] === 'subagents' && /\.jsonl$/i.test(parts[3]) && ID_RE.test(parts[1]) && ID_RE.test(base(parts[3]))) {
    return { projectDir: parts[0], id: `${parts[1]}:${base(parts[3])}`, parentId: parts[1] };
  }
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
const globRe = (g) => new RegExp('^' + norm(g).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

/**
 * True when a mirrorExclude pattern matches the session's cwd or its projects dir name. Case-insensitive. A pattern with
 * `*` is a glob over the whole value; one without is a path prefix (cwd: on a folder boundary; dir name: plain prefix).
 */
export function isExcluded(patterns, { cwd, projectDir }) {
  for (const raw of patterns ?? []) {
    const p = norm(raw);
    if (!p) continue;
    const subjects = [];
    if (cwd) subjects.push([norm(cwd), true]);
    if (projectDir) subjects.push([norm(projectDir), false]);
    for (const [s, isPath] of subjects) {
      if (p.includes('*')) { if (globRe(raw).test(s)) return true; }
      else if (s === p || (isPath ? s.startsWith(p + '/') : s.startsWith(p))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Reading

/**
 * Yields COMPLETE lines from byte `start`: { line, end } with `end` the byte offset just after the newline. A trailing
 * partial line (no newline yet) is never yielded; it waits for the next read. A line over MAX_LINE_BYTES yields
 * { line: null, end } so the offset still moves on. Reads in 1 MB chunks, so memory stays bounded.
 */
export async function* iterLines(file, start, { chunk = 1 << 20, maxLine = MAX_LINE_BYTES } = {}) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunk);
    let pos = start;
    let carry = Buffer.alloc(0);
    let skipping = false;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunk, pos);
      if (!bytesRead) return;
      const data = Buffer.from(buf.subarray(0, bytesRead));
      const base = pos;
      pos += bytesRead;
      let from = 0;
      for (;;) {
        const nl = data.indexOf(10, from);
        if (nl === -1) break;
        const end = base + nl + 1;
        if (skipping) { skipping = false; carry = Buffer.alloc(0); yield { line: null, end }; }
        else {
          const lb = carry.length ? Buffer.concat([carry, data.subarray(from, nl)]) : data.subarray(from, nl);
          carry = Buffer.alloc(0);
          if (lb.length > maxLine) yield { line: null, end };
          else yield { line: lb.toString('utf8').replace(/\r$/, ''), end };
        }
        from = nl + 1;
      }
      if (!skipping) {
        carry = Buffer.concat([carry, data.subarray(from)]);
        if (carry.length > maxLine) { carry = Buffer.alloc(0); skipping = true; }
      }
    }
  } finally {
    await fh.close();
  }
}

const parseLine = (line) => { try { return JSON.parse(line); } catch { return null; } };

/** cwd, first timestamp and title from the start of a file (read once, bounded). */
export async function scanHead(file) {
  const meta = { cwd: null, firstAt: null, title: null };
  const ctx = { toolNames: new Map() };
  let seen = 0;
  for await (const { line, end } of iterLines(file, 0)) {
    if (line) {
      const o = parseLine(line);
      if (o) {
        if (!meta.cwd && typeof o.cwd === 'string' && o.cwd) meta.cwd = o.cwd;
        if (meta.firstAt === null) { const t = Date.parse(o.timestamp); if (t) meta.firstAt = t; }
        if (!meta.title) for (const e of mapLine(o, ctx)) { meta.title = titleFromEntry(e); if (meta.title) break; }
      }
    }
    seen = end;
    if ((meta.cwd && meta.firstAt !== null && meta.title) || seen > HEAD_SCAN_BYTES) break;
  }
  return meta;
}

// ---------------------------------------------------------------------------------------------------------
// Repo info

/** git by absolute path from PATH (never a bare name: Windows would look in the working folder first). */
export function findGit(pathEnv = process.env.PATH, exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) {
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const dir of String(pathEnv ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const n of names) { const p = path.join(dir, n); if (exists(p)) return p; }
  }
  return null;
}

function defaultGit(gitPath) {
  return (cwd, args) => new Promise((resolve) => {
    // Runs from the runner's own folder with -C <cwd>; hardened env ignores the repo's and the user's git config.
    execFile(gitPath, ['-C', cwd, ...args], { env: gitHardenedEnv(process.env), timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024, cwd: os.tmpdir() },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

/** { name, remote, branch, head } for the repo around cwd, or null. `git(cwd, args)` resolves stdout or null. Cached per cwd. */
export function makeRepoInfo({ git, exists = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } } }) {
  const cache = new Map();
  return (cwd) => {
    if (!cwd || !git || !path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd) || cwd.includes('\0')) return Promise.resolve(null);
    if (!cache.has(cwd)) {
      cache.set(cwd, (async () => {
        if (!exists(cwd)) return null;
        const top = await git(cwd, ['rev-parse', '--show-toplevel']);
        if (!top) return null;
        const [remote, branch, head] = await Promise.all([
          git(cwd, ['remote', 'get-url', 'origin']), git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']), git(cwd, ['rev-parse', 'HEAD']),
        ]);
        return { name: path.basename(top.replace(/[\\/]+$/, '')), remote: remote ? scrub(remote).text : null, branch: branch ?? null, head: head ?? null };
      })());
    }
    return cache.get(cwd);
  };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP

/** Request function for the tailer: resolves { status, json } for 2xx/400/404/409, throws (e.network) for anything else. */
export function httpRequester({ baseUrl, token, guard = () => {}, timeoutMs = 30_000 }) {
  return async (method, p, body) => {
    guard(); // runner.mjs: throws unless the tunnel is verified; nothing is sent before that
    let res;
    try {
      res = await fetch(`${baseUrl}/api/pc-sessions${p}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { const err = new Error(`${method} request failed: ${e.cause?.code || e.name || 'error'}`); err.network = true; throw err; }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok || [400, 404, 409, 410].includes(res.status)) return { status: res.status, json };
    const err = new Error(`${method} -> HTTP ${res.status}`);
    err.network = true; // 5xx, 401, 429...: retry with backoff
    throw err;
  };
}

// ---------------------------------------------------------------------------------------------------------
// Tailer

/**
 * options: getConfig() -> { mirror, mirrorBackfillDays, mirrorExclude, claudeProjectsDir } | null; request (httpRequester);
 * isPaused(); isReady(); log(event, fields); machine; git (cwd,args)->stdout|null; now(); pollMs; fullScanEvery (ticks).
 */
export function createMirror(options) {
  const { getConfig, request, log = () => {}, isPaused = () => false, isReady = () => true, now = () => Date.now(), pollMs = 5000, fullScanEvery = 12 } = options;
  const machine = options.machine ?? os.hostname();
  const repoInfo = makeRepoInfo({ git: options.git ?? (findGit() ? defaultGit(findGit()) : null) });
  const tracked = new Map(); // file -> state
  const excluded = new Set();
  const dirty = new Set();
  const held = new Set(); // session ids that live on the VPS right now: PC-side appends are not shipped (bridge P6)
  const warnedHeld = new Set();
  let hubOffsets = null; // id -> offset, from GET /sync
  let excludeKey = '';
  let stopped = false;
  let wake = null;
  let watcher = null;
  let tick = 0;
  let firstPassDone = false;
  const stats = { sessions: 0, entries: 0 };

  const projectsDir = () => getConfig()?.claudeProjectsDir || path.join(os.homedir(), '.claude', 'projects');
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(done, ms); wake = done; function done() { clearTimeout(t); wake = null; r(); } });

  function describe(file, stat) {
    const info = pathInfo(projectsDir(), file);
    return info ? { file, size: stat.size, mtimeMs: stat.mtimeMs, ...info } : null;
  }

  function scan() {
    const root = projectsDir();
    const found = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
    const add = (file) => { try { const d = describe(file, fs.statSync(file)); if (d) found.push(d); } catch { /* vanished */ } };
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      let kids = [];
      try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const k of kids) {
        if (k.isFile() && /\.jsonl$/i.test(k.name)) add(path.join(dir, k.name));
        else if (k.isDirectory() && k.name !== 'tool-results') {
          let subs = [];
          try { subs = fs.readdirSync(path.join(dir, k.name, 'subagents')); } catch { continue; }
          for (const s of subs) if (/\.jsonl$/i.test(s)) add(path.join(dir, k.name, 'subagents', s));
        }
      }
    }
    return found;
  }

  async function put(st) {
    const repo = await repoInfo(st.meta.cwd);
    const body = {
      machine, parentId: st.parentId, projectDir: st.projectDir, cwd: st.meta.cwd, repo, title: st.meta.title,
      firstAt: st.meta.firstAt ?? st.mtimeMs, lastAt: Math.max(st.lastAt, st.mtimeMs),
    };
    const r = await request('PUT', `/${encodeURIComponent(st.id)}`, body);
    if (r.status === 410) { // deleted in PocketRocket: never mirror it again (until the runner restarts and asks again)
      log('mirror_session_deleted', { id: st.id });
      st.dead = true;
      excluded.add(st.file);
      return null;
    }
    if (r.status !== 200 || !Number.isInteger(r.json?.offset)) throw new Error(`PUT session -> HTTP ${r.status}`);
    st.titleSent = st.meta.title;
    if (r.json.onVps === true) { held.add(st.id); return r.json.offset; }
    return r.json.offset;
  }

  /** Creates the state for a file: exclusion, head scan, PUT. Returns null when the file is not mirrored. */
  async function adopt(d, cfg) {
    if (excluded.has(d.file)) return null;
    if (isExcluded(cfg.mirrorExclude, { projectDir: d.projectDir })) { excluded.add(d.file); return null; }
    const meta = await scanHead(d.file);
    if (isExcluded(cfg.mirrorExclude, { cwd: meta.cwd })) { excluded.add(d.file); return null; }
    const st = { ...d, meta, lastAt: meta.firstAt ?? d.mtimeMs, offset: 0, toolNames: new Map(), titleSent: null, dead: false, retryAt: 0, sentEntries: 0 };
    const offset = await put(st);
    if (offset === null) return null;
    st.offset = offset;
    tracked.set(d.file, st);
    stats.sessions++;
    return st;
  }

  /** Reads and sends everything new in one file. Throws on network errors (the loop backs off). */
  async function ship(st, size) {
    if (size < st.offset) { // truncated or rotated: never resend, never guess
      log('mirror_file_shrunk', { id: st.id });
      st.dead = true;
      return;
    }
    let resyncs = 0;
    let batch = null;
    const fresh = (from) => ({ from, to: from, entries: [], bytes: 0 });
    const flush = async () => {
      const b = batch;
      batch = null;
      if (!b || b.to <= b.from) return true;
      if (st.meta.title && st.meta.title !== st.titleSent && (await put(st)) === null) return true;
      if (!b.entries.length && st.noEmpty) { st.offset = b.to; return true; }
      let r = await request('POST', `/${encodeURIComponent(st.id)}/entries`, { from: b.from, to: b.to, entries: b.entries });
      if (r.status === 404) { if ((await put(st)) === null) return true; r = await request('POST', `/${encodeURIComponent(st.id)}/entries`, { from: b.from, to: b.to, entries: b.entries }); }
      if (r.status === 400 && !b.entries.length) { st.noEmpty = true; st.offset = b.to; return true; } // hub wants non-empty batches
      if (r.status === 409 && Number.isInteger(r.json?.offset)) {
        if (++resyncs > 3) throw Object.assign(new Error('resync loop'), { network: false });
        log('mirror_resync', { id: st.id });
        st.offset = r.json.offset;
        return false;
      }
      if (r.status !== 200) throw new Error(`POST entries -> HTTP ${r.status}`);
      if (r.json?.onVps === true) held.add(st.id);
      st.offset = b.to;
      st.sentEntries += b.entries.length;
      stats.entries += b.entries.length;
      return true;
    };
    for (;;) {
      if (stopped || st.dead) return;
      batch = fresh(st.offset);
      let again = false;
      for await (const { line, end } of iterLines(st.file, st.offset)) {
        const o = line ? parseLine(line) : null;
        let es = [];
        if (o) {
          if (!st.meta.cwd && typeof o.cwd === 'string' && o.cwd) st.meta.cwd = o.cwd;
          const t = Date.parse(o.timestamp);
          if (t && t > st.lastAt) st.lastAt = t;
          es = mapLine(o, { toolNames: st.toolNames, lineKey: batch.to, fallbackAt: st.lastAt });
          if (!st.meta.title) for (const e of es) { st.meta.title = titleFromEntry(e); if (st.meta.title) break; }
        }
        const bytes = es.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
        if (batch.entries.length && (batch.entries.length + es.length > BATCH_MAX_ENTRIES || batch.bytes + bytes > BATCH_MAX_BYTES)) {
          if (!(await flush())) { again = true; break; }
          batch = fresh(st.offset);
        }
        batch.entries.push(...es);
        batch.bytes += bytes;
        batch.to = end;
        if (stopped) break;
      }
      if (again) continue;
      if (batch && !(await flush())) continue;
      return;
    }
  }

  async function handle(d, cfg) {
    if (held.has(d.id)) {
      if (!warnedHeld.has(d.id)) { warnedHeld.add(d.id); log('mirror_session_on_vps', { id: d.id }); }
      return;
    }
    let st = tracked.get(d.file);
    if (!st) {
      const eligible = d.mtimeMs >= now() - cfg.mirrorBackfillDays * 86_400_000 || (hubOffsets && Object.hasOwn(hubOffsets, d.id));
      if (!eligible) return;
      st = await adopt(d, cfg);
      if (!st) return;
    }
    if (st.dead || now() < st.retryAt || held.has(st.id)) return;
    st.mtimeMs = d.mtimeMs;
    if (d.size === st.offset) return;
    await ship(st, d.size);
  }

  /** One scan-and-send round. `full` re-lists the projects dir (first pass, every minute, and when asked). */
  async function pass({ full = false } = {}) {
    const cfg = getConfig();
    if (!cfg || cfg.mirror === false || isPaused()) return { skipped: true };
    const key = JSON.stringify(cfg.mirrorExclude ?? []);
    if (key !== excludeKey) { excludeKey = key; excluded.clear(); }
    if (!hubOffsets) {
      const r = await request('GET', '/sync');
      if (r.status !== 200 || typeof r.json?.sessions !== 'object' || !r.json.sessions) throw new Error(`GET sync -> HTTP ${r.status}`);
      hubOffsets = Object.fromEntries(Object.entries(r.json.sessions).map(([id, v]) => [id, Number(v?.offset) || 0]));
      for (const [id, v] of Object.entries(r.json.sessions)) { if (v?.onVps === true) held.add(id); else if (v?.onVps === false) { held.delete(id); warnedHeld.delete(id); } }
      full = true;
    }
    const targets = new Map();
    if (full) for (const d of scan()) targets.set(d.file, d);
    else {
      for (const [file, st] of tracked) {
        if (st.dead) continue;
        try { const s = fs.statSync(file); if (s.size !== st.offset) { const d = describe(file, s); if (d) targets.set(file, d); } } catch { /* gone */ }
      }
      for (const file of dirty) {
        try { const d = describe(file, fs.statSync(file)); if (d) targets.set(file, d); } catch { /* gone */ }
      }
    }
    dirty.clear();
    const sessionsBefore = stats.sessions;
    let complete = true;
    for (const d of targets.values()) {
      if (stopped || !isReady() || isPaused()) { complete = false; break; }
      try { await handle(d, cfg); } catch (e) {
        if (e.network) throw e;
        log('mirror_file_error', { id: d.id, error: e.code || e.message });
        const st = tracked.get(d.file);
        if (st) st.retryAt = now() + 60_000;
      }
    }
    if (full && complete && !firstPassDone && !stopped) {
      firstPassDone = true;
      log('mirror_backfill', { sessions: stats.sessions, entries: stats.entries, windowDays: cfg.mirrorBackfillDays });
    } else if (stats.sessions > sessionsBefore) log('mirror_new_sessions', { count: stats.sessions - sessionsBefore });
    return { skipped: false, sessions: stats.sessions, entries: stats.entries };
  }

  function startWatch() {
    try {
      watcher = fs.watch(projectsDir(), { recursive: true }, (_ev, name) => {
        if (!name || !/\.jsonl$/i.test(name)) return;
        dirty.add(path.join(projectsDir(), name));
        if (wake) wake();
      });
      watcher.on('error', () => { /* the 5 s poll still covers us */ });
    } catch { watcher = null; }
  }

  async function loop() {
    let attempt = 0;
    let lastError = '';
    startWatch();
    log('mirror_start', { watching: !!watcher });
    while (!stopped) {
      if (!isReady()) { hubOffsets = null; await sleep(1000); continue; } // tunnel (re)verifying: ask the hub again after
      try {
        const r = await pass({ full: tick % fullScanEvery === 0 });
        tick++;
        attempt = 0; lastError = '';
        if (r.skipped) { await sleep(pollMs); continue; }
      } catch (e) {
        if (e.message !== lastError) log('mirror_error', { error: e.message });
        lastError = e.message;
        await sleep(backoffMs(attempt++));
        continue;
      }
      await sleep(pollMs);
    }
  }

  return {
    pass,
    start() { loop().catch((e) => log('mirror_error', { error: e.message })); },
    stop() { stopped = true; try { watcher?.close(); } catch { /* closed */ } if (wake) wake(); },
    /** A moved session is on the VPS: stop shipping its PC file. */
    hold(id) { held.add(id); },
    /** The session is back on this PC (pulled): forget what was tracked so it is adopted again from the hub's offset. */
    release(id) { held.delete(id); warnedHeld.delete(id); for (const [file, st] of tracked) if (st.id === id) tracked.delete(file); },
    isHeld: (id) => held.has(id),
    stats: () => ({ ...stats, tracked: tracked.size }),
  };
}
