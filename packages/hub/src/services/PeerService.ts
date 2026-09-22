import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WORKSPACE_DIR } from '../config.js';
import { isInside } from '../permissions/pathRules.js';

/**
 * Linked hubs (docs/proposals/linked-hubs.md): a second hub, normally the other end of the desktop app's SSH
 * tunnel, whose bots may look at this machine, and whose machine this hub's bots may look at.
 *
 * Two independent halves, both off unless configured:
 *  - **inbound** (`acceptToken`): this hub answers `/api/peer/*` for a caller presenting that token. The
 *    token is not the hub token and opens nothing else. Reads are confined to the workspace plus
 *    `readRoots`; running commands is a separate switch.
 *  - **outbound** (`url` + `token`): this hub's bots get `peer_*` tools that call the other hub.
 *
 * The machine that owns the files enforces the limits. The caller is never trusted to police itself.
 */
export interface PeerConfig {
  name: string;
  url: string | null;
  token: string | null;
  acceptToken: string | null;
  readRoots: string[];
  allowRun: boolean;
}

const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

export function parsePeerEnv(env: NodeJS.ProcessEnv = process.env): PeerConfig {
  const url = (env.POCKETROCKET_PEER_URL ?? '').trim().replace(/\/+$/, '') || null;
  return {
    name: (env.POCKETROCKET_PEER_NAME ?? '').trim() || 'peer',
    url,
    token: (env.POCKETROCKET_PEER_TOKEN ?? '').trim() || null,
    acceptToken: (env.POCKETROCKET_PEER_ACCEPT_TOKEN ?? '').trim() || null,
    readRoots: (env.POCKETROCKET_PEER_READ_ROOTS ?? '').split(path.delimiter).map((s) => s.trim()).filter(Boolean),
    allowRun: truthy(env.POCKETROCKET_PEER_RUN),
  };
}

export class PeerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_DIR_ENTRIES = 500;
export const MAX_RUN_OUTPUT = 64 * 1024;
export const RUN_TIMEOUT_MS = 120_000;

export interface DirEntry { name: string; type: 'file' | 'dir' | 'other'; size: number | null }
export interface RunResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Inbound half: what a peer may do on this machine. Pure functions of the config, so tests need no server. */
export class PeerHost {
  constructor(private cfg: PeerConfig, private workspace: string = WORKSPACE_DIR) {}

  get enabled(): boolean {
    return !!this.cfg.acceptToken;
  }
  get acceptToken(): string | null {
    return this.cfg.acceptToken;
  }
  get roots(): string[] {
    return [this.workspace, ...this.cfg.readRoots];
  }

  info() {
    return { workspace: this.workspace, readRoots: this.roots, run: this.cfg.allowRun, platform: process.platform };
  }

  /** Relative paths resolve against the workspace; the result must sit inside a readable root (symlinks resolved). */
  private resolve(p: string): string {
    const raw = (p ?? '').trim() || '.';
    const abs = path.isAbsolute(raw) ? raw : path.resolve(this.workspace, raw);
    if (!isInside(abs, this.roots, this.workspace)) {
      throw new PeerError(403, 'Outside the folders this machine shares with its peer: ' + raw);
    }
    return abs;
  }

  listDir(p: string): { path: string; entries: DirEntry[]; truncated: boolean } {
    const abs = this.resolve(p);
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      throw new PeerError(404, 'Cannot list ' + p + ': ' + (e as NodeJS.ErrnoException).code);
    }
    const entries = names.slice(0, MAX_DIR_ENTRIES).map((d): DirEntry => {
      const type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
      let size: number | null = null;
      if (type === 'file') {
        try { size = fs.statSync(path.join(abs, d.name)).size; } catch { /* raced away */ }
      }
      return { name: d.name, type, size };
    });
    return { path: abs, entries, truncated: names.length > MAX_DIR_ENTRIES };
  }

  readFile(p: string, offset = 0, limit = MAX_READ_BYTES): { path: string; size: number; offset: number; text: string; truncated: boolean } {
    const abs = this.resolve(p);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch (e) {
      throw new PeerError(404, 'Cannot read ' + p + ': ' + (e as NodeJS.ErrnoException).code);
    }
    if (!st.isFile()) throw new PeerError(400, 'Not a file: ' + p);
    const start = Math.max(0, Math.floor(offset));
    const len = Math.max(0, Math.min(Math.floor(limit), MAX_READ_BYTES, st.size - start));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(abs, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.includes(0)) throw new PeerError(415, 'Binary file; peers read text only: ' + p);
    return { path: abs, size: st.size, offset: start, text: buf.toString('utf8'), truncated: start + len < st.size };
  }

  run(command: string, cwd?: string): Promise<RunResult> {
    if (!this.cfg.allowRun) throw new PeerError(403, 'This machine does not let its peer run commands (POCKETROCKET_PEER_RUN is off)');
    if (!command.trim()) throw new PeerError(400, 'Empty command');
    const dir = this.resolve(cwd ?? '.');
    return new Promise((resolve) => {
      const child = spawn(command, { cwd: dir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const cap = (cur: string, chunk: Buffer) => (cur.length >= MAX_RUN_OUTPUT ? cur : (cur + chunk.toString('utf8')).slice(0, MAX_RUN_OUTPUT));
      child.stdout.on('data', (c: Buffer) => { stdout = cap(stdout, c); });
      child.stderr.on('data', (c: Buffer) => { stderr = cap(stderr, c); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr: stderr + String(e), timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr, timedOut }); });
    });
  }
}

/** Outbound half: calls the other hub's `/api/peer/*`. */
export class PeerClient {
  constructor(private cfg: PeerConfig, private fetchImpl: typeof fetch = fetch) {}

  get enabled(): boolean {
    return !!(this.cfg.url && this.cfg.token);
  }
  get name(): string {
    return this.cfg.name;
  }

  async call<T>(op: 'info' | 'list' | 'read' | 'run', body: Record<string, unknown> = {}): Promise<T> {
    if (!this.enabled) throw new PeerError(503, 'No peer hub is linked');
    let r: Response;
    try {
      r = await this.fetchImpl(this.cfg.url + '/api/peer/' + op, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.cfg.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS + 10_000),
      });
    } catch (e) {
      throw new PeerError(502, 'Peer "' + this.cfg.name + '" is unreachable (' + (e instanceof Error ? e.message : String(e)) + '). Is the link still up?');
    }
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new PeerError(r.status, data.error ?? 'Peer answered HTTP ' + r.status);
    return data as T;
  }
}
