import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import httpProxy from 'http-proxy';
import {
  HOST, PORT, WEB_DIST, WORKSPACE_DIR, SCREEN_URL, VERSION, DATA_DIR, ENABLED_PROVIDERS, MEDIA_DIR,
  ensureDirs, ensureHubToken, migrateLegacyDb, KNOWLEDGE_SYNC_MINUTES, HUB_TOKEN, HUB_TOKEN_PATH,
} from './config.js';
import { Db } from './db/db.js';
import { Repos } from './db/repos.js';
import { MemoryService } from './services/MemoryService.js';
import { SkillService } from './services/SkillService.js';
import { UsageTracker } from './services/UsageTracker.js';
import { AutoMemory } from './services/AutoMemory.js';
import { SettingsStore, installSettings } from './services/SettingsStore.js';
import { SecretsStore } from './services/SecretsStore.js';
import { AccountService } from './services/AccountService.js';
import { PermissionBroker } from './permissions/PermissionBroker.js';
import { RoomRouter } from './rooms/RoomRouter.js';
import { BotRunner } from './agent/BotRunner.js';
import { RoutingRules } from './services/RoutingRules.js';
import { RoutineScheduler } from './services/RoutineScheduler.js';
import { FollowUp } from './services/FollowUp.js';
import { KnowledgeRepo } from './services/KnowledgeRepo.js';
import { VoiceProposals } from './services/VoiceProposals.js';
import { createProviders } from './providers/registry.js';
import { TurnRegistry, createMcpHandler } from './mcp/httpServer.js';
import { createRest } from './api/rest.js';
import { attachWs } from './api/ws.js';
import { AUTH_CALLBACK_PATH, AuthRateLimiter, bearerToken, checkContentType, checkRequestOrigin, checkToken, clientIp, cookieValue, dropCookie, presentsHubToken, tokenMatches } from './api/guard.js';
import { ScreenSessions, screenCookieName, screenViewerPath } from './api/screenSession.js';
import { readBody } from './api/body.js';
import { handleAuthCallback } from './api/authCallback.js';
import { addSecret, logError } from './providers/redact.js';
import { ComputersRepo } from './db/computers.js';
import { ComputerManager } from './services/ComputerManager.js';
import { events } from './events.js';
import { IntegrationService } from './services/IntegrationService.js';
import { createIntegrationsApi } from './api/integrations.js';
import { OAUTH_START_PREFIX, handleOAuthCallback, handleOAuthStart } from './api/oauth.js';
import { OAUTH_CALLBACK_PREFIX } from './api/guard.js';
import { TriggerService } from './services/TriggerService.js';
import { createTriggersApi } from './api/triggers.js';
import type { SocketFactory } from './services/SlackSocketMode.js';
// P9: devices, pairing, push
import { ALLOWED_HOSTS, PUSH_SUBJECT, VAPID_PATH } from './config.js';
import { seedDefaultBots } from './services/SeedBots.js';
import { DEVICE_PAIR_PATH, deviceMayAccess, setPrincipal } from './api/guard.js';
import { DevicesRepo } from './db/devices.js';
import { DeviceService } from './services/DeviceService.js';
import { PushService } from './services/PushService.js';
import { AUTH_LOGIN_PATH, AUTH_STATUS_PATH, createAuthApi, handleAuthStatus, handleLogin } from './api/auth.js';
import { AuthService, SESSION_COOKIE } from './services/AuthService.js';
import { auditRequest } from './services/AuditLog.js';
import { createDevicesApi, handleDevicePair } from './api/devices.js';
import type { WebSocket as WsSocket } from 'ws';
import { ApprovalStore, type ParkedApproval } from './db/approvalStore.js';
import { ComputerControlService, type VncControl } from './services/ComputerControl.js';
import { createTakeoverApi } from './api/takeover.js';
import { handBackNote } from './rooms/RoomRouter.js';
// P6: teach by demonstration, skill versions and reflection
import { Recorder, type RecorderDeps } from './services/Recorder.js';
import { SkillDistiller } from './services/SkillDistiller.js';
import { SkillReflection } from './services/SkillReflection.js';
import { Training, type TrainingDeps } from './services/Training.js';
import { createTeachApi } from './api/teach.js';
import { MEDIA_SWEEP_MS, MediaStore, referencedMedia } from './services/MediaStore.js';
import { createMediaApi } from './api/media.js';

