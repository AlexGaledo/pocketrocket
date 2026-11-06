import { pickCoordinator } from '../rooms/coordinator.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import { z } from 'zod';
import {
  BotInputSchema, RoomInputSchema, RoomModelInputSchema, RoutineInputSchema, RoutingInputSchema, SecretsPatchSchema, SettingsPatchSchema,
  isMediaRef, mediaHash,
  type HealthInfo, type ProviderId, type Room,
} from '@pocketrocket/shared';
import net from 'node:net';
import { readBody } from './body.js';
import { WORKSPACE_DIR, SCREEN_URL, CDP_URL, DESKTOP_AVAILABLE, VERSION } from '../config.js';
import { openWorkspace, workspaceTarget } from './openWorkspace.js';
import { SCREEN_VIEWER_PATH, screenViewerPath, type ScreenSessions } from './screenSession.js';
import { AlwaysOnRefused, type ComputerManager } from '../services/ComputerManager.js';

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
import { MAX_MEMORY_BYTES, type MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import { RoutineScheduler } from '../services/RoutineScheduler.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import type { BotRunner } from '../agent/BotRunner.js';
import { SettingsRejected, type SettingsStore } from '../services/SettingsStore.js';
import type { SecretsStore } from '../services/SecretsStore.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { AccountError, type AccountService } from '../services/AccountService.js';
import { AUTH_CALLBACK_PATH, deviceIdOf, screenOwnerOf } from './guard.js';
import type { KnowledgeRepo } from '../services/KnowledgeRepo.js';
import type { RoutingRules } from '../services/RoutingRules.js';
import type { VoiceProposals } from '../services/VoiceProposals.js';
import { logError } from '../providers/redact.js';
import type { MediaStore } from '../services/MediaStore.js';

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
  // ---- P7 ----
  knowledge?: KnowledgeRepo;
  voice?: VoiceProposals;
  /** Per-bot computers (P1): Screen tab status, Wake, Keep awake. */
  computers: ComputerManager;
  /** The owner's routing rules. */
  routing?: RoutingRules;
  /** P2: true while the viewer of this screen (bot id, or null for the shared one) may only watch. */
  viewOnly?: (scope: string | null) => boolean;
  /** Uploaded pictures: a reference is only stored once its file is here. */
  media?: MediaStore;
}

