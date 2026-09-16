import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  BotInputSchema, RoomInputSchema, RoutineInputSchema, SecretsPatchSchema, SettingsPatchSchema,
  type HealthInfo, type ProviderId,
} from '@pocketrocket/shared';
import net from 'node:net';
import { readBody } from './body.js';
import { WORKSPACE_DIR, SCREEN_URL, CDP_URL, DESKTOP_AVAILABLE, VERSION } from '../config.js';
import { openWorkspace } from './openWorkspace.js';
import { SCREEN_VIEWER_PATH, type ScreenSessions } from './screenSession.js';

/** TCP-probe a http://host:port URL; resolves true when something accepts the connection within 600ms. */
function probe(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(600, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import type { RoutineScheduler } from '../services/RoutineScheduler.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import type { BotRunner } from '../agent/BotRunner.js';
import { SettingsRejected, type SettingsStore } from '../services/SettingsStore.js';
import type { SecretsStore } from '../services/SecretsStore.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { AccountError, type AccountService } from '../services/AccountService.js';
import { AUTH_CALLBACK_PATH } from './guard.js';

type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: unknown; req: IncomingMessage }) => unknown | Promise<unknown>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** A handler returns this to answer 204 with no body. */
const NO_CONTENT = Symbol('no content');

export interface RestDeps {
  repos: Repos; memory: MemoryService; skills: SkillService; scheduler: RoutineScheduler; router: RoomRouter; runner: BotRunner;
  settings: SettingsStore; secrets: SecretsStore; providers: ProviderRegistry;
  /** Mints the single-use tickets the Screen tab trades for its `/screen` cookie. */
  screenSessions: ScreenSessions;
  account: AccountService;
}