export interface HubOptions {
  port?: number;
  /** Bearer token required on /api/* and /ws. Defaults to POCKETROCKET_TOKEN. */
  token?: string | null;
  /** SQLite file; ':memory:' in tests. */
  dbFile?: string;
  /** Skip directory creation + legacy db copy (tests). */
  skipBootstrap?: boolean;
  /** The owner's routing rules; tests hand in a temp file. Defaults to data/routing.md. */
  routingFile?: string;
  /** Account service; tests hand in one over a fake Supabase client. */
  account?: AccountService;
  /** Per-bot computers (P1); tests hand in one over a fake systemctl. Built from the environment otherwise. */
  computers?: (db: Db) => ComputerManager;
  /** P4 integrations, built on the hub's db; tests hand in a factory with a temp vault and a fake fetch. */
  integrations?: (db: Db) => IntegrationService;
  /** P5: Slack Socket Mode transport; tests hand in a fake socket. */
  slackSocket?: SocketFactory;
  // ---- P9 ----
  /** Extra Host names accepted over HTTPS (POCKETROCKET_ALLOWED_HOSTS); tests pass their own. */
  allowedHosts?: readonly string[];
  /** Web Push; tests hand in one with a fixed VAPID key and a fake fetch. */
  push?: (devices: DevicesRepo, repos: Repos) => PushService;
  /** Create the default bots on start. Only the real entry point sets it, so tests start empty. */
  seedBots?: boolean;
  /** P2: x11vnc view-only toggle; tests pass a fake. Defaults to `x11vnc -R viewonly|noviewonly`. */
  vnc?: VncControl;
  // ---- P6 ----
  /** Recorder overrides (tests: availability, a fake CDP, fake scrot/xdotool, a temp folder). */
  recorder?: Partial<Omit<RecorderDeps, 'computers' | 'control'>>;
  /** Bot training overrides (tests: a fake one-shot runner, a fixed clock or zone). */
  training?: Partial<Pick<TrainingDeps, 'run' | 'exeExists' | 'now' | 'timezone'>>;
  /** Uploaded pictures; tests hand in a temp folder. Defaults to data/media. */
  mediaDir?: string;
}

export interface Hub {
  server: http.Server;
  port: number;
  repos: Repos;
  settings: SettingsStore;
  secrets: SecretsStore;
  account: AccountService;
  providers: ReturnType<typeof createProviders>;
  turns: TurnRegistry;
  runner: BotRunner;
  computers: ComputerManager;
  integrations: IntegrationService;
  /** P5: event triggers (pollers, Slack Socket Mode, matcher). */
  triggers: TriggerService;
  // P9
  devices: DeviceService;
  push: PushService;
  // ---- P2 ----
  /** Who drives each bot's computer (agent / user / paused). P6's recorder forces `user` through this. */
  control: ComputerControlService;
  broker: PermissionBroker;
  approvals: ApprovalStore;
  // ---- P6 ----
  skills: SkillService;
  recorder: Recorder;
  distiller: SkillDistiller;
  media: MediaStore;
  listen(): Promise<number>;
  shutdown(): Promise<void>;
}

