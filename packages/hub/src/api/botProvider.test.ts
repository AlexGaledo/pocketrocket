import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ServerEvent } from '@pocketrocket/shared';

// Codex must be enabled before config.ts reads POCKETROCKET_PROVIDERS (hub imports it).
vi.hoisted(() => {
  process.env.POCKETROCKET_PROVIDERS = 'codex';
});

import { createHub, type Hub } from '../hub.js';
import { events } from '../events.js';

const TOKEN = 'bot-provider-token';

/** M6 (spec 01 P1-3): the owner sets a bot's provider and backup over REST; the hub checks both. */
describe('PATCH /api/bots/:id provider and backup', () => {
  let hub: Hub;
  let port: number;
  let dir: string;
  let n = 0;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-botprov-'));
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, mediaDir: dir });
    port = await hub.listen();
  });
  afterAll(async () => {
    await hub.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.POCKETROCKET_PROVIDERS;
  });
  const req = (method: string, url: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + TOKEN, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  const bot = (model = 'claude-opus-5') => { const h = 'p' + ++n; return hub.repos.createBot({ name: 'Bot' + n, handle: h, title: '', description: 'x', avatar: '', model, allowedTools: [], maxBudgetUsd: 1 }); };
  const codexDefault = () => hub.providers.modelsSync('codex').find((m) => m.default)!.id;

  it('moves a bot to another provider, re-points a model it lacks with a note, and sends bots.changed', async () => {
    const b = bot();
    const room = hub.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [b.id], coordinatorBotId: null });
    const seen: ServerEvent[] = [];
    const off = events.onEvent((e) => { if (e.type === 'bots.changed') seen.push(e); });
    const r = await req('PATCH', '/api/bots/' + b.id, { provider: 'codex' });
    off();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ provider: 'codex', model: codexDefault() });
    expect(hub.repos.getBot(b.id)).toMatchObject({ provider: 'codex', model: codexDefault() });
    const changed = seen.at(-1) as Extract<ServerEvent, { type: 'bots.changed' }>;
    expect(changed.bots.find((x) => x.id === b.id)).toMatchObject({ provider: 'codex' });
    expect(hub.repos.listMessages(room.id, { limit: 10 }).map((m) => m.text)).toEqual([
      'Bot' + n + ' switched to ' + codexDefault() + ' (claude-opus-5 is not available on codex).',
    ]);

    // Back to the default: a model the default offers is named in the same patch, so nothing else moves.
    const back = await req('PATCH', '/api/bots/' + b.id, { provider: null, model: 'claude-sonnet-5' });
    expect(back.status).toBe(200);
    expect(hub.repos.getBot(b.id)).toMatchObject({ provider: null, model: 'claude-sonnet-5' });
  });

  it('refuses a provider this server does not enable, and a model the chosen provider does not list', async () => {
    const b = bot();
    expect((await req('PATCH', '/api/bots/' + b.id, { provider: 'grok' })).status).toBe(400);
    expect((await req('PATCH', '/api/bots/' + b.id, { provider: 'nope' })).status).toBe(400);
    const wrong = await req('PATCH', '/api/bots/' + b.id, { provider: 'codex', model: 'claude-sonnet-5' });
    expect(wrong.status).toBe(400);
    expect(String(wrong.json.error)).toContain('not a');
    expect(hub.repos.getBot(b.id)).toMatchObject({ provider: null, model: 'claude-opus-5' });
  });

  it('stores one backup, checked against its own provider', async () => {
    const b = bot();
    expect((await req('PATCH', '/api/bots/' + b.id, { backup: { provider: 'codex', model: 'claude-opus-5' } })).status).toBe(400);
    expect((await req('PATCH', '/api/bots/' + b.id, { backup: { provider: 'grok', model: 'x' } })).status).toBe(400);
    const ok = await req('PATCH', '/api/bots/' + b.id, { backup: { provider: 'codex', model: codexDefault() } });
    expect(ok.status).toBe(200);
    expect(hub.repos.getBot(b.id)!.backup).toEqual({ provider: 'codex', model: codexDefault() });
    expect((await req('PATCH', '/api/bots/' + b.id, { backup: null })).status).toBe(200);
    expect(hub.repos.getBot(b.id)!.backup).toBeNull();
  });

  it('creates a bot on its own provider with that provider\'s default model', async () => {
    const r = await req('POST', '/api/bots', { name: 'Cy', handle: 'cy-new', provider: 'codex' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ provider: 'codex', model: codexDefault(), backup: null });
    const plain = await req('POST', '/api/bots', { name: 'Di', handle: 'di-new' });
    expect(plain.json).toMatchObject({ provider: null, backup: null, model: 'claude-sonnet-5' });
  });

  it('reports usage by provider and the last init per provider', async () => {
    const usage = await req('GET', '/api/usage');
    expect(usage.status).toBe(200);
    expect(Array.isArray(usage.json.byProvider)).toBe(true);
    const init = await req('GET', '/api/debug/last-init');
    expect(init.status).toBe(200);
    expect(init.json).toEqual({});
  });
});
