import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Db } from '../db/db.js';
import { addSecret, logError, redact, removeSecret } from '../providers/redact.js';

/**
 * The owner's Windows PC as a job runner. A helper on the PC polls the hub (over the SSH tunnel) with its own
 * token, picks up Claude Code jobs a bot asked for, and only ever sees jobs the owner approved on a card. The
 * PC asks again locally before it runs anything.
 *
 * The hub keeps only a sha256 of the runner token, in `pc-runner.json` (0600). A bot on a bypass hub can read
 * DATA_DIR with Bash, so the file must be useless to it: the hash cannot be presented as the token.
 */

/** A folder name the PC allows. Names only: the PC maps them to real paths, the hub never sees one. */
export const PC_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const MAX_PC_FOLDERS = 50;
export const MAX_PC_PROMPT_BYTES = 8 * 1024;
export const MAX_PC_OUTPUT = 20 * 1024;
/** Jobs waiting for the owner, queued, claimed or running. */
export const MAX_PC_QUEUE = 5;
export const PC_ONLINE_MS = 30_000;
export const PC_EXPIRE_MS = 30 * 60_000;
export const PC_WAIT_MS = 15 * 60_000;
export const PC_OFF_MESSAGE = 'PC runner was turned off';
export const PC_EXPIRED_MESSAGE = "The PC is offline or didn't pick it up";

export type PcJobStatus = 'pending_approval' | 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'refused' | 'expired' | 'cancelled';
const OPEN: readonly PcJobStatus[] = ['pending_approval', 'queued', 'claimed', 'running'];
const TERMINAL = new Set<PcJobStatus>(['done', 'failed', 'refused', 'expired', 'cancelled']);

export interface PcJob {
  id: string;
  botId: string;
  roomId: string;
  folder: string;
  prompt: string;
  status: PcJobStatus;
  result: string | null;
  costUsd: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RunnerFile {
  tokenSha256: string;
  folders: string[];
  createdAt: number;
  lastSeenAt: number | null;
}

export interface PcRunnerOptions {
  db: Db;
  /** `DATA_DIR/pc-runner.json`; tests hand in a temp path. */
  file: string;
  now?: () => number;
  /** A queued job nobody claimed this long expires. Default 30 min. */
  expireMs?: number;
  /** How long run_on_pc waits for a result. Default 15 min. */
  waitMs?: number;
  /** How often a waiting tool re-reads the job. Default 1 s. */
  pollMs?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const toJob = (r: Record<string, unknown>): PcJob => ({
  id: r.id as string,
  botId: r.bot_id as string,
  roomId: r.room_id as string,
  folder: r.folder as string,
  prompt: r.prompt as string,
  status: r.status as PcJobStatus,
  result: (r.result as string | null) ?? null,
  costUsd: (r.cost_usd as number | null) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

export class PcRunnerError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class PcRunner {
  private cfg: RunnerFile | null;
  /** Last heartbeat in this process. Not persisted: online means "heard from it in the last 30 s". */
  private heardAt: number | null = null;
  /** The plain token minted by this process, so a log line or tool output that carries it gets redacted. */
  private liveToken: string | null = null;
  private wakers = new Map<string, Set<() => void>>();
  readonly expireMs: number;
  readonly waitMs: number;
  readonly pollMs: number;

  constructor(private opts: PcRunnerOptions) {
    this.expireMs = opts.expireMs ?? PC_EXPIRE_MS;
    this.waitMs = opts.waitMs ?? PC_WAIT_MS;
    this.pollMs = opts.pollMs ?? 1000;
    this.cfg = this.load();
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private load(): RunnerFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8')) as Partial<RunnerFile>;
      if (typeof raw.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.tokenSha256)) return null;
      return {
        tokenSha256: raw.tokenSha256,
        folders: Array.isArray(raw.folders) ? raw.folders.filter((f): f is string => typeof f === 'string' && PC_FOLDER_RE.test(f)) : [],
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
        lastSeenAt: typeof raw.lastSeenAt === 'number' ? raw.lastSeenAt : null,
      };
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this.cfg) return;
    fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
    const tmp = this.opts.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.opts.file);
    try { fs.chmodSync(this.opts.file, 0o600); } catch { /* Windows: mode bits are advisory */ }
  }

  // ---------- pairing ----------

  isPaired(): boolean {
    return this.cfg !== null;
  }

