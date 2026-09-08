import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import httpProxy from 'http-proxy';
import { HOST, PORT, WEB_DIST, CLAUDE_EXE, WORKSPACE_DIR, SCREEN_URL, ensureDirs } from './config.js';
import { Db } from './db/db.js';
import { Repos } from './db/repos.js';
import { MemoryService } from './services/MemoryService.js';
import { SkillService } from './services/SkillService.js';
import { UsageTracker } from './services/UsageTracker.js';
import { PermissionBroker } from './permissions/PermissionBroker.js';
import { RoomRouter } from './rooms/RoomRouter.js';
import { BotRunner } from './agent/BotRunner.js';
import { RoutineScheduler } from './services/RoutineScheduler.js';
import { createRest } from './api/rest.js';
import { attachWs } from './api/ws.js';

// The SDK warns every turn that bare allowedTools entries (WebSearch/WebFetch/mcp__claudebot__*) bypass
// canUseTool. That is intentional here; file/shell tools are never pre-approved. Silence just that warning.
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('canUseTool will not be invoked')) return;
  (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

ensureDirs();
const db = new Db();
const repos = new Repos(db);
const memory = new MemoryService();
const skills = new SkillService(repos);
const usage = new UsageTracker(repos);
const broker = new PermissionBroker(repos);
const router = new RoomRouter(repos, usage);
const runner = new BotRunner(repos, memory, skills, broker, usage, {
  dispatchFromBot: (req, targets) => router.dispatchFromBot(req, targets),
  setState: (botId, roomId, state, note) => router.setState(botId, roomId, state, note),
});
router.runner = runner;
const scheduler = new RoutineScheduler(repos, router);

const rest = createRest({ repos, memory, skills, scheduler, router, runner });

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

// /screen/* -> noVNC (websockify) on the computer. Same-origin, so the SSH tunnel / Tailscale covers it.
const screenProxy = httpProxy.createProxyServer({ target: SCREEN_URL, ws: true, changeOrigin: true });
screenProxy.on('error', (_err, _req, res) => {
  if (res && 'writeHead' in res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Screen is not running on this computer. On the VPS: systemctl status claudebot-screen');
  } else if (res && 'destroy' in res) {
    (res as { destroy: () => void }).destroy();
  }
});

const server = http.createServer(async (req, res) => {
  try {
    if (await rest(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
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
      res.end('Claudebot hub running. Web UI not built; run `pnpm dev` for Vite dev server or `pnpm build`.');
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

const wss = attachWs(server, { repos, router, broker });
server.on('upgrade', (req, socket, head) => {
  const p = req.url ?? '';
  if (p === '/ws' || p.startsWith('/ws?')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (p.startsWith('/screen/')) {
    req.url = p.slice('/screen'.length);
    screenProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const exe = BotRunner.checkExe();
  console.log('[claudebot] hub listening on http://' + HOST + ':' + PORT);
  console.log('[claudebot] workspace: ' + WORKSPACE_DIR);
  console.log('[claudebot] claude: ' + CLAUDE_EXE + (exe.ok ? '' : '  (NOT FOUND)'));
  scheduler.start();
});

const shutdown = () => {
  scheduler.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