export function createRest(deps: RestDeps) {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, pattern, keys, handler });
  };
  const { repos, memory, skills, scheduler, router, runner, settings, secrets, providers, screenSessions, account, computers } = deps;
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

  /** A picture reference must name a file this hub holds. Icon keys and '' pass; the schemas have dropped the rest. */
  const needPicture = (avatar: string | undefined) => {
    if (isMediaRef(avatar) && !deps.media?.has(mediaHash(avatar))) throw new HttpError(400, 'That picture is gone. Upload it again.');
  };
  /** What the owner changed in a group, as the lines the chat shows. */
  const roomChanges = (before: Room, after: Room): string[] => {
    const who = settings.get().userName;
    const label = (id: string) => { const b = repos.getBot(id); return b ? b.name + ' (@' + b.handle + ')' : 'A bot'; };
    const lines: string[] = [];
    if (after.name !== before.name) lines.push(who + ' renamed this chat to "' + after.name + '".');
    for (const id of after.memberIds) if (!before.memberIds.includes(id)) lines.push(who + ' added ' + label(id) + '.');
    for (const id of before.memberIds) if (!after.memberIds.includes(id)) lines.push(who + ' removed ' + label(id) + '.');
    if (after.coordinatorBotId !== before.coordinatorBotId) {
      lines.push(after.coordinatorBotId ? 'Coordinator is now ' + label(after.coordinatorBotId) + '.' : 'This chat has no coordinator now.');
    }
    return lines;
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
  add('GET', '/api/screen', async ({ query }) => {
    // P1: `?botId=` asks about that bot's own computer. Without per-bot computers (or without a bot) it is the
    // one shared screen, exactly as before; `computer` then says perBot: false.
    const botId = query.get('botId');
    if (botId && computers.enabled) {
      need(repos.getBot(botId), 'Bot');
      const computer = computers.status(botId);
      const ep = computers.existingEndpoint(botId);
      const live = !!ep && computer.state === 'live';
      const [screen, cdp] = live ? await Promise.all([probe(ep.screenUrl), probe(ep.cdpUrl)]) : [false, false];
      return { screen, cdp, url: screenViewerPath(botId, deps.viewOnly?.(botId) ?? false), computer };
    }
    const [screen, cdp] = await Promise.all([probe(SCREEN_URL), probe(CDP_URL)]);
    return { screen, cdp, url: screenViewerPath(null, deps.viewOnly?.(null) ?? false), ...(botId ? { computer: computers.status(botId) } : {}) };
  });
  // The web client cannot put the hub token in an iframe URL, so it spends the token here instead: one
  // authenticated POST buys a ticket that `/screen/session` trades for a `/screen`-scoped httpOnly cookie.
  // P1: with `{ botId }` the ticket (and the cookie it buys) opens that bot's computer and nothing else.
  add('POST', '/api/screen/ticket', ({ body, req }) => {
    const { botId } = parse(z.object({ botId: z.string().optional() }), body ?? {});
    // P9: a ticket a paired device or signed-in browser mints is tagged with it, so revoking that closes its Screen too.
    const owner = screenOwnerOf(req);
    if (botId && computers.enabled) {
      need(repos.getBot(botId), 'Bot');
      if (!computers.existingEndpoint(botId)) throw new HttpError(409, 'This bot has no computer yet');
      return { url: screenSessions.mintTicket(botId, owner).url };
    }
    return { url: screenSessions.mintTicket(null, owner).url };
  });

  // ---- per-bot computers (P1). Human-only: no bot tool reaches these.
  add('GET', '/api/computers/:botId', ({ params }) => computers.status(need(repos.getBot(params.botId), 'Bot').id));
  // The app opened: warm the bot in `botId` and one more recent one, in empty places only. Answers at once; the
  // starts show up as computer.state events. Not on DEVICE_ALLOW: opening the app on a phone wakes nothing.
  add('POST', '/api/computers/warm', ({ body }) => {
    const { botId } = parse(z.object({ botId: z.string().optional() }), body ?? {});
    void computers.warm(botId && repos.getBot(botId) ? botId : null).catch((e) => console.warn('[computers] ' + (e as Error).message));
    return { ok: true };
  });
  // `auto`: nobody pressed anything (a bot was selected, a screen was opened), so the memory guard applies and only
  // a cold computer may be evicted. A paired device always gets those rules. Without it this is the Retry button.
  add('POST', '/api/computers/:botId/wake', async ({ params, body, req }) => {
    const bot = need(repos.getBot(params.botId), 'Bot');
    const { auto } = parse(z.object({ auto: z.boolean().optional() }), body ?? {});
    if (!computers.enabled) throw new HttpError(409, 'This server has no per-bot computers');
    if (auto || deviceIdOf(req)) await computers.wakeFocused(bot.id);
    else await computers.ensureRunning(bot.id);
    return computers.status(bot.id);
  });
  add('PUT', '/api/computers/:botId/keep-awake', ({ params, body }) => {
    const bot = need(repos.getBot(params.botId), 'Bot');
    const { on } = parse(z.object({ on: z.boolean() }), body);
    if (!computers.enabled) throw new HttpError(409, 'This server has no per-bot computers');
    try {
      return computers.setKeepAwake(bot.id, on);
    } catch (e) {
      if (e instanceof AlwaysOnRefused) throw new HttpError(409, e.message);
      throw e;
    }
  });
  add('GET', '/api/config', () => ({ workspaceDir: WORKSPACE_DIR, version: VERSION }));
  // Opens the workspace on the machine the HUB runs on, which is the only machine it exists on: the user's
  // own PC for a local hub, the virtual desktop behind the Screen tab for a server one. The path is fixed,
  // so the request carries nothing that reaches the shell.
  // P1: with per-bot computers it opens on the requesting bot's running computer (`{ botId }`), or says why not.
  add('POST', '/api/workspace/open', ({ body }) => {
    const { botId } = parse(z.object({ botId: z.string().optional() }), body ?? {});
    const bot = botId ? need(repos.getBot(botId), 'Bot') : null;
    return openWorkspace({ screen: DESKTOP_AVAILABLE, ...workspaceTarget(computers, bot) });
  });

  // ---- settings / secrets / providers
  add('GET', '/api/me', () => repos.owner());
  add('GET', '/api/settings', () => settings.get());
  // The only writer of `approvals`: no bot tool, MCP route or WS event reaches the SettingsStore.
  add('PUT', '/api/settings', ({ body, req }) => {
    const patch = parsePatch(SettingsPatchSchema, body);
    needPicture(patch.userAvatar);
    const before = settings.approvals();
    try {
      const next = settings.patch(patch);
      const who = actorOf(req);
      if (who) {
        const keys = Object.keys(patch);
        const level = before !== settings.approvals() ? 'approvals: ' + before + ' to ' + settings.approvals() : null;
        if (level) recordAudit(repos.db, who, 'permissions.changed', null, level);
        const rest = keys.filter((k) => k !== 'approvals');
        // Key names only: a value here could be anything, and this log must stay free of secrets.
        if (rest.length) recordAudit(repos.db, who, 'settings.updated', null, rest.join(', '));
      }
      if (patch.userName !== undefined) repos.renameOwner(next.userName);
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
    needPicture(input.avatar);
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
    needPicture(input.avatar);
    if (input.handle && input.handle !== cur.handle && repos.getBotByHandle(input.handle)) throw new HttpError(409, 'Handle already taken');
    const bot = repos.updateBot(params.id, input)!;
    if (input.description !== undefined) memory.writeIdentity(bot.id, input.description);
    events.emitEvent({ type: 'bots.changed', bots: repos.listBots() });
    return bot;
  });
  add('DELETE', '/api/bots/:id', ({ params }) => {
    need(repos.getBot(params.id), 'Bot');
    repos.deleteBot(params.id);
    memory.removeHome(params.id);
    deps.voice?.removeForBot(params.id);
    events.emitEvent({ type: 'bots.changed', bots: repos.listBots() });
    events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
    return { ok: true };
  });
  // The Memory tab shows how full memory.md is and when auto-memory last wrote to it.
  add('GET', '/api/bots/:id/memory', ({ params }) => {
    const bot = need(repos.getBot(params.id), 'Bot');
    const text = memory.read(bot.id);
    return { text, bytes: Buffer.byteLength(text, 'utf8'), limit: MAX_MEMORY_BYTES, lastAutoSavedAt: repos.lastAutoMemorySave(bot.id) };
  });
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
    if (input.coordinatorBotId && !input.memberIds.includes(input.coordinatorBotId)) throw new HttpError(400, 'The coordinator must be in the chat');
    needPicture(input.avatar);
    const coord = input.kind === 'group' && input.memberIds.length >= 2 && !input.coordinatorBotId
      ? pickCoordinator(input.memberIds.map((id) => repos.getBot(id)!))
      : null;
    const room = repos.createRoom(coord ? { ...input, coordinatorBotId: coord.id } : input);
    events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
    return room;
  });
  add('PATCH', '/api/rooms/:id', ({ params, body }) => {
    const cur = need(repos.getRoom(params.id), 'Room');
    const input = parsePatch(RoomInputSchema.partial(), body);
    for (const id of input.memberIds ?? []) need(repos.getBot(id), 'Bot ' + id);
    if ((input.kind ?? cur.kind) === 'dm' && (input.memberIds ?? cur.memberIds).length !== 1) throw new HttpError(400, 'DM needs exactly one bot');
    needPicture(input.avatar);
    const memberIds = input.memberIds ?? cur.memberIds;
    if (input.coordinatorBotId && !memberIds.includes(input.coordinatorBotId)) throw new HttpError(400, 'The coordinator must be in the chat');
    // A coordinator who leaves stops being one. An empty `memberIds` never gets here: the schema wants at least one bot.
    let coordinatorBotId = input.coordinatorBotId === undefined && cur.coordinatorBotId && !memberIds.includes(cur.coordinatorBotId) ? null : input.coordinatorBotId;
    // A group of two or more always has a coordinator: clearing it, or losing it, picks another member.
    const kept = coordinatorBotId === undefined ? cur.coordinatorBotId : coordinatorBotId;
    if ((input.kind ?? cur.kind) === 'group' && memberIds.length >= 2 && !kept) {
      coordinatorBotId = pickCoordinator(memberIds.map((id) => repos.getBot(id)!))?.id ?? null;
    }
    const room = repos.updateRoom(params.id, { ...input, coordinatorBotId })!;
    for (const id of cur.memberIds) if (!room.memberIds.includes(id)) router.botLeftRoom(id, room.id);
    events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
    if (room.kind === 'group') for (const line of roomChanges(cur, room)) router.systemNote(room, line, null, 0);
    return room;
  });
  // The composer's model pick for this chat. Human-only: no bot tool reaches it, and a paired device is refused.
  add('PUT', '/api/rooms/:id/model', ({ params, body }) => {
    need(repos.getRoom(params.id), 'Room');
    const room = repos.setRoomChatModel(params.id, parse(RoomModelInputSchema, body).model)!;
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
  add('GET', '/api/previews', () => repos.botPreviews());
  add('GET', '/api/search', ({ query }) => {
    const q = (query.get('q') ?? '').trim();
    return q.length < 2 ? [] : repos.searchMessages(q.slice(0, 200), 50);
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
    const sched = RoutineScheduler.resolveSchedule(i, scheduler.timezone());
    if ('error' in sched) throw new HttpError(400, sched.error);
    need(repos.getBot(i.botId), 'Bot'); need(repos.getRoom(i.roomId), 'Room');
    const r = repos.createRoutine({ ...i, ...sched });
    scheduler.reload();
    return repos.getRoutine(r.id);
  });
  add('PATCH', '/api/routines/:id', ({ params, body }) => {
    const cur = need(repos.getRoutine(params.id), 'Routine');
    const { onceAt, ...i } = parsePatch(RoutineInputSchema.partial(), body);
    let sched = {};
    if (i.cron !== undefined || onceAt !== undefined) {
      // Re-check the schedule only when it changes, so toggling an old one-shot is not refused as "past".
      const s = RoutineScheduler.resolveSchedule({ cron: i.cron ?? cur.cron, onceAt: onceAt === undefined ? cur.onceAt : onceAt }, scheduler.timezone());
      if ('error' in s) throw new HttpError(400, s.error);
      sched = s;
    }
    const r = repos.updateRoutine(params.id, { ...i, ...sched })!;
    scheduler.reload();
    return repos.getRoutine(r.id);
  });
  add('DELETE', '/api/routines/:id', ({ params }) => { repos.deleteRoutine(params.id); scheduler.reload(); return { ok: true }; });
  add('POST', '/api/routines/:id/run', ({ params }) => ({ ok: scheduler.fire(params.id, { manual: true }) }));
  add('GET', '/api/routines/:id/runs', ({ params }) => repos.listRuns(params.id));

  // ---- the owner's routing rules. Human-only, like settings; a bot can only propose a line, on an approval card.
  if (deps.routing) {
    const routing = deps.routing;
    add('GET', '/api/routing', () => ({ text: routing.read() }));
    add('PUT', '/api/routing', ({ body }) => {
      const { text } = parse(RoutingInputSchema, body);
      try {
        routing.write(text);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return { text };
    });
  }

  // ---- P7: knowledge repo, voice, notes, skill import from git
  // Human-only, like settings: no bot tool reaches the knowledge sync or the voice approvals.
  if (deps.knowledge) {
    const knowledge = deps.knowledge;
    add('GET', '/api/knowledge', () => knowledge.status());
    add('POST', '/api/knowledge/sync', () => knowledge.sync());
  }
  add('GET', '/api/bots/:id/voice', ({ params }) => {
    const bot = need(repos.getBot(params.id), 'Bot');
    return { text: memory.readVoice(bot.id), proposals: deps.voice?.list(bot.id) ?? [] };
  });
  add('PUT', '/api/bots/:id/voice', ({ params, body }) => {
    const { text } = parse(z.object({ text: z.string().max(64 * 1024) }), body);
    const trimmed = memory.writeVoice(need(repos.getBot(params.id), 'Bot').id, text);
    return { ok: true, trimmed };
  });
  add('POST', '/api/bots/:id/voice/proposals/:pid', ({ params, body }) => {
    const bot = need(repos.getBot(params.id), 'Bot');
    const { decision } = parse(z.object({ decision: z.enum(['approve', 'dismiss']) }), body);
    if (!deps.voice?.decide(bot.id, params.pid, decision)) throw new HttpError(404, 'Proposal not found');
    return { text: memory.readVoice(bot.id), proposals: deps.voice.list(bot.id) };
  });
  add('GET', '/api/bots/:id/notes', ({ params }) => memory.listNotes(need(repos.getBot(params.id), 'Bot').id));
  add('POST', '/api/skills/import-git', async ({ body }) => {
    const { url } = parse(z.object({ url: z.string().min(1).max(500) }), body);
    try {
      return await skills.importFromGit(url);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  // ---- usage
  add('GET', '/api/usage', ({ query }) => {
    const botId = query.get('botId') ?? undefined;
    const roomId = query.get('roomId') ?? undefined;
    // byModel / byCause (P8): where the money went, so automation spend is visible next to chat spend.
    return { totals: repos.usageTotals({ botId, roomId }), rows: repos.usageBreakdown(), byModel: repos.usageBy('model'), byCause: repos.usageBy('causeKind') };
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
        if (status === 500) logError('[rest]', e);
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
