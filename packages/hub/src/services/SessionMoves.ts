import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  PC_OFFLOAD_MAX_CONTEXT_TOKENS, wipBranchName,
  type Bot, type PcMoveJobInfo, type PcMoveResult, type PcPullJobInfo, type PcPullResult, type PcSessionDetail, type PcSessionMove, type Room,
} from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { redact, logError } from '../providers/redact.js';
import { settings } from './SettingsStore.js';
import { hardenedGit, vpsDir } from './BundleImport.js';
import type { PcJob, PcRunner } from './PcRunner.js';
import type { PcSessions } from './PcSessions.js';
import type { ProjectService } from './ProjectService.js';
import { claudeConfigDir, rewriteSessionFile, sessionFilePath } from './SessionFile.js';
import { compactLine, lastContextTokens } from './SessionCompact.js';
import type { OffloadTurnOutcome, OffloadTurnRequest } from '../agent/BotRunner.js';

/**
 * A PC session that moved to the VPS (bridge P6). The state machine, per session:
 *
 *   (none | local) --startMove--> moving --move job done--> on-vps --startPull--> pulling --pull job done--> local
 *                      |                                      ^                      |
 *                      +-- move job failed / refused: row dropped                      +-- pull job failed / refused: back to on-vps
 *
 * While it is moving, on-vps or pulling the session is LOCKED: no resume or sync job for it, no second move, and the
 * mirror drops the PC's appends. The VPS turns run one at a time through the Claude provider (agent/BotRunner
 * runOffloadTurn) in a git worktree of the project's VPS copy, on the wip branch the bundle was imported to; the hub commits
 * whatever a turn changed to that branch and nothing else, and never pushes.
 */

export class SessionMoveError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type MoveState = 'moving' | 'on-vps' | 'pulling' | 'local';

export interface MoveRepo {
  project: string;
  repo: string;
  /** The repo's folder under the project (repos.json `vps`). */
  vps: string;
  remote: string;
  protected: string[];
  /** wip/<machine>/<sid8> */
  branch: string;
  /** The snapshot commit the PC reported (what the move started from). */
  base?: string;
  /** The PC's toplevel for this repo, when it said. */
  toplevel?: string;
  imported?: boolean;
}

export interface MoveRow {
  sessionId: string;
  state: MoveState;
  project: string | null;
  roomId: string | null;
  repos: MoveRepo[];
  pcRoot: string | null;
  vpsCwd: string | null;
  worktree: string | null;
  feedOffset: number;
  movedAt: number;
  pulledAt: number | null;
  moveJobId: string | null;
  pullJobId: string | null;
  turns: number;
}

const toRow = (r: Record<string, unknown>): MoveRow => {
  let repos: MoveRepo[] = [];
  try { repos = JSON.parse(String(r.repos_json ?? '[]')) as MoveRepo[]; } catch { /* hand-edited */ }
  return {
    sessionId: r.session_id as string, state: r.state as MoveState, project: (r.project as string) ?? null, roomId: (r.room_id as string) ?? null,
    repos, pcRoot: (r.pc_root as string) ?? null, vpsCwd: (r.vps_cwd as string) ?? null, worktree: (r.worktree as string) ?? null,
    feedOffset: Number(r.feed_offset ?? 0), movedAt: Number(r.moved_at), pulledAt: r.pulled_at == null ? null : Number(r.pulled_at),
    moveJobId: (r.move_job_id as string) ?? null, pullJobId: (r.pull_job_id as string) ?? null, turns: Number(r.turns ?? 0),
  };
};

export interface SessionMovesDeps {
  db: Db;
  repos: Repos;
  pcRunner: PcRunner;
  pcSessions: PcSessions;
  projects: ProjectService;
  /** Where uploads and downloads wait (DATA_DIR/pc-moves). */
  dir: string;
  /** Runs one VPS turn (BotRunner.runOffloadTurn). */
  runTurn: (req: OffloadTurnRequest) => Promise<OffloadTurnOutcome>;
  /** The Claude CLI's config folder on this machine. Tests hand in a temp one. */
  configDir?: () => string;
  model?: () => string;
  /** How often a running turn's new lines are fed to the mirror. */
  feedEveryMs?: number;
}

