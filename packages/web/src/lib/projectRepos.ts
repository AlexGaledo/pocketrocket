// Bridge P5: per-project repo lists, the repo links on mirrored PC sessions and sync jobs. Pure helpers, no React.
// The hub never stores PC paths: a repo is its name plus a remote URL, and the PC finds the checkout itself.
import type { PcJobView } from './pcRun';

// TODO(bridge P5): from @pocketrocket/shared once hub/project-repos merges
export type RepoSyncMode = 'wip-branch' | 'bundle' | 'none';
export interface ProjectRepo {
  name: string;
  remote: string;
  sync: RepoSyncMode;
  protected: string[];
  client: boolean;
  /** Relative path under the project folder where a VPS copy lives. Default `repos/<name>`. */
  vps?: string;
}
export interface ProjectReposFile { repos: ProjectRepo[] }
/** `links` on a mirrored session summary. */
export interface PcSessionLink { project: string; repo: string }
export interface SyncScan { blocked: boolean; findings: string[] }
export interface SyncResultView { mode: 'wip-branch' | 'bundle'; branch?: string; commit: string; bundleBytes?: number; scan: SyncScan }
export interface SyncRequestView { project: string; repo: string; remote?: string; mode: 'wip-branch' | 'bundle'; protected?: string[] }
/** A job as the hub sends it once P5 lands: `sync` is the request; the runner's result may sit on `sync` or `syncResult`. */
export type PcJobWithSync = Omit<PcJobView, 'mode'> & {
  mode: PcJobView['mode'] | 'sync';
  sync?: Partial<SyncRequestView> & Partial<SyncResultView>;
  syncResult?: SyncResultView | null;
};

export const SYNC_LABEL: Record<RepoSyncMode, string> = { 'wip-branch': 'Push wip branch', bundle: 'Sync to VPS', none: 'Off' };
export const REPO_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const emptyRepo = (): ProjectRepo => ({ name: '', remote: '', sync: 'none', protected: [], client: false, vps: '' });

/** Same repo whatever way it was typed: https or scp-style, with or without .git, any host case, no credentials. */
export function normaliseRemote(raw: string): string {
  let s = raw.trim();
  const scp = /^[^\s@/]+@([^\s:/]+):(?!\/)(.+)$/.exec(s);
  if (scp) s = 'https://' + scp[1] + '/' + scp[2];
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(s);
  if (!url) return s.toLowerCase();
  const path = url[3].replace(/\/+$/, '').replace(/\.git$/i, '');
  return 'https://' + url[2].toLowerCase() + '/' + path;
}

export interface RepoIssue { index: number; field: 'name' | 'remote' | 'vps' | 'protected'; message: string; level: 'error' | 'warn' }

/** Client-side checks that mirror the hub's schema. The hub stays the real gate; its 400 text is shown too. */
export function validateRepos(repos: ProjectRepo[]): RepoIssue[] {
  const out: RepoIssue[] = [];
  const names = new Map<string, number>();
  const remotes = new Map<string, number>();
  repos.forEach((r, index) => {
    const err = (field: RepoIssue['field'], message: string) => out.push({ index, field, message, level: 'error' });
    const name = r.name.trim();
    if (!name) err('name', 'Give the repo a name.');
    else if (!REPO_NAME_RE.test(name)) err('name', 'Use lower-case letters, digits, - and _ (up to 41 characters, starting with a letter or digit).');
    else if (names.has(name)) err('name', 'Another repo here is already called ' + name + '.');
    if (name && !names.has(name)) names.set(name, index);
    const remote = r.remote.trim();
    if (!remote) err('remote', 'Add the remote URL, for example git@github.com:org/app.git.');
    else if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(remote)) err('remote', 'Leave the password out of the URL. Credentials are never stored.');
    else if (!/^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/.+|[^\s@/]+@[^\s:/]+:.+)$/i.test(remote)) err('remote', 'This does not look like a git remote URL.');
    else {
      const key = normaliseRemote(remote);
      const first = remotes.get(key);
      if (first !== undefined) out.push({ index, field: 'remote', level: 'warn', message: 'Same remote as ' + (repos[first].name.trim() || 'repo ' + (first + 1)) + '.' });
      else remotes.set(key, index);
    }
    const vps = (r.vps ?? '').trim();
    if (vps && (/^([a-z]:|[\\/])/i.test(vps) || vps.split(/[\\/]/).includes('..'))) err('vps', 'Use a relative folder inside the project, without "..".');
    if (r.protected.some((b) => !b.trim() || /\s/.test(b))) err('protected', 'Branch names cannot contain spaces.');
  });
  return out;
}
export const hasErrors = (issues: RepoIssue[]) => issues.some((i) => i.level === 'error');

/** The PUT body: trimmed, protected de-duplicated, a blank VPS folder left out so the hub applies its default. */
export function reposBody(repos: ProjectRepo[]): ProjectReposFile {
  return {
    repos: repos.map((r) => {
      const vps = (r.vps ?? '').trim();
      return {
        name: r.name.trim(),
        remote: r.remote.trim(),
        sync: r.sync,
        protected: [...new Set(r.protected.map((b) => b.trim()).filter(Boolean))],
        client: r.client,
        ...(vps ? { vps } : {}),
      };
    }),
  };
}

/** Why a sync cannot start for this repo, or null. `repo` undefined means the project's list has no such repo. */
export function syncBlockedReason(repo: ProjectRepo | undefined, pcBlocked: string | null): string | null {
  if (!repo) return 'This repo is no longer in the project. Check Settings > Projects.';
  if (repo.client) return 'Client repo: it stays on your PC until bots are sandboxed.';
  if (repo.sync === 'none') return 'Sync is off for this repo. Turn it on in Settings > Projects.';
  return pcBlocked;
}

export function syncActionLabel(repo: ProjectRepo | undefined): string {
  return repo && repo.sync !== 'none' ? SYNC_LABEL[repo.sync] : 'Sync';
}

export const linksOf = (s: object): PcSessionLink[] => (s as { links?: PcSessionLink[] }).links ?? [];

export function syncBody(sessionId: string, l: PcSessionLink) {
  return { mode: 'sync' as const, sessionId, project: l.project, repo: l.repo };
}

/** The runner's result for a sync job, wherever the hub put it. */
export function syncResultOf(j: Pick<PcJobWithSync, 'sync' | 'syncResult'>): SyncResultView | null {
  if (j.syncResult) return j.syncResult;
  const s = j.sync;
  return s && s.commit && s.scan ? (s as SyncResultView) : null;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}
