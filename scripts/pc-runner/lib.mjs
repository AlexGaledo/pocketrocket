// Pure helpers for the PocketRocket PC runner (no I/O, so node:test can cover them on any OS).
import path from 'node:path';

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
/** An ssh config alias or user@host. Never starts with '-', so it can't be read as an ssh option. */
export const SSH_ALIAS_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/;
/** One --allowedTools entry: `Read`, `mcp__server__tool`, or `Bash(git status:*)`. No commas (the list is comma-joined). */
export const TOOL_RE = /^[A-Za-z0-9_]+(\([^(),\r\n]{1,200}\))?$/;
export const HUB_PORT = 7788;
export const OUTPUT_CAP_BYTES = 20 * 1024;
export const PROMPT_LOG_CHARS = 200;
export const JOB_TIMEOUT_MS = 15 * 60 * 1000;
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

export const DEFAULT_ALLOWED_TOOLS = Object.freeze([
  'Read', 'Glob', 'Grep', 'Edit', 'Write',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(pnpm test:*)', 'Bash(npm test:*)',
]);

/** Flags that would turn off Claude's permission checks. Never passed, never accepted from config or a job. */
const FORBIDDEN = /dangerously|bypasspermissions|skip-permissions|permission-mode/i;

/** Returns an error string for a bad tool entry, or null. */
export function toolError(t) {
  if (typeof t !== 'string' || !t) return 'not a string';
  if (FORBIDDEN.test(t)) return 'permission-bypass flags are never allowed';
  if (!TOOL_RE.test(t)) return 'must look like Read, mcp__server__tool or Bash(git status:*)';
  // Bash with no pattern, or a pattern that matches every command, is a shell on this PC.
  if (t === 'Bash' || /^Bash\(\s*(:?\*|\*:\*)?\s*\)$/.test(t)) return 'unrestricted Bash is not allowed; list exact commands like Bash(git status:*)';
  return null;
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

  let defaultAllowedTools = [...DEFAULT_ALLOWED_TOOLS];
  if (raw.defaultAllowedTools !== undefined) {
    if (!Array.isArray(raw.defaultAllowedTools) || raw.defaultAllowedTools.length === 0) errors.push('defaultAllowedTools must be a non-empty array');
    else {
      for (const t of raw.defaultAllowedTools) { const e = toolError(t); if (e) errors.push(`defaultAllowedTools: ${JSON.stringify(t)}: ${e}`); }
      defaultAllowedTools = [...raw.defaultAllowedTools];
    }
  }

  const folders = {};
  if (!raw.folders || typeof raw.folders !== 'object' || Array.isArray(raw.folders)) errors.push('folders must be an object of { name: { path, allowedTools? } }');
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
      folders[name] = { path: path.win32.normalize(f.path), allowedTools: tools };
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { sshAlias, localPort, folders, defaultAllowedTools } };
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

/** Arguments for `claude`. The prompt goes on stdin, never in argv. */
export function buildClaudeArgs(allowedTools) {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) throw new Error('allowedTools must be a non-empty array');
  for (const t of allowedTools) { const e = toolError(t); if (e) throw new Error(`bad tool ${JSON.stringify(t)}: ${e}`); }
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'default', '--allowedTools', allowedTools.join(',')];
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