export function createHub(opts: HubOptions = {}): Hub {
  const token = opts.token !== undefined ? opts.token : ensureHubToken();
  addSecret(token);
  let port = opts.port ?? PORT;
  if (!opts.skipBootstrap) {
    ensureDirs();
    migrateLegacyDb();
  }

  const db = opts.dbFile ? new Db(opts.dbFile) : new Db();
  const repos = new Repos(db);
  const memory = new MemoryService();
  const skills = new SkillService(repos);
  const usage = new UsageTracker(repos);
  const secrets = new SecretsStore();
  const account = opts.account ?? new AccountService();
  const settings = new SettingsStore({
    repos,
    enabled: ENABLED_PROVIDERS,
    models: (p) => providers.modelsSync(p),
    modelsAsync: (p) => providers.modelsAwaited(p),
  });
  installSettings(settings);
  // A name set before migration 112, or the OS account default, reaches the owner's row here.
  repos.renameOwner(settings.get().userName);
  if (opts.seedBots) {
    const seeded = seedDefaultBots(repos, memory);
    if (seeded.length) console.log('created default bots: ' + seeded.map((b) => '@' + b.handle).join(', '));
  }
  const providers = createProviders({ settings, enabled: ENABLED_PROVIDERS });
  settings.ensureEnabledProvider();
  // Live, not a constant: toggling approvals in Settings reaches the very next tool call and turn.
  // P7: the knowledge repo, read-only to every bot. Its folder is a read root only while it is synced.
  const knowledge = new KnowledgeRepo({ repos, source: () => settings.get().knowledgeRepo });
  const voice = new VoiceProposals(repos, memory);
  // P2: parked approvals and approval rules. "Allow for this session" rows belong to the previous process.
  const approvalStore = new ApprovalStore(db);
  approvalStore.clearSessionPolicies();
  const broker = new PermissionBroker(repos, {
    bypass: () => settings.approvals() === 'bypass',
    globalReadOnly: () => settings.approvals() === 'read-only',
    readOnlyRoots: () => { const d = knowledge.activeDir(); return d ? [d] : []; },
    store: approvalStore,
  });
  // Cards left open by the previous process can never be answered (their turns are gone): show them as expired.
  const expired = repos.expirePendingApprovals();
  if (expired.length) console.log('expired ' + expired.length + ' approval card(s) left open by the previous run');
  const router = new RoomRouter(repos, usage);
  const turns = new TurnRegistry();
  const routing = new RoutingRules(opts.routingFile);
  if (!opts.skipBootstrap) routing.ensureSeeded();
  // Per-bot computers (P1). Off unless POCKETROCKET_COMPUTERS=1 on Linux; then bots get no Browser or Desktop.
  const computers = opts.computers
    ? opts.computers(db)
    : new ComputerManager(new ComputersRepo(db), {
        routineDueSoon: (botId, withinMs) => {
          const t = Date.now();
          return repos.listRoutines().some((r) => r.botId === botId && r.enabled && r.nextRunAt !== null && r.nextRunAt - t <= withinMs);
        },
      });
  // A deleted bot (REST or the delete_bot tool) takes its computer with it: unit stopped, folder erased.
  const offComputers = events.onEvent((ev) => {
    if (ev.type === 'bots.changed') void computers.prune(ev.bots.map((b) => b.id)).catch((e) => console.warn('[computers] ' + (e as Error).message));
  });
  const media = new MediaStore(opts.mediaDir ?? MEDIA_DIR);
  const runner = new BotRunner(repos, memory, skills, broker, usage, {
    dispatchFromBot: (req, targets, onDone) => router.dispatchFromBot(req, targets, onDone),
    setState: (botId, roomId, state, note) => router.setState(botId, roomId, state, note),
    routinesChanged: () => scheduler.reload(),
  }, providers, turns, computers, { knowledgeDir: () => knowledge.activeDir(), routing }, media);
  router.runner = runner;
  router.autoMemory = new AutoMemory({ repos, memory, usage, activeProvider: () => providers.active().id, voice });
  const scheduler = new RoutineScheduler(repos, router);
  // P3: resumes turns a restart cut off, and nudges stalled handoffs.
  const followUp = new FollowUp({ repos, router, heldRuns: () => [...approvalStore.parkedRunIds(), ...control.parkedRunIds()] });

  // P2: take over / hand back / pause, and resuming turns that parked on the user.
  const control = new ComputerControlService({ computers, repos, vnc: opts.vnc });
  computers.wire({
    usesComputer: (botId) => {
      const tools = repos.getBot(botId)?.allowedTools ?? [];
      return tools.includes('Browser') || tools.includes('Desktop');
    },
    personHolds: (botId) => control.get(botId).control !== 'agent',
  });
  const restoredTakeovers = control.restoreParked();
  if (restoredTakeovers) console.log('restored ' + restoredTakeovers + ' parked takeover(s) from the previous run');
  runner.control = control;
  router.control = control;
  broker.onParkedDecision = (p, decision) => {
    router.resumeParked(p.botId, p.roomId, { causeId: p.causeId, hop: p.hop, runId: p.runId, note: parkedDecisionNote(p, decision) });
  };
  control.onParkedHandBack = (botId, t, note) => {
    router.resumeParked(botId, t.roomId, {
      causeId: t.causeId, hop: t.hop, runId: t.runId,
      note: note === null
        ? '(Nobody took over your computer within ' + Math.round(control.maxParkMs / 3_600_000) + ' hours of your request "' + t.reason +
          '", so you have control again. Do not ask again right away; tell the user what is still blocked.)'
        : handBackNote(note || 'no note'),
    });
  };
  approvalStore.prunePolicies(repos.listBots().map((b) => b.id));
  const offP2 = events.onEvent((ev) => {
    if (ev.type !== 'bots.changed') return;
    const ids = ev.bots.map((b) => b.id);
    approvalStore.prunePolicies(ids);
    control.prune(ids);
  });
  const takeoverApi = createTakeoverApi({ repos, control, store: approvalStore, broker });
  let p2Timer: NodeJS.Timeout | null = null;

  // P6: teach by demonstration (forces control=user while recording), distill/corrections, opt-in reflection.
  const recorder = new Recorder({ computers, control, ...opts.recorder });
  recorder.listen();
  const activeModels = () => providers.modelsSync(providers.active().id);
  const distiller = new SkillDistiller({ repos, skills, recorder, usage, activeProvider: () => providers.active().id, models: activeModels });
  router.skillReflection = new SkillReflection({ repos, skills, usage, activeProvider: () => providers.active().id, models: activeModels });
  // Bot training: opt-in per bot, weekly, and only the owner's Approve changes a bot.
  const training = new Training({ repos, memory, usage, activeProvider: () => providers.active().id, models: activeModels, ...opts.training });
  skills.versionsRepo.prune(repos.listBots().map((b) => b.id));
  training.prune(repos.listBots().map((b) => b.id));
  const offP6 = events.onEvent((ev) => {
    if (ev.type !== 'bots.changed') return;
    skills.versionsRepo.prune(ev.bots.map((b) => b.id));
    training.prune(ev.bots.map((b) => b.id));
  });
  const teachApi = createTeachApi({ repos, skills, recorder, distiller, training });

  // P4: integrations. Shared connections, per-bot grants; grants of deleted bots are dropped as bots change.
  const integrations = opts.integrations ? opts.integrations(db) : new IntegrationService({ db });
  runner.integrations = integrations;
  integrations.pruneGrants(repos.listBots().map((b) => b.id));
  const offBots = events.onEvent((ev) => { if (ev.type === 'bots.changed') integrations.pruneGrants(ev.bots.map((b) => b.id)); });
  const integrationsApi = createIntegrationsApi({ integrations, repos });

  // P5: event triggers. Outbound polling and Slack Socket Mode only (Q5); started in listen(), stopped first on shutdown.
  const triggers = new TriggerService({ db, repos, integrations, router, socket: opts.slackSocket });
  const triggersApi = createTriggersApi({ triggers });
  router.triggerBudget = (id) => triggers.remainingBudget(id);

  const screenSessions = new ScreenSessions();

  // P9: paired devices and opt-in Web Push. What a device token may reach is guard.ts `deviceMayAccess`.
  const allowedHosts = opts.allowedHosts ?? ALLOWED_HOSTS;
  const devicesRepo = new DevicesRepo(db);
  const devices = new DeviceService(devicesRepo);
  const push = opts.push
    ? opts.push(devicesRepo, repos)
    : PushService.withFile({ devices: devicesRepo, repos, subject: PUSH_SUBJECT, vapidPath: VAPID_PATH });
  const devicesApi = createDevicesApi({ devices, push, allowedHosts });
  // Every socket a device holds open (/ws and its Screen), so revoking it hangs them up at once.
  const deviceSockets = new Map<string, Set<{ close(): void }>>();
  const trackDeviceSocket = (deviceId: string, s: { close(): void }, onClose: (fn: () => void) => void) => {
    let set = deviceSockets.get(deviceId);
    if (!set) deviceSockets.set(deviceId, (set = new Set()));
    const mine = set;
    mine.add(s);
    onClose(() => {
      mine.delete(s);
      if (!mine.size && deviceSockets.get(deviceId) === mine) deviceSockets.delete(deviceId);
    });
  };
  const offRevoke = devices.onRevoke((id) => {
    screenSessions.revokeOwner(id);
    for (const s of deviceSockets.get(id) ?? []) s.close();
    deviceSockets.delete(id);
  });
  const mediaApi = createMediaApi({ media });
  // A hub on a test database must never sweep the real folder: every picture in it would look unreferenced.
  const sweepMedia = () => {
    if (opts.skipBootstrap && !opts.mediaDir) return;
    try { media.sweep(referencedMedia(repos, settings.get())); } catch (e) { logError('[media]', e); }
  };
  let mediaTimer: NodeJS.Timeout | null = null;
  const rest = createRest({
    media,
    repos, memory, skills, scheduler, router, runner, settings, secrets, providers, screenSessions, account, knowledge, voice, computers, routing,
    viewOnly: (scope) => control.viewOnly(scope),
  });
  const handleMcp = createMcpHandler(turns);

  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
    // P9: PWA manifest
    '.webmanifest': 'application/manifest+json',
  };

  // /screen/* -> noVNC (websockify) on the computer. Same-origin, so the SSH tunnel / Tailscale covers it.
  const screenProxy = httpProxy.createProxyServer({ target: SCREEN_URL, ws: true, changeOrigin: true });
  // Nothing secret rides these URLs any more, but the noVNC page is a live view of a real desktop: keep it
  // out of caches, out of Referer headers, and out of anyone else's frame.
  screenProxy.on('proxyRes', (proxyRes) => {
    proxyRes.headers['referrer-policy'] = 'no-referrer';
    proxyRes.headers['cache-control'] = 'no-store';
    proxyRes.headers['x-frame-options'] = 'SAMEORIGIN';
  });
  screenProxy.on('error', (_err, _req, res) => {
    if (res && 'writeHead' in res && typeof res.writeHead === 'function' && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('This screen is not running.');
    } else if (res && 'destroy' in res) {
      (res as { destroy: () => void }).destroy();
    }
  });

  /**
   * A GET that resolves to a real file under WEB_DIST is the app shell and its hashed assets: served without
   * the token so the browser can load the page that then asks for one. Nothing else is public — in
   * particular `/screen/*` resolves to no file here, so it falls through to the token check.
   */
  const isPublicAsset = (pathname: string): boolean => {
    const file = path.join(WEB_DIST, pathname);
    if (!file.startsWith(WEB_DIST + path.sep)) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };

  /**
   * `/screen/*` is the one place a browser cannot set a header — it is an iframe and then a websocket — so the
   * hub token used to ride the query string. It now presents the httpOnly cookie that `/screen/session` handed
   * out in exchange for a ticket. A bearer header still works for scripts and curl; `?token=` no longer does,
   * which is the whole point: the hub token can never end up in a URL, a history entry or a DOM attribute.
   */
  const screenAuth = (req: http.IncomingMessage): boolean => {
    const { scope } = screenRoute(new URL(req.url ?? '/', 'http://localhost').pathname);
    return screenSessions.valid(cookieValue(req, screenCookieName(scope)), scope) || (token !== null && tokenMatches(bearerToken(req), token));
  };

  /**
   * P1: `/screen/<botId>/*` is that bot's computer, `/screen/*` otherwise the shared screen. The scope decides
   * both which cookie authenticates the request and where it is proxied, so a session for bot A never reaches
   * bot B's screen. Only a bot that already has a computer slot is a scope; anything else is the shared screen.
   */
  function screenRoute(pathname: string): { scope: string | null; rest: string; target: string } {
    const m = /^\/screen\/([^/]+)(\/.*)?$/.exec(pathname);
    const ep = m ? computers.existingEndpoint(m[1]) : null;
    if (m && ep) return { scope: m[1], rest: m[2] ?? '/', target: ep.screenUrl };
    return { scope: null, rest: pathname.slice('/screen'.length), target: SCREEN_URL };
  }

  const limiter = new AuthRateLimiter();
  const auth = new AuthService(db);
  // Cookies ignore ports, so hubs on one machine need different names or signing in to one signs out the other.
  const sessionCookieName = () => SESSION_COOKIE + '_' + port;
  const authDeps = { db, repos, auth, limiter, cookieName: sessionCookieName };
  const authApi = createAuthApi(authDeps);
  const offSessionRevoke = auth.onRevoke((id) => {
    screenSessions.revokeOwner('session:' + id);
    for (const s of deviceSockets.get('session:' + id) ?? []) s.close();
    deviceSockets.delete('session:' + id);
  });
  /** The live session behind this request's cookie, if any. */
  const sessionOf = (req: http.IncomingMessage) => auth.authenticate(cookieValue(req, sessionCookieName()));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const guard = checkRequestOrigin(req, port, { allowedHosts });
      if (!guard.ok) {
        res.writeHead(guard.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: guard.reason }));
        return;
      }
      const ip = clientIp(req);
      if (limiter.blocked(ip)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
        res.end(JSON.stringify({ error: 'Too many failed authentication attempts; try again in a minute' }));
        return;
      }
      // The screen handshake authenticates with a one-shot ticket rather than the hub token, so it answers
      // ahead of the general check — but a bad ticket is a failed auth like any other and feeds the limiter.
      if (url.pathname === '/screen/session' && (req.method ?? 'GET') === 'GET') {
        const redeemed = screenSessions.redeemScoped(url.searchParams.get('ticket'));
        if (!redeemed) {
          limiter.fail(ip);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired screen ticket' }));
          return;
        }
        limiter.succeed(ip);
        res.writeHead(302, {
          'set-cookie': redeemed.cookie,
          location: screenViewerPath(redeemed.scope, control.viewOnly(redeemed.scope)),
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end();
        return;
      }
      let deviceId: string | null = null;
      const deviceToken = (t: string) => (deviceId = devices.authenticate(t)) !== null;
      const session = sessionOf(req);
      if (!checkToken(req, url, token, { isPublicAsset, screenAuth, deviceToken, session: () => !!session })) {
        limiter.fail(ip);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid hub token' }));
        return;
      }
      // P9: who this is. A device token only reaches what deviceMayAccess lists (403 otherwise, never 401).
      if (presentsHubToken(req, url, token)) setPrincipal(req, { kind: 'hub', userId: repos.owner().id });
      else if (session) {
        // Does not clear the limiter: a held session must not wipe failed password tries from this address.
        setPrincipal(req, { kind: 'hub', sessionId: session.sessionId, userId: session.userId });
      } else if (deviceId) {
        setPrincipal(req, { kind: 'device', deviceId });
        limiter.succeed(ip);
        if (!deviceMayAccess(req.method ?? 'GET', url.pathname)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not available from a paired device; use the desktop app' }));
          return;
        }
      }
      const auditMethod = req.method ?? 'GET';
      const auditPath = url.pathname;
      // On the answer rather than on 'finish', which never fires if the client hangs up after the change is made.
      if (auditMethod !== 'GET') {
        const end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
        let logged = false;
        res.end = ((...a: unknown[]) => {
          if (!logged) {
            logged = true;
            auditRequest(db, req, auditMethod, auditPath, res.statusCode);
          }
          return end(...a);
        }) as typeof res.end;
      }
      if (url.pathname === AUTH_STATUS_PATH && auditMethod === 'GET') { handleAuthStatus(req, res, authDeps); return; }
      // Token-exempt, so reaching it proves nothing: it must not clear the limiter, and it feeds it on failure.
      if (url.pathname === AUTH_CALLBACK_PATH && (req.method ?? 'GET') === 'GET') {
        await handleAuthCallback(req, res, url, { account, limiter });
        return;
      }
      // P4: same footing as /auth/callback (token-exempt, feeds the limiter when nothing is pending).
      if (url.pathname.startsWith(OAUTH_CALLBACK_PREFIX) && (req.method ?? 'GET') === 'GET') {
        await handleOAuthCallback(req, res, url, { integrations, limiter });
        return;
      }
      if (presentsHubToken(req, url, token)) limiter.succeed(ip);
      const ct = checkContentType(req, url);
      if (!ct.ok) {
        res.writeHead(ct.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: ct.reason }));
        return;
      }
      // P9: token-exempt; every miss feeds the limiter.
      if (url.pathname === DEVICE_PAIR_PATH && (req.method ?? 'GET') === 'POST') {
        await handleDevicePair(req, res, { devices, limiter });
        return;
      }
      if (url.pathname === '/mcp') {
        let body: unknown;
        if ((req.method ?? 'GET') === 'POST') {
          const buf = await readBody(req);
          if (buf === null) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            return;
          }
          const raw = buf.toString('utf8');
          try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
        }
        await handleMcp(req, res, body);
        return;
      }
      if (url.pathname.startsWith(OAUTH_START_PREFIX)) {
        await handleOAuthStart(req, res, url, { integrations });
        return;
      }
      if (url.pathname === AUTH_LOGIN_PATH && auditMethod === 'POST') { await handleLogin(req, res, authDeps); return; }
      if (await authApi(req, res, url)) return;
      if (await mediaApi(req, res)) return;
      if (await devicesApi(req, res)) return;
      if (await integrationsApi(req, res)) return;
      if (await triggersApi(req, res)) return;
      if (await takeoverApi(req, res)) return;
      if (await teachApi(req, res)) return;
      if (await rest(req, res)) return;
      if (url.pathname.startsWith('/screen/')) {
        const route = screenRoute(url.pathname);
        req.url = route.rest + url.search;
        // The screen backend runs beside the bots, and a sign-in cookie opens the whole hub.
        dropCookie(req, sessionCookieName());
        screenProxy.web(req, res, { target: route.target });
        return;
      }
      // static web/dist (production)
      let file = path.join(WEB_DIST, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(WEB_DIST)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('PocketRocket hub running. Web UI not built; run `pnpm dev` for Vite dev server or `pnpm build`.');
        return;
      }
      // P9: the service worker and the manifest have fixed names, so they must be revalidated like the shell;
      // an immutable sw.js would pin every installed phone to the build it first saw.
      const isShell = ['index.html', 'sw.js', 'manifest.json', 'manifest.webmanifest'].includes(path.basename(file));
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        // hashed assets are immutable; the shell must always be re-fetched so a reload picks up new builds
        'cache-control': isShell ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      logError('[static]', e);
      res.writeHead(500);
      res.end('error');
    }
  });

  const wss = attachWs(server, { repos, router, broker, settings });
  server.on('upgrade', (req, socket, head) => {
    const p = req.url ?? '';
    const url = new URL(p, 'http://localhost');
    const ip = clientIp(req);
    if (limiter.blocked(ip) || !checkRequestOrigin(req, port, { allowedHosts }).ok) {
      socket.destroy();
      return;
    }
    // Applies to /screen/* too: the noVNC proxy used to be exempt (audit 2026-09-09, B2).
    let deviceId: string | null = null;
    const deviceToken = (t: string) => (deviceId = devices.authenticate(t)) !== null;
    const session = sessionOf(req);
    if (!checkToken(req, url, token, { isPublicAsset, screenAuth, deviceToken, session: () => !!session })) {
      limiter.fail(ip);
      socket.destroy();
      return;
    }
    if (presentsHubToken(req, url, token)) {
      limiter.succeed(ip);
      setPrincipal(req, { kind: 'hub', userId: repos.owner().id });
    } else if (session) {
      setPrincipal(req, { kind: 'hub', sessionId: session.sessionId, userId: session.userId });
    } else if (deviceId) {
      limiter.succeed(ip);
      setPrincipal(req, { kind: 'device', deviceId });
    }
    if (url.pathname === '/ws') {
      const id: string | null = deviceId;
      const sessionId = session?.sessionId;
      wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
        if (sessionId && !presentsHubToken(req, url, token)) trackDeviceSocket('session:' + sessionId, { close: () => ws.close(4001, 'signed out') }, (fn) => ws.once('close', fn));
        if (id) trackDeviceSocket(id, { close: () => ws.close(4001, 'device revoked') }, (fn) => ws.once('close', fn));
        wss.emit('connection', ws, req);
      });
    } else if (url.pathname.startsWith('/screen/')) {
      const route = screenRoute(url.pathname);
      req.url = route.rest + url.search;
      // An open viewer keeps the bot's computer from an idle stop until it disconnects.
      if (route.scope) socket.once('close', computers.viewerOpened(route.scope));
      // P9: a Screen a paired device opened closes with the device.
      const owner = screenSessions.ownerOf(cookieValue(req, screenCookieName(route.scope)), route.scope);
      if (owner) trackDeviceSocket(owner, { close: () => socket.destroy() }, (fn) => socket.once('close', fn));
      dropCookie(req, sessionCookieName());
      screenProxy.ws(req, socket, head, { target: route.target });
    } else {
      socket.destroy();
    }
  });

  return {
    server, get port() { return port; }, repos, settings, secrets, account, providers, turns, runner, computers, integrations, triggers, devices, push,
    control, broker, approvals: approvalStore,
    skills, recorder, distiller, media,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          port = (server.address() as { port: number }).port;
          const resumed = followUp.resumeInterrupted();
          if (resumed) console.log('resuming ' + resumed + ' turn(s) cut off by the previous run');
          followUp.start();
          // P2: re-apply view-only as computers come up; give up on parked cards and takeovers after 24 h.
          control.start();
          broker.sweepParked();
          p2Timer ??= setInterval(() => { broker.sweepParked(); control.sweep(); auth.expireDue(); }, 60_000);
          p2Timer.unref();
          sweepMedia();
          mediaTimer ??= setInterval(sweepMedia, MEDIA_SWEEP_MS);
          mediaTimer.unref();
          scheduler.start();
          training.start();
          // P5: after resumeInterrupted, so a resumed trigger turn is not also re-fired from the inbox.
          triggers.start();
          // P9: content-free pushes for approval cards and finished routines (only to opted-in subscriptions).
          push.start();
          // P7: sync the knowledge repo if its source changed, then pull it on a timer (never blocks start).
          knowledge.start(KNOWLEDGE_SYNC_MINUTES);
          // Reconcile with systemd, prune deleted bots, move the shared screen's logins (once), start timers.
          void computers.startBackground(repos.listBots()).catch((e) => console.warn('[computers] ' + (e as Error).message));
          // Async on purpose: an offline start must not hold the hub up (see AccountService).
          void account.start();
          console.log(
            'PocketRocket hub v' + VERSION + ' · node ' + process.versions.node +
            ' · provider ' + settings.get().provider + ' · data ' + DATA_DIR +
            ' · http://' + HOST + ':' + port,
          );
          console.log('[pocketrocket] workspace: ' + WORKSPACE_DIR + (token ? '  (token required)' : ''));
          if (settings.approvals() === 'bypass') {
            console.warn(
              '[pocketrocket] WARNING: permissions bypassed — bots run every shell/file/web action with no approval card (' +
              (settings.approvalsLocked ? 'set by POCKETROCKET_BYPASS_PERMISSIONS; =0 to restore' : 'turn approvals back on in Settings') + ')',
            );
          }
          // Say where the token is, never what it is: this output ends up in the journal and in hub.log.
          if (token) console.log('[pocketrocket] open: http://' + HOST + ':' + port + '/  (sign in with the token from ' + (HUB_TOKEN ? 'POCKETROCKET_TOKEN' : HUB_TOKEN_PATH) + ')');
          resolve(port);
        });
      }),
    async shutdown() {
      scheduler.stop();
      // Aborts a running pass and waits for it, so nothing writes to the database after it closes below.
      await training.stop();
      triggers.stop();
      followUp.stop();
      control.stop();
      offP2();
      // P6: an open recording ends (its control is in memory anyway) and its computer is released.
      offP6();
      await recorder.shutdown();
      if (p2Timer) clearInterval(p2Timer);
      if (mediaTimer) clearInterval(mediaTimer);
      knowledge.stop();
      offComputers();
      // Timers only: the computers are systemd units and keep running across a hub restart.
      computers.stopBackground();
      // P4: stop listening for bot changes and drop any OAuth/device sign-in still waiting.
      offBots();
      for (const p of integrations.pending()) integrations.cancel(p.provider);
      account.stop();
      push.stop();
      offRevoke();
      offSessionRevoke();
      // Keep the lane journal: the turns interrupted here resume on the next start (P3).
      router.freeze();
      runner.interruptAll();
      await providers.shutdown();
      for (const c of wss.clients) c.terminate();
      wss.close();
      // Keep-alive sockets would otherwise hold server.close() open until they time out.
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try { db.raw.close(); } catch { /* already closed */ }
    },
  };
}

/** P2: the line a resumed bot gets when the user answers the approval card its turn parked on. */
function parkedDecisionNote(p: ParkedApproval, decision: 'allow' | 'always' | 'deny' | 'timeout'): string {
  const what = '"' + p.toolName + '"' + (p.reason ? ' (' + p.reason + ')' : '');
  if (decision === 'allow' || decision === 'always') {
    return '(Approval granted: the user allowed ' + what + '. Retry exactly the same call now; it goes through without another card. Then finish the task.)';
  }
  if (decision === 'deny') return '(Approval denied: the user declined ' + what + '. Do not retry it; choose another approach or say so in the room.)';
  return '(Approval expired: nobody answered ' + what + ' in time, so it was denied. Do not retry it; say so in the room.)';
}