const SID8 = (branch: string) => branch.split('/').pop() ?? 'session';
const TAIL_BYTES = 256 * 1024;

export class SessionMoves {
  private running = new Map<string, Promise<void>>();
  private toolNames = new Map<string, Map<string, string>>();

  constructor(private d: SessionMovesDeps) {}

  private cfg() { return (this.d.configDir ?? claudeConfigDir)(); }

  // ---------- state ----------

  get(sessionId: string): MoveRow | null {
    const r = this.d.db.get('SELECT * FROM pc_session_moves WHERE session_id = ?', sessionId);
    return r ? toRow(r) : null;
  }

  /** moving, on-vps or pulling: the PC must not resume or sync it, and the mirror drops the PC's appends. */
  locked(sessionId: string): boolean {
    const s = this.get(sessionId)?.state;
    return s === 'moving' || s === 'on-vps' || s === 'pulling';
  }

  turnRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** What the app sees on a session summary. Never a path: the worktree is its own name. */
  summary(sessionId: string): PcSessionMove | null {
    const m = this.get(sessionId);
    if (!m) return null;
    return {
      state: m.state, room: m.roomId, project: m.project,
      repos: m.repos.map((r) => ({ project: r.project, repo: r.repo, branch: r.branch })),
      worktree: m.worktree, movedAt: m.movedAt, pulledAt: m.pulledAt, turnRunning: this.turnRunning(sessionId),
    };
  }

  private save(m: MoveRow): void {
    this.d.db.run(
      `INSERT INTO pc_session_moves (session_id, state, project, room_id, repos_json, pc_root, vps_cwd, worktree, feed_offset, moved_at, pulled_at, move_job_id, pull_job_id, turns)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET state=excluded.state, project=excluded.project, room_id=excluded.room_id, repos_json=excluded.repos_json,
         pc_root=excluded.pc_root, vps_cwd=excluded.vps_cwd, worktree=excluded.worktree, feed_offset=excluded.feed_offset, moved_at=excluded.moved_at,
         pulled_at=excluded.pulled_at, move_job_id=excluded.move_job_id, pull_job_id=excluded.pull_job_id, turns=excluded.turns`,
      m.sessionId, m.state, m.project, m.roomId, JSON.stringify(m.repos), m.pcRoot, m.vpsCwd, m.worktree, m.feedOffset, m.movedAt, m.pulledAt, m.moveJobId, m.pullJobId, m.turns,
    );
    this.d.pcSessions.touch(m.sessionId);
  }

  private drop(sessionId: string): void {
    this.d.db.run('DELETE FROM pc_session_moves WHERE session_id = ?', sessionId);
    this.d.pcSessions.touch(sessionId);
  }

  // ---------- rooms ----------

  /**
   * The rooms a session's VPS turns may run in: the linked project's own room, then any group chat that holds every one of
   * the project's member bots. The first is the default.
   */
  roomCandidates(links: readonly { project: string }[]): Room[] {
    const out: Room[] = [];
    const seen = new Set<string>();
    const add = (r: Room | undefined) => { if (r && r.kind !== 'dm' && !seen.has(r.id)) { seen.add(r.id); out.push(r); } };
    const slugs = [...new Set(links.map((l) => l.project))];
    for (const slug of slugs) add(this.d.projects.get(slug)?.roomId ? this.d.repos.getRoom(this.d.projects.get(slug)!.roomId!) : undefined);
    for (const slug of slugs) {
      const members = this.d.projects.get(slug)?.memberIds ?? [];
      if (!members.length) continue;
      for (const r of this.d.repos.listRooms()) if (r.kind !== 'dm' && members.every((m) => r.memberIds.includes(m))) add(r);
    }
    return out;
  }

  /** The member whose tools and permissions the turns use: @persona when it is in the room, else the first member that exists. */
  private botFor(room: Room): Bot | null {
    const persona = settings.get().personaBotId;
    const ids = [...(persona && room.memberIds.includes(persona) ? [persona] : []), ...room.memberIds];
    for (const id of ids) {
      const b = this.d.repos.getBot(id);
      if (b) return b;
    }
    return null;
  }

  // ---------- move ----------

