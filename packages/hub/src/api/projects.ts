import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { events } from '../events.js';
import { readBody } from './body.js';
import type { Repos } from '../db/repos.js';
import type { Db } from '../db/db.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import { ProjectError, type ProjectService } from '../services/ProjectService.js';
import { logError } from '../providers/redact.js';

const CreateInput = z.object({ name: z.string().trim().min(1).max(60), team: z.boolean().optional(), memberIds: z.array(z.string()).max(100).optional() });
const MembersInput = z.object({ memberIds: z.array(z.string()).max(100) });
const RoomLinkInput = z.object({ roomId: z.string().min(1).nullable() });

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

/**
 * `/api/projects/*`. Human-only: a paired phone is refused by deviceMayAccess and no bot tool reaches it, so only the
 * owner decides which bots work in which folder.
 *
 *   GET    /api/projects
 *   POST   /api/projects                { name, team?, memberIds? }; team clones the dev team template
 *   PUT    /api/projects/:slug/members  { memberIds }
 *   PUT    /api/projects/:slug/room     { roomId | null }; links a group chat to the folder
 *   GET    /api/projects/:slug/search   ?q=&archived=1, with no AI turn
 *   GET    /api/projects/:slug/lint     what has gone stale or messy
 *   GET    /api/projects/:slug/repos    { repos: ProjectRepo[] } from repos.json (bridge P5)
 *   GET    /api/projects/:slug/map      ProjectMapReply from map.json (Toki UI B2); a bad file is an `error`, not a failure
 *   GET    /api/projects/:slug/overview ProjectOverview parsed from current.md, with no AI turn (Toki UI B3)
 *   PUT    /api/projects/:slug/repos    { repos } -> saved file; 400 names every schema problem. Remotes only, never a PC path
 *   DELETE /api/projects/:slug          forgets it; the folder and any cloned bots stay
 *
 * Create, members, room and delete each emit `projects.changed` once (no payload: a paired phone gets every event).
 */
export function createProjectsApi(deps: { projects: ProjectService; repos: Repos; db?: Db }) {
  const { projects, repos, db } = deps;
  const changed = () => events.emitEvent({ type: 'projects.changed' });
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/projects' && !url.pathname.startsWith('/api/projects/')) return false;
    const method = req.method ?? 'GET';
    const parts = url.pathname.replace(/^\/api\/projects\/?/, '').replace(/\/$/, '').split('/').filter(Boolean).map(decodeURIComponent);
    let body: unknown;
    if (method === 'POST' || method === 'PUT') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    try {
      if (parts.length === 0) {
        if (method === 'GET') return send(res, 200, projects.list());
        if (method === 'POST') {
          const p = CreateInput.safeParse(body);
          if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
          const made = projects.create(p.data);
          if (made.bots.length) events.emitEvent({ type: 'bots.changed', bots: repos.listBots() });
          if (made.room) events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
          changed();
          return send(res, 200, made);
        }
      }
      const [slug, action] = parts;
      if (parts.length === 1 && method === 'DELETE') { projects.remove(slug); changed(); return send(res, 200, { ok: true }); }
      if (parts.length === 2 && action === 'members' && method === 'PUT') {
        const p = MembersInput.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
        projects.setMembers(slug, p.data.memberIds);
        changed();
        return send(res, 200, projects.need(slug));
      }
      if (parts.length === 2 && action === 'room' && method === 'PUT') {
        const p = RoomLinkInput.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
        projects.setRoom(slug, p.data.roomId);
        changed();
        return send(res, 200, projects.need(slug));
      }
      if (parts.length === 2 && action === 'search' && method === 'GET') {
        projects.need(slug);
        const q = url.searchParams.get('q') ?? '';
        if (!q.trim()) return send(res, 400, { error: 'q is required' });
        return send(res, 200, projects.search([slug], q, { includeArchived: url.searchParams.get('archived') === '1', limit: 10 }));
      }
      if (parts.length === 2 && action === 'lint' && method === 'GET') return send(res, 200, projects.lint(slug));
      if (parts.length === 2 && action === 'repos' && method === 'GET') {
        projects.need(slug);
        return send(res, 200, projects.reposFile(slug));
      }
      if (parts.length === 2 && action === 'map' && method === 'GET') return send(res, 200, projects.map(slug));
      if (parts.length === 2 && action === 'overview' && method === 'GET') return send(res, 200, projects.overview(slug));
      if (parts.length === 2 && action === 'repos' && method === 'PUT') {
        const saved = projects.setRepos(slug, body);
        const actor = actorOf(req);
        if (db && actor) recordAudit(db, actor, 'project.repos.saved', slug, saved.repos.map((r) => r.name + ':' + r.sync + (r.client ? ':client' : '')).join(', ').slice(0, 300));
        return send(res, 200, saved);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof ProjectError) return send(res, e.status, { error: e.message });
      logError('[projects api]', e);
      return send(res, 500, { error: 'Internal error' });
    }
  };
}
