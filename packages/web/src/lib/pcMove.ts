// Bridge P6: move a mirrored PC session to the VPS and pull it back. Pure helpers, no React.
import type { PcMoveJobInfo, PcMoveResult, PcMoveState, PcPullJobInfo, PcPullResult, PcRunnerJob, PcSessionMove } from '@pocketrocket/shared';
import type { PcSessionLink, ProjectRepo } from './projectRepos';

export type { PcMoveJobInfo, PcMoveResult, PcMoveState, PcPullJobInfo, PcPullResult, PcSessionMove };
/** The hub's job view already carries move / pull and their results. */
export type PcJobWithMove = PcRunnerJob;

/** POST /api/pc-runner/jobs bodies added by P6. */
export type PcMoveRequest = { mode: 'move'; sessionId: string; room?: string } | { mode: 'pull'; sessionId: string };

export const moveOf = (s: object): PcSessionMove | null => (s as { move?: PcSessionMove | null }).move ?? null;
export const isOnVps = (s: object): boolean => { const m = moveOf(s); return !!m && m.state !== 'local'; };

const BADGE: Record<Exclude<PcMoveState, 'local'>, { label: string; tone: 'accent' | 'warn' }> = {
  'on-vps': { label: 'On VPS', tone: 'accent' },
  moving: { label: 'Moving to VPS', tone: 'warn' },
  pulling: { label: 'Pulling back', tone: 'warn' },
};
/** The badge for a list row or header; null for a session that lives on the PC. */
export function moveBadge(s: object): { label: string; tone: 'accent' | 'warn' } | null {
  const m = moveOf(s);
  return m && m.state !== 'local' ? BADGE[m.state] : null;
}

export function moveBody(sessionId: string, room?: string | null): PcMoveRequest {
  return room ? { mode: 'move', sessionId, room } : { mode: 'move', sessionId };
}
export const pullBody = (sessionId: string): PcMoveRequest => ({ mode: 'pull', sessionId });
export const continueBody = (prompt: string) => ({ prompt: prompt.trim() });

/** Why one linked repo cannot move, or null. Moves are bundle-only and never for client repos (until sandboxing). */
export function moveRepoReason(repo: ProjectRepo | undefined): string | null {
  if (!repo) return 'This repo is no longer in the project. Check Settings > Projects.';
  if (repo.client) return 'Client repo: it stays on your PC until bots are sandboxed.';
  if (repo.sync !== 'bundle') return 'Moving needs bundle sync. Set this repo to "Sync to VPS" in Settings > Projects.';
  return null;
}

/**
 * Why Move to VPS is disabled, or null. Order: PC offline / not signed in, no linked repo, then the first repo that
 * cannot move. `repos` maps a project slug to its list; a missing key has not loaded yet. The hub stays the real gate.
 */
export function moveBlockedReason(o: { links: PcSessionLink[]; repos: Record<string, ProjectRepo[] | undefined>; pcBlocked: string | null }): string | null {
  if (o.pcBlocked) return o.pcBlocked;
  if (o.links.length === 0) return 'This session is not linked to a project repo. Add the repo in Settings > Projects first.';
  for (const l of o.links) {
    const list = o.repos[l.project];
    if (list === undefined) return 'Checking the repo settings…';
    const why = moveRepoReason(list.find((r) => r.name === l.repo));
    if (why) return l.repo + ': ' + why;
  }
  return null;
}

/** Why Pull back is disabled, or null. A turn running on the VPS must finish first. */
export function pullBlockedReason(move: PcSessionMove | null, pcBlocked: string | null): string | null {
  if (pcBlocked) return pcBlocked;
  if (move?.state === 'pulling') return 'Already pulling back.';
  if (move?.turnRunning) return 'A turn is running on the VPS. Pull back once it finishes.';
  return null;
}

/** Why Continue on VPS cannot send right now, or null. */
export function continueBlockedReason(move: PcSessionMove | null, signedIn: boolean): string | null {
  if (!signedIn) return 'Sign in with your password to send a turn. The hub token alone cannot.';
  if (move?.state === 'pulling') return 'This session is being pulled back to your PC.';
  if (move?.turnRunning) return 'A turn is running. One at a time.';
  return null;
}

/** Rooms that can own the VPS turns: the project's own room first, then group chats holding all its members. */
export function roomChoices(
  project: { roomId: string | null; memberIds: string[] } | undefined,
  rooms: Array<{ id: string; name: string; kind: string; memberIds: string[] }>,
): Array<{ id: string; name: string }> {
  if (!project) return [];
  const own = rooms.filter((r) => r.id === project.roomId);
  const others = project.memberIds.length ? rooms.filter((r) => r.id !== project.roomId && r.kind === 'group' && project.memberIds.every((m) => r.memberIds.includes(m))) : [];
  return [...own, ...others].map((r) => ({ id: r.id, name: r.name }));
}

export function pullConfirmText(move: PcSessionMove | null): string {
  const repos = move?.repos.length ? ' (' + move.repos.map((r) => r.repo).join(', ') + ')' : '';
  return 'Your PC fetches the session and the VPS work' + repos + '. If your folder has not changed since the move, the edits land as uncommitted changes without moving your branch; otherwise they stay on a wip branch for you to merge. Your PC still asks before it runs.';
}

/** One repo of a move or pull result, as the job log shows it: a move has the branch, a pull says whether it was applied. */
export interface PcMoveRepoResult { repo: string; commit: string; branch?: string; applied?: boolean }
export interface PcMoveResultView { repos: PcMoveRepoResult[]; sessionBytes: number }
export const moveResultOf = (j: Partial<PcJobWithMove>): PcMoveResultView | null => j.moveResult ?? null;
export const pullResultOf = (j: Partial<PcJobWithMove>): PcMoveResultView | null => j.pullResult ?? null;

/** The repos a move/pull job covers, from the request or, failing that, the result. */
export function jobRepos(j: Partial<PcJobWithMove>): string[] {
  const pull = (j.mode as string) === 'pull';
  const asked = pull ? j.pull?.repos : j.move?.repos;
  if (asked?.length) return asked.map((r) => r.project + ' / ' + r.repo);
  return (pull ? j.pullResult : j.moveResult)?.repos.map((r) => r.repo) ?? [];
}

/** The applied / not applied note for one pulled repo; empty for a move. */
export function appliedNote(r: PcMoveRepoResult): string {
  if (r.applied === undefined) return '';
  return r.applied ? 'Applied to your folder as uncommitted edits' : 'Your folder changed since the move; merge the wip branch yourself';
}
