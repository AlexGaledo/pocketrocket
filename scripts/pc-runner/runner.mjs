#!/usr/bin/env node
// PocketRocket PC runner: runs owner-approved jobs from the VPS hub on this Windows PC, one at a time,
// after a second approval in a local dialog. See README.md for setup and the threat model.
//
//   node runner.mjs pair     read the runner token from the clipboard, save it (owner-only ACL), clear the clipboard
//   node runner.mjs check    validate config.json, resolve claude.exe, snapshot the MCP servers folders name
//   node runner.mjs run      open the ssh tunnel and work the job queue (what runner-on.ps1 starts)
//
// Data folder: %LOCALAPPDATA%\PocketRocketRunner (override: POCKETROCKET_RUNNER_DIR).
// The runner token is never printed or logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HUB_PORT, JOB_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, RUNNER_SETTINGS,
  validateConfig, folderFor, parseJob, buildClaudeArgs, buildMcpConfig, parseClaudeResult, capOutput, promptPreview,
  cleanToken, backoffMs, logFileName, resolveClaudePath, canRunCode, listenerIsOurs, isInside, gitHardenedEnv,
} from './lib.mjs';
import { BASE, TOKEN_PATH, MIRROR_PAUSED_PATH, loadConfig, readToken, listenersOn } from './local.mjs';
import { createMirror, httpRequester, findGit } from './mirror.mjs';
import { uploadBundleFile, uploadSessionFile, downloadBundleFile, downloadSessionFile } from './sync.mjs';
import { handleJob } from './jobs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SNAPSHOT_PATH = path.join(BASE, 'mcp-snapshot.json');
const LOG_DIR = path.join(BASE, 'logs');
const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;

// System tools by absolute path: never whatever a bare name resolves to from the current folder.
const SYS = process.env.SystemRoot || 'C:\\Windows';
const BIN = {
  powershell: path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  taskkill: path.join(SYS, 'System32', 'taskkill.exe'),
  icacls: path.join(SYS, 'System32', 'icacls.exe'),
  ssh: fs.existsSync(path.join(SYS, 'System32', 'OpenSSH', 'ssh.exe')) ? path.join(SYS, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh',
};

// ---------------------------------------------------------------------------------------------------------
function log(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, logFileName()), line + '\n');
  } catch { /* logging must never stop the runner */ }
  if (process.stdout.isTTY) console.log(line);
}

function powershell(args, opts = {}) {
  return execFileSync(BIN.powershell, ['-NoProfile', '-NonInteractive', ...args], { windowsHide: true, encoding: 'utf8', ...opts });
}

