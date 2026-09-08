import type { ClientEvent, ServerEvent } from '@pocketrocket/shared';
import { useStore } from '../store';
import { getToken } from './auth';

let socket: WebSocket | null = null;
let retry = 0;

export function connectWs() {
  const token = getToken();
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  socket = new WebSocket(url);
  socket.onopen = () => {
    retry = 0;
    useStore.getState().setConnected(true);
  };
  socket.onclose = () => {
    useStore.getState().setConnected(false);
    const delay = Math.min(10000, 500 * 2 ** retry++);
    setTimeout(connectWs, delay);
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
