import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  DistillInputSchema, RecorderStartSchema, SkillCorrectionSchema, SkillReflectionPatchSchema, SkillVersionDecisionSchema,
} from '@pocketrocket/shared';
import { readBody } from './body.js';
import type { Repos } from '../db/repos.js';
import { RecorderError, type Recorder } from '../services/Recorder.js';
import { DistillError, type SkillDistiller } from '../services/SkillDistiller.js';
import type { SkillService } from '../services/SkillService.js';
import { events } from '../events.js';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Ctx = { params: Record<string, string>; body: unknown };
interface Route { method: string; pattern: RegExp; keys: string[]; handler: (c: Ctx) => unknown }

/**
 * P6 REST, human-only (hub token, or a paired phone for the routes guard.ts `DEVICE_ALLOW` lists: reading
 * recordings, versions and the reflection setting, and stopping a recording). Starting a recording, distilling,
 * corrections, reflection opt-in and approving or rejecting a version are desktop actions. No bot tool or MCP
 * route reaches any of it. Kept out of rest.ts so phases merge cleanly; hub.ts asks it before rest.
 *
 *   GET    /api/computers/:botId/recorder                 RecorderStatus
 *   POST   /api/computers/:botId/recorder/start           { title? }  Teach
 *   POST   /api/computers/:botId/recorder/stop            Done
 *   GET    /api/computers/:botId/recordings               RecordingInfo[]
 *   GET    /api/computers/:botId/recordings/:rid          RecordingInfo & { trace }
 *   DELETE /api/computers/:botId/recordings/:rid
 *   POST   /api/computers/:botId/recordings/:rid/distill  { name?, hint? }  → { skill, version }
 *   GET    /api/skills/:id/versions                       SkillVersion[]
 *   GET    /api/skills/:id/versions/:vid                  SkillVersionDetail (with the line diff)
 *   POST   /api/skills/:id/versions/:vid                  { decision: approve|reject }
 *   POST   /api/skills/:id/corrections                    { text }  → SkillVersion (pending)
 *   GET|PUT /api/bots/:id/skill-reflection                SkillReflectionConfig
 */
export function createTeachApi(deps: { repos: Repos; skills: SkillService; recorder: Recorder; distiller: SkillDistiller }) {
  const { repos, skills, recorder, distiller } = deps;
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
  const skill = (id: string) => {
    const s = repos.getSkill(id);
    if (!s || s.parentId) throw new HttpError(404, 'Skill not found');
    return s;
  };

  add('GET', '/api/computers/:botId/recorder', ({ params }) => recorder.status(bot(params.botId).id));
  add('POST', '/api/computers/:botId/recorder/start', ({ params, body }) => recorder.start(bot(params.botId).id, parse(RecorderStartSchema, body ?? {})));
  add('POST', '/api/computers/:botId/recorder/stop', async ({ params }) => {
    const b = bot(params.botId);
    const rec = await recorder.stop(b.id, { reason: 'user' });
    return { recording: rec, status: recorder.status(b.id) };
  });
  add('GET', '/api/computers/:botId/recordings', ({ params }) => recorder.list(bot(params.botId).id));
  add('GET', '/api/computers/:botId/recordings/:rid', ({ params }) => {
    const b = bot(params.botId);
    const rec = recorder.get(b.id, params.rid);
    if (!rec) throw new HttpError(404, 'Recording not found');
    return { ...rec, trace: recorder.readTrace(b.id, params.rid) };
  });
  add('DELETE', '/api/computers/:botId/recordings/:rid', ({ params }) => {
    if (!recorder.remove(bot(params.botId).id, params.rid)) throw new HttpError(404, 'Recording not found (or still recording)');
    return { ok: true };
  });
  add('POST', '/api/computers/:botId/recordings/:rid/distill', ({ params, body }) =>
    distiller.distill(bot(params.botId).id, params.rid, parse(DistillInputSchema, body ?? {})));

  add('GET', '/api/skills/:id/versions', ({ params }) => skills.listVersions(skill(params.id).id));
  add('GET', '/api/skills/:id/versions/:vid', ({ params }) => {
    const d = skills.versionDetail(skill(params.id).id, params.vid);
    if (!d) throw new HttpError(404, 'Version not found');
    return d;
  });
  add('POST', '/api/skills/:id/versions/:vid', ({ params, body }) => {
    const s = skill(params.id);
    const { decision } = parse(SkillVersionDecisionSchema, body);
    try {
      return skills.decideVersion(s.id, params.vid, decision);
    } catch (e) {
      throw new HttpError(/not found/i.test((e as Error).message) ? 404 : 409, (e as Error).message);
    }
  });
  add('POST', '/api/skills/:id/corrections', ({ params, body }) => {
    const s = skill(params.id);
    const { text } = parse(SkillCorrectionSchema, body);
    return distiller.correct(s.id, text, null);
  });

  add('GET', '/api/bots/:id/skill-reflection', ({ params }) => skills.versionsRepo.reflection(bot(params.id).id));
  add('PUT', '/api/bots/:id/skill-reflection', ({ params, body }) => {
    const b = bot(params.id);
    const out = skills.versionsRepo.setReflection(b.id, parse(SkillReflectionPatchSchema, body));
    events.emitEvent({ type: 'skills.changed' });
    return out;
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: unknown = undefined;
      if (method !== 'GET' && method !== 'DELETE') {
        const buf = await readBody(req);
        if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
        const raw = buf.toString('utf8');
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      }
      try {
        return send(res, 200, (await r.handler({ params, body })) ?? { ok: true });
      } catch (e) {
        const status = e instanceof HttpError || e instanceof RecorderError || e instanceof DistillError ? e.status : 500;
        if (status === 500) console.error(e);
        return send(res, status, { error: (e as Error).message ?? String(e) });
      }
    }
    return false;
  };
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
