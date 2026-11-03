import { ApiClient, clip, type PollResult } from './base.js';
import { IntegrationError } from './http.js';

const API = 'https://api.github.com';
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

export interface GhIssue {
  repo: string;
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  author: string;
  labels: string[];
  updatedAt: string;
  url: string;
}
export interface GhNotification {
  id: string;
  repo: string;
  reason: string;
  unread: boolean;
  type: string;
  title: string;
  /** API URL of the subject (issue, PR, release …). */
  subjectUrl: string | null;
  updatedAt: string;
}

type RawIssue = {
  number: number; title: string; state: string; html_url: string; updated_at: string; repository_url?: string;
  user?: { login: string }; labels?: Array<{ name: string } | string>; pull_request?: unknown; body?: string | null;
};

function toIssue(r: RawIssue, repo?: string): GhIssue {
  return {
    repo: repo ?? (r.repository_url ?? '').replace(API + '/repos/', ''),
    number: r.number,
    title: r.title,
    state: r.state,
    isPullRequest: !!r.pull_request,
    author: r.user?.login ?? '',
    labels: (r.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    updatedAt: r.updated_at,
    url: r.html_url,
  };
}

/** `owner/name`, validated so it cannot walk to another API path. */
export function repoPath(repo: string): string {
  const r = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) throw new IntegrationError('Repository must look like owner/name, got "' + repo + '"', 400);
  return r;
}

export class GitHubClient extends ApiClient {
  /** Login and granted scopes (classic tokens report them in X-OAuth-Scopes; fine-grained PATs report none). */
  async whoami(): Promise<{ login: string; scopes: string[] }> {
    const r = await this.call<{ login: string }>(API + '/user', { headers: HEADERS });
    const scopes = (r.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { login: r.data.login, scopes };
  }

  /** GitHub search syntax, e.g. `is:open is:pr review-requested:@me` or `repo:o/r label:bug`. */
  async searchIssues(q: string, limit = 20): Promise<GhIssue[]> {
    const r = await this.call<{ items: RawIssue[] }>(API + '/search/issues', { headers: HEADERS, query: { q, per_page: Math.min(limit, 50) } });
    return r.data.items.map((i) => toIssue(i));
  }

  async listIssues(repo: string, o: { kind?: 'issues' | 'prs' | 'all'; state?: 'open' | 'closed' | 'all'; labels?: string; limit?: number } = {}): Promise<GhIssue[]> {
    const rp = repoPath(repo);
    const per = Math.min(o.limit ?? 20, 50);
    if (o.kind === 'prs') {
      const r = await this.call<RawIssue[]>(API + '/repos/' + rp + '/pulls', { headers: HEADERS, query: { state: o.state ?? 'open', per_page: per } });
      return r.data.map((i) => ({ ...toIssue(i, rp), isPullRequest: true }));
    }
    const r = await this.call<RawIssue[]>(API + '/repos/' + rp + '/issues', { headers: HEADERS, query: { state: o.state ?? 'open', labels: o.labels, per_page: per } });
    const all = r.data.map((i) => toIssue(i, rp));
    return o.kind === 'issues' ? all.filter((i) => !i.isPullRequest) : all;
  }

  /** One issue or PR with its body and latest comments. */
  async readIssue(repo: string, number: number, comments = 20): Promise<GhIssue & { body: string; comments: Array<{ author: string; body: string; createdAt: string }> }> {
    const rp = repoPath(repo);
    const r = await this.call<RawIssue>(API + '/repos/' + rp + '/issues/' + number, { headers: HEADERS });
    const c = await this.call<Array<{ user?: { login: string }; body: string; created_at: string }>>(
      API + '/repos/' + rp + '/issues/' + number + '/comments', { headers: HEADERS, query: { per_page: Math.min(comments, 50) } },
    );
    return {
      ...toIssue(r.data, rp),
      body: clip(r.data.body ?? '', 10_000),
      comments: c.data.map((x) => ({ author: x.user?.login ?? '', body: clip(x.body ?? '', 4_000), createdAt: x.created_at })),
    };
  }

  async notifications(o: { all?: boolean; participating?: boolean; limit?: number } = {}): Promise<GhNotification[]> {
    const r = await this.call<RawNotification[]>(API + '/notifications', {
      headers: HEADERS, query: { all: o.all, participating: o.participating, per_page: Math.min(o.limit ?? 30, 50) },
    });
    return r.data.map(toNotification);
  }

  /**
   * Poll API (P5). Conditional on `Last-Modified`: GitHub answers 304 when nothing changed, and a 304
   * does not count against the rate limit. `cursor` is the Last-Modified value to send back.
   */
  async pollNotifications(o: { cursor?: string | null } = {}): Promise<PollResult<GhNotification>> {
    const r = await this.call<RawNotification[]>(API + '/notifications', { headers: HEADERS, ifModifiedSince: o.cursor ?? null, query: { per_page: 50 } });
    const interval = Number(r.headers.get('x-poll-interval')) || undefined;
    if (r.notModified) return { items: [], cursor: o.cursor ?? null, notModified: true, resync: false, pollIntervalSec: interval };
    return { items: r.data.map(toNotification), cursor: r.headers.get('last-modified') ?? o.cursor ?? null, notModified: false, resync: false, pollIntervalSec: interval };
  }

  /**
   * Poll API (P5): a repo's event feed with ETag. `etag` from the last call makes an unchanged feed a free 304.
   */
  async pollRepoEvents(repo: string, o: { etag?: string | null } = {}): Promise<PollResult<{ id: string; type: string; actor: string; createdAt: string; payload: unknown }>> {
    const r = await this.call<Array<{ id: string; type: string; actor?: { login: string }; created_at: string; payload: unknown }>>(
      API + '/repos/' + repoPath(repo) + '/events', { headers: HEADERS, etag: o.etag ?? null, query: { per_page: 50 } },
    );
    const interval = Number(r.headers.get('x-poll-interval')) || undefined;
    if (r.notModified) return { items: [], cursor: null, etag: o.etag ?? null, notModified: true, resync: false, pollIntervalSec: interval };
    return {
      items: r.data.map((e) => ({ id: e.id, type: e.type, actor: e.actor?.login ?? '', createdAt: e.created_at, payload: e.payload })),
      cursor: r.data[0]?.id ?? null, etag: r.headers.get('etag'), notModified: false, resync: false, pollIntervalSec: interval,
    };
  }

  async createIssue(repo: string, i: { title: string; body?: string; labels?: string[] }): Promise<GhIssue> {
    const rp = repoPath(repo);
    const r = await this.call<RawIssue>(API + '/repos/' + rp + '/issues', { method: 'POST', headers: HEADERS, json: { title: i.title, body: i.body, labels: i.labels } });
    return toIssue(r.data, rp);
  }

  async comment(repo: string, number: number, body: string): Promise<{ url: string }> {
    const r = await this.call<{ html_url: string }>(API + '/repos/' + repoPath(repo) + '/issues/' + number + '/comments', { method: 'POST', headers: HEADERS, json: { body } });
    return { url: r.data.html_url };
  }
}

type RawNotification = {
  id: string; reason: string; unread: boolean; updated_at: string;
  subject: { title: string; type: string; url: string | null }; repository: { full_name: string };
};
function toNotification(n: RawNotification): GhNotification {
  return {
    id: n.id, repo: n.repository.full_name, reason: n.reason, unread: n.unread, type: n.subject.type,
    title: n.subject.title, subjectUrl: n.subject.url, updatedAt: n.updated_at,
  };
}