export function createRest(deps: RestDeps) {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, pattern, keys, handler });
  };
  const { repos, memory, skills, scheduler, router, runner, settings, secrets, providers, screenSessions, account } = deps;
  const need = <T>(v: T | undefined, what: string): T => { if (!v) throw new HttpError(404, what + ' not found'); return v; };
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
    return r.data;
  };
  /**
   * Partial body parse. zod 4 keeps `.default()` inside `.partial()`, so parsing `{name}` against a
   * partial schema yields EVERY key filled with its default — which would silently reset the fields the
   * caller did not send. Validate, then keep only the keys actually present in the request body.
   */
  const parsePatch = <T extends object>(schema: z.ZodType<T>, body: unknown): Partial<T> => {
    const parsed = parse(schema, body) as Record<string, unknown>;
    const sent = new Set(Object.keys((body ?? {}) as Record<string, unknown>));
    return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<T>;
  };

  // ---- health
  // Answers without the hub token (the desktop app polls it before it has one), so nothing personal goes
  // here: no account email or plan, and no path to the CLI either — CLAUDE_EXE holds the home directory,
  // which is the machine's user name. `ok` already says whether the CLI was found; the authenticated
  // provider check carries the path for the people who can already ask for it.
  add('GET', '/api/health', (): HealthInfo & { provider: ProviderId; version: string } => {
    const exe = runner.constructor as typeof BotRunner;
    const chk = exe.checkExe();
    return {
      ok: chk.ok, error: chk.error,
      apiKeySource: runner.lastInit.apiKeySource,
      provider: settings.get().provider, version: VERSION,
      approvals: settings.approvals(), approvalsLocked: settings.approvalsLocked,
    };
  });
  add('GET', '/api/debug/last-init', () => runner.lastInit);
  add('GET', '/api/screen', async () => {
    const [screen, cdp] = await Promise.all([probe(SCREEN_URL), probe(CDP_URL)]);
    return { screen, cdp, url: SCREEN_VIEWER_PATH };
  });
  // The web client cannot put the hub token in an iframe URL, so it spends the token here instead: one
  // authenticated POST buys a ticket that `/screen/session` trades for a `/screen`-scoped httpOnly cookie.
  add('POST', '/api/screen/ticket', () => ({ url: screenSessions.mintTicket().url }));
  add('GET', '/api/config', () => ({ workspaceDir: WORKSPACE_DIR, version: VERSION }));
  // Opens the workspace on the machine the HUB runs on, which is the only machine it exists on: the user's
  // own PC for a local hub, the virtual desktop behind the Screen tab for a server one. The path is fixed,
  // so the request carries nothing that reaches the shell.
  add('POST', '/api/workspace/open', () => openWorkspace({ screen: DESKTOP_AVAILABLE }));

  // ---- settings / secrets / providers
  add('GET', '/api/settings', () => settings.get());
  // The only writer of `approvals`: no bot tool, MCP route or WS event reaches the SettingsStore.
  add('PUT', '/api/settings', ({ body }) => {
    const patch = parsePatch(SettingsPatchSchema, body);
    const before = settings.approvals();
    try {
      const next = settings.patch(patch);
      if (before !== 'bypass' && settings.approvals() === 'bypass') {
        console.warn('[pocketrocket] WARNING: approvals turned off in Settings — bots now run every action with no approval card');
      }
      return next;
    } catch (e) {
      if (e instanceof SettingsRejected) throw new HttpError(e.status, e.message);
      throw e;
    }
  });
  // Only which keys are set is ever returned; values stay on disk / in the environment.
  add('GET', '/api/secrets', () => secrets.status());
  add('PUT', '/api/secrets', ({ body }) => secrets.set(parse(SecretsPatchSchema, body)));
  add('GET', '/api/providers', () => providers.response());
  add('POST', '/api/providers/:id/check', ({ params }) => {
    const id = params.id as ProviderId;
    // A disabled provider is as unknown as a made-up one: nothing may spawn its CLI.
    if (!providers.enabled.includes(id)) throw new HttpError(404, 'Unknown provider ' + params.id);
    return providers.check(id, true);
  });

  // ---- account (optional). Human-only: no bot tool or MCP route reaches the AccountService.
  add('GET', '/api/account', () => account.state());
  add('POST', '/api/account/magic-link', async ({ body, req }) => {
    const { email } = parse(z.object({ email: z.string() }), body);
    await account.sendMagicLink(email, callbackUrl(req));
    return NO_CONTENT;
  });
  add('POST', '/api/account/verify', ({ body }) => {
    const { email, code } = parse(z.object({ email: z.string(), code: z.string() }), body);
    return account.verifyCode(email, code);
  });
  add('POST', '/api/account/oauth', async ({ body, req }) => {
    const { provider } = parse(z.object({ provider: z.enum(['google', 'github']) }), body);
    return { url: await account.oauthUrl(provider, callbackUrl(req)) };
  });
  add('POST', '/api/account/cancel', () => account.cancelPending());
  add('POST', '/api/account/sign-out', () => account.signOut());

  // ---- bots
  add('GET', '/api/bots', () => repos.listBots());
  add('POST', '/api/bots', ({ body }) => {
    const input = parse(BotInputSchema, body);
    if (repos.getBotByHandle(input.handle)) throw new HttpError(409, 'Handle already taken');
    const bot = repos.createBot(input);
    memory.ensureHome(bot.id);
    memory.writeIdentity(bot.id, bot.description);
    events.emitEvent({ type: 'bots.changed', bots: repos.listBots() });
    return bot;
  });
  add('PATCH', '/api/bots/:id', ({ params, body }) => {
    const cur = need(repos.getBot(params.id), 'Bot');
    const input = parsePatch(BotInputSchema.partial(), body);
    if (input.handle && input.handle !== cur.handle && repos.getBotByHandle(input.handle)) throw new HttpError(409, 'Handle already taken');
    const bot = repos.updateBot(params.id, input)!;
    if (input.description !== undefined) memory.writeIdentity(bot.id, input.description);
    events.emitEvent({ type: 'bots.changed', bots: repos.listBots() });
    return bot;
  });
  add('DELETE', '/api/bots/:id', ({ params }) => {
    need(repos.getBot(params.id), 'Bot');
    repos.deleteBot(params.id);
    events.emitEvent({ type: 'bots.changed', bots: repos.listBots() });
    events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
    return { ok: true };
  });
  add('GET', '/api/bots/:id/memory', ({ params }) => ({ text: memory.read(need(repos.getBot(params.id), 'Bot').id) }));
  add('PUT', '/api/bots/:id/memory', ({ params, body }) => {
    const { text } = parse(z.object({ text: z.string() }), body);
    memory.write(need(repos.getBot(params.id), 'Bot').id, text);
    return { ok: true };
  });
  add('GET', '/api/bots/:id/skills', ({ params }) => repos.botSkillIds(need(repos.getBot(params.id), 'Bot').id));
  add('PUT', '/api/bots/:id/skills', ({ params, body }) => {
    const bot = need(repos.getBot(params.id), 'Bot');
    const { skillIds } = parse(z.object({ skillIds: z.array(z.string()) }), body);
    repos.setBotSkills(bot.id, skillIds);
    skills.materialize(bot.id, bot.handle);
    return { ok: true };
  });
  add('POST', '/api/bots/:id/reset-session', ({ params, body }) => {
    const bot = need(repos.getBot(params.id), 'Bot');
    const { roomId } = parse(z.object({ roomId: z.string() }), body);
    repos.resetSession(bot.id, roomId);
    return { ok: true };
  });

  // ---- rooms
  add('GET', '/api/rooms', () => repos.listRooms());
  add('POST', '/api/rooms', ({ body }) => {
    const input = parse(RoomInputSchema, body);
    for (const id of input.memberIds) need(repos.getBot(id), 'Bot ' + id);
    if (input.kind === 'dm' && input.memberIds.length !== 1) throw new HttpError(400, 'DM needs exactly one bot');
    const room = repos.createRoom(input);
    events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
    return room;
  });
  add('PATCH', '/api/rooms/:id', ({ params, body }) => {
    need(repos.getRoom(params.id), 'Room');
    const input = parsePatch(RoomInputSchema.partial(), body);
    const room = repos.updateRoom(params.id, input)!;
    events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
    return room;
  });
  add('DELETE', '/api/rooms/:id', ({ params }) => {
    need(repos.getRoom(params.id), 'Room');
    repos.deleteRoom(params.id);
    events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
    return { ok: true };
  });
  add('GET', '/api/rooms/:id/messages', ({ params, query }) => {
    need(repos.getRoom(params.id), 'Room');
    const before = query.get('before') ? Number(query.get('before')) : undefined;
    const limit = query.get('limit') ? Number(query.get('limit')) : 200;
    return repos.listMessages(params.id, { before, limit });
  });
  add('POST', '/api/rooms/:id/messages', ({ params, body }) => {
    const { text } = parse(z.object({ text: z.string().min(1) }), body);
    return router.onUserMessage(params.id, text);
  });

  // ---- skills
  add('GET', '/api/skills', () => repos.listSkills());
  add('GET', '/api/skills/importable', () => skills.listImportable());
  add('POST', '/api/skills/import', ({ body }) => {
    const { names } = parse(z.object({ names: z.array(z.string()).min(1) }), body);
    return names.map((n) => skills.importFromUser(n));
  });
  add('POST', '/api/skills', ({ body }) => {
    const i = parse(z.object({ name: z.string(), description: z.string(), markdown: z.string() }), body);
    return skills.save(i.name, i.description, i.markdown, { source: 'authored' });
  });
  add('GET', '/api/skills/:id', ({ params }) => {
    const s = need(repos.getSkill(params.id), 'Skill');
    return { ...s, markdown: skills.readMarkdown(s) };
  });
  add('PATCH', '/api/skills/:id', ({ params, body }) => {
    const s = need(repos.getSkill(params.id), 'Skill');
    const { reviewStatus } = parse(z.object({ reviewStatus: z.enum(['approved', 'pending']) }), body);
    repos.setSkillReview(s.id, reviewStatus);
    for (const b of repos.listBots()) if (repos.botSkillIds(b.id).includes(s.id)) skills.materialize(b.id, b.handle);
    return { ...s, reviewStatus };
  });
  add('DELETE', '/api/skills/:id', ({ params }) => { skills.remove(params.id); return { ok: true }; });

  // ---- routines
  add('GET', '/api/routines', () => repos.listRoutines());
  add('POST', '/api/routines', ({ body }) => {
    const i = parse(RoutineInputSchema, body);
    const err = scheduler.constructor as typeof RoutineScheduler;
    const bad = err.validate(i.cron);
    if (bad) throw new HttpError(400, 'Invalid cron: ' + bad);
    need(repos.getBot(i.botId), 'Bot'); need(repos.getRoom(i.roomId), 'Room');
    const r = repos.createRoutine(i);
    scheduler.reload();
    return repos.getRoutine(r.id);
  });
  add('PATCH', '/api/routines/:id', ({ params, body }) => {
    need(repos.getRoutine(params.id), 'Routine');
    const i = parsePatch(RoutineInputSchema.partial(), body);
    if (i.cron) { const bad = (scheduler.constructor as typeof RoutineScheduler).validate(i.cron); if (bad) throw new HttpError(400, 'Invalid cron: ' + bad); }
    const r = repos.updateRoutine(params.id, i)!;
    scheduler.reload();
    return repos.getRoutine(r.id);
  });
  add('DELETE', '/api/routines/:id', ({ params }) => { repos.deleteRoutine(params.id); scheduler.reload(); return { ok: true }; });
  add('POST', '/api/routines/:id/run', ({ params }) => ({ ok: scheduler.fire(params.id) }));
  add('GET', '/api/routines/:id/runs', ({ params }) => repos.listRuns(params.id));

  // ---- usage
  add('GET', '/api/usage', ({ query }) => {
    const botId = query.get('botId') ?? undefined;
    const roomId = query.get('roomId') ?? undefined;
    return { totals: repos.usageTotals({ botId, roomId }), rows: repos.usageBreakdown() };
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    const method = req.method ?? 'GET';
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: unknown = undefined;
      if (method !== 'GET' && method !== 'DELETE') {
        // 1 MB cap (audit 2026-09-09, B15): an unbounded body was a free memory-exhaustion DoS.
        const buf = await readBody(req);
        if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
        const raw = buf.toString('utf8');
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      }
      try {
        const out = await r.handler({ params, query: url.searchParams, body, req });
        if (out === NO_CONTENT) { res.writeHead(204); res.end(); return true; }
        return send(res, 200, out ?? { ok: true });
      } catch (e) {
        const status = e instanceof HttpError || e instanceof AccountError ? e.status : 500;
        if (status === 500) console.error(e);
        return send(res, status, { error: (e as Error).message ?? String(e) });
      }
    }
    return send(res, 404, { error: 'Not found' });
  };
}

/**
 * Where the sign-in link sends the browser: this request's own Host (guard.ts has already held it to a loopback
 * name), so it lands on this hub whatever port the desktop picked or a tunnel forwards. Re-checked strictly
 * here because it is about to leave the machine inside an email.
 */
function callbackUrl(req: IncomingMessage): string {
  const host = String(req.headers.host ?? '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(host)) throw new HttpError(400, 'Bad Host header: ' + host);
  return 'http://' + host + AUTH_CALLBACK_PATH;
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
