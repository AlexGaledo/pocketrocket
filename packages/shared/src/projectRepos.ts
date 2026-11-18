import { z } from 'zod';

/**
 * Project repo lists (Claude Code bridge P5, docs/specs/claude-code-bridge.md 5).
 *
 * A project folder holds `repos.json`, edited only by the owner (PUT /api/projects/:slug/repos). Repos are identified by
 * their remote URL and a name. The hub never stores a path on the owner's PC: the PC runner finds its own checkout
 * (session cwd -> git toplevel -> an `origin` whose normalised URL matches).
 */

export const REPO_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const REPO_SYNC_MODES = ['wip-branch', 'bundle', 'none'] as const;
export type RepoSyncMode = (typeof REPO_SYNC_MODES)[number];
/** Always protected, whatever a repo lists. */
export const ALWAYS_PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];
export const MAX_PROJECT_REPOS = 50;

/**
 * One canonical form for a git remote, so `git@GitHub.com:org/app.git`, `ssh://git@github.com/org/app` and
 * `https://github.com/org/app.git` compare equal: `https://<lower-case host>/<path>`.
 *
 * Credentials (`user:token@`) are dropped, a trailing `.git` and slashes are dropped, the host is lower-cased and the
 * path keeps its case. An ssh port is dropped (it is not an https port); an http(s) port is kept unless it is the
 * scheme's default. Returns null for anything that is not a remote with a host and a path: local paths, `file://`,
 * option-like text, `ext::` helpers, control characters. The runner keeps an identical copy; both are tested against the
 * same table (`projectRepos.test.ts` in shared and the runner's own test).
 */
export function normaliseRemote(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 500 || s.startsWith('-') || s.includes('::') || /[\u0000-\u001f\u007f\s\\]/.test(s)) return null;
  let host: string;
  let pathPart: string;
  let port = '';
  let scheme = 'ssh';
  const scheme3 = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (scheme3) {
    scheme = scheme3[1].toLowerCase();
    if (!['https', 'http', 'ssh', 'git'].includes(scheme)) return null;
    const rest = scheme3[2];
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    let authority = rest.slice(0, slash);
    pathPart = rest.slice(slash + 1);
    authority = authority.slice(authority.lastIndexOf('@') + 1);
    const m = /^([^:/]+)(?::(\d*))?$/.exec(authority);
    if (!m) return null;
    host = m[1];
    if (m[2]) port = m[2];
  } else {
    // scp-like: [user@]host:path (a Windows drive letter or a plain path has no such shape).
    const m = /^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(s);
    if (!m || m[1].length < 2) return null;
    host = m[1];
    pathPart = m[2];
  }
  host = host.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  pathPart = pathPart.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!pathPart || pathPart.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null;
  const keepPort = (scheme === 'https' || scheme === 'http') && port && port !== (scheme === 'https' ? '443' : '80');
  return 'https://' + host + (keepPort ? ':' + port : '') + '/' + pathPart;
}

/** A remote may be `https://user:token@host/...`; that is a credential, not a remote, and is refused at the door. */
export function remoteHasCredentials(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(raw.trim()) || /^https?:\/\/[^/@\s]+@/i.test(raw.trim());
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const branchOk = (b: string) => BRANCH_RE.test(b) && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.lock');
/** A path segment of `vps`. No dot-prefixed names: `.git` and `.incoming` are the hub's. */
const VPS_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True for a relative, forward-slash path under the project folder with no `..`, no absolute or drive forms. */
export function vpsPathOk(p: string): boolean {
  if (!p || p.length > 200 || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split('/');
  return segs.length <= 6 && segs.every((s) => VPS_SEGMENT_RE.test(s) && s !== '..');
}

export const ProjectRepoSchema = z
  .object({
    name: z.string().regex(REPO_NAME_RE, 'name must be lower-case letters, numbers, - or _ (1 to 41 characters, starting with a letter or number)'),
    remote: z
      .string()
      .trim()
      .min(1, 'remote is required')
      .max(500)
      .refine((r) => !remoteHasCredentials(r), 'remote must not contain credentials: remove the user:token@ part')
      .refine((r) => normaliseRemote(r) !== null, 'remote must be a git URL such as git@github.com:org/app.git or https://github.com/org/app'),
    sync: z.enum(REPO_SYNC_MODES).default('none'),
    protected: z.array(z.string().refine(branchOk, 'not a branch name')).max(30).default([]),
    client: z.boolean().default(false),
    vps: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.vps !== undefined && !vpsPathOk(r.vps)) {
      ctx.addIssue({ code: 'custom', path: ['vps'], message: 'vps must be a relative folder under the project (no leading /, no .., no drive letter), such as repos/app' });
    }
  })
  .transform((r) => ({ ...r, vps: r.vps ?? 'repos/' + r.name, protected: [...new Set(r.protected)] }));

export const ProjectReposFileSchema = z
  .object({ repos: z.array(ProjectRepoSchema).max(MAX_PROJECT_REPOS) })
  .superRefine((f, ctx) => {
    const names = new Set<string>();
    const vpss = new Set<string>();
    f.repos.forEach((r, i) => {
      // An entry that already failed its own checks arrives untransformed.
      if (typeof r?.name !== 'string' || typeof r.vps !== 'string') return;
      if (names.has(r.name)) ctx.addIssue({ code: 'custom', path: ['repos', i, 'name'], message: 'duplicate repo name "' + r.name + '"' });
      names.add(r.name);
      const v = r.vps.toLowerCase();
      if (vpss.has(v)) ctx.addIssue({ code: 'custom', path: ['repos', i, 'vps'], message: 'two repos use the same vps folder "' + r.vps + '"' });
      vpss.add(v);
    });
  });

export type ProjectRepo = z.output<typeof ProjectRepoSchema>;
export type ProjectReposFile = z.output<typeof ProjectReposFileSchema>;

/** Which project repos a mirrored PC session belongs to (`PcSessionSummary.links`, computed at read). */
export interface PcSessionLink {
  project: string;
  repo: string;
}

/** What a sync job carries to the runner (`GET /api/pc-runner/jobs/next` -> `sync`). */
export interface PcSyncJobInfo {
  project: string;
  repo: string;
  /** The repo's remote as listed in repos.json; the runner compares its own `origin` through normaliseRemote(). */
  remote: string;
  mode: 'wip-branch' | 'bundle';
  /** The repo's protected branches plus main and master. A sync never touches one. */
  protected: string[];
}

/** What the runner reports for a sync job (`POST .../result` -> `sync`). Stored redacted. */
export interface PcSyncResult {
  mode: 'wip-branch' | 'bundle';
  branch?: string;
  commit: string;
  bundleBytes?: number;
  scan: { blocked: boolean; findings: string[] };
}

/** What the hub did with an uploaded bundle (`PcRunnerJob.hubImport`). */
export interface PcSyncImport {
  /** The branch in the VPS copy. */
  branch: string;
  /** Relative to the project folder. */
  vps: string;
  bytes: number;
  at: number;
}

export const PC_BUNDLE_MAX_BYTES = 200 * 1024 * 1024;

/** `wip/<machine>/<first 8 of the session id>`: the one ref a sync is allowed to write. */
export function wipBranchName(machine: string, sessionId: string): string {
  // Same rule as the PC runner's sanitizeMachine (scripts/pc-runner/sync.mjs), so both name the same branch.
  const m = machine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '') || 'pc';
  const s = sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'session';
  return 'wip/' + m + '/' + s;
}
