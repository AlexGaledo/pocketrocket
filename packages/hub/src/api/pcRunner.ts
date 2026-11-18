import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Db } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import { MAX_PC_FOLDERS, MAX_PC_PROMPT_BYTES, PC_FOLDER_RE, PcRunnerError, type PcJob, type PcRunner } from '../services/PcRunner.js';
import type { PcSessions } from '../services/PcSessions.js';
import { MachinePolicyInputSchema, PC_BUNDLE_MAX_BYTES, PC_MACHINE_ID, PC_SESSION_ID_RE, PC_SESSION_UPLOAD_MAX_BYTES, REPO_NAME_RE, wipBranchName, type PcRunnerJob, type PcSyncJobInfo } from '@pocketrocket/shared';
import { ProjectError, type ProjectService } from '../services/ProjectService.js';
import { BundleError, importBundle, incomingPath, receiveToFile, vpsDir } from '../services/BundleImport.js';
import { SessionMoveError, type SessionMoves } from '../services/SessionMoves.js';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Machines } from '../services/Machines.js';
import { logError } from '../providers/redact.js';
import { sandboxActive } from '../providers/sandbox.js';

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
  mode: z.enum(['new', 'resume', 'sync', 'move', 'pull']),
  sessionId: RESUMABLE_ID.optional(),
  folder: z.string().regex(PC_FOLDER_RE).optional(),
  /** Required for new and resume; a sync takes none. */
  prompt: z.string().min(1).max(8000).optional(),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).optional(),
  repo: z.string().regex(REPO_NAME_RE).optional(),
  /** Mode 'move': the room whose tools the VPS turns use. Default: the project's own room. */
  room: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});
const SyncResultInput = z.object({
  mode: z.enum(['wip-branch', 'bundle']),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/).optional(),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  bundleBytes: z.number().int().min(0).max(PC_BUNDLE_MAX_BYTES).optional(),
  scan: z.object({ blocked: z.boolean(), findings: z.array(z.string().max(500)).max(100) }),
});
const MoveResultInput = z.object({
  repos: z.array(z.object({
    repo: z.string().regex(REPO_NAME_RE),
    commit: z.string().regex(/^[0-9a-f]{7,64}$/),
    branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/),
    toplevel: z.string().min(1).max(500).optional(),
  })).min(1).max(20),
  sessionBytes: z.number().int().min(1).max(PC_SESSION_UPLOAD_MAX_BYTES),
});
const PullResultInput = z.object({
  repos: z.array(z.object({ repo: z.string().regex(REPO_NAME_RE), commit: z.string().regex(/^[0-9a-f]{7,64}$/), applied: z.boolean() })).min(1).max(20),
  sessionBytes: z.number().int().min(1).max(PC_SESSION_UPLOAD_MAX_BYTES),
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
  /** Sync jobs: the snapshot commit, the branch pushed, and what the pre-push scan found. */
  sync: SyncResultInput.optional(),
  /** Move jobs: what travelled. Pull jobs: what came home. */
  move: MoveResultInput.optional(),
  pull: PullResultInput.optional(),
});

