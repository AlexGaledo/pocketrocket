import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { renameOver, restrictFile } from '../config.js';
import { addSecret } from '../providers/redact.js';
import { ENV_KEY_RE, NAME_RE, OUTSIDE_MCP_PATH, RESERVED, stdioCommand } from './outsideMcp.js';

/**
 * The owner's writer for <DATA_DIR>/mcp-servers.json (see outsideMcp.ts for the format and the rules the
 * turn-time loader enforces). The REST API (api/mcpServers.ts) is the only caller; no bot tool reaches it.
 *
 * Works on the raw JSON object, not on parsed entries: an entry that is hand-edited, malformed or carries
 * keys this code does not know is written back untouched unless it is the one being changed. A file that does
 * not parse is never overwritten. Secrets stay in the file as the loader reads them (plain, 0600); the
 * IntegrationVault cannot hold them without breaking hand-edited files. Values never leave through `list`.
 */

export class McpStoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const TEXT = z.string().min(1).max(100).refine((s) => s === s.trim() && !/[\0\r\n]/.test(s), 'no surrounding space or control characters');
const urlRule = z.string().max(2048).superRefine((v, ctx) => {
  let u: URL;
  try { u = new URL(v); } catch { ctx.addIssue({ code: 'custom', message: 'not a valid URL' }); return; }
  if (u.username || u.password) { ctx.addIssue({ code: 'custom', message: 'no credentials in the url; use token' }); return; }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  // The loader's rule: a key only ever travels over TLS, or to this machine.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    ctx.addIssue({ code: 'custom', message: 'must be https, or http to 127.0.0.1 / localhost' });
  }
});
const commandRule = z.string().max(1024).refine((v) => stdioCommand(v) !== null, 'must be npx, node or an absolute path');
const argsRule = z.array(z.string().max(2000).refine((s) => !s.includes('\0'), 'no NUL')).max(64);
const envKeyRule = z.string().max(128).regex(ENV_KEY_RE, 'not an environment variable name');
const envValueRule = z.string().max(8192).refine((s) => !s.includes('\0'), 'no NUL');

const shared = {
  rooms: z.array(TEXT).max(50).optional(),
  bots: z.array(TEXT).max(50).optional(),
  approve: z.enum(['every-call', 'writes', 'none']).optional(),
  readTools: z.array(z.string().regex(LABEL)).max(100).optional(),
  needs: z.array(z.string().regex(LABEL)).max(50).optional(),
};

const nameRule = z.string().regex(NAME_RE, 'lowercase letters, digits, - and single _, up to 32 characters').refine((n) => !RESERVED.has(n), 'that name is reserved');

/** POST body. Exactly one of `url` (remote) or `command` (stdio). */
export const McpServerAddSchema = z.object({
  name: nameRule,
  url: urlRule.optional(),
  token: z.string().min(1).max(4096).optional(),
  command: commandRule.optional(),
  args: argsRule.optional(),
  env: z.record(envKeyRule, envValueRule).optional(),
  ...shared,
}).strict().superRefine((v, ctx) => {
  if ((v.url === undefined) === (v.command === undefined)) ctx.addIssue({ code: 'custom', message: 'give either url or command, not both' });
  if (v.url !== undefined && (v.args !== undefined || v.env !== undefined)) ctx.addIssue({ code: 'custom', message: 'args and env belong to a command server' });
  if (v.command !== undefined && v.token !== undefined) ctx.addIssue({ code: 'custom', message: 'token belongs to a url server; put keys in env' });
  if (!v.rooms?.length && !v.bots?.length) ctx.addIssue({ code: 'custom', message: 'name at least one room or bot' });
  if (Object.keys(v.env ?? {}).length > 32) ctx.addIssue({ code: 'custom', message: 'env: at most 32 variables' });
});

/** PATCH body. `token: null` clears the token; an `env` value of null removes that variable; absent keeps. */
export const McpServerPatchSchema = z.object({
  url: urlRule.optional(),
  token: z.string().min(1).max(4096).nullable().optional(),
  command: commandRule.optional(),
  args: argsRule.optional(),
  env: z.record(envKeyRule, envValueRule.nullable()).optional(),
  ...shared,
}).strict();
export type McpServerAdd = z.infer<typeof McpServerAddSchema>;
export type McpServerPatch = z.infer<typeof McpServerPatchSchema>;