  /**
   * Checks a move request and returns what the job carries. 400 for a session with no linked repo, a client repo, a repo whose
   * sync is not bundle, or a room the project is not linked to; 409 when the session is already moved or has a job open.
   */
  planMove(session: PcSessionDetail, roomId?: string): { info: PcMoveJobInfo; room: Room; repos: MoveRepo[] } {
    if (session.parentId) throw new SessionMoveError(400, 'That is a subagent transcript; move its parent session.');
    const cur = this.get(session.id);
    if (cur && cur.state !== 'local') throw new SessionMoveError(409, cur.state === 'on-vps' ? 'That session is already on the VPS.' : 'That session is already ' + cur.state + '.');
    if (this.openJobFor(session.id)) throw new SessionMoveError(409, 'That session already has a job waiting or running on the PC.');
    if (session.links.length === 0) throw new SessionMoveError(400, 'That session is not linked to any project repo, so there is nothing to move it into. Add the repo to a project first.');
    const repos: MoveRepo[] = [];
    const wip = wipBranchName(session.machine, session.id);
    for (const l of session.links) {
      const file = this.d.projects.reposFile(l.project).repos.find((r) => r.name === l.repo);
      if (!file) throw new SessionMoveError(400, 'Project ' + l.project + ' has no repo called ' + l.repo);
      if (file.client) throw new SessionMoveError(400, l.repo + ' is a client repo: it stays on your PC until bots are sandboxed, so its session cannot move to the VPS.');
      if (file.sync !== 'bundle') throw new SessionMoveError(400, l.repo + ' has sync set to "' + file.sync + '". A session moves only with bundle sync: change it in the project settings first.');
      repos.push({ project: l.project, repo: l.repo, vps: file.vps, remote: file.remote, protected: [...new Set(['main', 'master', ...file.protected])], branch: wip });
    }
    const candidates = this.roomCandidates(session.links);
    const room = roomId ? candidates.find((r) => r.id === roomId) : candidates[0];
    if (roomId && !room) throw new SessionMoveError(400, 'That room is not one of the project\'s rooms: use the project\'s own room, or a group chat with all of its bots.');
    if (!room) throw new SessionMoveError(400, 'The project has no room, so the VPS turns would have no tools or permissions to run under. Make a room for it first.');
    if (!this.botFor(room)) throw new SessionMoveError(400, 'The room has no bot in it to run the turns.');
    // The worktree path has to be one the CLI can find the session under.
    const first = repos[0];
    try {
      sessionFilePath(this.worktreePath(first, wip), session.id, this.cfg());
    } catch (e) {
      throw new SessionMoveError(400, (e as Error).message);
    }
    return { info: { room: room.id, title: session.title, repos: repos.map((r) => this.d.projects.syncTarget(session, r.project, r.repo)) as PcMoveJobInfo['repos'] }, room, repos };
  }

  /** Creates the move job (queued: the caller has the owner's approval) and the 'moving' row. */
  startMove(session: PcSessionDetail, o: { roomId?: string; botId?: string | null; fromRoomId?: string | null }): PcJob {
    const plan = this.planMove(session, o.roomId);
    const job = this.d.pcRunner.create({
      mode: 'move', sessionId: session.id, folder: null, origin: o.botId ? 'bot' : 'owner', botId: o.botId ?? null, roomId: o.fromRoomId ?? null,
      prompt: 'Move ' + (session.title ?? session.id) + ' to the VPS (' + plan.repos.map((r) => r.project + '/' + r.repo).join(', ') + ')',
      move: plan.info,
    });
    const pcRoot = session.cwd ?? null;
    this.save({
      sessionId: session.id, state: 'moving', project: plan.repos[0].project, roomId: plan.room.id, repos: plan.repos, pcRoot,
      vpsCwd: null, worktree: SID8(plan.repos[0].branch), feedOffset: 0, movedAt: Date.now(), pulledAt: null, moveJobId: job.id, pullJobId: null, turns: 0,
    });
    this.d.pcRunner.approve(job.id);
    return this.d.pcRunner.get(job.id)!;
  }

  private openJobFor(sessionId: string): boolean {
    return this.d.pcRunner.list(200).some((j) => j.sessionId === sessionId && (j.status === 'pending_approval' || j.status === 'queued' || j.status === 'claimed' || j.status === 'running'));
  }

