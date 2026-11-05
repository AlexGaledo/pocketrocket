import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readBody } from './body.js';
import { MAX_PENDING_CONTEXT, type ContextRepo } from '../db/contextRepo.js';
import { hubTool } from '../agent/botTools.js';
import { scrubContext } from '../services/contextScrub.js';
import { ProjectError, slugify, type ProjectService } from '../services/ProjectService.js';
import { logError } from '../providers/redact.js';
import type { HubTool } from '../providers/types.js';

export const CONTEXT_CONNECTOR_PREFIX = '/mcp/context/';
const MAX_BODY_CHARS = 200_000;

const ProjectName = z.string().trim().min(1).max(100);
const Title = z.string().trim().min(1).max(200);
const Body = z.string().min(1).max(MAX_BODY_CHARS);
const ImportInput = z.object({
  source: z.enum(['drop-folder', 'export']),
  project: ProjectName,
  title: Title,
  body: Body,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateApproximate: z.boolean().optional(),
});

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};
const issues = (e: z.ZodError) => e.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ');

/**
 * `/api/context/*`. Human-only: it needs the hub token or a signed-in browser, a paired phone is refused by
 * deviceMayAccess, and no bot tool reaches it. Reviewed text becomes a file in the project's folder.
 *
 *   POST   /api/context               import into a project, already reviewed on the PC
 *   GET    /api/context               what the connector sent, waiting for review, without its text
 *   GET    /api/context/:id           one waiting item with its text
 *   POST   /api/context/:id/approve   into the project's folder
 *   DELETE /api/context/:id           reject
 *   GET    /api/context/connector     whether the connector is on
 *   POST   /api/context/connector     on, with a new secret URL (shown once; any older URL dies)
 *   DELETE /api/context/connector     off
 */
export function createContextApi(deps: { context: ContextRepo; projects: ProjectService }) {
  const { context, projects } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/context' && !url.pathname.startsWith('/api/context/')) return false;
    const method = req.method ?? 'GET';
    const sub = url.pathname.replace(/^\/api\/context\/?/, '').replace(/\/$/, '');
    let body: unknown;
    if (method === 'POST' || method === 'PUT') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    try {
      if (sub === '') {
        if (method === 'GET') return send(res, 200, context.list());
        if (method === 'POST') {
          const p = ImportInput.safeParse(body);
          if (!p.success) return send(res, 400, { error: issues(p.error) });
          const slug = slugify(p.data.project);
          const file = projects.saveImport(slug, { ...p.data, body: scrubContext(p.data.body) });
          return send(res, 200, { project: slug, path: file });
        }
      }
      if (sub === 'connector') {
        if (method === 'GET') return send(res, 200, { enabled: context.connectorEnabled() });
        if (method === 'POST') return send(res, 200, { path: CONTEXT_CONNECTOR_PREFIX + context.mintConnectorToken() });
        if (method === 'DELETE') { context.revokeConnectorToken(); return send(res, 200, { enabled: false }); }
      }
      const m = /^([^/]+)(\/approve)?$/.exec(sub);
      if (m && sub !== 'connector') {
        const id = decodeURIComponent(m[1]);
        const item = context.get(id);
        if (!item) return send(res, 404, { error: 'Nothing waiting with that id' });
        if (m[2] && method === 'POST') {
          const slug = slugify(item.project);
          const file = projects.saveImport(slug, { source: 'connector', title: item.title, body: item.body });
          context.remove(id);
          return send(res, 200, { project: slug, path: file });
        }
        if (!m[2] && method === 'GET') return send(res, 200, item);
        if (!m[2] && method === 'DELETE') { context.remove(id); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof ProjectError) return send(res, e.status, { error: e.message });
      logError('[context api]', e);
      return send(res, 500, { error: 'Internal error' });
    }
  };
}

/**
 * The only tool the public connector exposes. It writes to a review queue and reads nothing back, so its URL
 * leaking costs junk in the queue (capped), never access to the hub.
 */
export function contextConnectorTools(context: ContextRepo): HubTool[] {
  return [
    hubTool(
      'save_project_context',
      'Save context from this Claude project to PocketRocket: its instructions, what its knowledge files say, decisions, current state. The owner reviews it before it reaches any bot. Do not include passwords, API keys or other credentials. Call once per topic. You cannot read anything back.',
      { project: ProjectName.describe('Name of this project'), title: Title.describe('Short topic, like "Project instructions"'), content: Body.describe('The context, as Markdown') },
      async (a) => {
        if (context.pendingCount() >= MAX_PENDING_CONTEXT) {
          return { content: [{ type: 'text', text: 'The review queue is full. Ask the owner to review it, then try again.' }], isError: true };
        }
        const saved = context.queue({ project: a.project, title: a.title, body: scrubContext(a.content) });
        return { content: [{ type: 'text', text: 'Saved for review (' + saved.bytes + ' characters).' }] };
      },
    ),
  ];
}
