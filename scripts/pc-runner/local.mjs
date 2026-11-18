// I/O helpers shared by runner.mjs and mcp.mjs: where the runner keeps its files, and how to look at local
// listeners and processes. Importing this file has no side effects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateConfig, cleanToken } from './lib.mjs';

export const BASE = process.env.POCKETROCKET_RUNNER_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PocketRocketRunner');
export const CONFIG_PATH = path.join(BASE, 'config.json');
export const TOKEN_PATH = path.join(BASE, 'token');
/** Flag file: while it exists the session mirror sends nothing (the "Mirror pause-resume" shortcut toggles it). */
export const MIRROR_PAUSED_PATH = path.join(BASE, 'mirror.paused');
export const PID_PATH = path.join(BASE, 'runner.pid');
export const POWERSHELL = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
    return { ok: false, errors: [`cannot read ${CONFIG_PATH}: ${e.code || e.message}`] };
  }
  return validateConfig(raw);
}

export function readToken() {
  try { return cleanToken(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

/** The pid `runner-on.ps1` wrote, or null. */
export function readRunnerPid() {
  try {
    const s = fs.readFileSync(PID_PATH, 'utf8').trim();
    return /^\d{1,10}$/.test(s) ? Number(s) : null;
  } catch { return null; }
}

/**
 * Every TCP socket whose LOCAL port is `port`, as [{address, pid}]: the listener plus connections it accepted, all
 * owned by whoever listens. Our own outgoing fetches have it as the remote port, so they don't show up. No -State
 * filter: some Windows setups report State as 0 for live listeners, and a filtered query would then find nothing.
 * The port goes in through an env var, never into the script text.
 */
export function listenersOn(port) {
  // spawnSync, not execFileSync: PowerShell exits 1 when nothing matches, which here just means "no listener yet".
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    '$p = [int]$env:PR_RUNNER_PORT; Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | ' +
    "ForEach-Object { $_.LocalAddress + '|' + $_.OwningProcess }"],
  { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, PR_RUNNER_PORT: String(port) } });
  if (r.error) throw r.error;
  const out = r.stdout || '';
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.lastIndexOf('|');
    return { address: l.slice(0, i), pid: Number(l.slice(i + 1)) };
  });
}

/** Parent pid, name and command line for each pid, as { [pid]: { ppid, name, cmd } }. Pids go in through an env var. */
export function processInfo(pids) {
  const ids = [...new Set(pids)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return {};
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    '$ids = $env:PR_RUNNER_PIDS -split ","; Get-CimInstance Win32_Process | Where-Object { $ids -contains [string]$_.ProcessId } | ' +
    "ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + $_.Name + '|' + $_.CommandLine }"],
  { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, PR_RUNNER_PIDS: ids.join(',') } });
  if (r.error) throw r.error;
  const out = {};
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|([^|]*)\|(.*)$/.exec(line.trim());
    if (m) out[m[1]] = { ppid: Number(m[2]), name: m[3], cmd: m[4] };
  }
  return out;
}