/**
 * `/api/pc-runner/*`. Two audiences, never mixed:
 *
 * Owner (hub principal: the hub token or a signed-in browser; a paired phone is refused by deviceMayAccess):
 *   POST   /api/pc-runner/token      -> { token }   fresh 32-byte token, shown once, replaces the old one
 *   GET    /api/pc-runner            -> { paired, folders, lastSeenAt, online }
 *   DELETE /api/pc-runner            kill switch: forget the token, cancel every open job
 *   POST   /api/pc-runner/jobs       { mode: 'new'|'resume'|'sync'|'move'|'pull', sessionId?, folder?, prompt?, project?, repo?, room? } -> PcRunnerJob (queued). The click IS the
 *                                    approval, so only a browser signed in with the owner's password may do it: the hub token, the
 *                                    desktop app and a paired phone get 403. 409 when no runner is paired; 400 for a resume whose
 *                                    session is not in the mirror, or a new job in a folder the PC does not allow. A sync (sessionId,
 *                                    project, repo; no prompt) is 400 for a client repo, a repo whose sync is none, or a session that is
 *                                    not mapped to that repo (bridge P5). A move (sessionId, room?) is 400 unless every repo the session is linked to
 *                                    syncs by bundle and is not a client repo, and 409 for a session already on the VPS; a pull (sessionId) is 409
 *                                    unless the session is on the VPS with no turn running (bridge P6). A resume or sync of a moved session is 409.
 *   GET    /api/pc-runner/jobs?limit=50  -> PcRunnerJob[] newest first (limit 1..200)
 *   GET    /api/pc-runner/jobs/:id       -> PcRunnerJob
 *   GET    /api/pc-runner/machines       -> MachineInfo[] (policy per machine: never | ask | always)
 *   PUT    /api/pc-runner/machines/:id   { policy } -> MachineInfo; only the owner, never a bot tool
 *   Every change pushes `pc-runner.changed` on /ws (no content; clients refetch).
 *
 * The helper on the PC (runner principal only; the hub token gets 403 here, guard.ts keeps the runner out of
 * everything else):
 *   POST /api/pc-runner/heartbeat          { folders: string[] }
 *   GET  /api/pc-runner/jobs/next          -> 204 | { id, mode, sessionId, folder, origin, bot: { handle }, room: { id, name }, prompt, createdAt, sync? }
 *                                            (a resume has folder null: the PC finds the session's directory itself; a sync carries
 *                                            sync: { project, repo, remote, mode, protected } and a sessionId whose working tree to snapshot)
 *   POST /api/pc-runner/jobs/:id/bundle    raw application/octet-stream, Content-Length required (max 200 MB), x-bundle-sha256: the
 *                                            bundle of a bundle-mode sync, streamed to disk, verified and imported on wip/<machine>/<session>
 *                                            in the project's VPS copy -> { ok, branch, bytes }
 *   POST /api/pc-runner/jobs/:id/bundle?repo=<name>   the same for a move job, once per repo of the move (bridge P6)
 *   POST /api/pc-runner/jobs/:id/session  raw application/octet-stream, Content-Length (max 100 MB), x-session-sha256: a move job's session
 *                                            .jsonl, after every bundle -> { ok, bytes }
 *   GET  /api/pc-runner/jobs/:id/session  a pull job: the session file with the VPS worktree swapped back for the PC folder; x-session-sha256
 *   GET  /api/pc-runner/jobs/:id/bundle?repo=<name>   a pull job: a git bundle of that repo's wip branch; x-bundle-sha256
 *   POST /api/pc-runner/jobs/:id/start
 *   POST /api/pc-runner/jobs/:id/result    { ok, refusedLocally?, output, costUsd?, durationMs?, resolvedFolder?, newSessionId?, sync? }
 */
