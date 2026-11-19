// The owner's PC as a Claude Code job runner (hub: services/PcRunner.ts, api/pcRunner.ts).

import type { PcSyncImport, PcSyncJobInfo, PcSyncResult } from './projectRepos.js';

export type PcJobStatus = 'pending_approval' | 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'refused' | 'expired' | 'cancelled';

/** GET /api/pc-runner */
export interface PcRunnerStatus {
  paired: boolean;
  /** Folder names the PC allows. Names only: the PC maps them to real paths. */
  folders: string[];
  lastSeenAt: number | null;
  online: boolean;
}

/**
 * A new job in an allowed folder, a resume of a mirrored Claude Code session (bridge P4), or a sync (bridge P5): the PC
 * snapshots that session's working tree without touching it and pushes a wip branch or uploads a git bundle.
 */
export type PcJobMode = 'new' | 'resume' | 'sync' | 'move' | 'pull';
/** Who asked: a bot's run_on_pc call, or the owner from the app (POST /api/pc-runner/jobs). */
export type PcJobOrigin = 'bot' | 'owner';

/** One row of GET /api/pc-runner/jobs (owner only). */
export interface PcRunnerJob {
  id: string;
  /** `id` and `handle` are null for a job the owner started from the app (origin 'owner'). */
  bot: { id: string | null; handle: string | null };
  room: { id: string | null; name: string | null };
  mode: PcJobMode;
  /** The mirrored Claude Code session a resume job continues, or whose working tree a sync snapshots; null for mode 'new'. */
  sessionId: string | null;
  origin: PcJobOrigin;
  /** The allowed folder: null for a resume (the PC resolves it, see `resolvedFolder`). */
  folder: string | null;
  /** The allowed folder NAME a resume ran in, as the PC reported it. */
  resolvedFolder: string | null;
  /** Set when the PC says the resume continued under a new session id instead of appending to the same one. */
  newSessionId: string | null;
  prompt: string;
  status: PcJobStatus;
  /** What the PC reported (done, failed). Redacted and capped at 20 KB by the hub. Plain text. */
  output: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** The owner said no in the prompt on the PC itself. */
  refusedLocally: boolean;
  /** Why the hub dropped it (cancelled, expired). */
  error: string | null;
  /** Sync jobs: which project repo and how. Null for the other modes. */
  sync: PcSyncJobInfo | null;
  /** Sync jobs: what the PC reported (commit, branch, pre-push scan). Null until it does. */
  syncResult: PcSyncResult | null;
  /** Bundle syncs: what the hub imported. Null until a bundle was accepted. */
  hubImport: PcSyncImport | null;
  /** Move jobs (bridge P6): the room that runs the VPS turns and the repos that travel. Null for the other modes. */
  move: PcMoveJobInfo | null;
  /** Move jobs: what the PC reported. Null until it does. */
  moveResult: PcMoveResult | null;
  /** Pull jobs (bridge P6): which wip branches come back and the snapshot each started from. Null for the other modes. */
  pull: PcPullJobInfo | null;
  /** Pull jobs: what the PC reported. Null until it does. */
  pullResult: PcPullResult | null;
}

/** One repo of a move job. A move is bundle mode only, and never a client repo. */
export type PcMoveRepoInfo = PcSyncJobInfo & { mode: 'bundle' };

/** What a move job carries to the runner (`GET /api/pc-runner/jobs/next` -> `move`). */
export interface PcMoveJobInfo {
  /** The room whose tools and permissions the VPS turns use. */
  room: string | null;
  /** The session's title, for the PC's one dialog. */
  title: string | null;
  repos: PcMoveRepoInfo[];
}

/** What the runner reports for a move job (`POST .../result` -> `move`). */
export interface PcMoveResult {
  /** `toplevel` is the repo's folder on the PC: the hub rewrites the session's paths from it. Without it the session's cwd stands in. */
  repos: { repo: string; commit: string; branch: string; toplevel?: string }[];
  sessionBytes: number;
}

/** What a pull job carries to the runner (`GET /api/pc-runner/jobs/next` -> `pull`). */
export interface PcPullJobInfo {
  /** `baseCommit` is the snapshot commit that was moved; `branch` is the one wip ref the pull may write. */
  repos: (PcSyncJobInfo & { branch: string; baseCommit: string })[];
  /** New turns the VPS ran, for the PC's dialog. */
  turns: number;
}

/** What the runner reports for a pull job (`POST .../result` -> `pull`). */
export interface PcPullResult {
  repos: { repo: string; commit: string; applied: boolean }[];
  sessionBytes: number;
}

/** Body of POST /api/pc-runner/jobs (owner, signed-in browser only). */
export interface PcRunnerJobCreate {
  mode: PcJobMode;
  /** Required for mode 'resume': a session id in the PC session mirror (never a subagent id). */
  sessionId?: string;
  /** Required for mode 'new': one of the folder names the PC allows. */
  folder?: string;
  /** 1..8000 characters and at most 8 KB. Required for 'new' and 'resume'; a sync takes none. */
  prompt?: string;
  /** Mode 'sync' (needs `sessionId`, `project`, `repo`): the project and the repo name from its repos.json. */
  project?: string;
  repo?: string;
  /** Mode 'move' (needs `sessionId`): the room whose tools the VPS turns use, when the session's repos sit in more than one project room. */
  room?: string;
}

/** The most a move job's session file may be (the .jsonl of one Claude Code session). */
export const PC_SESSION_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