  worktreePath(repo: MoveRepo, branch: string): string {
    return vpsDir(this.d.projects.dirOf(repo.project), repo.vps) + '-wt' + path.sep + SID8(branch);
  }

  uploadPath(jobId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new SessionMoveError(400, 'Bad job id');
    return path.join(this.d.dir, jobId + '.jsonl');
  }

  /** A bundle for one repo of a move was imported to its wip branch. */
  recordImport(sessionId: string, repoName: string, branch: string, commit: string): void {
    const m = this.get(sessionId);
    if (!m || m.state !== 'moving') throw new SessionMoveError(409, 'That session is not being moved.');
    const r = m.repos.find((x) => x.repo === repoName);
    if (!r || r.branch !== branch) throw new SessionMoveError(409, 'Not a repo of this move.');
    r.imported = true;
    r.base = commit;
    this.save(m);
  }

  /**
   * The runner reported the move: every bundle and the session file are here. Builds the worktrees, rewrites the session's
   * paths, files it where the VPS CLI looks, feeds the mirror what it was missing, and marks the session on-vps. Throws
   * (SessionMoveError) with the reason when something is off; the caller then fails the job.
   */
  async finalizeMove(job: PcJob, result: PcMoveResult): Promise<void> {
    const m = job.sessionId ? this.get(job.sessionId) : null;
    if (!m || m.state !== 'moving' || m.moveJobId !== job.id) throw new SessionMoveError(409, 'That session is not being moved by this job.');
    const upload = this.uploadPath(job.id);
    if (!fs.existsSync(upload)) throw new SessionMoveError(400, 'No session file was uploaded for this job.');
    const want = new Set(m.repos.map((r) => r.repo));
    const got = new Set(result.repos.map((r) => r.repo));
    if (want.size !== got.size || [...want].some((r) => !got.has(r))) throw new SessionMoveError(400, 'The move result does not list exactly the job\'s repos.');
    for (const r of m.repos) {
      if (!r.imported) throw new SessionMoveError(400, 'No bundle was uploaded for ' + r.repo + '.');
      const rep = result.repos.find((x) => x.repo === r.repo)!;
      r.toplevel = rep.toplevel;
      if (rep.branch !== r.branch) throw new SessionMoveError(400, 'The PC reported branch ' + rep.branch + ' for ' + r.repo + ', not ' + r.branch + '.');
    }
    const session = this.d.pcSessions.get(m.sessionId);
    if (!session) throw new SessionMoveError(409, 'The session is no longer in the mirror.');
    const primary = m.repos[0];
    const pcRoot = primary.toplevel ?? session.cwd;
    if (!pcRoot) throw new SessionMoveError(400, 'The PC did not say where the repo is, and the session has no folder of its own.');
    const created: { dir: string; wt: string }[] = [];
    try {
      for (const r of m.repos) {
        const dir = vpsDir(this.d.projects.dirOf(r.project), r.vps);
        const wt = this.worktreePath(r, r.branch);
        await this.addWorktree(dir, wt, r.branch);
        created.push({ dir, wt });
      }
      const vpsCwd = created[0].wt;
      const target = sessionFilePath(vpsCwd, m.sessionId, this.cfg());
      // Lines the mirror had not read yet (it lags the file a little): feed them before the file is rewritten.
      await this.feedFrom(m.sessionId, upload, this.mirrorOffset(m.sessionId), null, new Map());
      const tmp = target + '.pocketrocket-tmp';
      const done = await rewriteSessionFile(upload, tmp, pcRoot, vpsCwd);
      fs.renameSync(tmp, target);
      this.d.pcSessions.setOffset(m.sessionId, result.sessionBytes);
      m.state = 'on-vps';
      m.pcRoot = pcRoot;
      m.vpsCwd = vpsCwd;
      m.feedOffset = done.bytes;
      m.movedAt = Date.now();
      this.save(m);
    } catch (e) {
      for (const c of created) await this.removeWorktree(c.dir, c.wt).catch(() => undefined);
      throw e;
    } finally {
      fs.rmSync(upload, { force: true });
    }
    const room = m.roomId ? this.d.repos.getRoom(m.roomId) : undefined;
    if (room) this.post(room.id, 'Session "' + (session.title ?? m.sessionId) + '" moved to the VPS (' + m.repos.map((r) => r.project + '/' + r.repo).join(', ') + '). Continue it from the app; pull it back when you want it on your PC again.');
  }

