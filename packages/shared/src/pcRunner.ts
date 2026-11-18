// The owner's PC as a Claude Code job runner (hub: services/PcRunner.ts, api/pcRunner.ts).

export type PcJobStatus = 'pending_approval' | 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'refused' | 'expired' | 'cancelled';

/** GET /api/pc-runner */
export interface PcRunnerStatus {
  paired: boolean;
  /** Folder names the PC allows. Names only: the PC maps them to real paths. */
  folders: string[];
  lastSeenAt: number | null;
  online: boolean;
}

/** A new job in an allowed folder, or a resume of a mirrored Claude Code session (bridge P4). */
export type PcJobMode = 'new' | 'resume';
/** Who asked: a bot's run_on_pc call, or the owner from the app (POST /api/pc-runner/jobs). */
export type PcJobOrigin = 'bot' | 'owner';

/** One row of GET /api/pc-runner/jobs (owner only). */
export interface PcRunnerJob {
  id: string;
  /** `id` and `handle` are null for a job the owner started from the app (origin 'owner'). */
  bot: { id: string | null; handle: string | null };
  room: { id: string | null; name: string | null };
  mode: PcJobMode;
  /** The mirrored Claude Code session a resume job continues; null for mode 'new'. */
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
}

/** Body of POST /api/pc-runner/jobs (owner, signed-in browser only). */
export interface PcRunnerJobCreate {
  mode: PcJobMode;
  /** Required for mode 'resume': a session id in the PC session mirror (never a subagent id). */
  sessionId?: string;
  /** Required for mode 'new': one of the folder names the PC allows. */
  folder?: string;
  /** 1..8000 characters and at most 8 KB. */
  prompt: string;
}