  status(): { paired: boolean; folders: string[]; lastSeenAt: number | null; online: boolean } {
    const c = this.cfg;
    return {
      paired: !!c,
      folders: c ? [...c.folders] : [],
      lastSeenAt: c ? this.heardAt ?? c.lastSeenAt : null,
      online: this.online(),
    };
  }

  online(): boolean {
    return !!this.cfg && this.heardAt !== null && this.now() - this.heardAt <= PC_ONLINE_MS;
  }

  /** The folders the PC reported last. Empty when unpaired. */
  folders(): string[] {
    return this.cfg ? [...this.cfg.folders] : [];
  }

  /**
   * A fresh 32-byte token, returned once. Replaces any old one at once; jobs the old runner had claimed are
   * cancelled (it can no longer report on them), queued ones wait for the new runner.
   */
  mint(): string {
    const token = randomBytes(32).toString('base64url');
    if (this.liveToken) removeSecret(this.liveToken);
    this.liveToken = token;
    addSecret(token);
    this.cfg = { tokenSha256: sha256(token), folders: [], createdAt: this.now(), lastSeenAt: null };
    this.heardAt = null;
    this.save();
    this.cancelWhere(['claimed', 'running'], 'PC runner was paired again; this job was dropped');
    return token;
  }

  /** The kill switch: forget the token and cancel everything not finished. */
  turnOff(): number {
    this.cfg = null;
    this.heardAt = null;
    if (this.liveToken) removeSecret(this.liveToken);
    this.liveToken = null;
    try { fs.rmSync(this.opts.file, { force: true }); } catch (e) { logError('[pc-runner]', e); }
    return this.cancelWhere(OPEN, PC_OFF_MESSAGE);
  }

