import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess } from './guard.js';

/** P4-2: GET /api/rooms/:id/context, the context meter's read. */

const TOKEN = 'context-meter-token';

describe('GET /api/rooms/:id/context', () => {
  let hub: Hub;
  let port: number;
  let n = 0;
  beforeAll(async () => {
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
    port = await hub.listen();
  });
  afterAll(async () => {
    await hub.shutdown();
  });
  const get = (url: string, token: string | null = TOKEN) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port, ...(token ? { authorization: 'Bearer ' + token } : {}) };
    http.get({ host: '127.0.0.1', port, path: url, headers }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: out ? JSON.parse(out) : null }));
    }).on('error', reject);
  });
  const bot = () => { const h = 'cm' + ++n; return hub.repos.createBot({ name: 'B' + n, handle: h, title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 }); };

  it('gives each measured bot its size, window and rotation point, and leaves out the rest', async () => {
    const [a, b, c] = [bot(), bot(), bot()];
    const room = hub.repos.createRoom({ kind: 'group', name: 'crew', memberIds: [a.id, b.id, c.id], coordinatorBotId: a.id });
    hub.repos.saveSession(a.id, room.id, { sdkSessionId: 's1', provider: 'claude' });
    hub.repos.saveSessionState(a.id, room.id, { contextTokens: 84_000, contextWindow: 1_000_000, contextAt: Date.now() });
    // b: a fresh session that has not run a model call yet. c: never ran here.
    hub.repos.saveSessionState(b.id, room.id, { contextTokens: 0, contextAt: Date.now() });
    const r = await get('/api/rooms/' + room.id + '/context');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ [a.id]: { contextTokens: 84_000, window: 1_000_000, rotateAt: 120_000 } });
  });

  it('skips a session written by a provider this hub does not run', async () => {
    const a = bot();
    const room = hub.repos.createRoom({ kind: 'dm', name: 'dm', memberIds: [a.id], coordinatorBotId: null });
    hub.repos.saveSession(a.id, room.id, { sdkSessionId: 's1', provider: 'grok' });
    hub.repos.saveSessionState(a.id, room.id, { contextTokens: 50_000, contextAt: Date.now() });
    expect((await get('/api/rooms/' + room.id + '/context')).json).toEqual({});
  });

  it('404s an unknown room, refuses a missing or wrong token, and is a read a paired device may make', async () => {
    expect((await get('/api/rooms/nope/context')).status).toBe(404);
    const room = hub.repos.createRoom({ kind: 'dm', name: 'dm2', memberIds: [bot().id], coordinatorBotId: null });
    expect((await get('/api/rooms/' + room.id + '/context', null)).status).toBe(401);
    expect((await get('/api/rooms/' + room.id + '/context', 'wrong')).status).toBe(401);
    expect(deviceMayAccess('GET', '/api/rooms/r1/context')).toBe(true);
    expect(deviceMayAccess('POST', '/api/rooms/r1/context')).toBe(false);
  });
});
