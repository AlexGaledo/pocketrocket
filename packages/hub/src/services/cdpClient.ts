import WebSocket from 'ws';

/**
 * A minimal Chrome DevTools Protocol client over one WebSocket (flat sessions). The recorder is a *second*
 * client on a bot's Chromium, next to Playwright MCP; it only listens and installs a page script, so it needs
 * nothing more than JSON commands, replies and events. No puppeteer/playwright dependency for that.
 */
export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  /** Every event (`method`, `params`, `sessionId` when it came from an attached target). */
  onEvent(fn: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

const COMMAND_TIMEOUT_MS = 10_000;
/** A single CDP message larger than this is dropped (a page cannot flood the hub's memory through us). */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export function connectCdp(wsUrl: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    const listeners: ((m: string, p: Record<string, unknown>, s?: string) => void)[] = [];
    const closers: (() => void)[] = [];
    let open = false;
    const conn: CdpConnection = {
      send(method, params = {}, sessionId) {
        if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection is closed'));
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP ' + method + ' timed out')); }, COMMAND_TIMEOUT_MS);
          timer.unref?.();
          pending.set(id, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        });
      },
      onEvent: (fn) => { listeners.push(fn); },
      onClose: (fn) => { closers.push(fn); },
      close: () => { try { ws.close(); } catch { /* already closed */ } },
    };
    ws.on('open', () => { open = true; resolve(conn); });
    ws.on('error', (e) => { if (!open) reject(e); });
    ws.on('close', () => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed')); }
      pending.clear();
      for (const fn of closers) fn();
    });
    ws.on('message', (data) => {
      let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (msg.method) for (const fn of listeners) fn(msg.method, msg.params ?? {}, msg.sessionId);
    });
  });
}

/** `http://127.0.0.1:940n` → the browser's DevTools WebSocket URL (`/json/version`), kept on loopback. */
export async function browserWsUrl(cdpUrl: string, fetchJson: (url: string) => Promise<unknown> = defaultFetchJson): Promise<string> {
  const base = new URL(cdpUrl);
  const info = (await fetchJson(new URL('/json/version', base).toString())) as { webSocketDebuggerUrl?: string };
  if (!info?.webSocketDebuggerUrl) throw new Error('No DevTools endpoint at ' + base.origin);
  const ws = new URL(info.webSocketDebuggerUrl);
  // Chromium answers with the host it was asked on; pin it to the configured loopback host and port anyway.
  ws.hostname = base.hostname;
  ws.port = base.port;
  return ws.toString();
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
