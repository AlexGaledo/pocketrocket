import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHub, type Hub } from '../hub.js';

const TOKEN = 'test-token-123';
let hub: Hub;
let port: number;

beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
});

/** Raw request so we can forge Host / Origin (fetch refuses to set Host). */
function req(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: '127.0.0.1:' + port, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

function upgrade(path: string, headers: Record<string, string> = {}): Promise<'open' | 'closed'> {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: {
        host: '127.0.0.1:' + port, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers,
      },
    });
    r.on('upgrade', (_res, socket) => { socket.destroy(); resolve('open'); });
    r.on('response', () => resolve('closed'));
    r.on('error', () => resolve('closed'));
    r.end();
  });
}

describe('hub hardening', () => {
  it('serves health without a token', async () => {
    const r = await req('/api/health');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { provider: string; version: string };
    expect(body.provider).toBe('claude');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    expect((await req('/api/health', { host: 'evil.example.com' })).status).toBe(403);
    expect((await req('/api/health', { host: 'evil.example.com:' + port })).status).toBe(403);
  });

  it('accepts loopback Host names', async () => {
    expect((await req('/api/health', { host: 'localhost:' + port })).status).toBe(200);
    expect((await req('/api/health', { host: '[::1]:' + port })).status).toBe(200);
  });

  it('rejects a cross-site Origin', async () => {
    expect((await req('/api/health', { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await req('/api/health', { origin: 'http://127.0.0.1:' + port })).status).toBe(200);
    expect((await req('/api/health', { origin: 'http://localhost:' + port })).status).toBe(200);
  });

  it('requires the bearer token on /api/* but not on GET /api/health', async () => {
    expect((await req('/api/bots')).status).toBe(401);
    expect((await req('/api/bots', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await req('/api/bots', { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
    expect((await req('/api/settings', { authorization: 'Bearer ' + TOKEN })).status).toBe(200);
  });

  it('requires ?token= on the websocket upgrade', async () => {
    expect(await upgrade('/ws')).toBe('closed');
    expect(await upgrade('/ws?token=wrong')).toBe('closed');
    expect(await upgrade('/ws?token=' + TOKEN)).toBe('open');
    expect(await upgrade('/ws?token=' + TOKEN, { origin: 'https://evil.example.com' })).toBe('closed');
    expect(await upgrade('/ws?token=' + TOKEN, { host: 'evil.example.com' })).toBe('closed');
  });
});
