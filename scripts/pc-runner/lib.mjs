// Pure helpers for the PocketRocket PC runner (no I/O, so node:test can cover them on any OS).
import path from 'node:path';

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
/** An MCP server name as Claude Code accepts it in tool names (mcp__<name>__<tool>). */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** An ssh config alias or user@host. Never starts with '-', so it can't be read as an ssh option. */
export const SSH_ALIAS_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/;
/** One --allowedTools entry: `Read`, `mcp__server__tool`, or `Bash(git status:*)`. No commas (the list is comma-joined). */
export const TOOL_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\([^(),\r\n]{1,200}\))?$/;
export const HUB_PORT = 7788;
export const OUTPUT_CAP_BYTES = 20 * 1024;
export const PROMPT_LOG_CHARS = 200;
export const JOB_TIMEOUT_MS = 15 * 60 * 1000;
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Read, edit, and look at git history. No test runners: `pnpm test` / `npm test` run scripts from the repo, and
 * with Edit/Write in the same list that is arbitrary code. Add them per folder only where you accept that.
 */
export const DEFAULT_ALLOWED_TOOLS = Object.freeze([
  'Read', 'Glob', 'Grep', 'Edit', 'Write',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
]);

/**
 * Always denied, whatever the allow list says (deny wins in Claude Code). Each turns a read-only git command into
 * a file write or a program run: `--output=<file>` writes anywhere, `--ext-diff` runs a configured diff driver,
 * `-c` sets any config (core.pager, diff.external, ...) for one command.
 */
export const DISALLOWED_TOOLS = Object.freeze([
  'Bash(git * --output*)', 'Bash(git diff --output*)', 'Bash(git * --ext-diff*)', 'Bash(git -c *)',
  // Editing git's own config is code execution: core.fsmonitor, core.pager, diff.external, aliases in .git/config,
  // or filter/diff drivers named from .gitattributes, run on the next `git status` / `git diff`.
  'Edit(.git/**)', 'Write(.git/**)', 'Edit(**/.git/**)', 'Write(**/.git/**)',
  'Edit(**/.gitattributes)', 'Write(**/.gitattributes)', 'Edit(**/.gitmodules)', 'Write(**/.gitmodules)',
]);

/**
 * Git config forced for every git the job runs (Claude's Bash tool inherits claude's environment). Entries passed
 * through GIT_CONFIG_COUNT have command-line scope, so they override whatever a repo's .git/config says.
 *
 * Not here: `diff.external`. Git has no value meaning "none": an empty one makes every `git diff` fail with
 * "cannot spawn" (tested on git 2.46). A planted diff.external, like filter/textconv drivers, is instead kept
 * out by denying Edit/Write on .git/** and .gitattributes (DISALLOWED_TOOLS); GIT_EXTERNAL_DIFF is dropped from env.
 */
export const GIT_FORCED_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.pager', 'cat'],
  ['core.hooksPath', 'NUL'],
  ['core.sshCommand', ''],
]);

/**
 * The environment for the claude process: the caller's, minus anything that points git elsewhere or runs a
 * program, plus GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL=NUL (no system or user git config, so no user aliases or
 * credential helpers) and GIT_FORCED_CONFIG. Windows env names are case-insensitive, so removal ignores case.
 */
