import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SECRET_PLACEHOLDER, type RecorderStatus, type RecordingInfo, type TraceEvent } from '@pocketrocket/shared';
import { computerDir } from '../config.js';
import { events } from '../events.js';
import { redact } from '../providers/redact.js';
import type { ComputerEndpoint } from './ComputerManager.js';
import type { ControlStatus, ComputerControl } from '@pocketrocket/shared';
import { browserWsUrl, connectCdp, type CdpConnection } from './cdpClient.js';
import { PAGE_SCRIPT, RECORDER_BINDING, RECORDER_WORLD, isSecretField, type ElementDesc } from './recorderPage.js';

/**
 * P6 (6.1): teach by demonstration. The user presses **Teach** on a bot's Screen, does the task on the bot's
 * computer, and presses **Done**. Meanwhile this records, into `computers/<botId>/recordings/<id>/`:
 *
 * - `trace.jsonl`: navigations, clicks (robust selector, role, accessible name, text), typed values, special
 *   keys, submits and downloads, from a second CDP client on the bot's Chromium; plus the active window title
 *   (xdotool) every couple of seconds, for apps that are not the browser;
 * - `frames/*.png`: a scrot screenshot after each click;
 * - `meta.json`: the {@link RecordingInfo}.
 *
 * Redaction happens at capture time, never later: a value typed into a password, `autocomplete=*password*`,
 * `cc-*` or one-time-code field is written as «secret» (decided in the page and again here), and a screenshot is
 * dropped while such a field is focused, while a visible secret (card number, code) is filled in on the page, or
 * when the click itself was on one. Recordings never leave the machine and are erased with the bot.
 *
 * While recording, control is forced to the user (holder `recorder`), so the bot's computer tools refuse;
 * Done hands control back with a note. Handing back from the Screen tab also ends the recording.
 */

export interface RecorderCaps {
  /** Trace lines per recording. */
  maxEvents: number;
  /** Screenshots kept per recording. */
  maxFrames: number;
  /** Trace plus screenshots on disk. */
  maxBytes: number;
  /** A recording stops by itself after this long. */
  maxDurationMs: number;
  /** At most one screenshot per this interval. */
  frameIntervalMs: number;
}

export const DEFAULT_CAPS: RecorderCaps = {
  maxEvents: 2000,
  maxFrames: 200,
  maxBytes: 64 * 1024 * 1024,
  maxDurationMs: 30 * 60 * 1000,
  frameIntervalMs: 400,
};

/** A binding payload larger than this is ignored. */
const MAX_PAYLOAD = 16 * 1024;
const WINDOW_POLL_MS = 2000;
const STATUS_THROTTLE_MS = 2000;
export const RECORDING_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type ExecFn = (cmd: string, args: string[], env: Record<string, string>) => Promise<string>;

export interface RecorderDeps {
  computers: {
    readonly enabled: boolean;
    acquire(botId: string): Promise<{ ok: true; endpoint: ComputerEndpoint; release(): void } | { ok: false; reason: string; release(): void }>;
  };
  control: {
    set(botId: string, control: ComputerControl, o?: { holder?: string | null; note?: string }): ControlStatus;
    get(botId: string): ControlStatus;
  };
  /** Default: Linux with per-bot computers. Tests say yes. */
  available?: () => { ok: boolean; reason?: string };
  /** Root of a bot's recordings. Default `computers/<botId>/recordings`. */
  dir?: (botId: string) => string;
  /** Runs scrot / xdotool. Default execFile with a 5 s timeout. */
  exec?: ExecFn;
  connect?: (wsUrl: string) => Promise<CdpConnection>;
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => number;
  caps?: Partial<RecorderCaps>;
  /** 0 turns the xdotool window log off (tests). */
  windowPollMs?: number;
}

