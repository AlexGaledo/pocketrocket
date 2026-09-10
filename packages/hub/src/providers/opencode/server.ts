import fs from 'node:fs';
import net from 'node:net';
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { BYPASS_PERMISSIONS, HOST, WORKSPACE_DIR } from '../../config.js';
import { needsShell, resolveOpencodeExe, shellCommand } from './cli.js';
import { McpBridge } from './bridge.js';
import { childEnv } from '../env.js';
import { addSecret, redact } from '../redact.js';
import type { OcEvent } from './events.js';

/**
 * The single long-lived `opencode serve` child the hub talks to, plus its SSE subscription and the MCP
 * bridge. Started lazily on the first turn (so the MCP handshake happens while a turn is live and the hub's
 * tool list is reachable) and killed on `shutdown()`.
 *
 * Verified against opencode 1.17.6: basic auth uses the fixed username `opencode` with
 * `OPENCODE_SERVER_PASSWORD`, config is injected inline through `OPENCODE_CONFIG_CONTENT`, and the server's
 * project directory is the cwd it was started in (`GET /path` -> `directory`).
 */

export const BASIC_USER = 'opencode';

export interface ServerConfigInput {
  mcpUrl: string;
  mcpToken: string;
  /** BYPASS_PERMISSIONS: every permission `allow`, so OpenCode never emits a `permission.asked`. */
  bypass?: boolean;
}

/**
 * The inline config the serve child runs with. Permissions are deliberately mostly `ask`: every ask is
 * routed to the hub's PermissionBroker, which silently allows anything inside the workspace / bot home and
 * only raises an approval card for the rest. Reads and searches stay `allow` (cheap, and OpenCode's own
 * `external_directory` gate still catches anything outside the project).
 */
export function buildConfigContent(input: ServerConfigInput): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      pocketrocket: {
        type: 'remote',
        url: input.mcpUrl,
        headers: { Authorization: 'Bearer ' + input.mcpToken },
        enabled: true,
      },
    },
    permission: {
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      todowrite: 'allow',
      question: 'allow',
      task: 'allow',
      skill: 'allow',
      edit: input.bypass ? 'allow' : 'ask',
      bash: input.bypass ? 'allow' : 'ask',
      webfetch: input.bypass ? 'allow' : 'ask',
      websearch: input.bypass ? 'allow' : 'ask',
      external_directory: input.bypass ? 'allow' : 'ask',
      doom_loop: input.bypass ? 'allow' : 'ask',
    },
    // No AGENTS.md / user instruction files: the bot's identity comes from PromptBuilder alone.
    instructions: [],
    share: 'disabled',
    autoshare: false,
    autoupdate: false,
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, HOST, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Kill the child and everything it spawned (opencode is a `.cmd` shim wrapping a bun runtime on
 * Windows, so killing only the shim leaves the server running). Awaited by `stop()`: the caller
 * may `process.exit()` right after, and a fire-and-forget `taskkill` can lose that race.
 */
function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      try {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        resolve();
      }
    });
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  return Promise.resolve();
}

export interface StartedServer {
  client: OpencodeClient;
  bridge: McpBridge;
  baseUrl: string;
  version?: string;
}

export class OpenCodeServer {
  private starting: Promise<StartedServer> | null = null;
  private started: StartedServer | null = null;
  private child: ChildProcess | null = null;
  private stopEvents: (() => void) | null = null;
  private password = '';
  /** sessionID -> event handler installed by a running turn. */
  private listeners = new Map<string, (ev: OcEvent) => void>();
  private stderr: string[] = [];

  get running() {
    return !!this.started;
  }
  /** The live SDK client, or null when the server is not up. */
  get client(): OpencodeClient | null {
    return this.started?.client ?? null;
  }
  get authHeader() {
    return 'Basic ' + Buffer.from(BASIC_USER + ':' + this.password).toString('base64');
  }

  /** Idempotent; concurrent callers share one boot. `hubMcpUrl` is `TurnContext.mcp.url`. */
  async ensure(hubMcpUrl: string): Promise<StartedServer> {
    if (this.started) return this.started;
    if (!this.starting) {
      this.starting = this.boot(hubMcpUrl).catch((e) => {
        this.starting = null;
        throw e;
      });
    }
    return this.starting;
  }

