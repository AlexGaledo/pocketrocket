import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Bot, ComputerStatus } from '@pocketrocket/shared';
import {
  CDP_URL, COMPUTERS_DIR, COMPUTERS_ENABLED, COMPUTER_IDLE_MIN, COMPUTER_QUOTA_BYTES, DATA_DIR, DESKTOP_HOME,
  MAX_RUNNING_COMPUTERS, SCREEN_DISPLAY, SCREEN_URL,
} from '../config.js';
import type { ComputerRow, ComputersRepo } from '../db/computers.js';
import { events } from '../events.js';

/*
 * Per-bot computers (P1, option B in docs/specs/grok-bot-parity.md §2.1).
 *
 * Each bot that uses Browser or Desktop gets a slot. Slot n is display :(200+n), Chromium CDP on
 * 127.0.0.1:(9400+n), x11vnc on 127.0.0.1:(5800+n) and websockify (noVNC) on 127.0.0.1:(6200+n), run by the
 * systemd user unit `pocketrocket-crew-computer@<n>-<botId>.service` (deploy/computer.sh). These ranges were
 * picked to stay clear of the legacy shared screen (Crew :98/9223/5901/6081, stock :99/9222/5900/6080), of the
 * X11 TCP range 6000-6063, and of the :100+n / 9300+n ranges the upstream spec sketches, so a stock
 * PocketRocket that adopts per-bot computers can still share the VPS.
 *
 * Every computer runs as the same uid as the hub. Separate screens and profiles are NOT a security boundary.
 *
 * Off (desktop app, Windows, or a server without POCKETROCKET_COMPUTERS=1) everything resolves to the one
 * legacy screen (SCREEN_DISPLAY / CDP_URL / SCREEN_URL), exactly as before P1.
 */

export const SLOT_BASE = { display: 200, cdp: 9400, vnc: 5800, novnc: 6200 } as const;
export const MAX_SLOT = 99;
export const COMPUTER_UNIT_PREFIX = 'pocketrocket-crew-computer@';
/** A computer is not stopped for idleness when one of its bot's routines is due within this window. */
export const ROUTINE_GRACE_MS = 10 * 60 * 1000;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface SlotPorts {
  slot: number;
  display: string;
  cdpPort: number;
  vncPort: number;
  novncPort: number;
}

export function slotPorts(slot: number): SlotPorts {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) throw new Error('computer slot out of range: ' + slot);
  return {
    slot,
    display: ':' + (SLOT_BASE.display + slot),
    cdpPort: SLOT_BASE.cdp + slot,
    vncPort: SLOT_BASE.vnc + slot,
    novncPort: SLOT_BASE.novnc + slot,
  };
}

/** `pocketrocket-crew-computer@<slot>-<botId>.service`; refuses ids that could smuggle anything into a unit name. */
export function unitName(slot: number, botId: string): string {
  if (!BOT_ID_RE.test(botId)) throw new Error('bad bot id for a computer unit');
  slotPorts(slot);
  return COMPUTER_UNIT_PREFIX + slot + '-' + botId + '.service';
}

/** Where a bot's tools and the Screen tab reach its computer. P2 (takeover) and P6 (recorder) build on this. */
export interface ComputerEndpoint {
  /** False: the legacy shared screen (no per-bot computers on this hub). */
  perBot: boolean;
  botId: string | null;
  slot: number | null;
  /** X display for xdotool/scrot, e.g. ":201". */
  display: string;
  /** MIT cookie file every X client of this display needs. */
  xauthority: string;
  /** HOME of the desktop session (XFCE settings persist here). */
  home: string;
  /** The bot's own disk (Desktop, Downloads); null on the legacy screen, whose desktop is the workspace. */
  filesDir: string | null;
  /** Chromium DevTools endpoint for Playwright MCP, loopback only. */
  cdpUrl: string;
  /** websockify/noVNC origin the hub proxies `/screen/...` to, loopback only. */
  screenUrl: string;
  /** x11vnc port (loopback); P2 toggles view-only on it. Null on the legacy screen when unknown. */
  vncPort: number | null;
}

/** The hub's handle on `systemctl --user`. Tests pass a fake. */
export interface Systemctl {
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
  isActive(unit: string): Promise<boolean>;
}

