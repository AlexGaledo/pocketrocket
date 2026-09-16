import type { ClientEvent, ServerEvent } from '@pocketrocket/shared';
import { useStore } from '../store';
import { getToken, reportAuthFailure, clearAuthFailure } from './auth';

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped for every new socket, so callbacks from a replaced one (and its probe) change nothing. */
let generation = 0;

/**
 * What stands between this page and the hub, found with plain HTTP because a refused WebSocket upgrade
 * says nothing about why:
 * - `unreachable`: nothing answered at all (hub not running, wrong port) or it answered with a server error.
 * - `rateLimited`: the hub's brute-force brake is on (429), usually after a run of failed attempts.
 * - `auth`: the hub is up and rejects this token (401). The only case that should ask for a token.
 * - `ok`: the hub is up and accepts the token, so the socket failed for some other reason.
 */
export type HubProbe =
  | { result: 'ok' }
  | { result: 'auth' }
  | { result: 'rateLimited'; retryInMs: number }
  | { result: 'unreachable'; detail: string };

function retryAfterMs(r: Response): number {
  const seconds = Number(r.headers.get('retry-after'));
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
}

/**
 * Health first, since it needs no token: when that fails the token cannot be the problem. Only then one
 * authenticated GET with the token, whose 401 is the real "wrong token" signal.
 */
export async function probeHub(token: string | null): Promise<HubProbe> {
  try {
    const health = await fetch('/api/health', { cache: 'no-store' });
    if (health.status === 429) return { result: 'rateLimited', retryInMs: retryAfterMs(health) };
    if (!health.ok) return { result: 'unreachable', detail: 'The hub answered with HTTP ' + health.status + '.' };
  } catch {
    return { result: 'unreachable', detail: 'Nothing answered at ' + location.host + '.' };
  }
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch('/api/settings', { headers, cache: 'no-store' });
    if (r.status === 401) return { result: 'auth' };
    if (r.status === 429) return { result: 'rateLimited', retryInMs: retryAfterMs(r) };
    return { result: 'ok' };
  } catch {
    return { result: 'unreachable', detail: 'The hub stopped answering.' };
  }
}

/** Exponential backoff from 1s to 15s, with jitter so several tabs do not retry in lockstep. */
function backoffMs() {
  const base = Math.min(15_000, 1000 * 2 ** retry++);
  return base / 2 + Math.random() * (base / 2);
}

function schedule(delay: number) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(connectWs, delay);
}

/** Drop any pending backoff retry and reconnect immediately — used after the user pastes a token, or presses Retry. */
export function reconnectWsNow() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retry = 0;
  connectWs();
}

export function connectWs() {
  const gen = ++generation;
  // The old socket (usually one still trying to open) would otherwise report its own close later and
  // schedule a duplicate; the generation check ignores it, and closing it frees the connection.
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  const token = getToken();
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  socket = new WebSocket(url);
  let opened = false;
  socket.onopen = () => {
    if (gen !== generation) return;
    opened = true;
    retry = 0;
    clearAuthFailure();
    useStore.getState().setConnected(true);
  };
  socket.onclose = () => {
    if (gen !== generation) return;
    useStore.getState().setConnected(false);
    // A socket that was open and dropped: the hub restarted or the network blinked. Just come back.
    if (opened) return schedule(backoffMs());
    void diagnose(gen, token);
  };
  socket.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data) as ServerEvent;
      useStore.getState().applyEvent(ev);
    } catch (err) {
      console.error('bad ws event', err);
    }
  };
}

/**
 * The socket never opened. Earlier this assumed a bad token after three failures, which popped the token
 * panel whenever the hub was merely slow to start or rate-limiting. Now it asks, and every failed upgrade
 * also counts against the hub's limiter, so the retry pace follows the answer.
 */
async function diagnose(gen: number, token: string | null) {
  const probe = await probeHub(token);
  if (gen !== generation) return;
  const { setHubIssue } = useStore.getState();
  switch (probe.result) {
    case 'auth':
      setHubIssue({ kind: 'auth' });
      reportAuthFailure();
      // Slow retries only: a new token from the panel reconnects at once, and fast ones would trip the
      // limiter. This keeps a desktop restart that fixes the token from needing a reload.
      return schedule(30_000);
    case 'rateLimited':
      setHubIssue({ kind: 'rateLimited', retryInMs: probe.retryInMs });
      return schedule(probe.retryInMs);
    case 'unreachable':
      setHubIssue({ kind: 'unreachable', detail: probe.detail });
      return schedule(backoffMs());
    case 'ok':
      setHubIssue({ kind: 'refused' });
      return schedule(backoffMs());
  }
}

export function wsSend(ev: ClientEvent): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(ev));
  return true;
}
