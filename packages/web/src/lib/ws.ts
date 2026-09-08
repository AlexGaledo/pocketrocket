import type { ClientEvent, ServerEvent } from '@pocketrocket/shared';
import { useStore } from '../store';
import { getToken, reportAuthFailure, clearAuthFailure } from './auth';

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Drop any pending backoff retry and reconnect immediately — used after the user pastes a token. */
export function reconnectWsNow() {
  if (retryTimer) clearTimeout(retryTimer);
  retry = 0;
  connectWs();
}

export function connectWs() {
  const token = getToken();
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  socket = new WebSocket(url);
  let opened = false;
  socket.onopen = () => {
    opened = true;
    retry = 0;
    clearAuthFailure();
    useStore.getState().setConnected(true);
  };
  socket.onclose = () => {
    useStore.getState().setConnected(false);
    // The hub destroys the raw socket during the upgrade when the token/Origin check fails, so a
    // WS that never opens (and keeps failing across a couple of retries, ruling out "hub still
    // starting") almost always means the token is missing or wrong.
    if (!opened && retry >= 2) reportAuthFailure();
    const delay = Math.min(10000, 500 * 2 ** retry++);
    retryTimer = setTimeout(connectWs, delay);
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

export function wsSend(ev: ClientEvent): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(ev));
  return true;
}