/** Kills a process and everything it started (claude's shells, the confirm dialog). */
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    try { execFileSync(BIN.taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** The absolute claude.exe for this config (see resolveClaudePath). Real path, so a junction can't point it elsewhere. */
function resolveClaude(cfg) {
  const r = resolveClaudePath({ claudePath: cfg.claudePath, home: os.homedir(), pathEnv: process.env.PATH, folders: cfg.folders, exists: isFile });
  if (r.error) return r;
  const real = fs.realpathSync(r.path);
  const again = resolveClaudePath({ claudePath: real, home: null, pathEnv: '', folders: cfg.folders, exists: isFile });
  return again.error ? again : { path: real };
}

/** Definitions for the MCP servers folders name: config.mcpServers first, then the snapshot `check` took. */
function mcpDefinitions(cfg) {
  let snap = {};
  try { snap = JSON.parse(fs.readFileSync(MCP_SNAPSHOT_PATH, 'utf8')) ?? {}; } catch { /* none yet */ }
  return { ...snap, ...cfg.mcpServers };
}

// ---------------------------------------------------------------------------------------------------------
// pair
function pair() {
  if (process.platform !== 'win32') throw new Error('pair uses the Windows clipboard; run it on Windows');
  const clip = powershell(['-Command', 'Get-Clipboard -Raw']);
  const token = cleanToken(clip);
  if (!token) {
    console.error('The clipboard does not hold a runner token. Copy it from the hub (PC runner settings) and run pair again.');
    process.exit(1);
  }
  const user = process.env.USERNAME;
  if (!user) throw new Error('USERNAME is not set; cannot restrict the token file');
  fs.mkdirSync(BASE, { recursive: true });
  // A previous token file is read-only even to us (that is the point), so it can't be deleted as is. As its owner
  // we may always change its ACL: take full control back, then delete it.
  if (fs.existsSync(TOKEN_PATH)) {
    execFileSync(BIN.icacls, [TOKEN_PATH, '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true });
    fs.rmSync(TOKEN_PATH, { force: true });
  }
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600, flag: 'wx' });
  // Only this user may read it: drop inherited entries, grant read to the current user alone. No shell involved.
  execFileSync(BIN.icacls, [TOKEN_PATH, '/inheritance:r', '/grant:r', `${user}:R`], { stdio: 'ignore', windowsHide: true });
  // Clear the clipboard so the token doesn't sit there (Windows clipboard history, Win+V, may still hold it).
  powershell(['-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()']);
  console.log(`Paired. Token saved to ${TOKEN_PATH} (only ${user} can read it). Clipboard cleared.`);
  log('paired');
}

// ---------------------------------------------------------------------------------------------------------
// check
function check() {
  const r = loadConfig();
  if (!r.ok) { console.error('config.json has problems:\n  ' + r.errors.join('\n  ')); process.exit(1); }
  const cfg = r.config;
  const claude = resolveClaude(cfg);
  if (claude.error) { console.error('claude: ' + claude.error); process.exit(1); }
  console.log(`claude: ${claude.path}`);
  console.log(`ssh alias: ${cfg.sshAlias}, local port: ${cfg.localPort}`);

  // Snapshot the MCP servers folders name and config.json doesn't define, from ~/.claude.json, so a job never
  // reads Claude's own config files. Names only are printed; definitions can hold keys.
  const wanted = [...new Set(Object.values(cfg.folders).flatMap((f) => f.mcpServers))].filter((n) => !Object.hasOwn(cfg.mcpServers, n));
  const snap = {};
  if (wanted.length) {
    let user = {};
    try { user = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers ?? {}; } catch { /* none */ }
    for (const n of wanted) if (Object.hasOwn(user, n)) snap[n] = user[n];
  }
  fs.writeFileSync(MCP_SNAPSHOT_PATH, JSON.stringify(snap, null, 2), { mode: 0o600 });
  const defs = mcpDefinitions(cfg);

  let problems = 0;
  for (const [name, f] of Object.entries(cfg.folders)) {
    const exists = fs.existsSync(f.path) && fs.statSync(f.path).isDirectory();
    const { missing } = buildMcpConfig(f.mcpServers, defs);
    console.log(`  ${name}: ${f.path}${exists ? '' : '  (MISSING)'}`);
    console.log(`    tools: ${f.allowedTools.join(', ')}`);
    if (f.mcpServers.length) console.log(`    mcp servers: ${f.mcpServers.join(', ')}${missing.length ? `  (NOT FOUND: ${missing.join(', ')})` : ''}`);
    const orphans = f.allowedTools.filter((t) => t.startsWith('mcp__') && !f.mcpServers.includes(t.split('__')[1]));
    if (orphans.length) console.log(`    note: ${orphans.join(', ')} name a server this folder does not list in mcpServers; they will not exist`);
    if (canRunCode(f.allowedTools)) console.log('    WARNING: these tools can change files and run something from this folder, so a job can run code here');
    if (missing.length) problems++;
  }
  console.log(!cfg.mirror ? 'mirror: off (mirror is false in config.json)' : fs.existsSync(MIRROR_PAUSED_PATH) ? 'mirror: paused (mirror.paused exists)'
    : `mirror: on, backfill ${cfg.mirrorBackfillDays} days, ${cfg.mirrorExclude.length} exclude pattern(s)`);
  console.log(readToken() ? 'token: present' : 'token: missing (run: node runner.mjs pair)');
  if (problems) process.exit(1);
}

// ---------------------------------------------------------------------------------------------------------
// run
let stopping = false;
let tunnel = null;
/** True only after the listener on localPort was confirmed to be our own ssh child. Nothing is sent before. */
let tunnelVerified = false;
const currentChildren = new Set();

/** Waits for the ssh child's listener and checks nobody else holds the port. Resolves true/false. */
async function verifyTunnel(child, port) {
  for (let i = 0; i < 30 && !stopping && child.exitCode === null; i++) {
    let ls = [];
    try { ls = listenersOn(port); } catch (e) { log('port_check_failed', { error: e.message }); return false; }
    if (ls.length) {
      if (listenerIsOurs(ls, child.pid)) return true;
      log('port_squatted', { port, sshPid: child.pid, listeners: ls });
      return false;
    }
    await sleep(500);
  }
  return false;
}

function startTunnel(cfg) {
  let attempt = 0;
  const open = () => {
    if (stopping) return;
    tunnelVerified = false;
    const started = Date.now();
    // Outbound only: a local forward bound to 127.0.0.1 alone. BatchMode = keys only, never a password prompt.
    const args = ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${cfg.localPort}:127.0.0.1:${HUB_PORT}`, '--', cfg.sshAlias];
    const child = spawn(BIN.ssh, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    tunnel = child;
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    child.on('error', (e) => log('tunnel_error', { error: e.message }));
    log('tunnel_start', { alias: cfg.sshAlias, localPort: cfg.localPort, pid: child.pid });
    child.on('exit', (code) => {
      tunnel = null;
      tunnelVerified = false;
      if (stopping) return;
      if (Date.now() - started > 60_000) attempt = 0;
      const wait = backoffMs(attempt++);
      log('tunnel_exit', { code, stderr: err.trim().slice(-300), retryInMs: wait });
      setTimeout(open, wait);
    });
    verifyTunnel(child, cfg.localPort).then((ok) => {
      if (ok && child.exitCode === null && tunnel === child) { tunnelVerified = true; log('tunnel_verified', { pid: child.pid }); }
      else if (child.exitCode === null) { log('tunnel_not_verified', { pid: child.pid }); killTree(child); } // exit handler backs off
    });
  };
  open();
}

async function api(cfg, token, method, p, body) {
  // The token only ever goes to a listener we proved is our ssh child (or the dev hub with NO_TUNNEL).
  if (!tunnelVerified) throw new Error('tunnel not verified; nothing sent');
  const res = await fetch(`http://127.0.0.1:${cfg.localPort}/api/pc-runner${p}`, {
    method,
    // The hub refuses any POST that isn't JSON (CSRF guard in api/guard.ts), so a POST always sends a JSON body.
    headers: { authorization: `Bearer ${token}`, ...(method === 'POST' || body ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' || body ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

/** Posts a result, retrying while the tunnel comes back. */
async function postResult(cfg, token, id, result) {
  for (let i = 0; i < 6; i++) {
    try { await api(cfg, token, 'POST', `/jobs/${encodeURIComponent(id)}/result`, result); return true; } catch (e) {
      log('result_post_failed', { jobId: id, error: e.message, attempt: i + 1 });
      await sleep(5000);
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shows the Run / Refuse dialog. The job goes to the dialog in a temp JSON file, never inside script text. */
async function confirmLocally(payload) {
  if (process.platform !== 'win32') return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-runner-'));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(BIN.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
        '-File', path.join(HERE, 'confirm.ps1'), '-JobFile', file], { stdio: 'ignore', windowsHide: true });
      currentChildren.add(child);
      // The dialog refuses itself after 10 minutes; this is the backstop if it hangs.
      const t = setTimeout(() => killTree(child), CONFIRM_TIMEOUT_MS + 30_000);
      child.on('error', () => { clearTimeout(t); currentChildren.delete(child); resolve(-1); });
      child.on('exit', (c) => { clearTimeout(t); currentChildren.delete(child); resolve(c); });
    });
    return code === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs claude in the folder with the prompt on stdin, isolated from the folder's own config: the runner writes
 * the only settings file and MCP config the job sees into a temp folder outside the job folder (see buildClaudeArgs).
 * `cwd` is the allowlisted folder, or for a resume job the session's own working folder (inside one). Resolves { ok, output, costUsd?, durationMs?, sessionId? }.
 */
function runClaude(claudePath, { folder, cwd, mcpDefs, prompt, resumeSessionId }) {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-runner-job-'));
  const settingsPath = path.join(dir, 'settings.json');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(settingsPath, JSON.stringify(RUNNER_SETTINGS), { mode: 0o600 });
  fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig(folder.mcpServers, mcpDefs).config), { mode: 0o600 });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let args;
  try { args = buildClaudeArgs({ allowedTools: folder.allowedTools, settingsPath, mcpConfigPath, resumeSessionId }); } catch (e) {
    cleanup();
    return Promise.resolve({ ok: false, output: `refused to build the claude command: ${e.message}`, durationMs: 0 });
  }
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, outBytes = 0;
    // gitHardenedEnv: every git the job runs ignores system/user git config and has fsmonitor, pager, hooks and
    // sshCommand forced off, whatever the repo's .git/config says.
    const child = spawn(claudePath, args, { cwd, env: gitHardenedEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    currentChildren.add(child);
    const t = setTimeout(() => { timedOut = true; killTree(child); }, JOB_TIMEOUT_MS);
    // Keep memory bounded: the JSON result can't be parsed past ~4 MB anyway.
    child.stdout.on('data', (d) => { outBytes += d.length; if (outBytes < 4 * 1024 * 1024) out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => {
      clearTimeout(t); currentChildren.delete(child); cleanup();
      resolve({ ok: false, output: `could not start claude: ${e.message}`, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(t); currentChildren.delete(child); cleanup();
      const durationMs = Date.now() - started;
      if (timedOut) return resolve({ ok: false, output: capOutput(`Stopped after ${JOB_TIMEOUT_MS / 60000} minutes.\n\n${out.slice(-8000)}`), durationMs });
      const r = parseClaudeResult(out, code);
      if (!r.ok && !out.trim() && err.trim()) r.output = capOutput(err.trim());
      r.durationMs ??= durationMs;
      resolve(r);
    });
    child.stdin.on('error', () => { /* claude exited before reading stdin; 'close' reports it */ });
    child.stdin.end(prompt, 'utf8');
  });
}

/** The real pieces handleJob (jobs.mjs) works with. */
const jobDeps = (cfg, claudePath, token, mirror) => {
  const baseUrl = `http://127.0.0.1:${cfg.localPort}`;
  const guard = () => { if (!tunnelVerified) throw new Error('tunnel not verified; nothing sent'); };
  return {
  log, claudePath, loadConfig, mcpDefinitions,
  confirm: confirmLocally,
  startJob: (id) => api(cfg, token, 'POST', `/jobs/${encodeURIComponent(id)}/start`),
  run: (j) => runClaude(claudePath, j),
  // Sync jobs: git by absolute path, the machine name for wip branches, and the bundle upload through the verified tunnel.
  gitPath: findGit(), machine: os.hostname(),
  uploadBundle: (id, file, query) => uploadBundleFile({ baseUrl, token, jobId: id, file, query, guard }),
  // Move / pull jobs (bridge P6): the session transcript, the bundles back, and the mirror's on-the-VPS lock.
  uploadSession: (id, file) => uploadSessionFile({ baseUrl, token, jobId: id, file, guard }),
  downloadSession: (id, dest) => downloadSessionFile({ baseUrl, token, jobId: id, dest, guard }),
  downloadBundle: (id, repo, dest) => downloadBundleFile({ baseUrl, token, jobId: id, query: { repo }, dest, guard }),
  holdSession: (id) => mirror?.hold(id),
  releaseSession: (id) => mirror?.release(id),
  isOnVps: (id) => mirror?.isHeld(id) === true,
  postResult: (id, result) => postResult(cfg, token, id, result),
  };
};

async function run() {
  const r = loadConfig();
  if (!r.ok) { log('config_invalid', { errors: r.errors }); console.error('config.json has problems:\n  ' + r.errors.join('\n  ')); process.exit(1); }
  const token = readToken();
  if (!token) { log('no_token'); console.error(`No runner token at ${TOKEN_PATH}. Run: node runner.mjs pair`); process.exit(1); }
  const cfg = r.config;
  // Resolved once, to an absolute path; a bare `claude` is never spawned.
  const claude = resolveClaude(cfg);
  if (claude.error) { log('claude_not_found', { error: claude.error }); console.error(claude.error); process.exit(1); }
  log('runner_start', { pid: process.pid, folders: Object.keys(cfg.folders), claude: claude.path });

  const shutdown = (why) => {
    if (stopping) return;
    stopping = true;
    log('runner_stop', { why });
    for (const c of currentChildren) killTree(c);
    killTree(tunnel);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  process.on('exit', () => { for (const c of currentChildren) killTree(c); killTree(tunnel); });

  // Dev only: talk to a hub already listening on localPort (a local test hub) instead of opening the tunnel.
  if (process.env.POCKETROCKET_RUNNER_NO_TUNNEL === '1') { log('tunnel_skipped'); tunnelVerified = true; }
  else startTunnel(cfg);

  // Session mirror: runs only while the tunnel is verified (the request guard throws otherwise, so the token goes
  // nowhere else), pauses on `mirror: false` or a mirror.paused file (both checked every poll), stops with the runner.
  const mirror = createMirror({
    getConfig: () => loadConfig().config ?? null,
    request: httpRequester({
      baseUrl: `http://127.0.0.1:${cfg.localPort}`, token,
      guard: () => { if (!tunnelVerified) throw Object.assign(new Error('tunnel not verified; nothing sent'), { network: true }); },
    }),
    isPaused: () => fs.existsSync(MIRROR_PAUSED_PATH),
    isReady: () => tunnelVerified && !stopping,
    log,
  });
  mirror.start();
  const stopMirror = () => mirror.stop();
  process.on('exit', stopMirror);

  let lastBeatError = '';
  const beat = async () => {
    try {
      await api(cfg, token, 'POST', '/heartbeat', { folders: Object.keys((loadConfig().config ?? cfg).folders) });
      if (lastBeatError) log('heartbeat_ok');
      lastBeatError = '';
    } catch (e) {
      if (e.message !== lastBeatError) log('heartbeat_failed', { error: e.message });
      lastBeatError = e.message;
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_MS);

  let lastPollError = '';
  while (!stopping) {
    try {
      const job = await api(cfg, token, 'GET', '/jobs/next');
      lastPollError = '';
      if (job) await handleJob(jobDeps(cfg, claude.path, token, mirror), job);
    } catch (e) {
      if (e.message !== lastPollError) log('poll_failed', { error: e.message });
      lastPollError = e.message;
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------------------
const cmd = process.argv[2] || 'run';
try {
  if (cmd === 'pair') pair();
  else if (cmd === 'check') check();
  else if (cmd === 'run') await run();
  else { console.error('usage: node runner.mjs pair | check | run'); process.exit(2); }
} catch (e) {
  log('fatal', { error: e.message });
  console.error(e.message);
  process.exit(1);
}