export function gitHardenedEnv(baseEnv) {
  const drop = /^(GIT_CONFIG.*|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|EDITOR|VISUAL|GIT_TRACE.*)$/i;
  const env = {};
  for (const [k, v] of Object.entries(baseEnv ?? {})) if (!drop.test(k)) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = 'NUL';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_CONFIG_COUNT = String(GIT_FORCED_CONFIG.length);
  GIT_FORCED_CONFIG.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

/**
 * The only settings a job sees (passed with --settings; user, project and local settings files are not loaded).
 * Nothing pre-approved beyond --allowedTools, anything else denied, no hooks.
 */
export const RUNNER_SETTINGS = Object.freeze({
  permissions: { defaultMode: 'dontAsk', allow: [], deny: [...DISALLOWED_TOOLS] },
  disableAllHooks: true,
});

/** Flags that would turn off Claude's permission checks. Never passed, never accepted from config or a job. */
const FORBIDDEN = /dangerously|bypasspermissions|skip-permissions|permission-mode/i;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Returns an error string for a bad tool entry, or null. */
export function toolError(t) {
  if (typeof t !== 'string' || !t) return 'not a string';
  if (FORBIDDEN.test(t)) return 'permission-bypass flags are never allowed';
  if (!TOOL_RE.test(t)) return 'must look like Read, mcp__server__tool or Bash(git status:*)';
  // Bash with no pattern, or a pattern that matches every command, is a shell on this PC.
  if (t === 'Bash' || /^Bash\(\s*(:?\*|\*:\*)?\s*\)$/.test(t)) return 'unrestricted Bash is not allowed; list exact commands like Bash(git status:*)';
  if (t === 'PowerShell' || /^PowerShell\(\s*(:?\*|\*:\*)?\s*\)$/.test(t)) return 'unrestricted PowerShell is not allowed';
  return null;
}

/**
 * True when the list can both change files and run any command, git included: a file edit can turn the next
 * command (even `git status`) into running a program. The runner denies the known git routes (DISALLOWED_TOOLS,
 * gitHardenedEnv), but the dialog still says so plainly.
 */
export function canRunCode(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const writes = list.some((t) => WRITE_TOOLS.has(t));
  const runs = list.some((t) => /^(Bash|PowerShell)\b/.test(t));
  return writes && runs;
}

/** Built-in tool names for --tools: `Bash(git status:*)` -> `Bash`; MCP tools are not built-in. */
export function builtinToolsOf(tools) {
  const out = [];
  for (const t of tools) {
    if (t.startsWith('mcp__')) continue;
    const base = t.replace(/\(.*$/, '');
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

/** True when `child` is `parent` or inside it (Windows paths, case-insensitive). */
export function isInside(child, parent) {
  const c = path.win32.resolve(child).toLowerCase();
  const p = path.win32.resolve(parent).toLowerCase().replace(/\\+$/, '');
  return c === p || c.startsWith(p + '\\');
}

/**
 * Validates config.json. Returns { ok: true, config } with defaults filled in, or { ok: false, errors }.
 * `config.folders[name].allowedTools`, when set, REPLACES defaultAllowedTools for that folder.
 */
export function validateConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['config must be a JSON object'] };
  const sshAlias = raw.sshAlias ?? 'crm-agency';
  if (typeof sshAlias !== 'string' || !SSH_ALIAS_RE.test(sshAlias)) errors.push('sshAlias must be an ssh config alias (letters, digits, . _ @ -; not starting with -)');
  const localPort = raw.localPort ?? 7789;
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) errors.push('localPort must be an integer 1024-65535');
  const claudePath = raw.claudePath ?? null;
  if (claudePath !== null && (typeof claudePath !== 'string' || !path.win32.isAbsolute(claudePath) || /^\\\\/.test(claudePath) || !/\.exe$/i.test(claudePath))) {
    errors.push('claudePath must be an absolute local path to claude.exe');
  }

  const mcpServers = {};
  if (raw.mcpServers !== undefined) {
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object' || Array.isArray(raw.mcpServers)) errors.push('mcpServers must be an object of { name: definition }');
    else for (const [n, d] of Object.entries(raw.mcpServers)) {
      if (!MCP_NAME_RE.test(n)) errors.push(`mcpServers name ${JSON.stringify(n)} must match ${MCP_NAME_RE}`);
      else if (!d || typeof d !== 'object' || Array.isArray(d)) errors.push(`mcpServers.${n} must be an object`);
      else mcpServers[n] = d;
    }
  }

  let defaultAllowedTools = [...DEFAULT_ALLOWED_TOOLS];
  if (raw.defaultAllowedTools !== undefined) {
    if (!Array.isArray(raw.defaultAllowedTools) || raw.defaultAllowedTools.length === 0) errors.push('defaultAllowedTools must be a non-empty array');
    else {
      for (const t of raw.defaultAllowedTools) { const e = toolError(t); if (e) errors.push(`defaultAllowedTools: ${JSON.stringify(t)}: ${e}`); }
      defaultAllowedTools = [...raw.defaultAllowedTools];
    }
  }

  const folders = {};
  if (!raw.folders || typeof raw.folders !== 'object' || Array.isArray(raw.folders)) errors.push('folders must be an object of { name: { path, allowedTools?, mcpServers? } }');
  else {
    for (const [name, f] of Object.entries(raw.folders)) {
      if (!FOLDER_NAME_RE.test(name)) { errors.push(`folder name ${JSON.stringify(name)} must match ${FOLDER_NAME_RE}`); continue; }
      if (!f || typeof f !== 'object' || Array.isArray(f)) { errors.push(`folders.${name} must be an object`); continue; }
      if (typeof f.path !== 'string' || !path.win32.isAbsolute(f.path) || /^\\\\/.test(f.path)) {
        errors.push(`folders.${name}.path must be an absolute local path like C:\\\\Users\\\\you\\\\project`); continue;
      }
      let tools = defaultAllowedTools;
      if (f.allowedTools !== undefined) {
        if (!Array.isArray(f.allowedTools) || f.allowedTools.length === 0) { errors.push(`folders.${name}.allowedTools must be a non-empty array`); continue; }
        const bad = f.allowedTools.map((t) => [t, toolError(t)]).filter(([, e]) => e);
        if (bad.length) { for (const [t, e] of bad) errors.push(`folders.${name}.allowedTools: ${JSON.stringify(t)}: ${e}`); continue; }
        tools = [...f.allowedTools];
      }
      let servers = [];
      if (f.mcpServers !== undefined) {
        if (!Array.isArray(f.mcpServers) || f.mcpServers.some((n) => typeof n !== 'string' || !MCP_NAME_RE.test(n))) {
          errors.push(`folders.${name}.mcpServers must be a list of MCP server names`); continue;
        }
        servers = [...new Set(f.mcpServers)];
      }
      folders[name] = { path: path.win32.normalize(f.path), allowedTools: tools, mcpServers: servers };
    }
  }
  if (claudePath && Object.values(folders).some((f) => isInside(claudePath, f.path))) errors.push('claudePath must not be inside an allowlisted folder');
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { sshAlias, localPort, claudePath, mcpServers, folders, defaultAllowedTools } };
}

