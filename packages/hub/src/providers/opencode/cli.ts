import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ModelInfo } from '@pocketrocket/shared';

/**
 * Thin `opencode` CLI helpers: locating the executable and parsing the two commands the provider check
 * needs (`--version`, `auth list`) plus the model list (`models`). Kept free of any process state so the
 * parsers can be unit-tested against captured real output in `test-fixtures/opencode/`.
 */

let cachedExe: string | null = null;

/** `OPENCODE_EXE`, else the first `opencode[.cmd|.exe|.bat]` on PATH, else the bare name. */
export function resolveOpencodeExe(): string {
  if (process.env.OPENCODE_EXE) return process.env.OPENCODE_EXE;
  if (cachedExe) return cachedExe;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'opencode' + ext);
      try {
        if (fs.statSync(p).isFile()) return (cachedExe = p);
      } catch {
        /* keep looking */
      }
    }
  }
  return (cachedExe = 'opencode');
}

/** True for a Windows shim that cmd.exe has to interpret; spawn/execFile need `shell: true` for those. */
export function needsShell(exe: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
}

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * A single command string for the `shell: true` path. Passing an args array together with `shell: true` is
 * deprecated in Node (DEP0190) because the args are concatenated unescaped, so we do the quoting ourselves.
 */
export function shellCommand(exe: string, args: string[]): string {
  return ['"' + exe + '"', ...args.map((a) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))].join(' ');
}

/** `unref` detaches the child from the event loop; used for background refreshes nobody is waiting on. */
export function runCli(exe: string, args: string[], timeout = 5000, unref = false): Promise<CliResult> {
  const shell = needsShell(exe);
  return new Promise((resolve) => {
    const child = execFile(
      shell ? shellCommand(exe, args) : exe,
      shell ? undefined : args,
      { timeout, windowsHide: true, shell, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err ? String(err.message) : undefined });
      },
    );
    child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: '', error: String(e.message) }));
    if (unref) child.unref();
  });
}

/** Drop ANSI colour codes and the CR of CRLF so the parsers see plain text. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}

export interface AuthList {
  /** Display names of the configured providers, in the order the CLI printed them. */
  providers: string[];
  /** `oauth` entries mean a subscription login; `api` means a stored key. */
  auth: 'subscription' | 'apiKey' | 'none';
}

/**
 * `opencode auth list` prints a box: `●  <Provider name> <method>` per credential, where method is
 * `api` for a stored key and `oauth` for a subscription login. Anything else is chrome.
 */
export function parseAuthList(stdout: string): AuthList {
  const providers: string[] = [];
  let oauth = false;
  let api = false;
  for (const raw of stripAnsi(stdout).split('\n')) {
    const line = raw.replace(/^[\s│┌└├─┐┘]*/u, '').trim();
    const m = /^[●○*]\s+(.+?)\s+(api|oauth|wellknown|access|api_key)\s*$/i.exec(line);
    if (!m) continue;
    providers.push(m[1].trim());
    if (/^oauth|^access|^wellknown/i.test(m[2])) oauth = true;
    else api = true;
  }
  return { providers, auth: oauth ? 'subscription' : api ? 'apiKey' : 'none' };
}

/**
 * Where the CLI keeps its credentials (it prints this path in `auth list`). Reading it is instant, whereas
 * `opencode auth list` costs ~1.7s, so `check()` prefers the file and falls back to the CLI.
 */
export function authFilePath(): string {
  const base = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.local', 'share');
  return path.join(base, 'opencode', 'auth.json');
}

/** `{ "<providerID>": { "type": "api" | "oauth", ... } }`. Secrets in the file are never read out. */
export function parseAuthFile(json: string): AuthList {
  let parsed: Record<string, { type?: string }>;
  try {
    parsed = JSON.parse(json) as Record<string, { type?: string }>;
  } catch {
    return { providers: [], auth: 'none' };
  }
  const providers: string[] = [];
  let oauth = false;
  let api = false;
  for (const [id, entry] of Object.entries(parsed ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    providers.push(id);
    if (entry.type === 'oauth' || entry.type === 'wellknown') oauth = true;
    else api = true;
  }
  return { providers, auth: oauth ? 'subscription' : api ? 'apiKey' : 'none' };
}

/** The auth file when it exists and holds at least one credential, else null (caller falls back to the CLI). */
export function readAuthFile(): AuthList | null {
  try {
    const a = parseAuthFile(fs.readFileSync(authFilePath(), 'utf8'));
    return a.providers.length ? a : null;
  } catch {
    return null;
  }
}

const WORD_FIXES: Record<string, string> = {
  gpt: 'GPT', glm: 'GLM', ai: 'AI', llm: 'LLM', xai: 'xAI', v2: 'v2', v3: 'v3', v4: 'v4',
};

function pretty(segment: string): string {
  return segment
    .split('-')
    .map((w) => WORD_FIXES[w.toLowerCase()] ?? (/^[0-9]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// Ranked cheap/balanced defaults: the first match in this list becomes ModelInfo.default. Nothing here is
// hardcoded as available — it only orders whatever `opencode models` actually printed.
const DEFAULT_PREFERENCE: RegExp[] = [
  /(^|\/)claude-sonnet-5$/,
  /(^|\/)claude-sonnet-4-6$/,
  /claude-sonnet/,
  /(^|\/)gpt-5(\.\d+)?$/,
  /gpt-5[.\d]*-mini$/,
  /claude-haiku/,
  /grok-4/,
];
const PROVIDER_PREFERENCE = ['anthropic', 'openai', 'xai', 'opencode', 'github-copilot', 'google'];

/**
 * `opencode models` prints one `provider/model` id per line. Ids are never hardcoded: the picker shows
 * exactly what the user's logins expose.
 */
export function parseModels(stdout: string): ModelInfo[] {
  const ids: string[] = [];
  for (const raw of stripAnsi(stdout).split('\n')) {
    const line = raw.trim();
    if (!/^[\w.-]+\/[\w.:-]+$/.test(line)) continue;
    if (!ids.includes(line)) ids.push(line);
  }
  const models: ModelInfo[] = ids.map((id) => {
    const slash = id.indexOf('/');
    const provider = id.slice(0, slash);
    return { id, label: pretty(id.slice(slash + 1)), note: provider };
  });
  const pick = pickDefault(models.map((m) => m.id));
  const chosen = models.find((m) => m.id === pick);
  if (chosen) chosen.default = true;
  return models;
}

/** First id matching the preference list, tie-broken by provider order, else the first id at all. */
export function pickDefault(ids: string[]): string | undefined {
  const byProvider = [...ids].sort((a, b) => {
    const pa = PROVIDER_PREFERENCE.indexOf(a.slice(0, a.indexOf('/')));
    const pb = PROVIDER_PREFERENCE.indexOf(b.slice(0, b.indexOf('/')));
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
  });
  for (const re of DEFAULT_PREFERENCE) {
    const hit = byProvider.find((id) => re.test(id));
    if (hit) return hit;
  }
  return byProvider[0];
}

/** `opencode --version` prints just the semver. */
export function parseVersion(stdout: string): string | undefined {
  const line = stripAnsi(stdout).trim().split('\n')[0]?.trim();
  return line ? line : undefined;
}

/** Split a `provider/model` id. A bare id is assumed to belong to the `opencode` (Zen) provider. */
export function splitModelId(id: string): { providerID: string; modelID: string } {
  const i = id.indexOf('/');
  if (i < 0) return { providerID: 'opencode', modelID: id };
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) };
}