  /** Constant-time check of a presented token against the stored hash. */
  authenticate(supplied: string | null): boolean {
    const c = this.cfg;
    if (!c || !supplied) return false;
    const a = Buffer.from(sha256(supplied), 'hex');
    const b = Buffer.from(c.tokenSha256, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  heartbeat(folders: string[]): void {
    const c = this.cfg;
    if (!c) throw new PcRunnerError(403, 'Not paired');
    const t = this.now();
    this.heardAt = t;
    const changed = folders.join('\n') !== c.folders.join('\n');
    // lastSeenAt survives a restart; written when the list changes or at most once a minute, not every beat.
    if (changed || c.lastSeenAt === null || t - c.lastSeenAt >= 60_000) {
      c.folders = [...folders];
      c.lastSeenAt = t;
      this.save();
    }
  }

  // ---------- jobs ----------

  get(id: string): PcJob | undefined {
    const r = this.opts.db.get('SELECT * FROM pc_jobs WHERE id = ?', id);
    return r ? toJob(r) : undefined;
  }

  openCount(): number {
    return Number(this.opts.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM pc_jobs WHERE status IN (' + OPEN.map(() => '?').join(',') + ')', ...OPEN,
    )?.n ?? 0);
  }

  /** A job waiting for the owner's card. Not served until approve() moves it to `queued`. */
  create(j: { botId: string; roomId: string; folder: string; prompt: string }): PcJob {
    if (this.openCount() >= MAX_PC_QUEUE) throw new PcRunnerError(429, 'The PC already has ' + MAX_PC_QUEUE + ' jobs waiting or running. Wait for them to finish.');
    const id = nanoid(12);
    const t = this.now();
    this.opts.db.run(
      'INSERT INTO pc_jobs (id, bot_id, room_id, folder, prompt, status, result, cost_usd, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, j.botId, j.roomId, j.folder, j.prompt, 'pending_approval', null, null, t, t,
    );
    return this.get(id)!;
  }

  private setStatus(id: string, status: PcJobStatus, from: readonly PcJobStatus[], extra: { result?: string | null; costUsd?: number | null } = {}): boolean {
    const r = this.opts.db.run(
      'UPDATE pc_jobs SET status = ?, result = COALESCE(?, result), cost_usd = COALESCE(?, cost_usd), updated_at = ? ' +
        'WHERE id = ? AND status IN (' + from.map(() => '?').join(',') + ')',
      status, extra.result ?? null, extra.costUsd ?? null, this.now(), id, ...from,
    );
    const ok = Number(r.changes) > 0;
    if (ok) this.wake(id);
    return ok;
  }

  /** The owner said yes on the card. False when the job was cancelled meanwhile (kill switch, abort). */
  approve(id: string): boolean {
    return this.setStatus(id, 'queued', ['pending_approval']);
  }

  cancel(id: string, why: string): boolean {
    return this.setStatus(id, 'cancelled', OPEN, { result: why });
  }

  private cancelWhere(from: readonly PcJobStatus[], why: string): number {
    const ids = this.opts.db.all<{ id: string }>('SELECT id FROM pc_jobs WHERE status IN (' + from.map(() => '?').join(',') + ')', ...from).map((r) => r.id);
    let n = 0;
    for (const id of ids) if (this.setStatus(id, 'cancelled', from, { result: why })) n++;
    return n;
  }

  /** Queued jobs nobody claimed within expireMs. `updated_at` is when the owner approved them. */
  expireStale(): void {
    const cutoff = this.now() - this.expireMs;
    const ids = this.opts.db.all<{ id: string }>("SELECT id FROM pc_jobs WHERE status = 'queued' AND updated_at <= ?", cutoff).map((r) => r.id);
    for (const id of ids) this.setStatus(id, 'expired', ['queued'], { result: PC_EXPIRED_MESSAGE });
  }

  /** The next approved job, oldest first, now `claimed`. Null while one is claimed or running (one at a time). */
  next(): PcJob | null {
    this.expireStale();
    return this.opts.db.tx(() => {
      const busy = this.opts.db.get("SELECT id FROM pc_jobs WHERE status IN ('claimed','running') LIMIT 1");
      if (busy) return null;
      const r = this.opts.db.get("SELECT id FROM pc_jobs WHERE status = 'queued' ORDER BY updated_at ASC, created_at ASC LIMIT 1");
      if (!r) return null;
      const id = r.id as string;
      this.setStatus(id, 'claimed', ['queued']);
      return this.get(id) ?? null;
    });
  }

  start(id: string): PcJob {
    const j = this.get(id);
    if (!j) throw new PcRunnerError(404, 'No such job');
    if (j.status === 'running') return j;
    if (!this.setStatus(id, 'running', ['claimed'])) throw new PcRunnerError(409, 'Job is ' + j.status + ', not claimed');
    return this.get(id)!;
  }

  /**
   * What the PC reports. The output is redacted (known secrets, key-shaped strings) and then capped, before it is
   * stored or handed to the bot.
   */
  finish(id: string, r: { ok: boolean; refusedLocally?: boolean; output: string; costUsd?: number }): PcJob {
    const j = this.get(id);
    if (!j) throw new PcRunnerError(404, 'No such job');
    const status: PcJobStatus = r.refusedLocally ? 'refused' : r.ok ? 'done' : 'failed';
    const output = capOutput(redact(r.output));
    if (!this.setStatus(id, status, ['claimed', 'running'], { result: output, costUsd: r.costUsd ?? null })) {
      throw new PcRunnerError(409, 'Job is ' + j.status + '; it no longer takes a result');
    }
    return this.get(id)!;
  }

  private wake(id: string) {
    for (const fn of this.wakers.get(id) ?? []) fn();
  }

  /**
   * Waits until the job reaches a terminal state, expires, the wait runs out (cancelled) or `signal` aborts
   * (cancelled). Reads the row on every change and every pollMs, so expiry needs no timer of its own.
   */
  async wait(id: string, signal?: AbortSignal): Promise<PcJob> {
    const deadline = this.now() + this.waitMs;
    for (;;) {
      if (signal?.aborted) {
        this.cancel(id, 'The turn was stopped');
        return this.get(id)!;
      }
      const j0 = this.get(id);
      if (!j0) throw new PcRunnerError(404, 'No such job');
      if (j0.status === 'queued') this.expireStale();
      const j = this.get(id)!;
      if (TERMINAL.has(j.status)) return j;
      if (this.now() >= deadline) {
        this.cancel(id, 'No result within ' + Math.round(this.waitMs / 60_000) + ' minutes');
        return this.get(id)!;
      }
      await new Promise<void>((resolve) => {
        let set = this.wakers.get(id);
        if (!set) this.wakers.set(id, (set = new Set()));
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          set!.delete(done);
          if (!set!.size) this.wakers.delete(id);
          resolve();
        };
        const timer = setTimeout(done, this.pollMs);
        set.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}

export function capOutput(s: string): string {
  if (s.length <= MAX_PC_OUTPUT) return s;
  return s.slice(0, MAX_PC_OUTPUT) + '\n…(cut at 20 KB; ' + (s.length - MAX_PC_OUTPUT) + ' more characters on the PC)';
}