interface Session {
  info: RecordingInfo;
  dir: string;
  endpoint: ComputerEndpoint;
  release: () => void;
  cdp: CdpConnection | null;
  /** Target id → its attach (scripts installed), so start() can wait for every page it already saw. */
  attached: Map<string, Promise<void>>;
  /** Per CDP session: a secret field has focus. */
  secretFocus: Map<string, boolean>;
  /** Per CDP session: a secret that shows as text (card number, code) is filled in on that page. */
  visibleSecret: Map<string, boolean>;
  /** Bumped whenever a secret field gains focus; a screenshot taken across a bump is dropped. */
  secretEpoch: number;
  lastFrameAt: number;
  frameSeq: number;
  lastWindow: string;
  timers: NodeJS.Timeout[];
  statusTimer: NodeJS.Timeout | null;
  capsHit: Set<string>;
  stopping: boolean;
}

const defaultExec: ExecFn = (cmd, args, env) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, timeout: 5000, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(String(out)))),
  );

const clip = (v: unknown, n: number) => redact(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);

const SECRET_QUERY_RE = /token|code|key|secret|sig|auth|pass|session|otp|nonce|state|ticket|jwt/i;

/** Whether a URL carries a credential, so a screenshot of its address bar would show it. */
export function urlHasSecret(raw: string): boolean {
  try {
    const u = new URL(raw);
    return !!(u.username || u.password) || [...u.searchParams.keys()].some((k) => SECRET_QUERY_RE.test(k)) || SECRET_QUERY_RE.test(u.hash);
  } catch {
    return false;
  }
}

/** A window title can be a URL (Chrome uses it for a page with no title): its query is scrubbed like any other. */
export function scrubTitle(title: string): string {
  return title.replace(/\S+\?\S+/g, (tok) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return scrubUrl(tok);
    return scrubUrl('http://' + tok).replace(/^http:\/\//, '');
  });
}

/** Query values that look like credentials are replaced; the rest of the URL is kept for the skill. */
export function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_RE.test(k)) u.searchParams.set(k, SECRET_PLACEHOLDER);
    }
    if (u.hash.length > 1 && /token|code|key|secret|auth|session|jwt/i.test(u.hash)) u.hash = '';
    return redact(u.toString()).slice(0, 1000);
  } catch {
    return clip(raw, 500);
  }
}

/** The parts of an element description that go into the trace (never a value). */
function hint(d: ElementDesc | null | undefined) {
  if (!d) return null;
  const out: Record<string, string> = {};
  for (const k of ['selector', 'role', 'label', 'text', 'tag', 'type', 'name', 'placeholder'] as const) {
    const v = clip(d[k], k === 'selector' ? 300 : 120);
    if (v) out[k] = v;
  }
  return out;
}

export class Recorder {
  private sessions = new Map<string, Session>();
  private readonly caps: RecorderCaps;
  private readonly now: () => number;
  private readonly exec: ExecFn;
  private off: (() => void) | null = null;

  constructor(private deps: RecorderDeps) {
    this.caps = { ...DEFAULT_CAPS, ...deps.caps };
    this.now = deps.now ?? Date.now;
    this.exec = deps.exec ?? defaultExec;
  }

  /** Handing back from the Screen tab (or anything else taking control from the user) ends the recording. */
  listen() {
    this.off ??=events.onEvent((ev) => {
      if (ev.type === 'computer.control' && ev.status.control !== 'user' && this.sessions.has(ev.status.botId)) {
        void this.stop(ev.status.botId, { reason: 'handback' });
      }
      if (ev.type === 'bots.changed') {
        const ids = new Set(ev.bots.map((b) => b.id));
        for (const id of this.sessions.keys()) if (!ids.has(id)) void this.stop(id, { reason: 'shutdown' });
      }
    });
  }

