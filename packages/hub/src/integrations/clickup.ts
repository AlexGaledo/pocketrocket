import { ApiClient, clip, type PollResult } from './base.js';
import { IntegrationError } from './http.js';

const API = 'https://api.clickup.com/api/v2';

export interface CuTask {
  id: string; name: string; status: string; url: string; list: string; listId: string;
  assignees: string[]; dueDate: string | null; dateUpdated: string; description?: string;
}
type RawTask = {
  id: string; name: string; status?: { status: string }; url: string; list?: { id: string; name: string };
  assignees?: Array<{ username?: string; email?: string }>; due_date?: string | null; date_updated: string; description?: string;
};
const toTask = (t: RawTask, withDescription = false): CuTask => ({
  id: t.id, name: t.name, status: t.status?.status ?? '', url: t.url, list: t.list?.name ?? '', listId: t.list?.id ?? '',
  assignees: (t.assignees ?? []).map((a) => a.username || a.email || ''), dueDate: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
  dateUpdated: new Date(Number(t.date_updated)).toISOString(),
  ...(withDescription ? { description: clip(t.description ?? '', 8_000) } : {}),
});
const id = (v: string, what: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new IntegrationError('Bad ClickUp ' + what + ' id "' + v + '"', 400);
  return v;
};

export class ClickUpClient extends ApiClient {
  /** ClickUp takes the token bare in Authorization, with no `Bearer` (pk_ tokens; also used for OAuth tokens — unverified). */
  protected override authHeader(token: string): string {
    return token;
  }

  async whoami(): Promise<{ username: string; email: string }> {
    const r = await this.call<{ user: { username: string; email: string } }>(API + '/user');
    return { username: r.data.user.username, email: r.data.user.email };
  }

  /** Workspaces ("teams" in API v2). */
  async workspaces(): Promise<Array<{ id: string; name: string }>> {
    const r = await this.call<{ teams: Array<{ id: string; name: string }> }>(API + '/team');
    return r.data.teams.map((t) => ({ id: t.id, name: t.name }));
  }

  /** Every list in a workspace (folderless and inside folders), so a bot can find where to create a task. */
  async lists(workspaceId?: string): Promise<Array<{ id: string; name: string; space: string; folder: string | null }>> {
    const team = workspaceId ? id(workspaceId, 'workspace') : (await this.workspaces())[0]?.id;
    if (!team) return [];
    const spaces = (await this.call<{ spaces: Array<{ id: string; name: string }> }>(API + '/team/' + team + '/space', { query: { archived: false } })).data.spaces;
    const out: Array<{ id: string; name: string; space: string; folder: string | null }> = [];
    for (const s of spaces.slice(0, 20)) {
      const loose = (await this.call<{ lists: Array<{ id: string; name: string }> }>(API + '/space/' + s.id + '/list', { query: { archived: false } })).data.lists;
      for (const l of loose) out.push({ id: l.id, name: l.name, space: s.name, folder: null });
      const folders = (await this.call<{ folders: Array<{ name: string; lists: Array<{ id: string; name: string }> }> }>(API + '/space/' + s.id + '/folder', { query: { archived: false } })).data.folders;
      for (const f of folders) for (const l of f.lists) out.push({ id: l.id, name: l.name, space: s.name, folder: f.name });
    }
    return out;
  }

  async listTasks(listId: string, o: { includeClosed?: boolean; page?: number } = {}): Promise<CuTask[]> {
    const r = await this.call<{ tasks: RawTask[] }>(API + '/list/' + id(listId, 'list') + '/task', { query: { include_closed: o.includeClosed, page: o.page ?? 0 } });
    return r.data.tasks.map((t) => toTask(t));
  }

  /** Tasks across a workspace, filtered by name (ClickUp v2 has no full-text search; this matches on name). */
  async searchTasks(o: { query?: string; workspaceId?: string; includeClosed?: boolean; limit?: number } = {}): Promise<CuTask[]> {
    const team = o.workspaceId ? id(o.workspaceId, 'workspace') : (await this.workspaces())[0]?.id;
    if (!team) return [];
    const q = (o.query ?? '').toLowerCase();
    const out: CuTask[] = [];
    for (let page = 0; page < 5 && out.length < (o.limit ?? 25); page++) {
      const r = await this.call<{ tasks: RawTask[]; last_page?: boolean }>(API + '/team/' + team + '/task', {
        query: { include_closed: o.includeClosed, order_by: 'updated', page },
      });
      for (const t of r.data.tasks) if (!q || t.name.toLowerCase().includes(q)) out.push(toTask(t));
      if (r.data.last_page !== false && r.data.tasks.length < 100) break;
    }
    return out.slice(0, o.limit ?? 25);
  }

  async readTask(taskId: string): Promise<CuTask> {
    return toTask((await this.call<RawTask>(API + '/task/' + id(taskId, 'task'))).data, true);
  }

  async createTask(listId: string, t: { name: string; description?: string; dueDate?: string; priority?: 1 | 2 | 3 | 4 }): Promise<CuTask> {
    const r = await this.call<RawTask>(API + '/list/' + id(listId, 'list') + '/task', {
      method: 'POST',
      json: { name: t.name, description: t.description, priority: t.priority, due_date: t.dueDate ? Date.parse(t.dueDate) : undefined },
    });
    return toTask(r.data);
  }

  async comment(taskId: string, text: string): Promise<{ id: string }> {
    const r = await this.call<{ id: string | number }>(API + '/task/' + id(taskId, 'task') + '/comment', { method: 'POST', json: { comment_text: text, notify_all: false } });
    return { id: String(r.data.id) };
  }

  /**
   * Poll API (P5): tasks updated after `cursor` (milliseconds since epoch, as a string), newest cursor back.
   * Rate limit is 100 requests/min on Free/Business plans; poll no faster than once a minute per workspace.
   */
  async pollTasks(o: { workspaceId: string; cursor?: string | null }): Promise<PollResult<CuTask>> {
    const since = o.cursor ? Number(o.cursor) : Date.now() - 60_000;
    const r = await this.call<{ tasks: RawTask[] }>(API + '/team/' + id(o.workspaceId, 'workspace') + '/task', {
      query: { date_updated_gt: since, order_by: 'updated', include_closed: true, subtasks: true },
    });
    const max = r.data.tasks.reduce((m, t) => Math.max(m, Number(t.date_updated) || 0), since);
    return { items: r.data.tasks.map((t) => toTask(t)), cursor: String(max), notModified: r.data.tasks.length === 0, resync: false };
  }
}
