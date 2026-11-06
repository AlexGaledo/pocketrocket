import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Db } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import { MAX_PC_FOLDERS, PC_FOLDER_RE, PcRunnerError, type PcJob, type PcRunner } from '../services/PcRunner.js';
import type { PcRunnerJob } from '@pocketrocket/shared';
import { logError } from '../providers/redact.js';

const send = (res: ServerResponse, status: number, body?: unknown): true => {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return true;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

const HeartbeatInput = z.object({ folders: z.array(z.string().regex(PC_FOLDER_RE)).max(MAX_PC_FOLDERS) });
const ResultInput = z.object({
  ok: z.boolean(),
  refusedLocally: z.boolean().optional(),
  output: z.string(),
  costUsd: z.number().finite().min(0).optional(),
  durationMs: z.number().finite().min(0).optional(),
});

/**
 * `/api/pc-runner/*`. Two audiences, never mixed:
 *
 * Owner (hub principal: the hub token or a signed-in browser; a paired phone is refused by deviceMayAccess):
 *   POST   /api/pc-runner/token      -> { token }   fresh 32-byte token, shown once, replaces the old one
 *   GET    /api/pc-runner            -> { paired, folders, lastSeenAt, online }
 *   DELETE /api/pc-runner            kill switch: forget the token, cancel every open job
 *   GET    /api/pc-runner/jobs?limit=50  -> PcRunnerJob[] newest first (limit 1..200)
 *   GET    /api/pc-runner/jobs/:id       -> PcRunnerJob
 *   Every change pushes `pc-runner.changed` on /ws (no content; clients refetch).
 *
 * The helper on the PC (runner principal only; the hub token gets 403 here, guard.ts keeps the runner out of
 * everything else):
 *   POST /api/pc-runner/heartbeat          { folders: string[] }
 *   GET  /api/pc-runner/jobs/next          -> 204 | { id, bot: { handle }, room: { id, name }, folder, prompt, createdAt }
 *   POST /api/pc-runner/jobs/:id/start
 *   POST /api/pc-runner/jobs/:id/result    { ok, refusedLocally?, output, costUsd?, durationMs? }
 */
export function createPcRunnerApi(deps: { pcRunner: PcRunner; repos: Repos; db: Db }) {
  const { pcRunner, repos, db } = deps;
  /** The owner's view of a job. `result` is the PC's output, or the hub's reason when it dropped the job. */
  const view = (j: PcJob): PcRunnerJob => {
    const dropped = j.status === 'cancelled' || j.status === 'expired';
    return {
      id: j.id,
      bot: { id: j.botId, handle: repos.getBot(j.botId)?.handle ?? null },
      room: { id: j.roomId, name: repos.getRoom(j.roomId)?.name ?? null },
      folder: j.folder,
      prompt: j.prompt,
      status: j.status,
      output: dropped ? null : j.result,
      costUsd: j.costUsd,
      durationMs: j.durationMs,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      refusedLocally: j.status === 'refused',
      error: dropped ? j.result : null,
    };
  };
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/pc-runner' && !url.pathname.startsWith('/api/pc-runner/')) return false;
    const method = req.method ?? 'GET';
    const parts = url.pathname.replace(/^\/api\/pc-runner\/?/, '').replace(/\/$/, '').split('/').filter(Boolean);
    const kind = principalOf(req)?.kind;
    // The PC's routes are heartbeat, jobs/next and jobs/:id/(start|result). GET jobs and GET jobs/:id are the
    // owner's log; the runner never reads past jobs.
    const runnerRoute = parts[0] === 'heartbeat' || (parts[0] === 'jobs' && (parts[1] === 'next' || parts.length === 3));
    if (runnerRoute ? kind !== 'runner' : kind !== 'hub') {
      return send(res, 403, { error: runnerRoute ? 'Only the PC runner can do this' : 'Only the desktop app can do this' });
    }
    let body: unknown;
    if (method === 'POST') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    const bad = (e: z.ZodError) => send(res, 400, { error: e.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
    try {
      // ---- owner ----
      if (parts.length === 0 && method === 'GET') return send(res, 200, pcRunner.status());
      if (parts.length === 0 && method === 'DELETE') {
        const cancelled = pcRunner.turnOff();
        const actor = actorOf(req);
        if (actor) recordAudit(db, actor, 'pc-runner.turned-off', null, cancelled + ' job(s) cancelled');
        return send(res, 200, { ok: true, cancelled });
      }
      if (parts.length === 1 && parts[0] === 'token' && method === 'POST') {
        const token = pcRunner.mint();
        const actor = actorOf(req);
        if (actor) recordAudit(db, actor, 'pc-runner.token.minted');
        res.setHeader('cache-control', 'no-store');
        return send(res, 200, { token });
      }
      if (parts[0] === 'jobs' && parts.length === 1 && method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return send(res, 200, pcRunner.list(Number.isFinite(limit) ? limit : 50).map(view));
      }
      if (!runnerRoute && parts[0] === 'jobs' && parts.length === 2 && method === 'GET') {
        const j = pcRunner.get(parts[1]);
        return j ? send(res, 200, view(j)) : send(res, 404, { error: 'No such job' });
      }

      // ---- the PC ----
      if (parts.length === 1 && parts[0] === 'heartbeat' && method === 'POST') {
        const p = HeartbeatInput.safeParse(body);
        if (!p.success) return bad(p.error);
        pcRunner.heartbeat([...new Set(p.data.folders)]);
        return send(res, 200, { ok: true });
      }
      if (parts.length === 2 && parts[0] === 'jobs' && parts[1] === 'next' && method === 'GET') {
        const j = pcRunner.next();
        if (!j) return send(res, 204);
        const bot = repos.getBot(j.botId);
        const room = repos.getRoom(j.roomId);
        return send(res, 200, {
          id: j.id,
          bot: { handle: bot?.handle ?? '(deleted bot)' },
          room: { id: j.roomId, name: room?.name ?? '(deleted room)' },
          folder: j.folder,
          prompt: j.prompt,
          createdAt: j.createdAt,
        });
      }
      if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'start' && method === 'POST') {
        const j = pcRunner.start(parts[1]);
        return send(res, 200, { ok: true, status: j.status });
      }
      if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'result' && method === 'POST') {
        const p = ResultInput.safeParse(body);
        if (!p.success) return bad(p.error);
        const j = pcRunner.finish(parts[1], p.data);
        const detail = j.folder + (p.data.durationMs !== undefined ? ', ' + Math.round(p.data.durationMs / 1000) + ' s' : '') + (j.costUsd !== null ? ', $' + j.costUsd.toFixed(4) : '');
        recordAudit(db, { kind: 'bot', id: j.botId }, 'pc-runner.job.' + j.status, j.id, detail);
        return send(res, 200, { ok: true, status: j.status });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof PcRunnerError) return send(res, e.status, { error: e.message });
      logError('[pc-runner]', e);
      return send(res, 500, { error: 'PC runner error' });
    }
  };
}
