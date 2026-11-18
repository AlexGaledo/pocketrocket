import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess } from './guard.js';
import { setSandboxProbeForTests } from '../providers/sandbox.js';

/** Bridge P7: the sandbox switch and its status. Only the hub token writes it; a device (a phone) cannot. */
const TOKEN = 'sandbox-test-hub-token';
let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
});
afterEach(() => {
  setSandboxProbeForTests();
});

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port };
    if (token) headers.authorization = 'Bearer ' + token;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

describe('sandbox setting and status', () => {
  it('is off by default', async () => {
    expect((await req('GET', '/api/settings')).json.sandbox).toBe('off');
    setSandboxProbeForTests(() => ({ ok: true, reason: '' }));
    expect((await req('GET', '/api/sandbox/status')).json).toEqual({ available: true, active: false, reason: '' });
  });

  it('refuses to turn on while bubblewrap cannot run, and says why', async () => {
    setSandboxProbeForTests(() => ({ ok: false, reason: 'bubblewrap (bwrap) is not installed.' }));
    const r = await req('PUT', '/api/settings', { sandbox: 'on' });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('not installed');
    expect((await req('GET', '/api/settings')).json.sandbox).toBe('off');
    expect((await req('GET', '/api/sandbox/status')).json).toEqual({ available: false, active: false, reason: 'bubblewrap (bwrap) is not installed.' });
  });

  it('turns on when it works, reports active, and turns off again', async () => {
    setSandboxProbeForTests(() => ({ ok: true, reason: '' }));
    const on = await req('PUT', '/api/settings', { sandbox: 'on' });
    expect(on.status).toBe(200);
    expect(on.json.sandbox).toBe('on');
    expect((await req('GET', '/api/sandbox/status')).json).toEqual({ available: true, active: true, reason: '' });
    // Turning it off never needs bubblewrap.
    setSandboxProbeForTests(() => ({ ok: false, reason: 'gone' }));
    expect((await req('PUT', '/api/settings', { sandbox: 'off' })).json.sandbox).toBe('off');
  });

  it('rejects a value that is not off or on', async () => {
    expect((await req('PUT', '/api/settings', { sandbox: 'maybe' })).status).toBe(400);
  });

  it('needs a credential, and a paired device cannot read the status or write the setting', async () => {
    expect((await req('PUT', '/api/settings', { sandbox: 'off' }, null)).status).toBe(401);
    expect((await req('GET', '/api/sandbox/status', undefined, null)).status).toBe(401);
    expect(deviceMayAccess('PUT', '/api/settings')).toBe(false);
    expect(deviceMayAccess('GET', '/api/sandbox/status')).toBe(false);
  });
});