/**
 * Picks the claude binary: config claudePath, else %USERPROFILE%\.local\bin\claude.exe, else claude.exe on PATH,
 * looking only in absolute PATH entries (never the current folder). Refuses anything inside an allowlisted
 * folder, since a job may edit files there. `exists(p)` is injected so this stays pure.
 * Returns { path } or { error }.
 */
export function resolveClaudePath({ claudePath, home, pathEnv, folders, exists }) {
  const inFolder = (p) => Object.values(folders ?? {}).some((f) => isInside(p, f.path));
  const candidates = [];
  if (claudePath) candidates.push(claudePath);
  else {
    if (home) candidates.push(path.win32.join(home, '.local', 'bin', 'claude.exe'));
    for (const dir of String(pathEnv ?? '').split(';')) {
      const d = dir.trim().replace(/^"(.*)"$/, '$1');
      if (!d || !path.win32.isAbsolute(d) || /^\\\\/.test(d)) continue;
      candidates.push(path.win32.join(d, 'claude.exe'));
    }
  }
  for (const c of candidates) {
    if (!exists(c)) continue;
    if (inFolder(c)) return { error: `claude at ${c} is inside an allowlisted folder; set claudePath to a copy outside them` };
    return { path: path.win32.normalize(c) };
  }
  return { error: claudePath ? `claudePath ${claudePath} does not exist` : 'claude.exe not found (install Claude Code, or set claudePath)' };
}

/** The --mcp-config document for a folder: only the servers it names, from the given definitions. */
export function buildMcpConfig(names, defs) {
  const mcpServers = {};
  const missing = [];
  for (const n of names ?? []) {
    if (defs && Object.hasOwn(defs, n)) mcpServers[n] = defs[n];
    else missing.push(n);
  }
  return { config: { mcpServers }, missing };
}

/** The local allowlist entry for a job's folder, or null. Only own, valid names count (no prototype keys). */
export function folderFor(config, name) {
  if (typeof name !== 'string' || !FOLDER_NAME_RE.test(name)) return null;
  if (!config?.folders || !Object.hasOwn(config.folders, name)) return null;
  return config.folders[name];
}

/** Shape-checks a job from GET /jobs/next. Returns the job or null. */
export function parseJob(j) {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.id !== 'string' && typeof j.id !== 'number') return null;
  const id = String(j.id);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  if (typeof j.prompt !== 'string' || !j.prompt.trim()) return null;
  if (typeof j.folder !== 'string') return null;
  const handle = typeof j.bot?.handle === 'string' ? j.bot.handle : '?';
  const room = { id: String(j.room?.id ?? ''), name: typeof j.room?.name === 'string' ? j.room.name : '?' };
  return { id, bot: { handle }, room, folder: j.folder, prompt: j.prompt, createdAt: j.createdAt ?? null };
}

