import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR } from '../../config.js';

const isWin = process.platform === 'win32';
const EXE = isWin ? 'grok.exe' : 'grok';

/** Private Grok home for the hub: config, sessions and logs stay out of the user's `~/.grok`. */
export const GROK_HOME = process.env.POCKETROCKET_GROK_HOME
  ? path.resolve(process.env.POCKETROCKET_GROK_HOME)
  : path.join(DATA_DIR, 'grok-home');

/** Where the user's own `grok login` writes its credentials. */
export function userGrokHome(): string {
  return process.env.GROK_HOME ? path.resolve(process.env.GROK_HOME) : path.join(os.homedir(), '.grok');
}

/**
 * `GROK_EXE`, then the installer's default (`$GROK_BIN_DIR` or `~/.grok/bin`), then a bare `grok` so a
 * PATH install still works. Never throws: `check()` reports a missing binary.
 */
export function resolveGrokExe(): string {
  if (process.env.GROK_EXE) return process.env.GROK_EXE;
  const candidates = [
    process.env.GROK_BIN_DIR ? path.join(process.env.GROK_BIN_DIR, EXE) : null,
    path.join(userGrokHome(), 'bin', EXE),
    path.join(os.homedir(), '.local', 'bin', EXE),
  ].filter((p): p is string => !!p);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return EXE;
}

/**
 * Written once and reused by every turn. The MCP bearer token is per-turn, so the config references
 * `${POCKETROCKET_MCP_*}` — grok expands `${VAR}` in `url`/`headers` at load time — and the values ride the
 * child's environment instead. That keeps concurrent turns from racing on one file.
 */
export function grokConfigToml(): string {
  return [
    '# Written by PocketRocket. Edits are overwritten on the next turn.',
    '[cli]',
    'auto_update = false',
    '',
    '[mcp_servers.pocketrocket]',
    'url = "${POCKETROCKET_MCP_URL}"',
    'headers = { "Authorization" = "Bearer ${POCKETROCKET_MCP_TOKEN}" }',
    'startup_timeout_sec = 30',
    '',
  ].join('\n');
}

/**
 * Creates the private home and mirrors the user's cached credentials into it, so a `grok login` done in a
 * normal terminal also authenticates the hub. `XAI_API_KEY` needs none of this.
 */
export function ensureGrokHome(home: string = GROK_HOME): string {
  fs.mkdirSync(home, { recursive: true });
  const cfg = path.join(home, 'config.toml');
  const want = grokConfigToml();
  let have: string | null = null;
  try {
    have = fs.readFileSync(cfg, 'utf8');
  } catch {
    /* first run */
  }
  if (have !== want) fs.writeFileSync(cfg, want);
  mirrorAuth(home);
  return home;
}

function mirrorAuth(home: string) {
  const src = path.join(userGrokHome(), 'auth.json');
  const dst = path.join(home, 'auth.json');
  if (path.resolve(src) === path.resolve(dst)) return;
  try {
    const s = fs.statSync(src);
    let d: fs.Stats | null = null;
    try {
      d = fs.statSync(dst);
    } catch {
      /* not mirrored yet */
    }
    if (d && d.mtimeMs >= s.mtimeMs && d.size === s.size) return;
    fs.copyFileSync(src, dst);
  } catch {
    /* no cached login: XAI_API_KEY or `grok login` is the user's job */
  }
}

/**
 * Claude built-in names (what a bot's `allowedTools` uses, and what the settings UI shows) mapped onto grok's
 * documented permission-rule classes. `--deny <class>` denies every invocation of that class and beats
 * `--always-approve`, unlike `--tools`/`--disallowed-tools` which take internal tool ids the docs spell
 * inconsistently (`run_terminal_cmd` vs `run_terminal_command`).
 */
const RULE_CLASS: Record<string, string[]> = {
  Bash: ['Bash'],
  Read: ['Read'],
  Write: ['Write'],
  Edit: ['Edit'],
  Glob: ['Grep'],
  Grep: ['Grep'],
  WebFetch: ['WebFetch'],
  WebSearch: ['WebSearch'],
};

/** Rule classes to deny, i.e. every class no allowed built-in maps to. */
export function denyRules(allowedBuiltins: string[]): string[] {
  const keep = new Set<string>();
  for (const b of allowedBuiltins) for (const c of RULE_CLASS[b] ?? []) keep.add(c);
  const all = new Set<string>(Object.values(RULE_CLASS).flat());
  return [...all].filter((c) => !keep.has(c)).sort();
}

export interface ArgOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  cwd: string;
  maxTurns: number;
  resumeToken: string | null;
  allowedBuiltins: string[];
  /** Off on Windows: grok's filesystem sandbox is Seatbelt/Landlock only. */
  sandbox?: string | null;
}

export function buildArgs(o: ArgOptions): string[] {
  const args = [
    '-p', o.prompt,
    '--output-format', 'streaming-json',
    '--cwd', o.cwd,
    '-m', o.model,
    '--max-turns', String(o.maxTurns),
    // Approvals are best-effort for Grok: the bot asks the human through the `request_approval` hub tool
    // (BotRunner adds it for every best-effort provider), and the deny rules below are the hard floor.
    '--always-approve',
    // `--rules` appends to grok's system prompt; `--system-prompt-override` would replace it and drop the
    // CLI's own tool instructions.
    '--rules', o.systemPrompt,
    '--verbatim',
    '--no-auto-update',
  ];
  if (o.resumeToken) args.push('--resume', o.resumeToken);
  const sandbox = o.sandbox === undefined ? defaultSandbox() : o.sandbox;
  if (sandbox) args.push('--sandbox', sandbox);
  for (const rule of denyRules(o.allowedBuiltins)) args.push('--deny', rule);
  return args;
}

export function defaultSandbox(): string | null {
  if (process.env.GROK_SANDBOX) return process.env.GROK_SANDBOX;
  return isWin ? null : 'workspace';
}

export function turnEnv(base: NodeJS.ProcessEnv, home: string, mcp: { url: string; token: string }): NodeJS.ProcessEnv {
  return {
    ...base,
    GROK_HOME: home,
    GROK_DISABLE_AUTOUPDATER: '1',
    POCKETROCKET_MCP_URL: mcp.url,
    POCKETROCKET_MCP_TOKEN: mcp.token,
  };
}

/** Kill the CLI and everything it spawned (bash tool children, MCP stdio servers). */
export function treeKill(pid: number | undefined) {
  if (!pid) return;
  if (isWin) {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      return;
    } catch {
      /* fall through to a plain kill */
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/** `grok models` output: `  * grok-4.6 (default)` / `  - grok-4.5`, preceded by an auth line when signed out. */
export function parseModelsOutput(stdout: string): { ids: string[]; defaultId: string | null; authenticated: boolean } {
  const ids: string[] = [];
  let defaultId: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^\s*[*-]\s+(\S+)(\s+\(default\))?\s*$/.exec(raw);
    if (!m) continue;
    ids.push(m[1]);
    if (m[2]) defaultId = m[1];
  }
  if (!defaultId) {
    const d = /^\s*Default model:\s*(\S+)\s*$/m.exec(stdout);
    if (d) defaultId = d[1];
  }
  return { ids, defaultId, authenticated: !/not authenticated/i.test(stdout) };
}
