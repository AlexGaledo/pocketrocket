import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TelegramState } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { IntegrationService } from '../services/IntegrationService.js';
import { IntegrationVault } from '../services/IntegrationVault.js';
import { TelegramService, MAX_WRONG_CODES } from '../services/TelegramService.js';
import { fakeFetch } from '../integrations/fakeFetch.js';
import { deviceMayAccess, runnerMayAccess } from './guard.js';

const TOKEN = 'telegram-rest-hub-token';
const BOT_TOKEN = '123456789:AAF3kq9ZtPz0b1Yw8LmN4rVuHcDeXsGj7Ta';
const BOT = 'https://api.telegram.org/bot' + BOT_TOKEN + '/';
const CODE = 'K7Q2M9XD4A';
const f = fakeFetch();
let updates: unknown[] = [];
let hub: Hub;
let port: number;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tg-rest-'));
  const vault = new IntegrationVault({ file: path.join(dir, 'a.json'), keyFile: path.join(dir, 'a.key') });
  f.on('POST', BOT + 'getMe', () => ({ json: { ok: true, result: { id: 987654321, username: 'rocket_notify_bot' } } }));
  f.on('POST', BOT + 'getUpdates', () => { const r = updates; updates = []; return { json: { ok: true, result: r } }; });
  f.on('POST', BOT + 'sendMessage', () => ({ json: { ok: true, result: {} } }));
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN,
    integrations: (db) => new IntegrationService({ db, vault, fetch: f.fetch }),
    telegram: (db, v) => new TelegramService({ db, vault: v, fetch: f.fetch, makeCode: () => CODE, sleep: () => new Promise((r) => setTimeout(r, 5)) }),
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function req(method: string, p: string, opts: { body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, json, text }); });
    });
    r.on('error', reject);
    r.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

const update = (id: number, text: string) => ({ update_id: id, message: { date: Math.floor(Date.now() / 1000), text, chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false, first_name: 'Ada' } } });

describe('/api/telegram', () => {
  it('is owner only: no token is 401, a paired phone and the PC runner are refused', async () => {
    expect((await req('GET', '/api/telegram', { token: null })).status).toBe(401);
    const minted = await req('POST', '/api/devices/pairing', { body: {} });
    const paired = await req('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'Phone' } });
    expect(paired.status).toBe(200);
    for (const [m, p] of [['GET', '/api/telegram'], ['PUT', '/api/telegram/token'], ['DELETE', '/api/telegram/token'], ['POST', '/api/telegram/link'],
      ['POST', '/api/telegram/unlink'], ['PUT', '/api/telegram/notify'], ['POST', '/api/telegram/test']] as const) {
      const body = m === 'GET' || m === 'DELETE' ? undefined : {};
      expect((await req(m, p, { token: paired.json.token, body })).status, m + ' ' + p).toBe(403);
      expect(deviceMayAccess(m, p), m + ' ' + p).toBe(false);
      expect(runnerMayAccess(m, p), m + ' ' + p).toBe(false);
    }
    // Nothing the phone tried changed anything.
    expect((await req('GET', '/api/telegram')).json.configured).toBe(false);
  });

  it('walks the whole flow with the shape the UI codes against', async () => {
    const s0 = (await req('GET', '/api/telegram')).json as TelegramState;
    expect(s0).toEqual({ configured: false, botUsername: null, linked: false, linkedName: null, notify: false, pendingCode: null, error: null });

    // A bad token is a 400 in Telegram's words; nothing is saved.
    f.on('POST', 'https://api.telegram.org/bot999999999:' + 'Z'.repeat(35) + '/getMe', () => ({ status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } }));
    const bad = await req('PUT', '/api/telegram/token', { body: { token: '999999999:' + 'Z'.repeat(35) } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('Unauthorized');
    expect(bad.text).not.toContain('ZZZZZZZZ');
    expect((await req('PUT', '/api/telegram/token', { body: {} })).status).toBe(400);

    // Notify and link need earlier steps.
    expect((await req('POST', '/api/telegram/link', { body: {} })).status).toBe(400);
    expect((await req('PUT', '/api/telegram/notify', { body: { notify: true } })).status).toBe(400);
    expect((await req('POST', '/api/telegram/test', { body: {} })).status).toBe(400);

    const ok = await req('PUT', '/api/telegram/token', { body: { token: BOT_TOKEN } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ configured: true, botUsername: 'rocket_notify_bot', linked: false });
    expect(ok.text).not.toContain(BOT_TOKEN);

    const link = await req('POST', '/api/telegram/link', { body: {} });
    expect(link.status).toBe(200);
    expect(link.json.pendingCode).toMatchObject({ code: CODE, deepLink: 'https://t.me/rocket_notify_bot?start=' + CODE });
    expect(typeof link.json.pendingCode.expiresAt).toBe('number');

    // The owner presses Start in Telegram; the short poll picks it up.
    updates = [update(1, '/start ' + CODE)];
    await hub.telegram.pollOnce(0);
    const s1 = (await req('GET', '/api/telegram')).json as TelegramState;
    expect(s1).toMatchObject({ linked: true, linkedName: 'Ada', notify: false, pendingCode: null });

    const on = await req('PUT', '/api/telegram/notify', { body: { notify: true } });
    expect(on.json.notify).toBe(true);
    expect((await req('PUT', '/api/telegram/notify', { body: { notify: 'yes' } })).status).toBe(400);
    expect((await req('POST', '/api/telegram/test', { body: {} })).json).toEqual({ ok: true });

    const off = await req('POST', '/api/telegram/unlink', { body: {} });
    expect(off.json).toMatchObject({ configured: true, linked: false, notify: false, linkedName: null });
    const gone = await req('DELETE', '/api/telegram/token');
    expect(gone.json).toMatchObject({ configured: false, botUsername: null });
  });

  it('answers 409 when a webhook holds the bot, and 429 once locked', async () => {
    await req('PUT', '/api/telegram/token', { body: { token: BOT_TOKEN } });
    f.on('POST', BOT + 'getUpdates', () => ({ status: 409, json: { ok: false, error_code: 409, description: 'Conflict: webhook is active' } }));
    const conflict = await req('POST', '/api/telegram/link', { body: {} });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toMatch(/another Toki or a webhook uses this bot/i);
    expect(f.calls.some((c) => /webhook/i.test(c.url.pathname.split('/').pop() ?? '') && c.url.pathname.endsWith('Webhook'))).toBe(false);

    f.on('POST', BOT + 'getUpdates', () => { const r = updates; updates = []; return { json: { ok: true, result: r } }; });
    expect((await req('POST', '/api/telegram/link', { body: {} })).status).toBe(200);
    updates = Array.from({ length: MAX_WRONG_CODES }, (_, i) => update(100 + i, '/start WRONG' + i + 'AAAAA'));
    await hub.telegram.pollOnce(0);
    const locked = await req('POST', '/api/telegram/link', { body: {} });
    expect(locked.status).toBe(429);
    expect(locked.json.error).toMatch(/locked/i);
  });
});
