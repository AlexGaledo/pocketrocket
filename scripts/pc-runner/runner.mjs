#!/usr/bin/env node
// PocketRocket PC runner: runs owner-approved jobs from the VPS hub on this Windows PC, one at a time,
// after a second approval in a local dialog. See README.md for setup and the threat model.
//
//   node runner.mjs pair     read the runner token from the clipboard, save it (owner-only ACL), clear the clipboard
//   node runner.mjs check    validate config.json and print the folders and tools (no network)
//   node runner.mjs run      open the ssh tunnel and work the job queue (what runner-on.ps1 starts)
//
// Data folder: %LOCALAPPDATA%\PocketRocketRunner (override: POCKETROCKET_RUNNER_DIR).
// The runner token is never printed or logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HUB_PORT, JOB_TIMEOUT_MS, CONFIRM_TIMEOUT_MS,
  validateConfig, folderFor, parseJob, buildClaudeArgs, parseClaudeResult, capOutput, promptPreview,
  cleanToken, backoffMs, logFileName,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.POCKETROCKET_RUNNER_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PocketRocketRunner');
const CONFIG_PATH = path.join(BASE, 'config.json');
const TOKEN_PATH = path.join(BASE, 'token');
const LOG_DIR = path.join(BASE, 'logs');
const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;

// ---------------------------------------------------------------------------------------------------------
function log(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, logFileName()), line + '\n');
  } catch { /* logging must never stop the runner */ }
  if (process.stdout.isTTY) console.log(line);
}

function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
    return { ok: false, errors: [`cannot read ${CONFIG_PATH}: ${e.code || e.message}`] };
  }
  return validateConfig(raw);
}

function readToken() {
  try { return cleanToken(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

function powershell(args, opts = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { windowsHide: true, encoding: 'utf8', ...opts });
}

/** Kills a process and everything it started (claude's shells, the confirm dialog). */
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
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
    execFileSync('icacls', [TOKEN_PATH, '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true });
    fs.rmSync(TOKEN_PATH, { force: true });
  }
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600, flag: 'wx' });
  // Only this user may read it: drop inherited entries, grant read to the current user alone. No shell involved.
  execFileSync('icacls', [TOKEN_PATH, '/inheritance:r', '/grant:r', `${user}:R`], { stdio: 'ignore', windowsHide: true });
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
  console.log(`ssh alias: ${r.config.sshAlias}, local port: ${r.config.localPort}`);
  for (const [name, f] of Object.entries(r.config.folders)) {
    const exists = fs.existsSync(f.path) && fs.statSync(f.path).isDirectory();
    console.log(`  ${name}: ${f.path}${exists ? '' : '  (MISSING)'}\n    tools: ${f.allowedTools.join(', ')}`);
  }
  console.log(readToken() ? 'token: present' : 'token: missing (run: node runner.mjs pair)');
}

// ---------------------------------------------------------------------------------------------------------
// run
let stopping = false;
let tunnel = null;
let currentChildren = new Set();

function startTunnel(cfg) {
  let attempt = 0;
  const open = () => {
    if (stopping) return;
    const started = Date.now();
    // Outbound only: a local forward to the hub's loopback port. BatchMode = keys only, never a password prompt.
    const args = ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `${cfg.localPort}:127.0.0.1:${HUB_PORT}`, '--', cfg.sshAlias];
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    tunnel = child;
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    child.on('error', (e) => log('tunnel_error', { error: e.message }));
    log('tunnel_start', { alias: cfg.sshAlias, localPort: cfg.localPort, pid: child.pid });
    child.on('exit', (code) => {
      tunnel = null;
      if (stopping) return;
      if (Date.now() - started > 60_000) attempt = 0;
      const wait = backoffMs(attempt++);
      log('tunnel_exit', { code, stderr: err.trim().slice(-300), retryInMs: wait });
      setTimeout(open, wait);
    });
  };
  open();
}

