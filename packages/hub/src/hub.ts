import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import httpProxy from 'http-proxy';
import {
  HOST, PORT, WEB_DIST, WORKSPACE_DIR, SCREEN_URL, VERSION, DATA_DIR, ENABLED_PROVIDERS,
  ensureDirs, ensureHubToken, migrateLegacyDb,
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
import { RoutineScheduler } from './services/RoutineScheduler.js';
import { createProviders } from './providers/registry.js';
import { TurnRegistry, createMcpHandler } from './mcp/httpServer.js';
import { createRest } from './api/rest.js';
import { attachWs } from './api/ws.js';
import { AUTH_CALLBACK_PATH, AuthRateLimiter, bearerToken, checkContentType, checkRequestOrigin, checkToken, clientIp, cookieValue, tokenMatches } from './api/guard.js';
import { SCREEN_COOKIE, SCREEN_VIEWER_PATH, ScreenSessions } from './api/screenSession.js';
import { readBody } from './api/body.js';
import { handleAuthCallback } from './api/authCallback.js';
import { addSecret } from './providers/redact.js';

export interface HubOptions {
  port?: number;
  /** Bearer token required on /api/* and /ws. Defaults to POCKETROCKET_TOKEN. */
  token?: string | null;
  /** SQLite file; ':memory:' in tests. */
  dbFile?: string;
  /** Skip directory creation + legacy db copy (tests). */
  skipBootstrap?: boolean;
  /** Account service; tests hand in one over a fake Supabase client. */
  account?: AccountService;
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
  const providers = createProviders({ settings, enabled: ENABLED_PROVIDERS });
  settings.ensureEnabledProvider();
  // Live, not a constant: toggling approvals in Settings reaches the very next tool call and turn.
  const broker = new PermissionBroker(repos, { bypass: () => settings.approvals() === 'bypass' });
  const router = new RoomRouter(repos, usage);
  const turns = new TurnRegistry();
  const runner = new BotRunner(repos, memory, skills, broker, usage, {
    dispatchFromBot: (req, targets) => router.dispatchFromBot(req, targets),
    setState: (botId, roomId, state, note) => router.setState(botId, roomId, state, note),
  }, providers, turns);
  router.runner = runner;
  router.autoMemory = new AutoMemory({ repos, memory, usage, activeProvider: () => providers.active().id });
  const scheduler = new RoutineScheduler(repos, router);

  const screenSessions = new ScreenSessions();
  const rest = createRest({ repos, memory, skills, scheduler, router, runner, settings, secrets, providers, screenSessions, account });
  const handleMcp = createMcpHandler(turns);

  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
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
      res.end('Screen is not running on this computer. On the VPS: systemctl status pocketrocket-screen');
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
  const screenAuth = (req: http.IncomingMessage): boolean =>
    screenSessions.valid(cookieValue(req, SCREEN_COOKIE)) || (token !== null && tokenMatches(bearerToken(req), token));

  const limiter = new AuthRateLimiter();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const guard = checkRequestOrigin(req, port);
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
        const cookie = screenSessions.redeem(url.searchParams.get('ticket'));
        if (!cookie) {
          limiter.fail(ip);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired screen ticket' }));
          return;
        }
        limiter.succeed(ip);
        res.writeHead(302, {
          'set-cookie': cookie,
          location: SCREEN_VIEWER_PATH,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end();
        return;
      }
      if (!checkToken(req, url, token, { isPublicAsset, screenAuth })) {
        limiter.fail(ip);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid hub token' }));
        return;
      }
      // Token-exempt, so reaching it proves nothing: it must not clear the limiter, and it feeds it on failure.
      if (url.pathname === AUTH_CALLBACK_PATH && (req.method ?? 'GET') === 'GET') {
        await handleAuthCallback(req, res, url, { account, limiter });
        return;
      }
      limiter.succeed(ip);
      const ct = checkContentType(req, url);
      if (!ct.ok) {
        res.writeHead(ct.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: ct.reason }));
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
      if (await rest(req, res)) return;
      if (url.pathname.startsWith('/screen/')) {
        req.url = url.pathname.slice('/screen'.length) + url.search;
        screenProxy.web(req, res);
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
      const isShell = path.basename(file) === 'index.html';
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        // hashed assets are immutable; the shell must always be re-fetched so a reload picks up new builds
        'cache-control': isShell ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end('error');
    }
  });

  const wss = attachWs(server, { repos, router, broker, settings });
  server.on('upgrade', (req, socket, head) => {
    const p = req.url ?? '';
    const url = new URL(p, 'http://localhost');
    const ip = clientIp(req);
    if (limiter.blocked(ip) || !checkRequestOrigin(req, port).ok) {
      socket.destroy();
      return;
    }
    // Applies to /screen/* too: the noVNC proxy used to be exempt (audit 2026-09-09, B2).
    if (!checkToken(req, url, token, { isPublicAsset, screenAuth })) {
      limiter.fail(ip);
      socket.destroy();
      return;
    }
    limiter.succeed(ip);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (url.pathname.startsWith('/screen/')) {
      req.url = p.slice('/screen'.length);
      screenProxy.ws(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  return {
    server, get port() { return port; }, repos, settings, secrets, account, providers, turns, runner,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          port = (server.address() as { port: number }).port;
          scheduler.start();
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
          // The token lives in the URL fragment, so it never reaches the server as a query string and the
          // web client moves it straight into sessionStorage. This line is how a human opens the UI.
          if (token) console.log('[pocketrocket] open: http://' + HOST + ':' + port + '/#token=' + token);
          resolve(port);
        });
      }),
    async shutdown() {
      scheduler.stop();
      account.stop();
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
