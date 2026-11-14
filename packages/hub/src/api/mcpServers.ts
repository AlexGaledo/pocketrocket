import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Db } from '../db/db.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import {
  McpServerAddSchema, McpServerPatchSchema, McpStoreError, type McpServerStore,
} from '../services/outsideMcpStore.js';
import { NAME_RE } from '../services/outsideMcp.js';
import { logError } from '../providers/redact.js';

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

export const MCP_SIGN_IN_MESSAGE =
  'Adding or changing a server that runs a command needs a browser signed in with your password; the server token is not enough. Set a password in Settings, sign in, then try again.';

export interface McpCheck {
  ok: boolean;
  /** A fixed word, never the remote's own text: connected | auth-rejected | http-<code> | timeout | unreachable | command-found | command-missing | invalid */
  result: string;
  at: number;
}

/**
 * `/api/mcp-servers/*`: the owner's list and editor for data/mcp-servers.json. Human-only:
 * - Needs the hub token or a signed-in browser. A bot holds neither (its per-turn MCP bearer only opens /mcp),
 *   and a paired phone or the PC runner is refused by the guard's allowlists.
 * - Adding or changing a command (stdio) server executes a program with the owner's keys, so it also needs a
 *   signed-in browser session, the same bar as the run_on_pc approval (SIGN_IN_TOOLS). Url servers, and
 *   deleting any server, take the hub token.
 * - Tokens and env values are write-only: listings show whether a token is set and the env variable names.
 *
 *   GET    /api/mcp-servers               -> { servers: McpServerView[] }
 *   POST   /api/mcp-servers               add (body: name + url [+ token] | command [+ args, env]; rooms/bots, approve, readTools, needs)
 *   PATCH  /api/mcp-servers/:name         change; token null clears, env value null removes a variable
 *   DELETE /api/mcp-servers/:name
 *   POST   /api/mcp-servers/:name/check   url: one initialize call (5 s); command: does the program exist. Never spawns anything.
 *
 * Servers are mounted per turn by the provider, so there is no long-lived connection to restart: a change
 * applies on the next turn and `check` is the status probe.
 */
export function createMcpServersApi(deps: {
  store: McpServerStore;
  db: Db;
  fetch?: typeof fetch;
  /** Tests: where `which` looks. */
  pathEnv?: () => string;
}) {
  const { store, db } = deps;
  const doFetch = deps.fetch ?? fetch;
  const checks = new Map<string, McpCheck>();

  const hasCommand = (cmd: string): boolean => {
    if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
    const dirs = (deps.pathEnv?.() ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
    return dirs.some((d) => exts.some((x) => fs.existsSync(path.join(d, cmd + x))));
  };

  async function check(name: string): Promise<McpCheck> {
    const raw = store.rawEntry(name);
    if (!raw) throw new McpStoreError(404, 'No server named "' + name + '"');
    const at = Date.now();
    let out: McpCheck;
    if (raw.command !== undefined) {
      const found = typeof raw.command === 'string' && hasCommand(raw.command);
      out = { ok: found, result: found ? 'command-found' : 'command-missing', at };
    } else if (typeof raw.url === 'string') {
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        };
        if (typeof raw.token === 'string' && raw.token) headers.authorization = 'Bearer ' + raw.token;
        const r = await doFetch(raw.url, {
          method: 'POST',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pocketrocket-check', version: '1' } },
          }),
        });
        void r.body?.cancel().catch(() => undefined);
        out = r.ok
          ? { ok: true, result: 'connected', at }
          : { ok: false, result: r.status === 401 || r.status === 403 ? 'auth-rejected' : 'http-' + r.status, at };
      } catch (e) {
        out = { ok: false, result: (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'timeout' : 'unreachable', at };
      }
    } else {
      out = { ok: false, result: 'invalid', at };
    }
    checks.set(name, out);
    return out;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/mcp-servers' && !url.pathname.startsWith('/api/mcp-servers/')) return false;
    const method = req.method ?? 'GET';
    const principal = principalOf(req);
    const actor = actorOf(req);
    if (!principal || principal.kind !== 'hub' || !actor) return send(res, 403, { error: 'Not available from a paired device' });
    const parts = url.pathname.replace(/^\/api\/mcp-servers\/?/, '').split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const name = parts[0];
    if (name !== undefined && !NAME_RE.test(name)) return send(res, 404, { error: 'No such server' });
    const signedIn = !!principal.sessionId;
    const audit = (action: string, target: string) => recordAudit(db, actor, action, target, null);

    try {
      if (method === 'GET' && parts.length === 0) {
        const servers = store.list().map((s) => ({ ...s, lastCheck: checks.get(s.name) ?? null }));
        return send(res, 200, { servers });
      }
      if (method === 'POST' && parts.length === 0) {
        const body = await json(req, res);
        if (body === undefined) return true;
        const parsed = McpServerAddSchema.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: issues(parsed.error) });
        if (parsed.data.command !== undefined && !signedIn) return send(res, 403, { error: MCP_SIGN_IN_MESSAGE, signInRequired: true });
        const view = store.add(parsed.data);
        audit('mcp_server.added', view.name);
        return send(res, 201, view);
      }
      if (method === 'PATCH' && parts.length === 1) {
        const body = await json(req, res);
        if (body === undefined) return true;
        const parsed = McpServerPatchSchema.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: issues(parsed.error) });
        const cur = store.rawEntry(name);
        if (!cur) return send(res, 404, { error: 'No server named "' + name + '"' });
        // Also when the stored entry is a command server and the patch is only `approve` or `bots`: those widen who
        // may run the program, or drop its approval card.
        if (cur.command !== undefined && !signedIn) return send(res, 403, { error: MCP_SIGN_IN_MESSAGE, signInRequired: true });
        const view = store.patch(name, parsed.data);
        audit('mcp_server.changed', name);
        checks.delete(name);
        return send(res, 200, view);
      }
      if (method === 'DELETE' && parts.length === 1) {
        store.remove(name);
        audit('mcp_server.removed', name);
        checks.delete(name);
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && parts.length === 2 && parts[1] === 'check') {
        return send(res, 200, await check(name));
      }
      return send(res, 404, { error: 'No such route' });
    } catch (e) {
      if (e instanceof McpStoreError) return send(res, e.status, { error: e.message });
      logError('[api/mcp-servers]', e);
      return send(res, 500, { error: 'Could not update mcp-servers.json' });
    }
  };
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  e.issues.map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ');

/** The parsed JSON body, or undefined after answering 4xx. */
async function json(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const buf = await readBody(req);
  if (buf === null) { send(res, 413, { error: 'Request body too large (max 1 MB)' }); return undefined; }
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { send(res, 400, { error: 'Invalid JSON' }); return undefined; }
}