/**
 * `systemctl --user` as the hub's own uid. The hub runs as a system unit, which has no XDG_RUNTIME_DIR, so it is
 * pointed at `/run/user/<uid>`, where the lingering user manager (setup-vps.sh: `loginctl enable-linger`) lives.
 */
export function userSystemctl(): Systemctl {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/' + uid };
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile('systemctl', ['--user', ...args], { env, timeout: 30_000 }, (e, _out, stderr) =>
        e ? reject(new Error((String(stderr).trim() || e.message).slice(0, 300))) : resolve(),
      ),
    );
  return {
    start: (unit) => run(['start', unit]),
    stop: (unit) => run(['stop', unit]),
    isActive: (unit) => run(['is-active', '--quiet', unit]).then(() => true, () => false),
  };
}

/** Resolves true when something accepts a TCP connection on the URL's host:port within 600 ms. */
export function probeUrl(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(600, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Bytes under `dir`, not following symlinks (so `~/Shared` → workspace is never counted against a bot). */
export async function duBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      try { total += (await fs.promises.lstat(p)).size; } catch { /* vanished */ }
    }
  }
  return total;
}

export type EnsureResult = { ok: true; endpoint: ComputerEndpoint } | { ok: false; reason: string };
export type AcquireResult = EnsureResult & { release: () => void };

export interface ComputerManagerOptions {
  enabled?: boolean;
  maxRunning?: number;
  idleMs?: number;
  quotaBytes?: number;
  /** Root of the per-bot folders (default data/computers). */
  dir?: string;
  /** Where the legacy browser-profile / desktop-home live (default data/). */
  dataDir?: string;
  systemctl?: Systemctl;
  probe?: (url: string) => Promise<boolean>;
  diskUsage?: (dir: string) => Promise<number>;
  now?: () => number;
  startTimeoutMs?: number;
  pollMs?: number;
  /** True when one of the bot's routines fires within `withinMs` (keeps it from an idle stop). */
  routineDueSoon?: (botId: string, withinMs: number) => boolean;
}

const fmtGb = (b: number) => (b / 1024 ** 3).toFixed(1) + ' GB';

