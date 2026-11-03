import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { Hub } from '../hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TOKEN = 'proxy-hub-token';
const PASSWORD = 'correct horse battery';
const seen: (string | undefined)[] = [];
let backend: http.Server;
let hub: Hub;
let port: number;

// Stands in for the screen backend: it only records the cookies the hub passed on.
beforeAll(async () => {
  backend = http.createServer((req, res) => {
    seen.push(req.headers.cookie);
    res.end('screen');
  });
  const wss = new WebSocketServer({ server: backend });
  wss.on('connection', (ws, req) => {
    seen.push(req.headers.cookie);
    ws.send('hi');
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  process.env.SCREEN_URL = 'http://127.0.0.1:' + (backend.address() as AddressInfo).port;
  const { createHub } = await import('../hub.js');
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  backend.closeAllConnections();
  await new Promise((r) => backend.close(r));
  delete process.env.SCREEN_URL;
});

function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; cookie: string; json: { url?: string } }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1:' + port, 'content-type': 'application/json', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(raw); } catch { /* not every answer is JSON */ }
        resolve({ status: res.statusCode ?? 0, cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0], json });
      });
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

it('keeps the sign-in cookie away from the screen backend, on pages and on the websocket', async () => {
  await call('POST', '/api/auth/password', { authorization: 'Bearer ' + TOKEN }, { password: PASSWORD });
  const session = (await call('POST', '/api/auth/login', {}, { password: PASSWORD })).cookie;
  expect(session).toMatch(/^pr_session_\d+=/);
  const minted = await call('POST', '/api/screen/ticket', { cookie: session }, {});
  const screen = (await call('GET', minted.json.url!, {})).cookie;
  // A real browser sends both: the sign-in cookie has Path=/, so it rides along to /screen/*.
  const cookie = session + '; ' + screen;

  expect((await call('GET', '/screen/vnc.html', { cookie })).status).toBe(200);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/screen/websockify', { headers: { cookie } });
    ws.once('message', () => { ws.close(); resolve(); });
    ws.once('error', reject);
  });

  expect(seen).toEqual([screen, screen]);
});
