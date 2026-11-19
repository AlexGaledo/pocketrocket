import type { IncomingMessage, ServerResponse } from 'node:http';
import { FailoverDecisionSchema } from '@pocketrocket/shared';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import { publicCard } from '../db/failoverRepo.js';
import { FailoverError, type FailoverService } from '../services/Failover.js';
import { logError } from '../providers/redact.js';

/**
 * M8 (P3-1) failover cards. Behind the hub token like the rest of `/api`; a bot never reaches this file (no hub tool
 * answers a card, and a cta button or chat text only ever sends a message).
 *
 *   GET  /api/failover                        FailoverState: open cards and bots running on their backup
 *   POST /api/failover-cards/:id/decision     FailoverDecision {decision: 'continue' | 'wait'}. Person-only: 403 for
 *                                             anything but an owner principal (the hub token, a signed-in browser, a
 *                                             paired device), as for workflow approval cards.
 */
export function createFailoverApi(deps: { failover: FailoverService }) {
  const DECISION = /^\/api\/failover-cards\/([^/]+)\/decision\/?$/;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const p = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? 'GET';
    if (p === '/api/failover' || p === '/api/failover/') {
      if (method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      return send(res, 200, deps.failover.state());
    }
    const m = DECISION.exec(p);
    if (!m) return false;
    if (method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const kind = principalOf(req)?.kind;
    if (kind !== 'hub' && kind !== 'device') return send(res, 403, { error: 'Only you can answer this card' });
    const buf = await readBody(req);
    if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
    let body: unknown;
    try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    const parsed = FailoverDecisionSchema.safeParse(body);
    if (!parsed.success) return send(res, 400, { error: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
    try {
      return send(res, 200, publicCard(deps.failover.decide(decodeURIComponent(m[1]), parsed.data)));
    } catch (e) {
      if (e instanceof FailoverError) return send(res, e.status, { error: e.message });
      logError('[failover api]', e);
      return send(res, 500, { error: 'Internal error' });
    }
  };
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
