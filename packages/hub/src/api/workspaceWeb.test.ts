import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceWebHandler } from './workspaceWeb.js';

let base: string;
let ws: string;
let server: http.Server;
let port: number;

function get(p: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; type: string; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { host: opts.host ?? '127.0.0.1:' + port } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body, location: res.headers.location }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-wsweb-'));
  ws = path.join(base, 'workspace');
  fs.mkdirSync(path.join(ws, 'learning'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'learning', 'visuals.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(base, 'secrets.json'), '{"token":"x"}');
  server = http.createServer(workspaceWebHandler(ws));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(base, { recursive: true, force: true });
});

describe('workspace web server', () => {
  it('serves an HTML file from the workspace as a page', async () => {
    const r = await get('/learning/visuals.html');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/html/);
    expect(r.body).toBe('<h1>hi</h1>');
  });

  it('lists a folder, hiding dotfiles, and redirects to the trailing slash first', async () => {
    const redirect = await get('/learning');
    expect(redirect.status).toBe(301);
    expect(redirect.location).toBe('/learning/');
    const root = await get('/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('learning/');
    expect(root.body).not.toContain('.env');
  });

  it('never leaves the workspace', async () => {
    for (const p of ['/../secrets.json', '/..%2fsecrets.json', '/learning/..%2f..%2fsecrets.json', '/%2e%2e/secrets.json']) {
      const r = await get(p);
      expect(r.status, p).not.toBe(200);
      expect(r.body, p).not.toContain('token');
    }
  });

  it('refuses a symlink that points out of the workspace', async () => {
    try {
      fs.symlinkSync(path.join(base, 'secrets.json'), path.join(ws, 'link.json'));
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    const r = await get('/link.json');
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('token');
  });

  it('answers only loopback Host headers (no DNS rebinding) and only GET/HEAD', async () => {
    expect((await get('/learning/visuals.html', { host: 'evil.example:' + port })).status).toBe(403);
    expect((await get('/learning/visuals.html', { host: 'localhost:' + port })).status).toBe(200);
    expect((await get('/learning/visuals.html', { method: 'POST' })).status).toBe(405);
  });

  it('404s a missing file', async () => {
    expect((await get('/nope.html')).status).toBe(404);
  });
});
