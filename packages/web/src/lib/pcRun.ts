// Bridge P4: the app drives the PC. Pure helpers for "Continue on PC" (resume a mirrored session) and "Run on PC"
// (a new run in an allowed folder), plus the job status labels. Kept free of React so they are easy to test.
import type { PcJobStatus, PcRunnerJob, PcRunnerStatus } from '@pocketrocket/shared';
import type { PcMoveRequest } from './pcMove';

/** A job as the hub sends it. Owner-started jobs (origin 'owner') carry a bot and room with null fields. */
export type PcJobView = PcRunnerJob;

/** POST /api/pc-runner/jobs */
export type PcJobRequest =
  | { mode: 'resume'; sessionId: string; prompt: string }
  | { mode: 'new'; folder: string; prompt: string }
  // Bridge P5: snapshot the session's working tree and push it (the hub refuses client repos and sync "none").
  | { mode: 'sync'; sessionId: string; project: string; repo: string }
  // Bridge P6: move the session (and its bundle-synced repos) to the VPS, or pull it back.
  | PcMoveRequest;

export const PC_PROMPT_MAX = 8000;

export const JOB_STATUS: Record<PcJobStatus, { label: string; tone: 'muted' | 'ok' | 'warn' | 'bad' | 'accent' }> = {
  pending_approval: { label: 'Waiting for you', tone: 'warn' },
  queued: { label: 'Waiting for your PC', tone: 'muted' },
  claimed: { label: 'Picked up', tone: 'accent' },
  running: { label: 'Running', tone: 'accent' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  refused: { label: 'Refused on PC', tone: 'warn' },
  expired: { label: 'Expired', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export function statusLabel(s: PcJobStatus): string {
  return JOB_STATUS[s]?.label ?? s;
}

/** Still moving: show a live status rather than a result. */
export function jobActive(s: PcJobStatus): boolean {
  return s === 'queued' || s === 'claimed' || s === 'running' || s === 'pending_approval';
}

export function resumeBody(sessionId: string, prompt: string): PcJobRequest {
  return { mode: 'resume', sessionId, prompt: prompt.trim() };
}

export function newRunBody(folder: string, prompt: string): PcJobRequest {
  return { mode: 'new', folder, prompt: prompt.trim() };
}

/** A subagent mirror id contains ':'; only a top-level session can be resumed. */
export function canResume(sessionId: string): boolean {
  return !sessionId.includes(':');
}

/**
 * Why the PC cannot be started from here right now, or null when it can. The hub's 403 / 409 stay the real
 * gate; this only saves a round trip and says why. `status` null means it has not loaded yet.
 */
export function pcBlockedReason(o: { status: Pick<PcRunnerStatus, 'paired' | 'online'> | null; signedIn: boolean }): string | null {
  if (!o.signedIn) return 'Sign in with your password to run things on your PC. The hub token alone cannot approve a run.';
  if (!o.status) return 'Checking your PC…';
  if (!o.status.paired) return 'No PC is paired. Pair one in Settings > PC runner.';
  if (!o.status.online) return 'Your PC is offline. Start the Toki helper on it.';
  return null;
}

/** Whether a prompt can be sent: non-empty after trimming and within the hub's limit. */
export function promptOk(prompt: string): boolean {
  const n = prompt.trim().length;
  return n > 0 && n <= PC_PROMPT_MAX;
}

export function modeLabel(j: { mode?: string }): string {
  const m = j.mode as string | undefined;
  return m === 'resume' ? 'Resume' : m === 'sync' ? 'Sync' : m === 'move' ? 'Move' : m === 'pull' ? 'Pull' : 'New';
}

export function originLabel(j: Partial<Pick<PcJobView, 'origin'>>): string {
  return j.origin === 'owner' ? 'You' : 'Bot';
}
