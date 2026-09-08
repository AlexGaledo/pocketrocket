import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ClientEventSchema, type ServerEvent } from '@claudebot/shared';
import { events } from '../events.js';
import type { Repos } from '../db/repos.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';

/** Creates the app WebSocket server in noServer mode; the caller routes HTTP upgrades (see index.ts). */
export function attachWs(_server: Server, deps: { repos: Repos; router: RoomRouter; broker: PermissionBroker }) {
  const wss = new WebSocketServer({ noServer: true });
  const send = (ws: WebSocket, ev: ServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  };

  events.onEvent((ev) => {
    for (const c of wss.clients) send(c, ev);
  });

  wss.on('connection', (ws) => {
    send(ws, { type: 'hello', bots: deps.repos.listBots(), rooms: deps.repos.listRooms(), botStates: deps.router.botStates() });
    ws.on('message', (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return send(ws, { type: 'error', message: 'Invalid JSON' });
      }
      const parsed = ClientEventSchema.safeParse(data);
      if (!parsed.success) return send(ws, { type: 'error', message: 'Bad event: ' + parsed.error.issues.map((i) => i.message).join(', ') });
      const ev = parsed.data;
      try {
        if (ev.type === 'message.send') deps.router.onUserMessage(ev.roomId, ev.text);
        else if (ev.type === 'approval.decide') {
          if (!deps.broker.resolve(ev.approvalId, ev.decision)) send(ws, { type: 'error', message: 'Approval no longer pending', context: ev.approvalId });
        } else if (ev.type === 'turn.interrupt') {
          if (!deps.router.interrupt(ev.turnId)) send(ws, { type: 'error', message: 'Turn not active', context: ev.turnId });
        }
      } catch (e) {
        send(ws, { type: 'error', message: (e as Error).message ?? String(e) });
      }
    });
  });
  return wss;
}