async function api(cfg, token, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${cfg.localPort}/api/pc-runner${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
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
async function confirmLocally(job, folder) {
  if (process.platform !== 'win32') return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-runner-'));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({
    handle: job.bot.handle, room: job.room.name, folderName: job.folder, folderPath: folder.path,
    prompt: job.prompt, tools: folder.allowedTools, timeoutSec: CONFIRM_TIMEOUT_MS / 1000,
  }), { encoding: 'utf8', mode: 0o600 });
  try {
    const code = await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
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

function claudeCommand() {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

/** Runs claude in the folder with the prompt on stdin. Resolves { ok, output, costUsd?, durationMs? }. */
function runClaude(folder, prompt) {
  const args = buildClaudeArgs(folder.allowedTools);
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, outBytes = 0;
    const child = spawn(claudeCommand(), args, { cwd: folder.path, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    currentChildren.add(child);
    const t = setTimeout(() => { timedOut = true; killTree(child); }, JOB_TIMEOUT_MS);
    // Keep memory bounded: the JSON result can't be parsed past ~4 MB anyway.
    child.stdout.on('data', (d) => { outBytes += d.length; if (outBytes < 4 * 1024 * 1024) out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => {
      clearTimeout(t); currentChildren.delete(child);
      resolve({ ok: false, output: `could not start claude: ${e.message}`, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(t); currentChildren.delete(child);
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

async function handleJob(cfgAtStart, token, raw) {
  const job = parseJob(raw);
  if (!job) { log('job_malformed', { id: typeof raw?.id === 'string' ? raw.id.slice(0, 80) : null }); return; }
  const meta = { jobId: job.id, bot: job.bot.handle, room: job.room.name, folder: job.folder, prompt: promptPreview(job.prompt), promptChars: job.prompt.length };
  log('job_received', meta);
  const refuse = async (why) => {
    log('job_refused_locally', { jobId: job.id, why });
    await postResult(cfgAtStart, token, job.id, { ok: false, refusedLocally: true, output: why });
  };

  // Re-read config so removing a folder takes effect right away, then re-check the allowlist.
  const fresh = loadConfig();
  if (!fresh.ok) return refuse('The PC runner config is invalid right now; job refused.');
  const folder = folderFor(fresh.config, job.folder);
  if (!folder) return refuse(`Folder "${String(job.folder).slice(0, 60)}" is not in this PC's allowlist.`);
  if (!fs.existsSync(folder.path) || !fs.statSync(folder.path).isDirectory()) return refuse(`Folder "${job.folder}" does not exist on this PC.`);

  const approved = await confirmLocally(job, folder);
  if (!approved) return refuse('Refused on the PC (Refuse pressed, dialog closed, or no answer in 10 minutes).');
  log('job_approved_locally', { jobId: job.id });

  try { await api(cfgAtStart, token, 'POST', `/jobs/${encodeURIComponent(job.id)}/start`); } catch (e) {
    log('job_start_failed', { jobId: job.id, error: e.message });
    return; // the hub didn't accept the start (cancelled, expired); don't run
  }
  const r = await runClaude(folder, job.prompt);
  log('job_finished', { jobId: job.id, ok: r.ok, costUsd: r.costUsd ?? null, durationMs: r.durationMs ?? null, outputBytes: Buffer.byteLength(r.output) });
  await postResult(cfgAtStart, token, job.id, { ok: r.ok, output: r.output, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}), ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) });
}

async function run() {
  const r = loadConfig();
  if (!r.ok) { log('config_invalid', { errors: r.errors }); console.error('config.json has problems:\n  ' + r.errors.join('\n  ')); process.exit(1); }
  const token = readToken();
  if (!token) { log('no_token'); console.error(`No runner token at ${TOKEN_PATH}. Run: node runner.mjs pair`); process.exit(1); }
  const cfg = r.config;
  log('runner_start', { pid: process.pid, folders: Object.keys(cfg.folders) });

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
  if (process.env.POCKETROCKET_RUNNER_NO_TUNNEL === '1') log('tunnel_skipped');
  else { startTunnel(cfg); await sleep(3000); }

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
      if (job) await handleJob(cfg, token, job);
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
