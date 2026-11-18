import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Db } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import { MAX_PC_FOLDERS, MAX_PC_PROMPT_BYTES, PC_FOLDER_RE, PcRunnerError, type PcJob, type PcRunner } from '../services/PcRunner.js';
import type { PcSessions } from '../services/PcSessions.js';
import { MachinePolicyInputSchema, PC_MACHINE_ID, PC_SESSION_ID_RE, type PcRunnerJob } from '@pocketrocket/shared';
import { Machines } from '../services/Machines.js';
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
/** A session id the app or a bot may resume: a uuid-like id, never a subagent's `<uuid>:<file>`. */
const RESUMABLE_ID = z.string().regex(PC_SESSION_ID_RE).refine((v) => !v.includes(':'), 'not a resumable session id');
const JobCreateInput = z.object({
  mode: z.enum(['new', 'resume']),
  sessionId: RESUMABLE_ID.optional(),
  folder: z.string().regex(PC_FOLDER_RE).optional(),
  prompt: z.string().min(1).max(8000),
});
const ResultInput = z.object({
  /** The allowed folder NAME a resume ran in. */
  resolvedFolder: z.string().regex(PC_FOLDER_RE).optional(),
  /** Only when `claude --resume` continued under a different session id. */
  newSessionId: RESUMABLE_ID.optional(),
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
 *   POST   /api/pc-runner/jobs       { mode: 'new'|'resume', sessionId?, folder?, prompt } -> PcRunnerJob (queued). The click IS the
 *                                    approval, so only a browser signed in with the owner's password may do it: the hub token, the
 *                                    desktop app and a paired phone get 403. 409 when no runner is paired; 400 for a resume whose
 *                                    session is not in the mirror, or a new job in a folder the PC does not allow.
 *   GET    /api/pc-runner/jobs?limit=50  -> PcRunnerJob[] newest first (limit 1..200)
 *   GET    /api/pc-runner/jobs/:id       -> PcRunnerJob
 *   GET    /api/pc-runner/machines       -> MachineInfo[] (policy per machine: never | ask | always)
 *   PUT    /api/pc-runner/machines/:id   { policy } -> MachineInfo; only the owner, never a bot tool
 *   Every change pushes `pc-runner.changed` on /ws (no content; clients refetch).
 *
 * The helper on the PC (runner principal only; the hub token gets 403 here, guard.ts keeps the runner out of
 * everything else):
 *   POST /api/pc-runner/heartbeat          { folders: string[] }
 *   GET  /api/pc-runner/jobs/next          -> 204 | { id, mode, sessionId, folder, origin, bot: { handle }, room: { id, name }, prompt, createdAt }
 *                                            (a resume has folder null: the PC finds the session's directory itself)
 *   POST /api/pc-runner/jobs/:id/start
 *   POST /api/pc-runner/jobs/:id/result    { ok, refusedLocally?, output, costUsd?, durationMs?, resolvedFolder?, newSessionId? }
 */
export function createPcRunnerApi(deps: { pcRunner: PcRunner; repos: Repos; db: Db; pcSessions?: PcSessions }) {
  const { pcRunner, repos, db, pcSessions } = deps;
  const machines = new Machines(db, pcRunner);
  /** The owner's view of a job. `result` is the PC's output, or the hub's reason when it dropped the job. */
  const view = (j: PcJob): PcRunnerJob => {
    const dropped = j.status === 'cancelled' || j.status === 'expired';
    return {
      id: j.id,
      bot: { id: j.botId, handle: j.botId ? repos.getBot(j.botId)?.handle ?? null : null },
      room: { id: j.roomId, name: j.roomId ? repos.getRoom(j.roomId)?.name ?? null : null },
      mode: j.mode,
      sessionId: j.sessionId,
      origin: j.origin,
      folder: j.folder,
      resolvedFolder: j.resolvedFolder,
      newSessionId: j.newSessionId,
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
    if (method === 'POST' || method === 'PUT') {
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
      if (parts[0] === 'jobs' && parts.length === 1 && method === 'POST') {
        // The click in a signed-in browser is the approval. The hub token alone (the desktop app, a script, a bot
        // that read the token) never counts: same bar as the run_on_pc card.
        const principal = principalOf(req);
        if (principal?.kind !== 'hub' || !principal.sessionId) {
          return send(res, 403, { error: 'Starting a job on the PC needs a browser signed in with your password.', signInRequired: true });
        }
        const p = JobCreateInput.safeParse(body);
        if (!p.success) return bad(p.error);
        if (!pcRunner.isPaired()) return send(res, 409, { error: 'No PC runner is paired with this hub.' });
        // "Never" on the PC means never, for the owner's own clicks too; change the policy to run here.
        if (machines.policy(PC_MACHINE_ID) === 'never') {
          return send(res, 409, { error: 'Your PC is set to "never" in Machines. Change its policy to run jobs there.' });
        }
        if (Buffer.byteLength(p.data.prompt, 'utf8') > MAX_PC_PROMPT_BYTES) return send(res, 400, { error: 'The prompt is over 8 KB.' });
        let sessionId: string | null = null;
        let folder: string | null = null;
        if (p.data.mode === 'resume') {
          const sid = p.data.sessionId;
          const sess = sid && pcSessions ? pcSessions.get(sid) : null;
          if (!sid || !sess) return send(res, 400, { error: 'Resume needs a sessionId that is in the PC session mirror.' });
          if (sess.parentId) return send(res, 400, { error: 'That is a subagent transcript; resume its parent session.' });
          sessionId = sid;
        } else {
          folder = p.data.folder ?? null;
          if (!folder || !pcRunner.folders().includes(folder)) {
            const allowed = pcRunner.folders();
            return send(res, 400, { error: 'New needs one of the folders the PC allows' + (allowed.length ? ': ' + allowed.join(', ') + '.' : ' (it has not reported any).') });
          }
        }
        const job = pcRunner.create({ mode: p.data.mode, sessionId, folder, prompt: p.data.prompt, origin: 'owner' });
        pcRunner.approve(job.id);
        const actor = actorOf(req);
        if (actor) recordAudit(db, actor, 'pc-runner.job.approved', job.id, 'owner, from the app: ' + p.data.mode + ', ' + (sessionId ? 'session ' + sessionId : folder));
        return send(res, 200, view(pcRunner.get(job.id)!));
      }
      if (!runnerRoute && parts[0] === 'jobs' && parts.length === 2 && method === 'GET') {
        const j = pcRunner.get(parts[1]);
        return j ? send(res, 200, view(j)) : send(res, 404, { error: 'No such job' });
      }

      if (parts[0] === 'machines' && parts.length === 1 && method === 'GET') return send(res, 200, machines.list());
      if (parts[0] === 'machines' && parts.length === 2 && method === 'PUT') {
        const p = MachinePolicyInputSchema.safeParse(body);
        if (!p.success) return bad(p.error);
        if (!machines.setPolicy(parts[1], p.data.policy)) return send(res, 404, { error: 'No machine "' + parts[1] + '" with a policy to set' });
        const actor = actorOf(req);
        if (actor) recordAudit(db, actor, 'machine.policy.set', parts[1], p.data.policy);
        return send(res, 200, machines.get(parts[1]));
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
        const bot = j.botId ? repos.getBot(j.botId) : undefined;
        const room = j.roomId ? repos.getRoom(j.roomId) : undefined;
        return send(res, 200, {
          id: j.id,
          mode: j.mode,
          sessionId: j.sessionId,
          folder: j.folder,
          origin: j.origin,
          bot: { handle: j.origin === 'owner' ? '(the app)' : bot?.handle ?? '(deleted bot)' },
          room: { id: j.roomId ?? '', name: j.origin === 'owner' ? '(the app)' : room?.name ?? '(deleted room)' },
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
        const detail = 'machine pc, ' + (j.resolvedFolder ?? j.folder ?? 'resume ' + j.sessionId) + (j.newSessionId ? ', continued as ' + j.newSessionId : '') + (p.data.durationMs !== undefined ? ', ' + Math.round(p.data.durationMs / 1000) + ' s' : '') + (j.costUsd !== null ? ', $' + j.costUsd.toFixed(4) : '');
        recordAudit(db, j.botId ? { kind: 'bot', id: j.botId } : { kind: 'anonymous', id: 'pc-runner' }, 'pc-runner.job.' + j.status, j.id, detail);
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