  /**
   * A refusal message when `file` is not the .jsonl of session `sessionId`, else null: the head of the file has to carry at
   * least one `sessionId` field and every one it carries has to be this session's.
   */
  verifySessionFile(file: string, sessionId: string): string | null {
    const fd = fs.openSync(file, 'r');
    let head: string;
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = head.split('\n');
    lines.pop(); // the last may be cut
    let seen = 0;
    for (const l of lines) {
      if (!l.includes('"sessionId"')) continue;
      let o: { sessionId?: unknown };
      try { o = JSON.parse(l); } catch { return 'The session file is not Claude Code JSONL.'; }
      if (typeof o.sessionId !== 'string') continue;
      if (o.sessionId !== sessionId) return 'That file belongs to another session, not ' + sessionId + '.';
      seen++;
    }
    return seen > 0 ? null : 'The session file names no session id, so it cannot be checked.';
  }

  async hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(file)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
    return { sha256: hash.digest('hex'), bytes };
  }

  private mirrorOffset(sessionId: string): number {
    return this.d.pcSessions.syncState()[sessionId]?.offset ?? 0;
  }

  // ---------- job end ----------

  /** PcRunner calls this once for every move or pull job that reached a terminal status. */
  onJobFinished(job: PcJob): void {
    if ((job.mode !== 'move' && job.mode !== 'pull') || !job.sessionId) return;
    try {
      const m = this.get(job.sessionId);
      if (!m) return;
      if (job.mode === 'move' && m.moveJobId === job.id) {
        fs.rmSync(this.uploadPath(job.id), { force: true });
        if (job.status !== 'done' && m.state === 'moving') this.drop(job.sessionId);
      } else if (job.mode === 'pull' && m.pullJobId === job.id && job.status !== 'done' && m.state === 'pulling') {
        m.state = 'on-vps';
        this.save(m);
      }
    } catch (e) {
      logError('[session-moves] job finished', e);
    }
  }

  /** At start: a move or pull whose job is gone or over (the hub was down) goes back to where it was. */
  reconcile(): void {
    for (const r of this.d.db.all('SELECT * FROM pc_session_moves WHERE state IN (?, ?)', 'moving', 'pulling')) {
      const m = toRow(r);
      const job = this.d.pcRunner.get((m.state === 'moving' ? m.moveJobId : m.pullJobId) ?? '');
      const open = job && (job.status === 'pending_approval' || job.status === 'queued' || job.status === 'claimed' || job.status === 'running');
      if (open) continue;
      if (m.state === 'moving') this.drop(m.sessionId);
      else { m.state = 'on-vps'; this.save(m); }
    }
  }

  // ---------- turns on the VPS ----------

  /**
   * One VPS turn. Validates now (409 while a turn runs or when the session is not on the VPS, 409 past 120k tokens of context)
   * and runs in the background: `done` settles when the turn, the mirror feed and the commit are over.
   */
  continueSession(sessionId: string, prompt: string): { done: Promise<void> } {
    const m = this.get(sessionId);
    if (!m || m.state !== 'on-vps' || !m.vpsCwd) throw new SessionMoveError(409, 'That session is not on the VPS.');
    if (this.running.has(sessionId)) throw new SessionMoveError(409, 'A turn is already running on that session. One at a time.');
    const file = sessionFilePath(m.vpsCwd, sessionId, this.cfg());
    if (!fs.existsSync(file)) throw new SessionMoveError(409, 'The session file is missing on the VPS. Pull it back to your PC.');
    const ctxTokens = lastContextTokens(this.tail(file));
    if (ctxTokens !== null && ctxTokens > PC_OFFLOAD_MAX_CONTEXT_TOKENS) {
      throw new SessionMoveError(409, 'This session has grown to about ' + Math.round(ctxTokens / 1000) + 'k tokens of context, past the ' + PC_OFFLOAD_MAX_CONTEXT_TOKENS / 1000 + 'k the VPS will continue. Pull it back to your PC, or start a fresh session. (Carrying a summary over is not built yet.)');
    }
    const room = m.roomId ? this.d.repos.getRoom(m.roomId) : undefined;
    const bot = room ? this.botFor(room) : null;
    if (!room || !bot) throw new SessionMoveError(409, 'The room that runs this session is gone. Pull the session back to your PC.');
    const members = room.memberIds.map((id) => this.d.repos.getBot(id)).filter((b): b is Bot => !!b);
    const model = (this.d.model ?? (() => settings.get().offloadModel))();
    const run = (async () => {
      const every = this.d.feedEveryMs ?? 2000;
      const timer = setInterval(() => { void this.feed(sessionId).catch((e) => logError('[session-moves] feed', e)); }, every);
      timer.unref();
      let out: OffloadTurnOutcome;
      try {
        out = await this.d.runTurn({ bot, room, members, sessionId, cwd: m.vpsCwd!, model, prompt });
      } catch (e) {
        out = { ok: false, finalText: '', costUsd: 0, error: redact(String((e as Error).message ?? e)) };
      } finally {
        clearInterval(timer);
      }
      try { await this.feed(sessionId); } catch (e) { logError('[session-moves] feed', e); }
      let committed = '';
      try { committed = await this.commitWork(m, 'VPS turn: ' + prompt.replace(/\s+/g, ' ').slice(0, 60)); } catch (e) { committed = 'Could not commit: ' + redact((e as Error).message); }
      const cur = this.get(sessionId);
      if (cur) { cur.turns += 1; this.save(cur); }
      const head = out.ok
        ? 'VPS turn finished: ' + (redact(out.finalText).replace(/\s+/g, ' ').trim().slice(0, 300) || '(no text reply)')
        : 'VPS turn failed: ' + (out.error ?? 'unknown error').slice(0, 300);
      this.post(room.id, head + (committed ? '\n' + committed : '') + (out.sessionId ? '\nThe CLI continued as another session (' + out.sessionId + '), so this turn is not in the mirrored conversation.' : ''));
    })().finally(() => {
      this.running.delete(sessionId);
      this.d.pcSessions.touch(sessionId);
    });
    this.running.set(sessionId, run);
    this.d.pcSessions.touch(sessionId);
    return { done: run };
  }

  /** The turn's end: wait for it. Tests and shutdown use it. */
  async idle(sessionId: string): Promise<void> {
    await this.running.get(sessionId);
  }

  private tail(file: string): string {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Feeds the lines the VPS CLI appended since the last feed to the mirror, as machine 'vps'. */
  async feed(sessionId: string): Promise<number> {
    const m = this.get(sessionId);
    if (!m || !m.vpsCwd) return 0;
    const file = sessionFilePath(m.vpsCwd, sessionId, this.cfg());
    if (!fs.existsSync(file)) return 0;
    let names = this.toolNames.get(sessionId);
    if (!names) {
      names = new Map();
      this.toolNames.set(sessionId, names);
      await this.scanToolNames(file, m.feedOffset, names);
    }
    const r = await this.feedFrom(sessionId, file, m.feedOffset, 'vps', names);
    if (r.next !== m.feedOffset) {
      const cur = this.get(sessionId);
      if (cur) { cur.feedOffset = r.next; this.d.db.run('UPDATE pc_session_moves SET feed_offset = ? WHERE session_id = ?', r.next, sessionId); }
    }
    return r.stored;
  }

  private async scanToolNames(file: string, upTo: number, names: Map<string, string>): Promise<void> {
    if (upTo <= 0) return;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { end: upTo - 1, encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const l of rl) {
      if (!l.includes('"tool_use"')) continue;
      try { compactLine(JSON.parse(l), { toolNames: names }); } catch { /* not a line */ }
    }
  }

  /** Reads complete lines of `file` from byte `from`, maps and stores them. Returns the offset after the last complete line. */
  private async feedFrom(sessionId: string, file: string, from: number, machine: string | null, names: Map<string, string>): Promise<{ stored: number; next: number }> {
    const size = fs.statSync(file).size;
    if (from >= size) return { stored: 0, next: from };
    const fd = fs.openSync(file, 'r');
    const entries: ReturnType<typeof compactLine> = [];
    let next = from;
    try {
      const CH = 1 << 20;
      let carry = Buffer.alloc(0);
      let pos = from;
      while (pos < size) {
        const len = Math.min(CH, size - pos);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        pos += len;
        let data = Buffer.concat([carry, buf]);
        const base = pos - data.length;
        let start = 0;
        for (;;) {
          const nl = data.indexOf(0x0a, start);
          if (nl < 0) break;
          const line = data.subarray(start, nl).toString('utf8');
          if (line.trim()) {
            try { entries.push(...compactLine(JSON.parse(line), { toolNames: names, lineKey: base + start, fallbackAt: Date.now() })); } catch { /* a partial or foreign line */ }
          }
          start = nl + 1;
          next = base + start;
        }
        carry = data.subarray(start);
        data = Buffer.alloc(0);
      }
    } finally {
      fs.closeSync(fd);
    }
    const r = entries.length ? this.d.pcSessions.appendServerEntries(sessionId, machine, entries) : { stored: 0 };
    return { stored: r?.stored ?? 0, next };
  }

  // ---------- git on the VPS copy ----------

  private async git(cwd: string, args: string[]): Promise<string> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-move-'));
    try { return await hardenedGit(cwd, args, scratch); } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  private async addWorktree(repoDir: string, wt: string, branch: string): Promise<void> {
    await this.removeWorktree(repoDir, wt).catch(() => undefined);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await this.git(repoDir, ['worktree', 'add', '-q', '--', wt, branch]);
  }

  private async removeWorktree(repoDir: string, wt: string): Promise<void> {
    try { await this.git(repoDir, ['worktree', 'remove', '--force', '--', wt]); } catch { /* not registered */ }
    fs.rmSync(wt, { recursive: true, force: true });
    try { await this.git(repoDir, ['worktree', 'prune']); } catch { /* nothing to prune */ }
  }

  /**
   * Commits whatever the worktree changed to the wip branch (identity "PocketRocket offload <bot>"), and only if the
   * worktree is still on that branch. Returns a note for the room, or ''. Never pushes.
   */
  async commitWork(m: MoveRow, message: string): Promise<string> {
    const notes: string[] = [];
    const room = m.roomId ? this.d.repos.getRoom(m.roomId) : undefined;
    const bot = room ? this.botFor(room) : null;
    const who = 'PocketRocket offload ' + (bot?.handle ?? 'bot');
    for (const r of m.repos) {
      const wt = this.worktreePath(r, r.branch);
      if (!fs.existsSync(wt)) continue;
      const head = (await this.git(wt, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
      if (head !== 'refs/heads/' + r.branch) {
        notes.push(r.repo + ': the worktree is no longer on ' + r.branch + ', so nothing was committed there.');
        continue;
      }
      await this.git(wt, ['add', '-A']);
      if (!(await this.git(wt, ['status', '--porcelain'])).trim()) continue;
      await this.git(wt, [
        '-c', 'user.name=' + who, '-c', 'user.email=offload@pocketrocket.local', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--no-verify', '-m', message,
      ]);
      notes.push(r.repo + ': changes committed to ' + r.branch + '.');
    }
    return notes.join(' ');
  }

  // ---------- pull ----------

  /** Creates the pull job (queued: the caller has the owner's approval) and marks the session 'pulling'. */
  async startPull(sessionId: string, o: { botId?: string | null; fromRoomId?: string | null } = {}): Promise<PcJob> {
    const m = this.get(sessionId);
    if (!m) throw new SessionMoveError(404, 'That session never moved.');
    if (m.state !== 'on-vps') throw new SessionMoveError(409, m.state === 'local' ? 'That session is already back on your PC.' : 'That session is ' + m.state + ', not on the VPS.');
    if (this.running.has(sessionId)) throw new SessionMoveError(409, 'A turn is running on that session. Wait for it to finish.');
    if (this.openJobFor(sessionId)) throw new SessionMoveError(409, 'That session already has a job waiting or running on the PC.');
    // Whatever the VPS left uncommitted travels as a commit on the wip branch.
    try { await this.commitWork(m, 'VPS work before pull-back'); } catch (e) { throw new SessionMoveError(500, 'Could not commit the VPS work: ' + redact((e as Error).message)); }
    await this.feed(sessionId).catch(() => 0);
    const pull: PcPullJobInfo = {
      turns: m.turns,
      repos: m.repos.map((r) => ({ project: r.project, repo: r.repo, remote: r.remote, mode: 'bundle' as const, protected: r.protected, branch: r.branch, baseCommit: r.base ?? '' })),
    };
    const job = this.d.pcRunner.create({
      mode: 'pull', sessionId, folder: null, origin: o.botId ? 'bot' : 'owner', botId: o.botId ?? null, roomId: o.fromRoomId ?? null,
      prompt: 'Pull ' + sessionId + ' back from the VPS', pull,
    });
    m.state = 'pulling';
    m.pullJobId = job.id;
    this.save(m);
    this.d.pcRunner.approve(job.id);
    return this.d.pcRunner.get(job.id)!;
  }

  private pullRow(job: PcJob): MoveRow {
    const m = job.sessionId ? this.get(job.sessionId) : null;
    if (!m || m.state !== 'pulling' || m.pullJobId !== job.id || !m.vpsCwd || !m.pcRoot) throw new SessionMoveError(409, 'That session is not being pulled by this job.');
    return m;
  }

  /** The session file with the VPS worktree swapped back for the PC's folder: the exact inverse of the move rewrite. Written to a temp file the caller streams and removes. */
  async pullSessionFile(job: PcJob): Promise<{ file: string; bytes: number; sha256: string }> {
    const m = this.pullRow(job);
    const src = sessionFilePath(m.vpsCwd!, m.sessionId, this.cfg());
    if (!fs.existsSync(src)) throw new SessionMoveError(409, 'The session file is missing on the VPS.');
    const dest = path.join(this.d.dir, job.id + '.pull.jsonl');
    const r = await rewriteSessionFile(src, dest, m.vpsCwd!, m.pcRoot!);
    return { file: dest, bytes: r.bytes, sha256: r.sha256 };
  }

  /** A git bundle of one repo's wip branch, to stream to the runner and remove. */
  async pullBundle(job: PcJob, repoName: string): Promise<string> {
    const m = this.pullRow(job);
    const r = m.repos.find((x) => x.repo === repoName);
    if (!r) throw new SessionMoveError(404, 'Not a repo of this pull.');
    const dir = vpsDir(this.d.projects.dirOf(r.project), r.vps);
    const file = path.join(this.d.dir, job.id + '.' + r.repo + '.bundle');
    fs.mkdirSync(this.d.dir, { recursive: true });
    fs.rmSync(file, { force: true });
    await this.git(dir, ['bundle', 'create', '-q', file, 'refs/heads/' + r.branch]);
    return file;
  }

  /** The PC took the session and the branches home: the worktrees and the VPS copy of the file go, the session is local again. */
  async finalizePull(job: PcJob, result: PcPullResult): Promise<void> {
    const m = this.pullRow(job);
    const want = new Set(m.repos.map((r) => r.repo));
    const got = new Set(result.repos.map((r) => r.repo));
    if (want.size !== got.size || [...want].some((r) => !got.has(r))) throw new SessionMoveError(400, 'The pull result does not list exactly the job\'s repos.');
    const file = sessionFilePath(m.vpsCwd!, m.sessionId, this.cfg());
    for (const r of m.repos) await this.removeWorktree(vpsDir(this.d.projects.dirOf(r.project), r.vps), this.worktreePath(r, r.branch));
    fs.rmSync(file, { force: true });
    this.toolNames.delete(m.sessionId);
    // The PC's mirror carries on from the end of the file it now has.
    this.d.pcSessions.setOffset(m.sessionId, result.sessionBytes);
    m.state = 'local';
    m.pulledAt = Date.now();
    m.vpsCwd = null;
    this.save(m);
    const room = m.roomId ? this.d.repos.getRoom(m.roomId) : undefined;
    if (room) this.post(room.id, 'Session "' + (this.d.pcSessions.get(m.sessionId)?.title ?? m.sessionId) + '" is back on your PC (' + result.repos.map((r) => r.repo + (r.applied ? ': changes applied' : ': kept on the wip branch')).join('; ') + ').');
  }

  private post(roomId: string, text: string): void {
    try {
      const msg = this.d.repos.insertMessage({ roomId, authorType: 'system', authorId: null, kind: 'system', text, payload: null, causeId: nanoid(10), hop: 0, turnId: null });
      events.emitEvent({ type: 'message.new', message: msg });
    } catch (e) {
      logError('[session-moves] post', e);
    }
  }
}
