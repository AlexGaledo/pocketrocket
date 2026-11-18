import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { WorkflowDecisionSchema, WorkflowInputSchema, WorkflowPatchSchema, type WorkflowPatch } from '@pocketrocket/shared';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Repos } from '../db/repos.js';
import { summary, type WorkflowRepo } from '../db/workflowRepo.js';
import { WorkflowError, type WorkflowRunner } from '../services/WorkflowRunner.js';
import { logError } from '../providers/redact.js';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Ctx = { params: Record<string, string>; query: URLSearchParams; body: unknown; req: IncomingMessage };
interface Route { method: string; pattern: RegExp; keys: string[]; handler: (c: Ctx) => unknown | Promise<unknown> }

/**
 * `/api/workflows*`, `/api/workflow-runs*`, `/api/workflow-cards` (workflows v1). Owner-only like the rest of `/api`
 * (the hub token, a signed-in browser or a paired device, narrowed by DEVICE_ALLOW): a bot reaches workflows only
 * through the gated `create_workflow` / `update_workflow` tools, and never reaches this file.
 *
 *   GET    /api/workflows                       Workflow[]
 *   POST   /api/workflows                       create (WorkflowInput)
 *   GET    /api/workflows/:id
 *   PATCH  /api/workflows/:id                   WorkflowPatch
 *   DELETE /api/workflows/:id                   409 while a run is running or waiting
 *   POST   /api/workflows/:id/run               "Run now" (manual), 409 when a run is already going
 *   GET    /api/workflows/:id/runs?limit=20     newest first
 *   GET    /api/workflow-runs/:runId            the run with every step
 *   POST   /api/workflow-runs/:runId/cancel
 *   POST   /api/workflow-runs/:runId/retry      the failed step again (409 unless the run ended in an error)
 *   GET    /api/workflow-cards                  approval cards waiting for the owner
 *   POST   /api/workflow-runs/:runId/decision   WorkflowDecision. Person-only: 403 for anything but an owner principal.
 */
export function createWorkflowsApi(deps: { repos: Repos; workflows: WorkflowRepo; runner: WorkflowRunner }) {
  const { repos, workflows, runner } = deps;
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Route['handler']) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, pattern, keys, handler });
  };
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
    return r.data;
  };
  /** zod 4 keeps `.default()` under `.partial()`: keep only the keys the caller sent, or a PATCH would reset the rest. */
  const parsePatch = (body: unknown): WorkflowPatch => {
    const parsed = parse(WorkflowPatchSchema, body) as Record<string, unknown>;
    const sent = new Set(Object.keys((body ?? {}) as Record<string, unknown>));
    return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as WorkflowPatch;
  };
  const workflow = (id: string) => {
    const w = workflows.get(id);
    if (!w) throw new HttpError(404, 'Workflow not found');
    return w;
  };

  add('GET', '/api/workflows', () => workflows.list());
  add('POST', '/api/workflows', ({ body }) => runner.create(parse(WorkflowInputSchema, body)));
  add('GET', '/api/workflows/:id', ({ params }) => workflow(params.id));
  add('PATCH', '/api/workflows/:id', ({ params, body }) => runner.update(params.id, parsePatch(body)));
  add('DELETE', '/api/workflows/:id', ({ params }) => {
    runner.remove(workflow(params.id).id);
    return { ok: true };
  });
  add('POST', '/api/workflows/:id/run', ({ params }) => {
    const run = runner.start(workflow(params.id).id, { manual: true });
    return summary(run);
  });
  add('GET', '/api/workflows/:id/runs', ({ params, query }) => {
    workflow(params.id);
    const limit = Number(query.get('limit'));
    return workflows.listRuns(params.id, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20);
  });
  const run = (id: string) => {
    const r = runner.getRun(id);
    if (!r) throw new HttpError(404, 'Run not found');
    return r;
  };
  add('GET', '/api/workflow-runs/:runId', ({ params }) => {
    const { causeId: _c, graph: _g, budgetUsd: _b, expiresAt: _e, roomId: _r, ...pub } = run(params.runId);
    return pub;
  });
  add('POST', '/api/workflow-runs/:runId/cancel', ({ params }) => runner.cancel(params.runId));
  add('POST', '/api/workflow-runs/:runId/retry', ({ params }) => runner.retry(params.runId));
  add('GET', '/api/workflow-cards', () => runner.cards());
  add('POST', '/api/workflow-runs/:runId/decision', ({ params, body, req }) => {
    // Person-only. The hub token, a signed-in browser and a paired device are the owner; the PC runner and a request
    // with no principal are not, and no bot, cta button or chat text ever reaches this route.
    const kind = principalOf(req)?.kind;
    if (kind !== 'hub' && kind !== 'device') throw new HttpError(403, 'Only you can answer this card');
    return runner.decide(params.runId, parse(WorkflowDecisionSchema, body));
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p !== '/api/workflows' && p !== '/api/workflow-cards' && !p.startsWith('/api/workflows/') && !p.startsWith('/api/workflow-runs/')) return false;
    const method = req.method ?? 'GET';
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(p);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: unknown;
      if (method !== 'GET' && method !== 'DELETE') {
        const buf = await readBody(req);
        if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
        const raw = buf.toString('utf8');
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      }
      try {
        return send(res, 200, (await r.handler({ params, query: url.searchParams, body, req })) ?? { ok: true });
      } catch (e) {
        if (e instanceof HttpError || e instanceof WorkflowError) return send(res, e.status, { error: e.message });
        logError('[workflows api]', e);
        return send(res, 500, { error: 'Internal error' });
      }
    }
    return send(res, 404, { error: 'Not found' });
  };
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
