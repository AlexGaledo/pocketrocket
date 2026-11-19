import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { killTree, run, spawnTarget } from '../codex.js';

/**
 * The ACP client side (spec 01 §3, P2-1a): one agent process per turn, spoken to over stdio with newline-delimited
 * JSON-RPC through `@agentclientprotocol/sdk`. The hub advertises no `fs/*` or `terminal/*` client capability, so the
 * agent uses its own file and shell tools and asks through `session/request_permission` (P2-5 may change that).
 */

export interface AcpHandlers {
  onUpdate(n: SessionNotification): void;
  onPermission(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

export interface AcpProcess {
  conn: ClientConnection;
  child: ChildProcess;
  /** The agent's stderr so far (the last 8 KB). Never posted unredacted. */
  stderr(): string;
  /** Resolves with the exit code once the process is gone (null after a spawn error or a signal). */
  exited: Promise<number | null>;
  /** Set when the process could not start at all. */
  spawnError(): string | null;
  /** Closes the connection and tree-kills the process. Safe to call twice. */
  stop(): void;
}

/**
 * Starts `exe args` and opens an ACP client connection on its stdio. Throws only when spawn itself throws; a missing
 * binary (ENOENT) arrives later as `spawnError()` and `exited`.
 */
export function startAcp(exe: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, h: AcpHandlers): AcpProcess {
  const { command, argv } = spawnTarget(exe, args);
  let spawnError: string | null = null;
  const child: ChildProcess = spawn(command, argv, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => {
    stderr = (stderr + d).slice(-8192);
  });
  child.stdin?.on('error', () => undefined); // the agent may exit before reading everything
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      spawnError ??= String(e.message);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });

  const app = client({ name: 'pocketrocket' })
    .onNotification(methods.client.session.update, ({ params }) => h.onUpdate(params))
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) => h.onPermission(params, signal));
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  const conn = app.connect(stream);
  // When the agent goes away, pending requests fail at once instead of hanging the turn.
  void exited.then(() => conn.close(new Error('the agent process exited')));

  let stopped = false;
  return {
    conn,
    child,
    stderr: () => stderr,
    exited,
    spawnError: () => spawnError,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        conn.close();
      } catch {
        /* already closed */
      }
      killTree(child);
    },
  };
}

/** Rejects with `what timed out` after `ms`, so a silent agent cannot hold a turn slot forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(what + ' did not answer within ' + Math.round(ms / 1000) + 's')), ms);
    }),
  ]);
}

/**
 * `<override env var>` wins, otherwise the first `where`/`which` hit. On Windows only the spawnable kinds count
 * (`.exe` first, then `.cmd`/`.bat`, which `spawnTarget` routes through cmd.exe itself, never `shell: true`); a
 * `.ps1` or extensionless npm shim is skipped.
 */
export async function findExe(name: string, overrideVar: string, timeoutMs = 3000): Promise<string | null> {
  const override = process.env[overrideVar];
  if (override) return override;
  const win = process.platform === 'win32';
  const r = await run(win ? 'where' : 'which', [name], timeoutMs);
  const hits = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && fs.existsSync(l));
  if (!win) return hits[0] ?? null;
  const rank = (p: string) => (/\.exe$/i.test(p) ? 0 : /\.cmd$/i.test(p) ? 1 : /\.bat$/i.test(p) ? 2 : 9);
  const spawnable = hits.filter((p) => rank(p) < 9).sort((a, b) => rank(a) - rank(b));
  return spawnable[0] ?? null;
}

/**
 * A stdio MCP server that forwards each JSON-RPC line to the hub's `/mcp` with the turn's bearer, for agents that do
 * not take HTTP MCP servers. The hub's endpoint is stateless and answers in plain JSON (`mcp/httpServer.ts`), so a
 * line in is one POST and at most one line out. One line, single quotes only, run as `node -e`: the hub ships as a
 * single bundle, so there is no separate script file to point at.
 */
export const MCP_STDIO_BRIDGE =
  "const u=process.env.PR_MCP_URL,k=process.env.PR_MCP_TOKEN;let b='',q=Promise.resolve();" +
  "const out=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');" +
  "async function send(l){let id=null;try{id=JSON.parse(l).id??null}catch{}" +
  "try{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+k},body:l});" +
  "const t=await r.text();if(!r.ok&&r.status!==202)throw new Error('hub answered HTTP '+r.status);if(r.status===202||!t.trim())return;out(JSON.parse(t))}" +
  "catch(e){if(id!==null)out({jsonrpc:'2.0',id,error:{code:-32603,message:String(e&&e.message||e)}})}}" +
  "process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(l)q=q.then(()=>send(l))}});" +
  "process.stdin.on('end',()=>q.then(()=>process.exit(0)));";

/**
 * The hub's tools as the ACP `mcpServers` entry for this turn: HTTP with the per-turn bearer when the agent says it
 * takes HTTP servers (`mcpCapabilities.http`), otherwise the stdio bridge above, run by this same Node.
 */
export function hubMcpServer(init: Pick<InitializeResponse, 'agentCapabilities'>, mcp: { url: string; token: string }): McpServer {
  if (init.agentCapabilities?.mcpCapabilities?.http) {
    return { type: 'http', name: 'pocketrocket', url: mcp.url, headers: [{ name: 'Authorization', value: 'Bearer ' + mcp.token }] };
  }
  return {
    name: 'pocketrocket',
    command: process.execPath,
    args: ['-e', MCP_STDIO_BRIDGE],
    env: [
      { name: 'PR_MCP_URL', value: mcp.url },
      { name: 'PR_MCP_TOKEN', value: mcp.token },
    ],
  };
}
