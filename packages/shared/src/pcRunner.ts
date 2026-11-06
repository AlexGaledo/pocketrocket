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

/** One row of GET /api/pc-runner/jobs (owner only). */
export interface PcRunnerJob {
  id: string;
  bot: { id: string; handle: string | null };
  room: { id: string; name: string | null };
  folder: string;
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