export class ComputerManager {
  readonly enabled: boolean;
  readonly maxRunning: number;
  readonly idleMs: number;
  readonly quotaBytes: number;
  private dir: string;
  private dataDir: string;
  private sys: Systemctl;
  private probe: (url: string) => Promise<boolean>;
  private diskUsage: (dir: string) => Promise<number>;
  private now: () => number;
  private startTimeoutMs: number;
  private pollMs: number;
  private routineDueSoon: (botId: string, withinMs: number) => boolean;
  /** Turns currently using the computer, per bot. A busy computer is never stopped. */
  private busy = new Map<string, number>();
  /** Open noVNC websockets, per bot. A watched computer is never stopped. */
  private viewers = new Map<string, number>();
  private starting = new Map<string, Promise<EnsureResult>>();
  private reasons = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private repo: ComputersRepo, opts: ComputerManagerOptions = {}) {
    this.enabled = opts.enabled ?? COMPUTERS_ENABLED;
    this.maxRunning = Math.max(1, opts.maxRunning ?? MAX_RUNNING_COMPUTERS);
    this.idleMs = opts.idleMs ?? COMPUTER_IDLE_MIN * 60_000;
    this.quotaBytes = opts.quotaBytes ?? COMPUTER_QUOTA_BYTES;
    this.dir = opts.dir ?? COMPUTERS_DIR;
    this.dataDir = opts.dataDir ?? DATA_DIR;
    this.sys = opts.systemctl ?? userSystemctl();
    this.probe = opts.probe ?? probeUrl;
    this.diskUsage = opts.diskUsage ?? duBytes;
    this.now = opts.now ?? Date.now;
    this.startTimeoutMs = opts.startTimeoutMs ?? 25_000;
    this.pollMs = opts.pollMs ?? 250;
    this.routineDueSoon = opts.routineDueSoon ?? (() => false);
  }

  // ---- addressing -------------------------------------------------------------------------------

  /** The legacy shared screen: what every bot used before P1, and what all of them use when this is off. */
  legacyEndpoint(): ComputerEndpoint {
    return {
      perBot: false, botId: null, slot: null, display: SCREEN_DISPLAY,
      xauthority: process.env.XAUTHORITY || path.join(DESKTOP_HOME, '.Xauthority'), home: DESKTOP_HOME, filesDir: null,
      cdpUrl: CDP_URL, screenUrl: SCREEN_URL, vncPort: null,
    };
  }

  /**
   * Where `botId`'s computer is (or will be). Assigns a slot the first time; does not start anything. With
   * per-bot computers off, or no bot, or every slot taken, this is the legacy shared screen.
   */
  endpoint(botId: string | null): ComputerEndpoint {
    if (!this.enabled || !botId || !BOT_ID_RE.test(botId)) return this.legacyEndpoint();
    const row = this.repo.allocate(botId, MAX_SLOT, this.quotaBytes, this.now());
    if (!row) return this.legacyEndpoint();
    return this.endpointFor(row);
  }

  /** Endpoint of a bot that already has a slot, without assigning one (the `/screen/<botId>` proxy uses this). */
  existingEndpoint(botId: string): ComputerEndpoint | null {
    if (!this.enabled) return null;
    const row = this.repo.get(botId);
    return row ? this.endpointFor(row) : null;
  }

  private endpointFor(row: ComputerRow): ComputerEndpoint {
    const p = slotPorts(row.slot);
    const home = path.join(this.dir, row.botId, 'home');
    return {
      perBot: true, botId: row.botId, slot: row.slot, display: p.display, xauthority: path.join(home, '.Xauthority'), home,
      filesDir: path.join(this.dir, row.botId, 'files'),
      cdpUrl: 'http://127.0.0.1:' + p.cdpPort, screenUrl: 'http://127.0.0.1:' + p.novncPort, vncPort: p.vncPort,
    };
  }

  status(botId: string): ComputerStatus {
    const row = this.enabled ? this.repo.get(botId) : undefined;
    const reason = this.reasons.get(botId);
    return {
      botId, perBot: this.enabled,
      state: row?.state ?? 'asleep', slot: row?.slot ?? null, keepAwake: row?.keepAwake ?? false,
      diskBytes: row?.diskBytes ?? 0, quotaBytes: row?.quotaBytes ?? this.quotaBytes, lastUsedAt: row?.lastUsedAt ?? null,
      ...(reason ? { reason } : {}),
    };
  }

  private emit(botId: string) {
    events.emitEvent({ type: 'computer.state', status: this.status(botId) });
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  /**
   * Marks the computer busy for one turn and makes sure it runs. Always call `release()` when the turn ends,
   * whether or not it started. With per-bot computers off this is the legacy screen and never fails.
   */
  async acquire(botId: string): Promise<AcquireResult> {
    this.busy.set(botId, (this.busy.get(botId) ?? 0) + 1);
    this.touch(botId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.busy.get(botId) ?? 1) - 1;
      if (n > 0) this.busy.set(botId, n);
      else this.busy.delete(botId);
      this.touch(botId);
    };
    const r = await this.ensureRunning(botId);
    return { ...r, release };
  }

  /** Lazy start. Concurrent calls for one bot share a single start. */
  ensureRunning(botId: string): Promise<EnsureResult> {
    if (!this.enabled) return Promise.resolve({ ok: true, endpoint: this.legacyEndpoint() });
    const pending = this.starting.get(botId);
    if (pending) return pending;
    const p = this.start(botId).finally(() => this.starting.delete(botId));
    this.starting.set(botId, p);
    return p;
  }

  private fail(botId: string, reason: string): EnsureResult {
    this.reasons.set(botId, reason);
    this.emit(botId);
    return { ok: false, reason };
  }

  private async start(botId: string): Promise<EnsureResult> {
    if (!BOT_ID_RE.test(botId)) return { ok: false, reason: 'Invalid bot id.' };
    const row = this.repo.allocate(botId, MAX_SLOT, this.quotaBytes, this.now());
    if (!row) return this.fail(botId, 'Every computer slot (' + MAX_SLOT + ') is taken.');
    const endpoint = this.endpointFor(row);
    const unit = unitName(row.slot, botId);
    if (row.state === 'live') {
      if (await this.sys.isActive(unit)) {
        this.reasons.delete(botId);
        return { ok: true, endpoint };
      }
      this.repo.setState(botId, 'asleep');
    }

    // Everything from here to setState('starting') is synchronous, so two starts can never both see a free
    // place under the cap.
    const cur = this.repo.get(botId)!;
    if (cur.diskBytes >= cur.quotaBytes) {
      return this.fail(botId, 'Its disk is full (' + fmtGb(cur.diskBytes) + ' of ' + fmtGb(cur.quotaBytes) + '). Free space in ' + endpoint.filesDir + ' first.');
    }
    const running = this.repo.list().filter((r) => r.botId !== botId && r.state !== 'asleep');
    let victim: ComputerRow | undefined;
    if (running.length >= this.maxRunning) {
      victim = running.filter((r) => this.evictable(r)).sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0];
      if (!victim) {
        return this.fail(botId, this.maxRunning + ' computers are already running and all are in use (MAX_RUNNING_COMPUTERS=' + this.maxRunning + '). Try again when one is idle.');
      }
      this.repo.setState(victim.botId, 'asleep');
    }
    this.repo.setState(botId, 'starting');
    this.repo.touch(botId, this.now());
    this.reasons.delete(botId);
    this.emit(botId);
    if (victim) await this.stopUnit(victim.botId, 'evicted to make room');

    try {
      await this.sys.start(unit);
    } catch (e) {
      this.repo.setState(botId, 'asleep');
      return this.fail(botId, 'Its computer could not start: ' + (e as Error).message);
    }
    if (!(await this.waitFor(endpoint.cdpUrl))) {
      await this.sys.stop(unit).catch(() => undefined);
      this.repo.setState(botId, 'asleep');
      return this.fail(botId, 'Its computer did not come up within ' + Math.round(this.startTimeoutMs / 1000) + 's.');
    }
    this.repo.setState(botId, 'live');
    this.emit(botId);
    return { ok: true, endpoint };
  }

  private async waitFor(url: string): Promise<boolean> {
    // Wall clock, not the injectable `now`: this is a real wait on a real port.
    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      if (await this.probe(url)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** Not kept awake, not watched, not in a turn, and fully up. */
  private evictable(r: ComputerRow): boolean {
    return r.state === 'live' && !r.keepAwake && !this.viewers.get(r.botId) && !this.busy.get(r.botId);
  }

  /** Stop a computer; its disk is kept. */
  async stop(botId: string, why = 'stopped'): Promise<void> {
    const row = this.enabled ? this.repo.get(botId) : undefined;
    if (!row) return;
    this.repo.setState(botId, 'asleep');
    this.emit(botId);
    await this.stopUnit(botId, why);
  }

  private async stopUnit(botId: string, why: string) {
    const row = this.repo.get(botId);
    if (!row) return;
    try {
      await this.sys.stop(unitName(row.slot, botId));
    } catch (e) {
      console.warn('[computers] could not stop ' + botId + ' (' + why + '): ' + (e as Error).message);
    }
    this.emit(botId);
  }

  touch(botId: string) {
    if (this.enabled) this.repo.touch(botId, this.now());
  }

  setKeepAwake(botId: string, on: boolean): ComputerStatus {
    if (this.enabled && this.repo.allocate(botId, MAX_SLOT, this.quotaBytes, this.now())) {
      this.repo.setKeepAwake(botId, on);
      this.emit(botId);
    }
    return this.status(botId);
  }

  /** A noVNC viewer connected; call the returned function when it disconnects. */
  viewerOpened(botId: string): () => void {
    this.viewers.set(botId, (this.viewers.get(botId) ?? 0) + 1);
    this.touch(botId);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const n = (this.viewers.get(botId) ?? 1) - 1;
      if (n > 0) this.viewers.set(botId, n);
      else this.viewers.delete(botId);
      this.touch(botId);
    };
  }

  /** Stop computers idle for `idleMs` with no viewer, no turn, no keep-awake and no routine due. */
  async sweep(): Promise<string[]> {
    if (!this.enabled) return [];
    const t = this.now();
    const stopped: string[] = [];
    for (const r of this.repo.list()) {
      if (!this.evictable(r)) continue;
      if (t - (r.lastUsedAt ?? r.createdAt) < this.idleMs) continue;
      if (this.routineDueSoon(r.botId, ROUTINE_GRACE_MS)) continue;
      await this.stop(r.botId, 'idle');
      stopped.push(r.botId);
    }
    return stopped;
  }

  /** Hourly: `du` every computer folder into `disk_bytes`. */
  async refreshDisk(): Promise<void> {
    if (!this.enabled) return;
    for (const r of this.repo.list()) {
      const bytes = await this.diskUsage(path.join(this.dir, r.botId));
      if (bytes !== r.diskBytes) {
        this.repo.setDisk(r.botId, bytes);
        this.emit(r.botId);
      }
    }
  }

  /** After a hub restart: units outlive the hub, so ask systemd which ones are really running. */
  async reconcile(): Promise<void> {
    if (!this.enabled) return;
    for (const r of this.repo.list()) {
      const active = await this.sys.isActive(unitName(r.slot, r.botId)).catch(() => false);
      const state = active ? 'live' : 'asleep';
      if (state !== r.state) this.repo.setState(r.botId, state);
    }
  }

  /** Stop and erase the computers of bots that no longer exist (bot delete, via REST or the delete_bot tool). */
  async prune(liveBotIds: Iterable<string>): Promise<string[]> {
    if (!this.enabled) return [];
    const keep = new Set(liveBotIds);
    const gone: string[] = [];
    for (const r of this.repo.list()) {
      if (keep.has(r.botId)) continue;
      await this.sys.stop(unitName(r.slot, r.botId)).catch(() => undefined);
      this.repo.remove(r.botId);
      this.busy.delete(r.botId);
      this.viewers.delete(r.botId);
      this.reasons.delete(r.botId);
      fs.rmSync(path.join(this.dir, r.botId), { recursive: true, force: true });
      gone.push(r.botId);
    }
    return gone;
  }

  /**
   * 1.7: the one shared screen's Chromium profile (logins) and XFCE home move to the oldest bot that has the
   * Browser tool, so existing logins carry over. Runs once (a marker file records it). Skipped while the legacy
   * screen is still running, because moving a profile out from under a live Chromium corrupts it; the next hub
   * start tries again.
   */
  async migrateLegacy(bots: Bot[], legacyRunning: () => Promise<boolean> = () => this.probe(CDP_URL)): Promise<string | null> {
    if (!this.enabled) return null;
    const marker = path.join(this.dir, '.legacy-migrated');
    if (fs.existsSync(marker)) return null;
    const profile = path.join(this.dataDir, 'browser-profile');
    const dhome = path.join(this.dataDir, 'desktop-home');
    if (!fs.existsSync(profile) && !fs.existsSync(dhome)) return null;
    const target = [...bots].filter((b) => b.allowedTools.includes('Browser')).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!target || !BOT_ID_RE.test(target.id)) return null;
    if (await legacyRunning()) {
      console.warn('[computers] the shared screen is still running, so its logins were not moved to @' + target.handle + '. Stop pocketrocket-crew-screen and restart the hub.');
      return null;
    }
    if (!this.repo.allocate(target.id, MAX_SLOT, this.quotaBytes, this.now())) return null;
    const cdir = path.join(this.dir, target.id);
    fs.mkdirSync(cdir, { recursive: true });
    const moved: string[] = [];
    for (const [from, to] of [[profile, path.join(cdir, 'browser')], [dhome, path.join(cdir, 'home')]] as const) {
      if (!fs.existsSync(from) || !isEmptyOrMissing(to)) continue;
      fs.rmSync(to, { recursive: true, force: true });
      moveDir(from, to);
      moved.push(path.basename(from));
    }
    fs.writeFileSync(marker, JSON.stringify({ botId: target.id, moved, at: this.now() }) + '\n');
    console.log('[computers] moved the shared screen\'s ' + moved.join(' and ') + ' to @' + target.handle + '\'s computer');
    return target.id;
  }

  /** Reconcile, migrate, then run the idle sweep every minute and the disk count every hour. */
  async startBackground(bots: Bot[]): Promise<void> {
    if (!this.enabled) return;
    await this.reconcile();
    await this.prune(bots.map((b) => b.id));
    await this.migrateLegacy(bots).catch((e) => console.warn('[computers] legacy migration failed: ' + (e as Error).message));
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => void fn().catch((e) => console.warn('[computers] ' + (e as Error).message)), ms);
      t.unref();
      this.timers.push(t);
    };
    every(60_000, () => this.sweep());
    every(60 * 60_000, () => this.refreshDisk());
    const first = setTimeout(() => void this.refreshDisk().catch(() => undefined), 30_000);
    first.unref();
    this.timers.push(first);
  }

  /** Stops the timers only: computers are systemd units and deliberately outlive a hub restart. */
  stopBackground() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

function isEmptyOrMissing(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function moveDir(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
