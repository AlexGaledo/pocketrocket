import { actorOf, recordAudit } from '../services/AuditLog.js';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ClientEventSchema, type ServerEvent } from '@pocketrocket/shared';
import { MAX_WS_BYTES } from './body.js';
import { deviceIdOf } from './guard.js';
import { events } from '../events.js';
import type { Repos } from '../db/repos.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { SIGN_IN_MESSAGE, type PermissionBroker } from '../permissions/PermissionBroker.js';
import type { SettingsStore } from '../services/SettingsStore.js';

/** Creates the app WebSocket server in noServer mode; the caller routes HTTP upgrades (see index.ts). */
export function attachWs(
  _server: Server,
  deps: {
    repos: Repos; router: RoomRouter; broker: PermissionBroker; settings: SettingsStore;
    /**
     * True while the upgrade request's session cookie is live (owner password sign-in). Asked at answer time, so
     * signing out takes effect at once. Left out, no connection counts as signed in.
     */
    signedIn?: (req: IncomingMessage) => boolean;
  },
) {
  // 256 KB per frame (audit 2026-09-09, B15): the largest legitimate client event is a chat message.
  // `ws` closes the connection with 1009 on anything larger instead of buffering it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });
  const send = (ws: WebSocket, ev: ServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  };

  events.onEvent((ev) => {
    for (const c of wss.clients) send(c, ev);
  });

  wss.on('connection', (ws, req?: IncomingMessage) => {
    // P9: a paired phone answers cards once; a standing "always" grant is the desktop's call.
    const device = req ? deviceIdOf(req) : null;
    // A paired phone is never "signed in" for this purpose, even if a session cookie rides along.
    const signedIn = () => !device && !!req && !!deps.signedIn?.(req);
    // The client hides what a device is refused from this one flag rather than guessing per button.
    send(ws, { type: 'hello', bots: deps.repos.listBots(), rooms: deps.repos.listRooms(), botStates: deps.router.botStates(), settings: deps.settings.get(), principal: device ? 'device' : 'hub', signedIn: signedIn(), openApprovals: deps.repos.openApprovals() });
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
          if (device && ev.decision === 'always') return send(ws, { type: 'error', message: '"Always allow" can only be granted from the desktop app', context: ev.approvalId });
          const card = deps.repos.db.get('SELECT tool_name, bot_id FROM approvals WHERE id=?', ev.approvalId);
          const who = req ? actorOf(req) : null;
          const isSignedIn = signedIn();
          // A job on the PC: the hub token alone cannot allow it (a bot that read the token could answer itself).
          if (ev.decision !== 'deny' && !isSignedIn && deps.broker.needsSignIn(ev.approvalId)) {
            if (who && card) recordAudit(deps.repos.db, who, 'approval.refused_not_signed_in', ev.approvalId, String(card.tool_name) + ' by bot ' + String(card.bot_id));
            return send(ws, { type: 'error', message: SIGN_IN_MESSAGE, context: ev.approvalId });
          }
          const answered = deps.broker.resolve(ev.approvalId, ev.decision, { device: !!device, signedIn: isSignedIn });
          // Only a card this answer actually settled: an expired or repeated one changed nothing.
          if (answered && who && card) recordAudit(deps.repos.db, who, 'approval.' + ev.decision, ev.approvalId, String(card.tool_name) + ' by bot ' + String(card.bot_id));
          if (!answered) send(ws, { type: 'error', message: 'Approval no longer pending', context: ev.approvalId });
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
