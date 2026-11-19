import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { PC_SESSION_ID_RE, PcContinueSchema, PcEntriesPostSchema, PcSessionPutSchema } from '@pocketrocket/shared';
import { SessionMoveError, type SessionMoves } from '../services/SessionMoves.js';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Db } from '../db/db.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import type { PcSessions } from '../services/PcSessions.js';
import { logError } from '../providers/redact.js';

const send = (res: ServerResponse, status: number, body?: unknown): true => {
  res.writeHead(status, body === undefined ? undefined : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
  return true;
};

const num = (v: string | null): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * `/api/pc-sessions/*`, the PC session mirror (spec 3.1). Two audiences, never mixed:
 *
 * The runner on the PC (runner principal only; the hub token gets 403 here, guard.ts allows the runner these three and
 * nothing else under /api/pc-sessions):
 *   GET  /api/pc-sessions/sync            -> { sessions: { [id]: { offset, onVps } } }
 *   PUT  /api/pc-sessions/:id             session metadata (upsert) -> { ok, offset, onVps }
 *   POST /api/pc-sessions/:id/entries     { from, to, entries } -> { ok, offset, stored, truncated, onVps }; 409 { error, offset }
 *                                         when `from` is not the stored offset; 404 when the session is unknown. `onVps` (bridge P6): the
 *                                         session is moving, on the VPS or pulling; its entries are dropped (stored: 0) and the offset moves on.
 *
 * The owner (hub principal; a paired phone is refused by deviceMayAccess, the runner gets 403):
 *   GET    /api/pc-sessions?repo=&q=&limit=50&before=<lastAt>   -> { sessions }
 *   GET    /api/pc-sessions/:id                                 -> summary + children
 *   GET    /api/pc-sessions/:id/entries?after=<seq>&limit=200   -> { entries, more }
 *   DELETE /api/pc-sessions/:id                                 -> { ok: true }
 *   POST   /api/pc-sessions/:id/continue  { prompt }  -> { ok: true, turnRunning: true }: one turn of a moved session on the VPS (bridge P6).
 *                                         Only a browser signed in with the owner's password; 409 while a turn runs, when the session is not on
 *                                         the VPS, or past 120k tokens of context. The turn runs in the background.
 */
export function createPcSessionsApi(deps: { pcSessions: PcSessions; db: Db; sessionMoves?: SessionMoves }) {
  const { pcSessions, db, sessionMoves } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/pc-sessions' && !url.pathname.startsWith('/api/pc-sessions/')) return false;
    const method = req.method ?? 'GET';
    let parts: string[];
    try {
      parts = url.pathname.replace(/^\/api\/pc-sessions\/?/, '').replace(/\/$/, '').split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return send(res, 400, { error: 'Bad path' });
    }
    const kind = principalOf(req)?.kind;
    const runnerRoute =
      (method === 'GET' && parts.length === 1 && parts[0] === 'sync') ||
      (method === 'PUT' && parts.length === 1) ||
      (method === 'POST' && parts.length === 2 && parts[1] === 'entries');
    if (runnerRoute ? kind !== 'runner' : kind !== 'hub') {
      return send(res, 403, { error: runnerRoute ? 'Only the PC runner can do this' : 'Only the desktop app can do this' });
    }
    const id = parts[0] && parts[0] !== 'sync' ? parts[0] : null;
    if (parts.length > 0 && !(parts.length === 1 && parts[0] === 'sync' && method === 'GET')) {
      if (!id || !PC_SESSION_ID_RE.test(id)) return send(res, 400, { error: 'Bad session id' });
    }
    let body: unknown;
    if (method === 'POST' || method === 'PUT') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    const bad = (e: z.ZodError) => send(res, 400, { error: e.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
    try {
      // ---- the PC ----
      if (runnerRoute) {
        if (method === 'GET') return send(res, 200, { sessions: pcSessions.syncState() });
        if (method === 'PUT') {
          const p = PcSessionPutSchema.safeParse(body);
          if (!p.success) return bad(p.error);
          if (p.data.parentId === id) return send(res, 400, { error: 'A session cannot be its own parent' });
          if (pcSessions.refused(id!, p.data.lastAt)) return send(res, 410, { error: 'This session was deleted in PocketRocket; do not mirror it again' });
          return send(res, 200, { ok: true, ...pcSessions.upsert(id!, p.data), onVps: sessionMoves?.locked(id!) ?? false });
        }
        const p = PcEntriesPostSchema.safeParse(body);
        if (!p.success) return bad(p.error);
        if (p.data.to < p.data.from) return send(res, 400, { error: 'to must not be before from' });
        const onVps = sessionMoves?.locked(id!) ?? false;
        if (onVps) console.warn('[pc-sessions] dropped PC-side entries of ' + id + ': the session is on the VPS');
        const r = onVps ? pcSessions.skipEntries(id!, p.data.from, p.data.to) : pcSessions.appendEntries(id!, p.data.from, p.data.to, p.data.entries);
        if (r.ok) return send(res, 200, { ...r, onVps });
        if (r.conflict) return send(res, 409, { error: 'Offset mismatch: resend from the stored offset', offset: r.offset });
        return send(res, 404, { error: 'Unknown session: PUT it first' });
      }
      // ---- owner ----
      if (parts.length === 0 && method === 'GET') {
        const q = url.searchParams;
        return send(res, 200, {
          sessions: pcSessions.list({ repo: q.get('repo') || undefined, q: q.get('q') || undefined, limit: num(q.get('limit')), before: num(q.get('before')) }),
        });
      }
      if (parts.length === 1 && method === 'GET') {
        const s = pcSessions.get(id!);
        return s ? send(res, 200, s) : send(res, 404, { error: 'No such session' });
      }
      if (parts.length === 2 && parts[1] === 'entries' && method === 'GET') {
        const r = pcSessions.entries(id!, num(url.searchParams.get('after')) ?? 0, num(url.searchParams.get('limit')) ?? 200);
        return r ? send(res, 200, r) : send(res, 404, { error: 'No such session' });
      }
      if (parts.length === 2 && parts[1] === 'continue' && method === 'POST') {
        // Same bar as starting a job on the PC: the click in a signed-in browser is the approval.
        const principal = principalOf(req);
        if (principal?.kind !== 'hub' || !principal.sessionId) {
          return send(res, 403, { error: 'Continuing a session on the VPS needs a browser signed in with your password.', signInRequired: true });
        }
        const p = PcContinueSchema.safeParse(body);
        if (!p.success) return bad(p.error);
        if (!sessionMoves) return send(res, 400, { error: 'Moving sessions is not available here.' });
        const { done } = sessionMoves.continueSession(id!, p.data.prompt);
        done.catch((e) => logError('[pc-sessions continue]', e));
        const actor = actorOf(req);
        if (actor) recordAudit(db, actor, 'pc-session.continued-on-vps', id);
        return send(res, 200, { ok: true, turnRunning: true });
      }
      if (parts.length === 1 && method === 'DELETE') {
        if (!pcSessions.delete(id!)) return send(res, 404, { error: 'No such session' });
        const actor = actorOf(req);
        if (actor) recordAudit(db, actor, 'pc-session.deleted', id);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof SessionMoveError) return send(res, e.status, { error: e.message });
      logError('[pc-sessions]', e);
      return send(res, 500, { error: 'Internal error' });
    }
  };
}