  async shutdown() {
    this.off?.();
    this.off = null;
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id, { reason: 'shutdown' })));
  }

  available(): { ok: boolean; reason?: string } {
    if (this.deps.available) return this.deps.available();
    if (process.platform !== 'linux') return { ok: false, reason: 'Teach works on a server hub (Linux) with per-bot computers, not on the desktop app.' };
    if (!this.deps.computers.enabled) return { ok: false, reason: 'Teach needs per-bot computers (POCKETROCKET_COMPUTERS=1).' };
    return { ok: true };
  }

  status(botId: string): RecorderStatus {
    const a = this.available();
    const s = this.sessions.get(botId);
    return { botId, available: a.ok, ...(a.reason ? { reason: a.reason } : {}), active: s ? { ...s.info, capped: [...s.capsHit] } : null };
  }

  private root(botId: string): string {
    if (!BOT_ID_RE.test(botId)) throw new Error('Invalid bot id');
    return this.deps.dir ? this.deps.dir(botId) : path.join(computerDir(botId), 'recordings');
  }

  // ---- start / stop -------------------------------------------------------------------------------

  async start(botId: string, o: { title?: string } = {}): Promise<RecorderStatus> {
    const avail = this.available();
    if (!avail.ok) throw new RecorderError(409, avail.reason ?? 'Recording is not available here.');
    if (this.sessions.has(botId)) throw new RecorderError(409, 'Already recording on this computer.');
    const root = this.root(botId);
    // Control first, so the bot stops acting before anything is captured.
    const prev = this.deps.control.get(botId);
    this.deps.control.set(botId, 'user', { holder: 'recorder' });
    const acq = await this.deps.computers.acquire(botId);
    if (!acq.ok) {
      acq.release();
      this.deps.control.set(botId, prev.control === 'user' ? 'user' : 'agent', { holder: prev.holder });
      throw new RecorderError(409, "Couldn't start the computer: " + acq.reason);
    }
    const startedAt = this.now();
    const toId = (t: number) => new Date(t).toISOString().replace(/[:.]/g, '-');
    let stamp = startedAt;
    let id = toId(stamp);
    // Two recordings in one millisecond would share a folder.
    while (fs.existsSync(path.join(root, id))) id = toId(++stamp);
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
    const s: Session = {
      info: {
        id, botId, title: clip(o.title, 120), startedAt, endedAt: null, state: 'recording',
        events: 0, frames: 0, framesDropped: 0, bytes: 0, capped: [], skillId: null,
      },
      dir, endpoint: acq.endpoint, release: acq.release, cdp: null, attached: new Map(), secretFocus: new Map(), visibleSecret: new Map(),
      secretEpoch: 0, lastFrameAt: 0, frameSeq: 0, lastWindow: '', timers: [], statusTimer: null, capsHit: new Set(), stopping: false,
    };
    this.sessions.set(botId, s);
    this.write(s, { t: 'start', title: s.info.title });
    try {
      await this.attachBrowser(s);
    } catch (e) {
      // Still useful for desktop apps: keep the window log and screenshots, say why the browser part is missing.
      s.info.error = 'Browser not recorded: ' + clip((e as Error).message, 200);
    }
    const poll = this.deps.windowPollMs ?? WINDOW_POLL_MS;
    if (poll > 0) {
      const t = setInterval(() => void this.pollWindow(s), poll);
      t.unref?.();
      s.timers.push(t);
    }
    const limit = setTimeout(() => {
      this.cap(s, 'duration');
      void this.stop(botId, { reason: 'cap' });
    }, this.caps.maxDurationMs);
    limit.unref?.();
    s.timers.push(limit);
    this.saveMeta(s);
    this.emit(botId);
    return this.status(botId);
  }

  /**
   * Ends the recording and hands control back to the bot with a note (unless the user already did, or the hub is
   * shutting down). Returns the finished recording, or null when nothing was recording.
   */
  async stop(botId: string, o: { reason?: 'user' | 'handback' | 'cap' | 'shutdown' } = {}): Promise<RecordingInfo | null> {
    const s = this.sessions.get(botId);
    if (!s || s.stopping) return s ? s.info : null;
    s.stopping = true;
    for (const t of s.timers) clearTimeout(t);
    if (s.statusTimer) clearTimeout(s.statusTimer);
    try { s.cdp?.close(); } catch { /* gone */ }
    this.write(s, { t: 'stop', reason: o.reason ?? 'user' });
    s.info.state = 'stopped';
    s.info.endedAt = this.now();
    s.info.capped = [...s.capsHit];
    this.saveMeta(s);
    this.sessions.delete(botId);
    s.release();
    const reason = o.reason ?? 'user';
    if (reason !== 'handback' && reason !== 'shutdown' && this.deps.control.get(botId).control === 'user') {
      this.deps.control.set(botId, 'agent', {
        note: 'The user just showed you a task on your computer' + (s.info.title ? ' ("' + s.info.title + '")' : '') +
          ' while you waited (recording ' + s.info.id + ', ' + s.info.events + ' steps). It may become a skill once they review it; you have control again.',
      });
    }
    this.emit(botId);
    return s.info;
  }

  // ---- browser (CDP) ------------------------------------------------------------------------------

  private async attachBrowser(s: Session) {
    const url = await browserWsUrl(s.endpoint.cdpUrl, this.deps.fetchJson);
    const cdp = await (this.deps.connect ?? connectCdp)(url);
    s.cdp = cdp;
    cdp.onEvent((method, params, sessionId) => this.onCdp(s, method, params, sessionId));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos?: { targetId: string; type: string }[] };
    for (const t of targetInfos ?? []) void this.attachTarget(s, t);
    await Promise.all(s.attached.values());
  }

  private attachTarget(s: Session, t: { targetId: string; type: string }): Promise<void> {
    if (!s.cdp || s.stopping || (t.type !== 'page' && t.type !== 'iframe')) return Promise.resolve();
    let p = s.attached.get(t.targetId);
    if (!p) {
      p = this.attachNow(s, t).catch(() => undefined);
      s.attached.set(t.targetId, p);
    }
    return p;
  }

  private async attachNow(s: Session, t: { targetId: string; type: string }) {
    const { sessionId } = (await s.cdp!.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })) as { sessionId: string };
    const send = (m: string, p: Record<string, unknown> = {}) => s.cdp!.send(m, p, sessionId);
    // The binding and the script live in an isolated world: the page shares the DOM but cannot see or call them.
    await send('Runtime.addBinding', { name: RECORDER_BINDING, executionContextName: RECORDER_WORLD });
    // Runtime events (bindingCalled among them) only flow once the domain is on.
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT, worldName: RECORDER_WORLD });
    // Already-loaded frames: one isolated world each, and the script in it.
    const tree = (await send('Page.getFrameTree')) as { frameTree?: FrameTree };
    const frames: { id: string; url?: string; parentId?: string }[] = [];
    const walk = (n?: FrameTree) => { if (!n) return; frames.push(n.frame); for (const c of n.childFrames ?? []) walk(c); };
    walk(tree.frameTree);
    for (const f of frames) {
      try {
        const { executionContextId } = (await send('Page.createIsolatedWorld', { frameId: f.id, worldName: RECORDER_WORLD })) as { executionContextId: number };
        await send('Runtime.evaluate', { expression: PAGE_SCRIPT, contextId: executionContextId });
      } catch { /* a frame that went away */ }
    }
    const top = frames.find((f) => !f.parentId);
    if (top?.url && t.type === 'page') {
      if (urlHasSecret(top.url)) s.visibleSecret.set(sessionId ?? '', true);
      this.write(s, { t: 'nav', url: scrubUrl(top.url), initial: true });
    }
  }

  private onCdp(s: Session, method: string, params: Record<string, unknown>, sessionId?: string) {
    if (s.stopping) return;
    switch (method) {
      case 'Target.targetCreated': {
        const info = params.targetInfo as { targetId: string; type: string } | undefined;
        if (info) void this.attachTarget(s, info);
        return;
      }
      case 'Runtime.bindingCalled': {
        if (params.name !== RECORDER_BINDING || typeof params.payload !== 'string' || params.payload.length > MAX_PAYLOAD) return;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(params.payload); } catch { return; }
        if (ev && typeof ev === 'object') this.onPage(s, sessionId ?? '', ev);
        return;
      }
      case 'Page.frameNavigated': {
        const frame = params.frame as { parentId?: string; url?: string } | undefined;
        if (!frame || frame.parentId) return;
        // A new document: whatever secret was on screen is gone.
        s.visibleSecret.set(sessionId ?? '', !!frame.url && urlHasSecret(frame.url));
        s.secretFocus.set(sessionId ?? '', false);
        if (frame.url && frame.url !== 'about:blank') this.write(s, { t: 'nav', url: scrubUrl(frame.url) });
        return;
      }
      case 'Page.downloadWillBegin':
      case 'Browser.downloadWillBegin':
        this.write(s, { t: 'download', file: clip(params.suggestedFilename, 200), url: scrubUrl(String(params.url ?? '')) });
        return;
      case 'Page.downloadProgress':
      case 'Browser.downloadProgress':
        if (params.state === 'completed') this.write(s, { t: 'download', state: 'completed' });
        return;
      default:
    }
  }

  /** One event from the page script. Every value is re-checked here: the hub never trusts the page's redaction. */
  private onPage(s: Session, sid: string, ev: Record<string, unknown>) {
    const el = (ev.el && typeof ev.el === 'object' ? ev.el : null) as ElementDesc | null;
    const secret = isSecretField(el);
    switch (ev.t) {
      case 'focus':
        if (secret) s.secretEpoch++;
        s.secretFocus.set(sid, secret);
        return;
      case 'blur':
        s.secretFocus.set(sid, false);
        if (ev.visibleSecret === true) s.visibleSecret.set(sid, true);
        return;
      case 'type':
      case 'change': {
        const value = secret ? SECRET_PLACEHOLDER : clip(ev.value, ev.t === 'type' ? 2000 : 300);
        if (secret && String(el?.type ?? '').toLowerCase() !== 'password' && ev.value) s.visibleSecret.set(sid, true);
        this.write(s, { t: ev.t, target: hint(el), value, ...(secret ? { secret: true } : {}) });
        return;
      }
      case 'key':
        this.write(s, { t: 'key', key: clip(ev.key, 40), target: hint(el) });
        return;
      case 'submit':
        this.write(s, { t: 'submit', target: hint(el) });
        return;
      case 'click': {
        if (ev.visibleSecret === true) s.visibleSecret.set(sid, true);
        this.write(s, { t: 'click', target: hint(el), x: Number(ev.x) || 0, y: Number(ev.y) || 0 });
        const blocked = secret || [...s.secretFocus.values()].some(Boolean) || [...s.visibleSecret.values()].some(Boolean);
        void this.frame(s, blocked);
        return;
      }
      default:
    }
  }

  // ---- screenshots and the window log ------------------------------------------------------------

  private async frame(s: Session, blocked: boolean) {
    if (s.stopping || s.capsHit.has('frames') || s.capsHit.has('bytes')) return;
    if (blocked) {
      s.info.framesDropped++;
      this.write(s, { t: 'frame', dropped: 'secret' });
      return;
    }
    const t = this.now();
    if (t - s.lastFrameAt < this.caps.frameIntervalMs) return;
    if (s.info.frames >= this.caps.maxFrames) { this.cap(s, 'frames'); return; }
    s.lastFrameAt = t;
    const epoch = s.secretEpoch;
    const file = path.join(s.dir, 'frames', String(++s.frameSeq).padStart(5, '0') + '.png');
    try {
      await this.exec('scrot', ['-z', file], { DISPLAY: s.endpoint.display, XAUTHORITY: s.endpoint.xauthority });
    } catch {
      return;
    }
    const drop = () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } };
    // A secret field took focus while the shot was being taken: it may be in the picture.
    if (s.secretEpoch !== epoch || [...s.secretFocus.values()].some(Boolean) || [...s.visibleSecret.values()].some(Boolean)) {
      drop();
      s.info.framesDropped++;
      this.write(s, { t: 'frame', dropped: 'secret' });
      return;
    }
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (s.info.bytes + size > this.caps.maxBytes) { drop(); this.cap(s, 'bytes'); return; }
    if (s.stopping && !fs.existsSync(s.dir)) return;
    s.info.bytes += size;
    s.info.frames++;
    this.write(s, { t: 'frame', file: 'frames/' + path.basename(file) });
  }

  private async pollWindow(s: Session) {
    if (s.stopping) return;
    let title = '';
    try {
      title = (await this.exec('xdotool', ['getactivewindow', 'getwindowname'], { DISPLAY: s.endpoint.display, XAUTHORITY: s.endpoint.xauthority })).trim();
    } catch {
      return;
    }
    if (!title || title === s.lastWindow) return;
    s.lastWindow = title;
    this.write(s, { t: 'window', title: clip(scrubTitle(title), 200) });
  }

  // ---- trace ---------------------------------------------------------------------------------------

  private write(s: Session, ev: Omit<TraceEvent, 'ts'>) {
    const always = ev.t === 'start' || ev.t === 'stop' || ev.t === 'cap';
    if (!always && s.info.events >= this.caps.maxEvents) { this.cap(s, 'events'); return; }
    const line = JSON.stringify({ ts: this.now() - s.info.startedAt, ...ev }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (!always && s.info.bytes + bytes > this.caps.maxBytes) { this.cap(s, 'bytes'); return; }
    try { fs.appendFileSync(path.join(s.dir, 'trace.jsonl'), line); } catch { return; }
    s.info.bytes += bytes;
    if (!always) s.info.events++;
    this.emitSoon(s);
  }

  private cap(s: Session, which: string) {
    if (s.capsHit.has(which)) return;
    s.capsHit.add(which);
    s.info.capped = [...s.capsHit];
    this.write(s, { t: 'cap', which });
  }

  private saveMeta(s: Session) {
    try { fs.writeFileSync(path.join(s.dir, 'meta.json'), JSON.stringify(s.info, null, 2)); } catch { /* folder erased */ }
  }

  private emit(botId: string) {
    events.emitEvent({ type: 'recorder.state', status: this.status(botId) });
  }

  private emitSoon(s: Session) {
    if (s.statusTimer || s.stopping) return;
    s.statusTimer = setTimeout(() => {
      s.statusTimer = null;
      if (this.sessions.get(s.info.botId) !== s) return;
      this.saveMeta(s);
      this.emit(s.info.botId);
    }, STATUS_THROTTLE_MS);
    s.statusTimer.unref?.();
  }

  // ---- finished recordings ------------------------------------------------------------------------

  list(botId: string): RecordingInfo[] {
    let root: string;
    try { root = this.root(botId); } catch { return []; }
    let ids: string[] = [];
    try { ids = fs.readdirSync(root).filter((d) => RECORDING_ID_RE.test(d)); } catch { return []; }
    return ids
      .sort()
      .reverse()
      .map((id) => this.get(botId, id))
      .filter((r): r is RecordingInfo => !!r);
  }

  get(botId: string, id: string): RecordingInfo | null {
    if (!RECORDING_ID_RE.test(id)) return null;
    const live = this.sessions.get(botId);
    if (live?.info.id === id) return { ...live.info, capped: [...live.capsHit] };
    try {
      const info = JSON.parse(fs.readFileSync(path.join(this.root(botId), id, 'meta.json'), 'utf8')) as RecordingInfo;
      // Not live but never stopped: the hub went down mid-recording. What was written is still usable.
      if (info.state === 'recording') {
        return { ...info, id, botId, state: 'stopped', endedAt: info.endedAt ?? info.startedAt, error: info.error ?? 'Interrupted: the hub stopped while recording.' };
      }
      return { ...info, id, botId };
    } catch {
      return null;
    }
  }

  /** The trace of a finished recording, line by line (unparseable lines skipped). */
  readTrace(botId: string, id: string): TraceEvent[] {
    if (!RECORDING_ID_RE.test(id)) return [];
    let raw = '';
    try { raw = fs.readFileSync(path.join(this.root(botId), id, 'trace.jsonl'), 'utf8'); } catch { return []; }
    const out: TraceEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as TraceEvent); } catch { /* torn line */ }
    }
    return out;
  }

  /** Remembers which skill a distill produced from the recording. */
  setSkill(botId: string, id: string, skillId: string) {
    const info = this.get(botId, id);
    if (!info || info.state !== 'stopped') return;
    try { fs.writeFileSync(path.join(this.root(botId), id, 'meta.json'), JSON.stringify({ ...info, skillId }, null, 2)); } catch { /* gone */ }
  }

  remove(botId: string, id: string): boolean {
    if (!RECORDING_ID_RE.test(id) || this.sessions.get(botId)?.info.id === id) return false;
    const dir = path.join(this.root(botId), id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

interface FrameTree {
  frame: { id: string; url?: string; parentId?: string };
  childFrames?: FrameTree[];
}

export class RecorderError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
