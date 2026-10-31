import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { ApprovalPolicyInputSchema, ControlInputSchema, type ApprovalPolicy } from '@pocketrocket/shared';
import { readBody } from './body.js';
import type { Repos } from '../db/repos.js';
import { getApprovalRecord, type ApprovalStore, type StoredPolicy } from '../db/approvalStore.js';
import type { ComputerControlService } from '../services/ComputerControl.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import { approvalSubject } from '../permissions/PermissionBroker.js';
import { INTEGRATION_WRITE_TOOLS } from '../integrations/toolNames.js';
import { events } from '../events.js';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Ctx = { params: Record<string, string>; query: URLSearchParams; body: unknown };
interface Route { method: string; pattern: RegExp; keys: string[]; handler: (c: Ctx) => unknown }

const INTEGRATION_WRITES = new Set<string>(INTEGRATION_WRITE_TOOLS);
const toPublic = ({ scope: _scope, ...p }: StoredPolicy): ApprovalPolicy => p;

/**
 * P2 REST, human-only like the rest of `/api` (hub token; no bot tool or MCP route reaches it). Kept out of
 * rest.ts so the phases merge cleanly; hub.ts asks it before rest.
 *
 *   GET  /api/control                         every bot's control state that is not the default
 *   GET  /api/computers/:botId/control        one bot's control state
 *   PUT  /api/computers/:botId/control        { control: agent|user|paused, holder?, note? }
 *   GET  /api/approval-policies?botId=        persisted approval rules
 *   POST /api/approval-policies               { approvalId, pattern? } or { botId, tool, pattern }, decision?
 *   DELETE /api/approval-policies/:id         revoke a rule
 *   GET  /api/approvals/parked                cards routine/trigger turns are parked on
 */
export function createTakeoverApi(deps: { repos: Repos; control: ComputerControlService; store: ApprovalStore; broker: PermissionBroker }) {
  const { repos, control, store, broker } = deps;
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
  const bot = (id: string) => {
    const b = repos.getBot(id);
    if (!b) throw new HttpError(404, 'Bot not found');
    return b;
  };
  const policiesChanged = () => events.emitEvent({ type: 'policies.changed', policies: store.listPolicies().map(toPublic) });

  add('GET', '/api/control', () => control.list());
  add('GET', '/api/computers/:botId/control', ({ params }) => control.get(bot(params.botId).id));
  add('PUT', '/api/computers/:botId/control', ({ params, body }) => {
    const b = bot(params.botId);
    const input = parse(ControlInputSchema, body);
    return control.set(b.id, input.control, { holder: input.holder ?? null, note: input.note });
  });

  add('GET', '/api/approval-policies', ({ query }) => {
    const botId = query.get('botId') ?? undefined;
    return store.listPolicies(botId).map(toPublic);
  });
  add('POST', '/api/approval-policies', ({ body }) => {
    const input = parse(ApprovalPolicyInputSchema, body);
    let botId: string;
    let tool: string;
    let pattern: string;
    if (input.approvalId) {
      const rec = getApprovalRecord(repos.db, input.approvalId);
      if (!rec) throw new HttpError(404, 'Approval not found');
      if (rec.danger && input.decision === 'allow') throw new HttpError(400, 'A card flagged as dangerous cannot become an allow rule');
      botId = rec.botId;
      tool = rec.toolName;
      pattern = input.pattern ?? approvalSubject(rec.toolName, (rec.toolInput ?? {}) as Record<string, unknown>);
    } else {
      if (!input.botId || !input.tool || !input.pattern) throw new HttpError(400, 'Pass approvalId, or botId + tool + pattern');
      botId = input.botId;
      tool = input.tool;
      pattern = input.pattern;
    }
    bot(botId);
    // P4: sending or posting as the user to a third party asks on every call; no rule can pre-approve it.
    if (INTEGRATION_WRITES.has(tool)) throw new HttpError(400, 'Integration writes always ask; they cannot become a rule');
    const p = store.addPolicy({ botId, tool, pattern: pattern.trim(), decision: input.decision, scope: 'always' });
    policiesChanged();
    return toPublic(p);
  });
  add('DELETE', '/api/approval-policies/:id', ({ params }) => {
    const p = store.getPolicy(params.id);
    if (!p) throw new HttpError(404, 'Rule not found');
    store.removePolicy(p.id);
    policiesChanged();
    return { ok: true };
  });
  add('GET', '/api/approvals/parked', () => broker.parked());

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    let hit: { r: Route; m: RegExpExecArray } | null = null;
    for (const r of routes) {
      const m = r.method === method ? r.pattern.exec(url.pathname) : null;
      if (m) { hit = { r, m }; break; }
    }
    // Only this file's own paths; everything else falls through to rest.ts.
    if (!hit) return false;
    const params: Record<string, string> = {};
    hit.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(hit!.m[i + 1])));
    let body: unknown;
    if (method !== 'GET' && method !== 'DELETE') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      const raw = buf.toString('utf8');
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    try {
      return send(res, 200, (await hit.r.handler({ params, query: url.searchParams, body })) ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: (e as Error).message ?? String(e) });
    }
  };
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
