import WebSocket from 'ws';
import { IntegrationError } from '../integrations/http.js';

/** The part of a WebSocket the client uses; `ws` fits it, and tests hand in a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  on(event: 'open', fn: () => void): unknown;
  on(event: 'message', fn: (data: unknown) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
}
export type SocketFactory = (url: string) => SocketLike;

/** An `events_api` envelope's payload (Slack's event callback). */
export interface SlackEventCallback {
  event_id?: string;
  team_id?: string;
  event?: { type?: string; subtype?: string; channel?: string; user?: string; bot_id?: string; text?: string; ts?: string; thread_ts?: string };
}

export interface SlackSocketOptions {
  /** One-time `wss://` URL from `apps.connections.open` (a fresh one per connect). */
  openUrl: () => Promise<string>;
  onEvent: (payload: SlackEventCallback) => void;
  /** Connection state for the UI: null error = connected. */
  onStatus?: (s: { connected: boolean; error: string | null }) => void;
  socket?: SocketFactory;
  /** Reconnect timer; tests pass one they drive. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Slack Socket Mode (P5): an outbound WebSocket, so events arrive in real time without an inbound port.
 *
 * - Every envelope is acked at once, before it is handled: Slack wants the ack within 3 seconds and retries
 *   otherwise (the inbox dedupes retries anyway).
 * - `disconnect` (Slack rotates connections about hourly) and a dropped socket reconnect with a fresh URL,
 *   backing off 1 s, 2 s, 4 s … up to a minute. An auth failure stops: the connection needs the user.
 * - Slack does not replay what was sent while disconnected.
 */
export class SlackSocketMode {
  private ws: SocketLike | null = null;
  private running = false;
  private failures = 0;
  private timer: { cancel(): void } | null = null;
  private generation = 0;
  connected = false;

  constructor(private o: SlackSocketOptions) {}

  get active(): boolean {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    void this.connect();
  }

  stop() {
    this.running = false;
    this.generation++;
    this.timer?.cancel();
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    try { ws?.close(); } catch { /* already closed */ }
  }

  private async connect() {
    const gen = ++this.generation;
    let url: string;
    try {
      url = await this.o.openUrl();
    } catch (e) {
      if (gen !== this.generation || !this.running) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.o.onStatus?.({ connected: false, error: msg });
      // A refused credential will not fix itself; wait for the user (the service restarts us on integrations.changed).
      if (e instanceof IntegrationError && (e.auth || e.status === 400 || e.status === 404)) {
        this.running = false;
        return;
      }
      this.retry();
      return;
    }
    if (gen !== this.generation || !this.running) return;
    const ws = (this.o.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(url);
    this.ws = ws;
    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      this.onMessage(ws, data);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.o.onStatus?.({ connected: false, error: null });
      if (this.running) this.retry();
    });
    ws.on('error', (e) => {
      if (this.ws !== ws) return;
      this.o.onStatus?.({ connected: false, error: 'Slack socket: ' + e.message });
    });
  }

  private onMessage(ws: SocketLike, data: unknown) {
    let env: { envelope_id?: string; type?: string; payload?: SlackEventCallback; reason?: string };
    try {
      env = JSON.parse(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      return;
    }
    // Ack first, always: handling must never push the ack past Slack's 3 s.
    if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
    if (env.type === 'hello') {
      this.failures = 0;
      this.connected = true;
      this.o.onStatus?.({ connected: true, error: null });
      return;
    }
    if (env.type === 'disconnect') {
      // Slack is about to drop this socket; open a fresh one now rather than wait for the close.
      this.ws = null;
      this.connected = false;
      try { ws.close(); } catch { /* ignore */ }
      if (this.running) void this.connect();
      return;
    }
    if (env.type === 'events_api' && env.payload) {
      try { this.o.onEvent(env.payload); } catch (e) { console.warn('[slack socket] ' + (e as Error).message); }
    }
  }

  private retry() {
    const ms = Math.min(1000 * 2 ** this.failures, MAX_BACKOFF_MS);
    this.failures++;
    const set = this.o.setTimer ?? ((fn, t) => { const h = setTimeout(fn, t); h.unref?.(); return { cancel: () => clearTimeout(h) }; });
    this.timer?.cancel();
    this.timer = set(() => {
      this.timer = null;
      if (this.running) void this.connect();
    }, ms);
  }
}
