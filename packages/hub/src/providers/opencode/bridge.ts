import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { HOST } from '../../config.js';

/**
 * ## Why this exists (the per-turn MCP token problem)
 *
 * The hub's MCP endpoint authenticates with a token that lives and dies with a single turn
 * (`TurnRegistry.registerTurn`, see `mcp/httpServer.ts`). OpenCode, however, reads its MCP config once at
 * server start (`OPENCODE_CONFIG_CONTENT`) and — verified against opencode 1.17.6 — opens exactly one
 * long-lived MCP connection per configured server, with static headers and **no session identity on any
 * request** (captured headers: accept, authorization, content-type, mcp-protocol-version, user-agent).
 * There is no per-session or per-message MCP config, so a per-turn bearer token cannot be handed to it.
 *
 * So this loopback bridge is the stable endpoint OpenCode is configured with: one random token for the life
 * of the `opencode serve` child. Every request is forwarded to the hub's `/mcp` with the bearer token of the
 * turn it belongs to. A turn registers itself under its OpenCode session id; a `tools/call` is attributed to
 * the session that currently has that MCP tool in flight (the tool part goes pending/running just before the
 * MCP request arrives), or to the single live turn when there is only one. When neither pins it down the call
 * is refused rather than guessed — see `routeToken`. Handshake and `tools/list` traffic can go to any live
 * turn, since every turn exposes the same hub tools.
 */

export interface BridgeRoute {
  token: string;
  startedAt: number;
  /** MCP tool names (`pocketrocket_*`) currently in flight for this session. */
  pending: Set<string>;
}

export type RouteResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'none' | 'ambiguous' };

/**
 * Pick the turn token a JSON-RPC message belongs to. Exported for tests.
 *
 * A `tools/call` that cannot be pinned to exactly one live turn is **rejected**, not guessed
 * (audit 2026-09-09, B12). The old fallback picked the most recently started turn, so with two concurrent
 * turns waiting on the same tool name, bot A's call could execute as bot B: its budget, its room, its
 * authority to edit bots. Rejecting costs one failed tool call; guessing crosses a trust boundary.
 *
 * Handshake and `tools/list` traffic still take any live turn — every turn exposes the same tool list, and
 * those calls neither act nor spend.
 */
export function routeToken(routes: Map<string, BridgeRoute>, method: string | undefined, toolName?: string): RouteResult {
  const live = [...routes.values()];
  if (!live.length) return { ok: false, reason: 'none' };
  if (live.length === 1) return { ok: true, token: live[0].token };
  if (method === 'tools/call') {
    if (!toolName) return { ok: false, reason: 'ambiguous' };
    const owner = live.filter((r) => r.pending.has(toolName));
    if (owner.length === 1) return { ok: true, token: owner[0].token };
    return { ok: false, reason: 'ambiguous' };
  }
  return { ok: true, token: live.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)).token };
}

const FORWARD_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];

export class McpBridge {
  /** Static bearer the OpenCode MCP config carries; only this process knows it. */
  readonly token = randomBytes(24).toString('base64url');
  private routes = new Map<string, BridgeRoute>();
  private server: http.Server | null = null;
  private url: string | null = null;

  constructor(private target: string) {}

  /** Starts on a free loopback port and returns the URL to put in `mcp.pocketrocket.url`. */
  async start(): Promise<string> {
    if (this.url) return this.url;
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, HOST, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.url = 'http://' + HOST + ':' + port + '/mcp';
    return this.url;
  }

  async stop(): Promise<void> {
    this.routes.clear();
    const server = this.server;
    this.server = null;
    this.url = null;
    if (!server) return;
    // `server.close()` stops accepting but then waits for every open connection, and the whole
    // point of this bridge is that `opencode serve` holds one open for the life of the server.
    // Without closeAllConnections() the await never settles and shutdown hangs until the
    // 8s force-exit in index.ts, orphaning the serve child. (Found in P4 QA.)
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  register(sessionID: string, turnToken: string) {
    this.routes.set(sessionID, { token: turnToken, startedAt: Date.now(), pending: new Set() });
  }
  unregister(sessionID: string) {
    this.routes.delete(sessionID);
  }
  setPending(sessionID: string, toolName: string, pending: boolean) {
    const r = this.routes.get(sessionID);
    if (!r) return;
    if (pending) r.pending.add(toolName);
    else r.pending.delete(toolName);
  }
  get size() {
    return this.routes.size;
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? '').trim());
    if (!auth || auth[1] !== this.token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'bad bridge token' }, id: null }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    let method: string | undefined;
    let toolName: string | undefined;
    if (raw.length) {
      try {
        const body = JSON.parse(raw.toString('utf8')) as { method?: string; params?: { name?: string } };
        method = body.method;
        toolName = body.params?.name ? 'pocketrocket_' + body.params.name : undefined;
      } catch {
        /* forward it anyway and let the hub answer */
      }
    }
    const route = routeToken(this.routes, method, toolName);
    if (!route.ok) {
      const ambiguous = route.reason === 'ambiguous';
      res.writeHead(ambiguous ? 409 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: ambiguous
          ? { code: -32004, message: 'PocketRocket could not tell which bot this tool call belongs to (several turns are running). Retry it on its own.' }
          : { code: -32002, message: 'no active PocketRocket turn' },
        id: null,
      }));
      return;
    }
    const headers: Record<string, string> = { authorization: 'Bearer ' + route.token };
    for (const h of FORWARD_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    try {
      const upstream = await fetch(this.target, {
        method: req.method ?? 'POST',
        headers,
        body: raw.length ? raw : undefined,
      });
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') out[k] = v;
      });
      res.writeHead(upstream.status, out);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32003, message: String((e as Error).message ?? e) }, id: null }));
    }
  }
}
