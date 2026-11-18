import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess, runnerMayAccess } from './guard.js';

/**
 * Queue controls over REST (02 tasks 2.1a/2.1b/2.2): the owner's paired phone may read a room's queue and use its
 * controls, exactly the listed routes; every other queue path stays refused, and nothing answers without a token.
 */

const TOKEN = 'queue-rest-token';
let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
});

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
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
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function pairDevice(): Promise<string> {
  const minted = await req('POST', '/api/devices/pairing', { token: TOKEN, body: {} });
  const r = await req('POST', '/api/devices/pair', { body: { code: minted.json.code, name: 'Phone' } });
  expect(r.status).toBe(200);
  return r.json.token;
}

describe('queue routes', () => {
  it('the device allowlist names exactly the queue routes, nothing beside them', () => {
    expect(deviceMayAccess('GET', '/api/rooms/r1/queue')).toBe(true);
    for (const a of ['cancel', 'edit', 'send-now', 'pause']) expect(deviceMayAccess('POST', '/api/rooms/r1/queue/' + a), a).toBe(true);
    for (const [m, p] of [['POST', '/api/rooms/r1/queue/reorder'], ['DELETE', '/api/rooms/r1/queue'], ['PUT', '/api/rooms/r1/queue/pause'], ['GET', '/api/rooms/r1/queue/cancel'], ['POST', '/api/rooms/r1/queue']]) {
      expect(deviceMayAccess(m, p), m + ' ' + p).toBe(false);
    }
    expect(runnerMayAccess('GET', '/api/rooms/r1/queue')).toBe(false);
  });

  it('a paired phone reads the queue and pauses it; no token is refused', async () => {
    const bot = await req('POST', '/api/bots', { token: TOKEN, body: { name: 'Ada', handle: 'ada' } });
    expect(bot.status).toBe(200);
    const room = await req('POST', '/api/rooms', { token: TOKEN, body: { kind: 'dm', name: 'DM', memberIds: [bot.json.id] } });
    expect(room.status).toBe(200);
    const path = '/api/rooms/' + room.json.id + '/queue';
    const phone = await pairDevice();

    expect((await req('GET', path)).status).toBe(401);
    expect((await req('POST', path + '/pause', { body: { paused: true } })).status).toBe(401);

    expect(await req('GET', path, { token: phone })).toEqual({ status: 200, json: [] });
    const paused = await req('POST', path + '/pause', { token: phone, body: { botId: bot.json.id, paused: true } });
    expect(paused.status).toBe(200);
    expect(paused.json).toEqual([{ botId: bot.json.id, roomId: room.json.id, paused: true, running: false, items: [] }]);
    expect((await req('GET', path, { token: phone })).json).toEqual(paused.json);
    expect((await req('POST', path + '/pause', { token: phone, body: { paused: false } })).status).toBe(200);
    expect((await req('GET', path, { token: TOKEN })).json).toEqual([]);

    // Reaches the router (not the guard): nothing queued is a 404 / 409, a bad body a 400.
    expect((await req('POST', path + '/cancel', { token: phone, body: { journalId: 'nope' } })).status).toBe(404);
    expect((await req('POST', path + '/edit', { token: phone, body: { journalId: 'nope', text: 'x' } })).status).toBe(404);
    expect((await req('POST', path + '/edit', { token: phone, body: { journalId: 'nope', text: '' } })).status).toBe(400);
    expect((await req('POST', path + '/send-now', { token: phone, body: { botId: bot.json.id } })).status).toBe(409);
    expect((await req('GET', '/api/rooms/missing/queue', { token: TOKEN })).status).toBe(404);
    // A device still cannot reach routes beside them.
    expect((await req('POST', path + '/reorder', { token: phone, body: {} })).status).toBe(403);

    // Over the socket, a phone pauses the queue and every client hears queue.changed; a refusal names what it was about.
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(phone));
    const got: any[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send(JSON.stringify({ type: 'queue.pause', roomId: room.json.id, botId: bot.json.id, paused: true }));
    ws.send(JSON.stringify({ type: 'queue.cancel', journalId: 'gone' }));
    for (let i = 0; i < 200 && got.filter((e) => e.type !== 'hello' && e.type !== 'ping').length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    ws.close();
    expect(got.find((e) => e.type === 'queue.changed')?.queue).toMatchObject({ botId: bot.json.id, paused: true });
    expect(got.find((e) => e.type === 'error')).toMatchObject({ message: 'That item is no longer queued.', context: 'gone' });
  });
});