/**
 * Arguments for `claude`. The prompt goes on stdin, never in argv. Every flag here exists in Claude Code 2.1.x
 * (checked against `claude --help`):
 *   --restricted              ignore user/project/local settings files, refuse bypassPermissions, confine the
 *                             file tools to the working folder, drop code-running tools unless --tools names them
 *   --setting-sources ""      load no settings files at all (belt and braces with --restricted)
 *   --settings <file>         the runner's own settings (RUNNER_SETTINGS): dontAsk, empty allow, no hooks
 *   --permission-mode dontAsk anything not pre-approved is denied (there is nobody to ask in -p mode)
 *   --permission-prompts none and nothing is ever routed to a prompt
 *   --strict-mcp-config --mcp-config <file>  only the MCP servers this folder names; .mcp.json and
 *                             ~/.claude.json servers are ignored
 *   --tools                   only these built-in tools exist
 *   --allowedTools / --disallowedTools       the per-folder allow list, and the git escapes that are always denied
 *   --no-session-persistence  no transcript left on disk
 */
export function buildClaudeArgs({ allowedTools, settingsPath, mcpConfigPath } = {}) {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) throw new Error('allowedTools must be a non-empty array');
  for (const t of allowedTools) { const e = toolError(t); if (e) throw new Error(`bad tool ${JSON.stringify(t)}: ${e}`); }
  if (typeof settingsPath !== 'string' || !settingsPath) throw new Error('settingsPath is required');
  if (typeof mcpConfigPath !== 'string' || !mcpConfigPath) throw new Error('mcpConfigPath is required');
  const args = [
    '-p', '--output-format', 'json',
    '--restricted',
    '--setting-sources', '',
    '--settings', settingsPath,
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--tools', builtinToolsOf(allowedTools).join(','),
    '--allowedTools', allowedTools.join(','),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    '--no-session-persistence',
  ];
  // Belt and braces: whatever changes above, these never leave this function.
  if (args.some((a) => /dangerously|bypassPermissions/i.test(a))) throw new Error('refusing to build a permission-bypass command');
  return args;
}

/** Caps text at `max` UTF-8 bytes, cutting on a character boundary and saying how much was cut. */
export function capOutput(text, max = OUTPUT_CAP_BYTES) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  const note = `\n\n[output truncated: ${buf.length - max} more bytes]`;
  let end = Math.max(0, max - Buffer.byteLength(note));
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // don't split a multi-byte character
  return buf.subarray(0, end).toString('utf8') + note;
}

/** Reads `claude -p --output-format json` stdout. Returns { ok, output, costUsd?, durationMs? }. */
export function parseClaudeResult(stdout, exitCode) {
  let j = null;
  const text = String(stdout ?? '').trim();
  try { j = JSON.parse(text); } catch {
    // Some versions print a line or two before the JSON; take the last line that parses.
    for (const line of text.split(/\r?\n/).reverse()) { try { j = JSON.parse(line); break; } catch { /* next */ } }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, output: capOutput(text || `claude exited with code ${exitCode} and no output`) };
  }
  const out = { ok: exitCode === 0 && j.is_error !== true, output: capOutput(typeof j.result === 'string' ? j.result : JSON.stringify(j.result ?? '')) };
  if (typeof j.total_cost_usd === 'number' && Number.isFinite(j.total_cost_usd)) out.costUsd = j.total_cost_usd;
  if (typeof j.duration_ms === 'number' && Number.isFinite(j.duration_ms)) out.durationMs = Math.round(j.duration_ms);
  return out;
}

/**
 * Port-squatting check. `listeners` are rows from Get-NetTCPConnection -State Listen for the local port:
 * { address, pid }. The port is ours only when at least one listener exists and every one of them is the ssh child.
 */
export function listenerIsOurs(listeners, sshPid) {
  if (!Array.isArray(listeners) || listeners.length === 0 || !Number.isInteger(sshPid)) return false;
  return listeners.every((l) => Number(l.pid) === sshPid);
}

/** The first 200 characters of a prompt, on one line, for the log. */
export function promptPreview(p) {
  const s = String(p ?? '').replace(/\s+/g, ' ').trim();
  return s.length > PROMPT_LOG_CHARS ? s.slice(0, PROMPT_LOG_CHARS) + '...' : s;
}

/** A pasted runner token: one line of URL-safe characters. Returns the trimmed token or null. */
export function cleanToken(raw) {
  const t = String(raw ?? '').trim();
  return /^[A-Za-z0-9._~+/=-]{16,512}$/.test(t) ? t : null;
}

/** Restart delay for the ssh tunnel: 2 s doubling to 60 s. */
export function backoffMs(attempt) {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, attempt));
}

/** `runner-YYYY-MM-DD.log` in local time. */
export function logFileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `runner-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`;
}