export function createPcRunnerApi(deps: { pcRunner: PcRunner; repos: Repos; db: Db; pcSessions?: PcSessions; projects?: ProjectService; sessionMoves?: SessionMoves; bundleMaxBytes?: number; sessionMaxBytes?: number }) {
  const { pcRunner, repos, db, pcSessions, projects, sessionMoves } = deps;
  const sessionMax = deps.sessionMaxBytes ?? PC_SESSION_UPLOAD_MAX_BYTES;
  const bundleMax = deps.bundleMaxBytes ?? PC_BUNDLE_MAX_BYTES;
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
      sync: j.sync,
      syncResult: j.syncResult,
      hubImport: j.syncImport,
      move: j.move,
      moveResult: j.moveResult,
      pull: j.pull,
      pullResult: j.pullResult,
    };
  };
  /** A refusal made before the body is read: close the connection rather than drain up to 200 MB nobody will use. */
  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, error: string): true => {
    res.setHeader('connection', 'close');
    send(res, status, { error });
    res.once('finish', () => req.destroy());
    return true;
  };

  /** POST /api/pc-runner/jobs/:id/bundle: the runner's bundle for a bundle-mode sync. See services/BundleImport.ts. */
  async function receiveBundle(req: IncomingMessage, res: ServerResponse, jobId: string, repoParam: string | null): Promise<true> {
    const job = pcRunner.get(jobId);
    if (!job) return refuse(req, res, 404, 'No such job');
    const isMove = job.mode === 'move' && !!job.move;
    if (!isMove && (job.mode !== 'sync' || !job.sync || job.sync.mode !== 'bundle')) return refuse(req, res, 409, 'This job does not take a bundle.');
    // A move carries one bundle per repo, named in ?repo=; a sync has its one repo.
    const target = isMove ? job.move!.repos.find((r) => r.repo === repoParam) : job.sync!;
    if (!target) return refuse(req, res, 400, 'Name one of the move\'s repos in ?repo=.');
    if (job.status !== 'claimed' && job.status !== 'running') return refuse(req, res, 409, 'Job is ' + job.status + ', not claimed or running.');
    const moveRow = isMove && job.sessionId ? sessionMoves?.get(job.sessionId) : null;
    if (isMove && (!moveRow || moveRow.moveJobId !== job.id || moveRow.state !== 'moving')) return refuse(req, res, 409, 'That session is not being moved by this job.');
    if (isMove ? moveRow!.repos.find((r) => r.repo === target.repo)?.imported : job.syncImport) return refuse(req, res, 409, 'A bundle was already uploaded for this job.');
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/octet-stream') return refuse(req, res, 415, 'Content-Type must be application/octet-stream');
    if (String(req.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked') || !/^[0-9]{1,12}$/.test(String(req.headers['content-length'] ?? ''))) {
      return refuse(req, res, 411, 'Content-Length is required');
    }
    const length = Number(req.headers['content-length']);
    if (length < 1) return refuse(req, res, 400, 'The bundle is empty.');
    if (length > bundleMax) return refuse(req, res, 413, 'The bundle is over ' + Math.round(bundleMax / 1024 / 1024) + ' MB.');
    const sha = String(req.headers['x-bundle-sha256'] ?? '');
    if (!/^[0-9a-fA-F]{64}$/.test(sha)) return refuse(req, res, 400, 'x-bundle-sha256 must be a sha256 in hex.');
    // The repo list is the owner's and may have changed since the job was made.
    const repo = projects?.reposFile(target.project).repos.find((r) => r.name === target.repo);
    if (!projects || !repo || (repo.client && !sandboxActive()) || repo.sync !== 'bundle') return refuse(req, res, 409, 'That repo no longer takes bundle syncs.');
    const session = job.sessionId ? pcSessions?.get(job.sessionId) : null;
    if (!session || !job.sessionId) return refuse(req, res, 409, 'The session is no longer in the mirror.');
    const projectDir = projects.dirOf(target.project);
    const file = incomingPath(projectDir, repo.vps, job.id);
    try {
      const got = await receiveToFile(req, file, { expectBytes: length, sha256: sha });
      if (!got.ok) return refuse(req, res, got.status, got.error);
      const branch = wipBranchName(session.machine, job.sessionId);
      const { commit } = await importBundle({ projectDir, vps: repo.vps, bundleFile: file, branch });
      if (isMove) sessionMoves!.recordImport(job.sessionId!, target.repo, branch, commit);
      else pcRunner.setSyncImport(job.id, { branch, vps: repo.vps, bytes: got.bytes, at: Date.now() });
      recordAudit(db, job.botId ? { kind: 'bot', id: job.botId } : { kind: 'anonymous', id: 'pc-runner' }, 'pc-runner.bundle.imported', job.id, target.project + '/' + target.repo + ' ' + branch + ' ' + commit.slice(0, 12) + ', ' + got.bytes + ' bytes');
      return send(res, 200, { ok: true, branch, bytes: got.bytes });
    } finally {
      fs.rmSync(file, { force: true });
      try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty or gone */ }
    }
  }

  /** POST /api/pc-runner/jobs/:id/session: the session .jsonl of a move job, after its bundles. Streamed to disk, hashed, checked to be this session's. */
  async function receiveSession(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<true> {
    const job = pcRunner.get(jobId);
    if (!job) return refuse(req, res, 404, 'No such job');
    if (job.mode !== 'move' || !job.move || !job.sessionId) return refuse(req, res, 409, 'This job does not take a session file.');
    if (job.status !== 'claimed' && job.status !== 'running') return refuse(req, res, 409, 'Job is ' + job.status + ', not claimed or running.');
    const row = sessionMoves?.get(job.sessionId);
    if (!sessionMoves || !row || row.moveJobId !== job.id || row.state !== 'moving') return refuse(req, res, 409, 'That session is not being moved by this job.');
    if (!row.repos.every((r) => r.imported)) return refuse(req, res, 409, 'Upload every repo\'s bundle before the session file.');
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/octet-stream') return refuse(req, res, 415, 'Content-Type must be application/octet-stream');
    if (String(req.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked') || !/^[0-9]{1,12}$/.test(String(req.headers['content-length'] ?? ''))) {
      return refuse(req, res, 411, 'Content-Length is required');
    }
    const length = Number(req.headers['content-length']);
    if (length < 1) return refuse(req, res, 400, 'The session file is empty.');
    if (length > sessionMax) return refuse(req, res, 413, 'The session file is over ' + Math.round(sessionMax / 1024 / 1024) + ' MB.');
    const sha = String(req.headers['x-session-sha256'] ?? '');
    if (!/^[0-9a-fA-F]{64}$/.test(sha)) return refuse(req, res, 400, 'x-session-sha256 must be a sha256 in hex.');
    if (!pcSessions?.get(job.sessionId)) return refuse(req, res, 409, 'The session is no longer in the mirror.');
    const file = sessionMoves.uploadPath(job.id);
    if (fs.existsSync(file)) return refuse(req, res, 409, 'A session file was already uploaded for this job.');
    const got = await receiveToFile(req, file, { expectBytes: length, sha256: sha, what: 'session file', header: 'x-session-sha256' });
    if (!got.ok) return refuse(req, res, got.status, got.error);
    const bad = sessionMoves.verifySessionFile(file, job.sessionId);
    if (bad) {
      fs.rmSync(file, { force: true });
      return send(res, 400, { error: bad });
    }
    recordAudit(db, { kind: 'anonymous', id: 'pc-runner' }, 'pc-runner.session.uploaded', job.id, job.sessionId + ', ' + got.bytes + ' bytes');
    return send(res, 200, { ok: true, bytes: got.bytes });
  }

  /** GET /api/pc-runner/jobs/:id/(session|bundle): what a pull job brings home. Both are made when asked and removed after streaming. */
  async function sendPull(req: IncomingMessage, res: ServerResponse, jobId: string, what: 'session' | 'bundle', repo: string | null): Promise<true> {
    const job = pcRunner.get(jobId);
    if (!job) return send(res, 404, { error: 'No such job' });
    if (job.mode !== 'pull' || !job.pull || !sessionMoves) return send(res, 409, { error: 'This job does not bring anything home.' });
    if (job.status !== 'claimed' && job.status !== 'running') return send(res, 409, { error: 'Job is ' + job.status + ', not claimed or running.' });
    let file: string;
    let sha: string;
    let bytes: number;
    if (what === 'session') {
      const r = await sessionMoves.pullSessionFile(job);
      file = r.file; sha = r.sha256; bytes = r.bytes;
    } else {
      if (!repo || !job.pull.repos.some((r) => r.repo === repo)) return send(res, 400, { error: 'Name one of the pull\'s repos in ?repo=.' });
      file = await sessionMoves.pullBundle(job, repo);
      const r = await sessionMoves.hashFile(file);
      sha = r.sha256; bytes = r.bytes;
    }
    try {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes), [what === 'session' ? 'x-session-sha256' : 'x-bundle-sha256']: sha, 'cache-control': 'no-store' });
      await pipeline(createReadStream(file), res);
    } catch {
      res.destroy();
    } finally {
      fs.rmSync(file, { force: true });
    }
    void req;
    return true;
  }

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
    if (kind === 'runner' && parts.length === 3 && parts[0] === 'jobs' && (parts[2] === 'bundle' || parts[2] === 'session') && (method === 'POST' || method === 'GET')) {
      try {
        if (method === 'GET') return await sendPull(req, res, parts[1], parts[2], url.searchParams.get('repo'));
        return parts[2] === 'bundle' ? await receiveBundle(req, res, parts[1], url.searchParams.get('repo')) : await receiveSession(req, res, parts[1]);
      } catch (e) {
        if (e instanceof BundleError || e instanceof SessionMoveError) return send(res, e.status, { error: e.message });
        logError('[pc-runner bundle]', e);
        return send(res, 500, { error: 'PC runner error' });
      }
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
        const prompt = p.data.prompt ?? '';
        if (p.data.mode !== 'sync' && p.data.mode !== 'move' && p.data.mode !== 'pull' && !prompt) return send(res, 400, { error: 'A prompt is required.' });
        if (Buffer.byteLength(prompt, 'utf8') > MAX_PC_PROMPT_BYTES) return send(res, 400, { error: 'The prompt is over 8 KB.' });
        let sessionId: string | null = null;
        let folder: string | null = null;
        let sync: PcSyncJobInfo | null = null;
        if (p.data.mode === 'move' || p.data.mode === 'pull') {
          const sid = p.data.sessionId;
          const sess = sid && pcSessions ? pcSessions.get(sid) : null;
          if (!sid || !sess) return send(res, 400, { error: (p.data.mode === 'move' ? 'Move' : 'Pull') + ' needs a sessionId that is in the PC session mirror.' });
          if (!sessionMoves) return send(res, 400, { error: 'Moving sessions is not available here.' });
          const job = p.data.mode === 'move' ? sessionMoves.startMove(sess, { roomId: p.data.room }) : await sessionMoves.startPull(sid);
          const actor = actorOf(req);
          if (actor) recordAudit(db, actor, 'pc-runner.job.approved', job.id, 'owner, from the app: ' + p.data.mode + ' session ' + sid);
          return send(res, 200, view(pcRunner.get(job.id)!));
        }
        if ((p.data.mode === 'sync' || p.data.mode === 'resume') && p.data.sessionId && sessionMoves?.locked(p.data.sessionId)) {
          return send(res, 409, { error: 'That session is on the VPS (or on its way). Pull it back to your PC before ' + (p.data.mode === 'sync' ? 'syncing' : 'resuming') + ' it.', onVps: true });
        }
        if (p.data.mode === 'sync') {
          const sid = p.data.sessionId;
          const sess = sid && pcSessions ? pcSessions.get(sid) : null;
          if (!sid || !sess) return send(res, 400, { error: 'Sync needs a sessionId that is in the PC session mirror.' });
          if (sess.parentId) return send(res, 400, { error: 'That is a subagent transcript; sync its parent session.' });
          if (!p.data.project || !p.data.repo) return send(res, 400, { error: 'Sync needs project and repo.' });
          if (!projects) return send(res, 400, { error: 'Projects are not available here.' });
          sync = projects.syncTarget(sess, p.data.project, p.data.repo);
          sessionId = sid;
        } else if (p.data.mode === 'resume') {
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
        const job = pcRunner.create({
          mode: p.data.mode, sessionId, folder, origin: 'owner', sync,
          prompt: sync ? 'Sync ' + sync.project + '/' + sync.repo + ' (' + sync.mode + ')' : prompt,
        });
        pcRunner.approve(job.id);
        const actor = actorOf(req);
        if (actor) recordAudit(db, actor, 'pc-runner.job.approved', job.id, 'owner, from the app: ' + p.data.mode + ', ' + (sync ? sync.project + '/' + sync.repo + ' session ' + sessionId : sessionId ? 'session ' + sessionId : folder));
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
          ...(j.mode === 'sync' && j.sync ? { sync: j.sync } : {}),
          ...(j.mode === 'move' && j.move ? { move: j.move } : {}),
          ...(j.mode === 'pull' && j.pull ? { pull: j.pull } : {}),
          // The runner refuses a resume of a session that is on the VPS.
          ...(j.mode === 'resume' && j.sessionId && sessionMoves?.locked(j.sessionId) ? { onVps: true } : {}),
        });
      }
      if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'start' && method === 'POST') {
        const j = pcRunner.start(parts[1]);
        return send(res, 200, { ok: true, status: j.status });
      }
      if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'result' && method === 'POST') {
        const p = ResultInput.safeParse(body);
        if (!p.success) return bad(p.error);
        const cur = pcRunner.get(parts[1]);
        let ok = p.data.ok;
        if (cur?.mode === 'sync' && ok && !p.data.refusedLocally) {
          const s = p.data.sync;
          if (!s) return send(res, 400, { error: 'A sync result needs a sync object.' });
          if (cur.sync && s.mode !== cur.sync.mode) return send(res, 400, { error: 'sync.mode does not match the job.' });
          if (s.mode === 'wip-branch' && !s.scan.blocked && !(s.branch && s.branch.startsWith('wip/'))) return send(res, 400, { error: 'A wip-branch sync reports the wip/ branch it pushed.' });
          if (s.mode === 'bundle' && !s.scan.blocked && !cur.syncImport) return send(res, 400, { error: 'No bundle was uploaded for this job.' });
          // A blocked scan is never a success, whatever the runner says.
          if (s.scan.blocked) ok = false;
        }
        let output = p.data.output;
        if (cur?.mode === 'move' && ok && !p.data.refusedLocally) {
          if (!p.data.move) return send(res, 400, { error: 'A move result needs a move object.' });
          if (!sessionMoves) return send(res, 400, { error: 'Moving sessions is not available here.' });
          try {
            await sessionMoves.finalizeMove(cur, p.data.move);
          } catch (e) {
            if (!(e instanceof SessionMoveError)) logError('[pc-runner move]', e);
            ok = false;
            output = 'The hub could not finish the move: ' + (e instanceof SessionMoveError || e instanceof BundleError ? e.message : 'internal error') + (output ? '\n\n' + output : '');
          }
        }
        if (cur?.mode === 'pull' && ok && !p.data.refusedLocally) {
          if (!p.data.pull) return send(res, 400, { error: 'A pull result needs a pull object.' });
          if (!sessionMoves) return send(res, 400, { error: 'Moving sessions is not available here.' });
          try {
            await sessionMoves.finalizePull(cur, p.data.pull);
          } catch (e) {
            if (!(e instanceof SessionMoveError)) logError('[pc-runner pull]', e);
            ok = false;
            output = 'The hub could not finish the pull: ' + (e instanceof SessionMoveError || e instanceof BundleError ? e.message : 'internal error') + (output ? '\n\n' + output : '');
          }
        }
        const j = pcRunner.finish(parts[1], { ...p.data, ok, output });
        const detail = 'machine pc, ' + (j.mode === 'sync' && j.sync ? 'sync ' + j.sync.project + '/' + j.sync.repo + ' ' + (j.syncResult?.branch ?? j.syncResult?.commit ?? '') : j.resolvedFolder ?? j.folder ?? 'resume ' + j.sessionId) + (j.newSessionId ? ', continued as ' + j.newSessionId : '') + (p.data.durationMs !== undefined ? ', ' + Math.round(p.data.durationMs / 1000) + ' s' : '') + (j.costUsd !== null ? ', $' + j.costUsd.toFixed(4) : '');
        recordAudit(db, j.botId ? { kind: 'bot', id: j.botId } : { kind: 'anonymous', id: 'pc-runner' }, 'pc-runner.job.' + j.status, j.id, detail);
        return send(res, 200, { ok: true, status: j.status });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof PcRunnerError) return send(res, e.status, { error: e.message });
      if (e instanceof ProjectError) return send(res, e.status, { error: e.message });
      if (e instanceof SessionMoveError || e instanceof BundleError) return send(res, e.status, { error: e.message });
      logError('[pc-runner]', e);
      return send(res, 500, { error: 'PC runner error' });
    }
  };
}