  private async boot(hubMcpUrl: string): Promise<StartedServer> {
    const bridge = new McpBridge(hubMcpUrl);
    const bridgeUrl = await bridge.start();
    const port = await freePort();
    const exe = resolveOpencodeExe();
    this.password = randomBytes(18).toString('base64url');
    // Allowlisted env only (audit 2026-09-09, B7): OPENCODE_*, the three vendor keys OpenCode itself reads,
    // and nothing else — in particular never POCKETROCKET_TOKEN.
    const env = childEnv('opencode', {
      OPENCODE_SERVER_PASSWORD: this.password,
      OPENCODE_CONFIG_CONTENT: buildConfigContent({ mcpUrl: bridgeUrl, mcpToken: bridge.token, bypass: BYPASS_PERMISSIONS }),
      // Never let the child inherit a stale inline config path from the user's shell.
      OPENCODE_CONFIG: undefined,
    });
    // The inline config carries `Authorization: Bearer <bridge token>`; keep both out of any stderr tail.
    addSecret(this.password);
    addSecret(bridge.token);
    const args = ['serve', '--hostname', HOST, '--port', String(port)];
    // A missing cwd surfaces as a confusing ENOENT on the exe itself; the workspace may not exist yet on a fresh data dir.
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    const shell = needsShell(exe);
    const child = shell
      ? spawn(shellCommand(exe, args), { cwd: WORKSPACE_DIR, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(exe, args, { cwd: WORKSPACE_DIR, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      this.stderr.push(d);
      if (this.stderr.length > 50) this.stderr.shift();
      if (process.env.POCKETROCKET_DEBUG) process.stderr.write('[opencode serve] ' + d);
    });
    child.on('exit', (code) => {
      if (process.env.POCKETROCKET_DEBUG) console.log('[opencode serve] exited', code);
      this.started = null;
      this.starting = null;
      this.child = null;
    });

    const baseUrl = 'http://' + HOST + ':' + port;
    await this.waitReady(baseUrl, child);

    const client = createOpencodeClient({ baseUrl, headers: { Authorization: this.authHeader } });
    const started: StartedServer = { client, bridge, baseUrl };
    this.started = started;
    this.subscribe(client);
    return started;
  }

  /** Polls `GET /path` (cheap, auth'd) until the server answers or the child dies. */
  private async waitReady(baseUrl: string, child: ChildProcess, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error('opencode serve exited with code ' + child.exitCode + (this.stderr.length ? ': ' + redact(this.stderr.join('').slice(-400)) : ''));
      }
      try {
        const r = await fetch(baseUrl + '/path', { headers: { Authorization: this.authHeader } });
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('opencode serve did not become ready within ' + timeoutMs + 'ms');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** One SSE subscription for the whole server, demultiplexed by `properties.sessionID`. */
  private subscribe(client: OpencodeClient) {
    let stopped = false;
    this.stopEvents = () => {
      stopped = true;
    };
    void (async () => {
      while (!stopped && this.started) {
        try {
          const res = await client.event.subscribe({ headers: { Authorization: this.authHeader } });
          for await (const raw of res.stream as AsyncIterable<unknown>) {
            if (stopped) return;
            const ev = raw as OcEvent;
            const sessionID = (ev?.properties as { sessionID?: string } | undefined)?.sessionID;
            if (!sessionID) continue;
            this.listeners.get(sessionID)?.(ev);
          }
        } catch (e) {
          if (process.env.POCKETROCKET_DEBUG) console.log('[opencode events]', String((e as Error).message ?? e));
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 500));
      }
    })();
  }

  listen(sessionID: string, handler: (ev: OcEvent) => void) {
    this.listeners.set(sessionID, handler);
  }
  unlisten(sessionID: string) {
    this.listeners.delete(sessionID);
  }

  async stop(): Promise<void> {
    this.stopEvents?.();
    this.stopEvents = null;
    this.listeners.clear();
    const started = this.started;
    this.started = null;
    this.starting = null;
    // Kill the serve child first: it is the thing holding the bridge's MCP connection open, so
    // draining the bridge before it is gone is the slow order (and used to deadlock outright).
    const child = this.child;
    this.child = null;
    if (child) await killTree(child);
    if (started) await started.bridge.stop();
  }
}