const MASK = '***';
const SECRETISH = /key|token|secret|passw|auth|bearer|credential/i;
/** Args are shown so they can be edited, but a value that looks like a credential never is. */
export function maskArgs(args: readonly string[]): { args: string[]; masked: boolean } {
  let masked = false;
  const out = args.map((a, i) => {
    const eq = a.indexOf('=');
    if (a.startsWith('-') && eq > 0 && SECRETISH.test(a.slice(0, eq))) { masked = true; return a.slice(0, eq + 1) + MASK; }
    if (i > 0 && args[i - 1].startsWith('-') && !args[i - 1].includes('=') && SECRETISH.test(args[i - 1])) { masked = true; return MASK; }
    if (/^bearer\s+\S{8,}/i.test(a) || /^(sk|pk|ghp|xox[a-z])[-_][A-Za-z0-9_-]{12,}/.test(a)) { masked = true; return MASK; }
    return a;
  });
  return { args: out, masked };
}

export interface McpServerView {
  name: string;
  kind: 'http' | 'stdio' | 'invalid';
  status: 'configured' | 'invalid';
  problems: string[];
  url?: string;
  urlHasQuery?: boolean;
  tokenSet?: boolean;
  command?: string;
  args?: string[];
  argsMasked?: boolean;
  /** Names only. Values are never returned. */
  envKeys?: string[];
  rooms: string[];
  bots: string[];
  approve: 'every-call' | 'writes' | 'none';
  readTools: string[];
  needs: string[];
}

type Raw = Record<string, unknown>;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const safeOrigin = (u: string): string | null => { try { return new URL(u).origin; } catch { return null; } };
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** What is wrong with a stored entry, by the loader's own rules. Empty: the loader will mount it. */
export function entryProblems(v: unknown): string[] {
  if (!isObj(v)) return ['not an object'];
  const p: string[] = [];
  for (const k of ['rooms', 'bots', 'readTools', 'needs', 'args']) {
    if (v[k] !== undefined && (!Array.isArray(v[k]) || !(v[k] as unknown[]).every((x) => typeof x === 'string'))) p.push(k + ' must be a list of strings');
  }
  if (!strs(v.rooms).length && !strs(v.bots).length) p.push('no rooms or bots: nothing is mounted');
  if (v.command !== undefined) {
    if (v.url !== undefined) p.push('both url and command');
    if (stdioCommand(v.command) === null) p.push('command must be npx, node or an absolute path');
    const env = v.env ?? {};
    if (!isObj(env) || !Object.entries(env).every(([k, x]) => ENV_KEY_RE.test(k) && typeof x === 'string')) p.push('env must map variable names to strings');
  } else if (typeof v.url === 'string') {
    if (!urlRule.safeParse(v.url).success) p.push('url must be https, or http to 127.0.0.1 / localhost');
  } else p.push('needs a url or a command');
  return p;
}

export function viewOf(name: string, v: unknown): McpServerView {
  const problems = [...(NAME_RE.test(name) && !RESERVED.has(name) ? [] : ['name is not usable']), ...entryProblems(v)];
  const r: Raw = isObj(v) ? v : {};
  const stdio = r.command !== undefined;
  const approve: McpServerView['approve'] =
    r.approve === 'writes' || r.approve === 'none' ? r.approve : r.approve === undefined ? (stdio ? 'every-call' : 'none') : 'every-call';
  const base = {
    name,
    status: problems.length ? ('invalid' as const) : ('configured' as const),
    problems,
    rooms: strs(r.rooms),
    bots: strs(r.bots),
    approve,
    readTools: strs(r.readTools),
    needs: strs(r.needs),
  };
  if (stdio) {
    const m = maskArgs(strs(r.args));
    return {
      ...base, kind: 'stdio', command: typeof r.command === 'string' ? r.command : '', args: m.args, argsMasked: m.masked,
      envKeys: isObj(r.env) ? Object.keys(r.env) : [],
    };
  }
  if (typeof r.url === 'string') {
    let shown = '';
    let query = false;
    try { const u = new URL(r.url); shown = u.origin + u.pathname; query = !!u.search || !!u.hash; } catch { shown = ''; }
    return { ...base, kind: 'http', url: shown, urlHasQuery: query, tokenSet: typeof r.token === 'string' && !!r.token };
  }
  return { ...base, kind: 'invalid' };
}

export class McpServerStore {
  constructor(private file: string = OUTSIDE_MCP_PATH) {}

