import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Message, Trigger, TriggerFire, TriggersState } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { IntegrationService } from '../services/IntegrationService.js';
import { IntegrationVault } from '../services/IntegrationVault.js';
import { fakeFetch } from '../integrations/fakeFetch.js';
import type { TurnRequest, TurnResult } from '../agent/BotRunner.js';

const TOKEN = 'triggers-test-token';
let hub: Hub;
let port: number;
let dir: string;
const f = fakeFetch();
const turns: TurnRequest[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-trig-rest-'));
  const vault = new IntegrationVault({ file: path.join(dir, 'a.json'), keyFile: path.join(dir, 'a.key') });
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, integrations: (db) => new IntegrationService({ db, vault, fetch: f.fetch }) });
  // No provider CLI in tests: record the turn instead of running it.
  hub.runner.runTurn = async (req: TurnRequest): Promise<TurnResult> => { turns.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; };
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('/api/triggers', () => {
  it('needs the hub token', async () => {
    expect((await request('GET', '/api/triggers', { token: null })).status).toBe(401);
  });

  it('creates, lists, updates, test-fires and deletes a trigger', async () => {
    const bot = hub.repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: '', avatar: '🔎', model: 'm', allowedTools: [], maxBudgetUsd: 2 });
    const room = hub.repos.createRoom({ kind: 'dm', name: 'Scout', memberIds: [bot.id], coordinatorBotId: null });

    // Only connected providers are offered as sources.
    let s = (await request('GET', '/api/triggers')).json as TriggersState;
    expect(s.available).toEqual([]);
    const info = hub.integrations.repo.upsert({ provider: 'github', method: 'token', accountLabel: 'octo', scopes: [] });
    s = (await request('GET', '/api/triggers')).json as TriggersState;
    expect(s.available).toEqual(['github.notifications', 'github.repo']);

    const bad = await request('POST', '/api/triggers', { body: { name: 'x', source: 'github.repo', filter: { repo: 'not a repo' }, botId: bot.id, roomId: room.id, prompt: 'p' } });
    expect(bad.status).toBe(400);
    expect((await request('POST', '/api/triggers', { body: { name: 'x', source: 'fax', botId: bot.id, roomId: room.id, prompt: 'p' } })).status).toBe(400);
    expect((await request('POST', '/api/triggers', { body: { name: 'x', source: 'gmail', botId: 'nope', roomId: room.id, prompt: 'p' } })).status).toBe(400);

    const created = await request('POST', '/api/triggers', {
      body: { name: 'New bugs', source: 'github.repo', filter: { repo: 'acme/app', labels: 'bug', type: '' }, botId: bot.id, roomId: room.id, prompt: 'Triage {{event.title}}', maxPerHour: 3, budgetUsd: 1 },
    });
    expect(created.status).toBe(200);
    const t = created.json as Trigger;
    expect(t).toMatchObject({ name: 'New bugs', enabled: true, filter: { repo: 'acme/app', labels: 'bug' }, maxPerHour: 3, budgetUsd: 1 });

    const patched = (await request('PATCH', '/api/triggers/' + t.id, { body: { enabled: false } })).json as Trigger;
    expect(patched.enabled).toBe(false);
    expect((await request('PATCH', '/api/triggers/nope', { body: { enabled: false } })).status).toBe(404);

    // Test fire: a sample event straight to the bot, as a strict trigger turn.
    const fire = (await request('POST', '/api/triggers/' + t.id + '/test', { body: { event: { title: 'Sample crash', text: 'It broke' } } })).json as TriggerFire;
    expect(fire).toMatchObject({ status: 'running', test: true, title: 'Sample crash' });
    await until(() => turns.length === 1);
    expect(turns[0]).toMatchObject({ causeKind: 'trigger', strictApprovals: true });
    expect(turns[0].injected).toContain('Triage "Sample crash"');
    const msg = hub.repos.getMessage(fire.messageId!) as Message;
    expect(msg.kind).toBe('trigger');
    await until(() => hub.triggers.repo.getFire(fire.id)!.status === 'success');
    const fires = (await request('GET', '/api/triggers/' + t.id + '/fires')).json as TriggerFire[];
    expect(fires.map((x) => x.status)).toEqual(['success']);
    s = (await request('GET', '/api/triggers')).json as TriggersState;
    expect(s.stats[t.id].firesLastHour).toBe(1);

    expect((await request('DELETE', '/api/triggers/' + t.id)).status).toBe(200);
    expect((await request('GET', '/api/triggers/' + t.id + '/fires')).status).toBe(404);
    hub.integrations.repo.delete(info.id);
  });
});