  private read(): Raw {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return {}; }
    if (!text.trim()) return {};
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new McpStoreError(409, 'mcp-servers.json is not valid JSON; fix it by hand before using this API'); }
    if (!isObj(raw)) throw new McpStoreError(409, 'mcp-servers.json is not a JSON object; fix it by hand before using this API');
    return raw;
  }

  /** Temp file beside the target, 0600, then rename: a crash leaves the old file or the new one, never half. */
  private write(all: Raw): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      restrictFile(tmp);
      renameOver(tmp, this.file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw e;
    }
    restrictFile(this.file);
    // Keys written here must be scrubbed from output at once, not at the next turn.
    for (const v of Object.values(all)) {
      if (!isObj(v)) continue;
      if (typeof v.token === 'string') addSecret(v.token);
      if (isObj(v.env)) for (const x of Object.values(v.env)) if (typeof x === 'string') addSecret(x);
    }
  }

  list(): McpServerView[] {
    return Object.entries(this.read()).map(([name, v]) => viewOf(name, v));
  }

  /** The raw entry, for the check endpoint only. Never serialised to a client. */
  rawEntry(name: string): Raw | null {
    const all = this.read();
    return Object.hasOwn(all, name) && isObj(all[name]) ? all[name] : null;
  }

  add(input: McpServerAdd): McpServerView {
    const all = this.read();
    if (Object.hasOwn(all, input.name)) throw new McpStoreError(409, 'A server named "' + input.name + '" already exists');
    const { name, ...entry } = input;
    const clean: Raw = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
    // The token is bound to the origin it was saved for (outsideMcp.ts refuses to send it anywhere else).
    if (typeof clean.token === 'string' && typeof clean.url === 'string') clean.tokenOrigin = new URL(clean.url).origin;
    all[name] = clean;
    this.write(all);
    return viewOf(name, clean);
  }

  patch(name: string, input: McpServerPatch): McpServerView {
    const all = this.read();
    const cur = Object.hasOwn(all, name) ? all[name] : undefined;
    if (!isObj(cur)) throw new McpStoreError(404, 'No server named "' + name + '"');
    const stdio = cur.command !== undefined;
    if (stdio && (input.url !== undefined || input.token !== undefined)) throw new McpStoreError(400, 'url and token belong to a url server');
    if (!stdio && (input.command !== undefined || input.args !== undefined || input.env !== undefined)) throw new McpStoreError(400, 'command, args and env belong to a command server');
    if (input.args?.some((a) => a.includes(MASK))) throw new McpStoreError(400, 'args holds a masked value (***); send the real arguments');
    const next: Raw = { ...cur };
    // A stored token must not follow a new url to another origin: the caller sends a new token, or clears it.
    if (!stdio && input.url !== undefined && input.token === undefined && typeof cur.token === 'string' && cur.token) {
      const was = typeof cur.tokenOrigin === 'string' ? cur.tokenOrigin : typeof cur.url === 'string' ? safeOrigin(cur.url) : null;
      if (was !== new URL(input.url).origin) {
        throw new McpStoreError(409, 'This server has a stored token. Changing its url to another origin needs a new token in the same request, or token: null to clear it.');
      }
    }
    for (const k of ['url', 'command', 'args', 'rooms', 'bots', 'approve', 'readTools', 'needs'] as const) {
      if (input[k] !== undefined) next[k] = input[k];
    }
    if (input.token === null) { delete next.token; delete next.tokenOrigin; }
    else if (input.token !== undefined) next.token = input.token;
    if (typeof next.token === 'string' && next.token && typeof next.url === 'string' && (input.token !== undefined || next.tokenOrigin === undefined)) {
      next.tokenOrigin = new URL(next.url).origin;
    }
    if (input.env) {
      const env: Raw = isObj(cur.env) ? { ...cur.env } : {};
      for (const [k, v] of Object.entries(input.env)) { if (v === null) delete env[k]; else env[k] = v; }
      if (Object.keys(env).length > 32) throw new McpStoreError(400, 'env: at most 32 variables');
      next.env = env;
    }
    if (!strs(next.rooms).length && !strs(next.bots).length) throw new McpStoreError(400, 'name at least one room or bot');
    all[name] = next;
    this.write(all);
    return viewOf(name, next);
  }

  remove(name: string): void {
    const all = this.read();
    if (!Object.hasOwn(all, name)) throw new McpStoreError(404, 'No server named "' + name + '"');
    delete all[name];
    this.write(all);
  }
}
