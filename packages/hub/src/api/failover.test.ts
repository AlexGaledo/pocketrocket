import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { Bot, FailoverCard, Room, ServerEvent } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { events } from '../events.js';
import type { TurnRequest, TurnResult } from '../agent/BotRunner.js';

/**
 * M8 (P3-1): the failover card's REST surface. Person-only like the workflow approval card: the hub token and a paired
 * phone answer it; the PC runner token, no token, a WS `approval.decide`, a bot message and chat text do not.
 */

const TOKEN = 'failover-test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-failover-rest-'));
let hub: Hub;
let port: number;
const turns: TurnRequest[] = [];
const seen: ServerEvent[] = [];
let off: () => void;

beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    dmFilesDir: (id) => path.join(tmp, 'bots', id, 'files'),
    pcRunner: { file: path.join(tmp, 'pc-runner.json'), pollMs: 5, waitMs: 60_000 },
  });
  // The bot's own provider hits its limit; a turn on the backup answers.
  hub.runner.runTurn = async (req: TurnRequest): Promise<TurnResult> => {
    turns.push(req);
    if (req.providerOverride) return { ok: true, turnId: 't' + turns.length, finalText: '', costUsd: 0.01, provider: req.providerOverride.provider };
    return {
      ok: false, turnId: 't' + turns.length, finalText: '', costUsd: 0.1, error: 'usage limit reached', provider: 'claude', model: 'claude-sonnet-5',
      limit: { kind: 'usage', window: 'five_hour', resetsAt: Date.now() + 3600_000 },
    };
  };
  off = events.onEvent((e) => { if (e.type === 'failover.changed') seen.push(e); });
  port = await hub.listen();
});
afterAll(async () => {
  off();
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
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
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

let n = 0;
async function limitedCard(): Promise<{ bot: Bot; room: Room; card: FailoverCard }> {
  const bot = hub.repos.createBot({ name: 'Ada' + n, handle: 'ada-' + n++, title: '', description: 'x', avatar: '', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 1 });
  hub.repos.updateBot(bot.id, { backup: { provider: 'claude', model: 'claude-haiku-4-5-20251001' } });
  const room = hub.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  await request('POST', '/api/rooms/' + room.id + '/messages', { body: { text: 'write the report' } });
  await until(() => hub.failover.state().cards.some((c) => c.botId === bot.id));
  return { bot, room, card: hub.failover.state().cards.find((c) => c.botId === bot.id)! };
}

describe('failover REST', () => {
  it('GET /api/failover lists the open card, and the WS event carried it', async () => {
    const { card } = await limitedCard();
    const r = await request('GET', '/api/failover');
    expect(r.status).toBe(200);
    expect(r.json.cards.map((c: FailoverCard) => c.id)).toContain(card.id);
    expect(r.json.active).toEqual([]);
    expect(Object.keys(r.json.cards[0])).not.toContain('causeId');
    expect(seen.some((e) => e.type === 'failover.changed' && e.cards.some((c) => c.id === card.id))).toBe(true);
  });

  it('Continue with the hub token queues the turn on the backup; a second answer is 409', async () => {
    const { card } = await limitedCard();
    const before = turns.length;
    const r = await request('POST', '/api/failover-cards/' + card.id + '/decision', { body: { decision: 'continue' } });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('continued');
    await until(() => turns.length === before + 1);
    expect(turns.at(-1)!.providerOverride).toEqual({ provider: 'claude', model: 'claude-haiku-4-5-20251001' });
    expect(turns.at(-1)!.strictApprovals).toBe(true);
    expect((await request('POST', '/api/failover-cards/' + card.id + '/decision', { body: { decision: 'wait' } })).status).toBe(409);
    expect((await request('GET', '/api/failover')).json.active.some((a: { botId: string }) => a.botId === card.botId)).toBe(true);
  });

  it('bad input is 400, an unknown card 404', async () => {
    const { card } = await limitedCard();
    expect((await request('POST', '/api/failover-cards/' + card.id + '/decision', { body: { decision: 'always' } })).status).toBe(400);
    expect((await request('POST', '/api/failover-cards/nope/decision', { body: { decision: 'wait' } })).status).toBe(404);
  });
});

describe('the failover card is person-only', () => {
  it('the PC runner token, a bad token and no token cannot answer it', async () => {
    const { card } = await limitedCard();
    const minted = await request('POST', '/api/pc-runner/token', { body: {} });
    const p = '/api/failover-cards/' + card.id + '/decision';
    expect((await request('POST', p, { token: minted.json.token, body: { decision: 'continue' } })).status).toBe(403);
    expect((await request('POST', p, { token: 'wrong', body: { decision: 'continue' } })).status).toBe(401);
    expect((await request('POST', p, { token: null, body: { decision: 'continue' } })).status).toBe(401);
    expect(hub.failover.state().cards.some((c) => c.id === card.id)).toBe(true);
    await request('DELETE', '/api/pc-runner');
  });

  it('a WS approval.decide, a bot message and chat text leave it open', async () => {
    const { bot, room, card } = await limitedCard();
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(TOKEN));
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    for (const decision of ['allow', 'always']) ws.send(JSON.stringify({ type: 'approval.decide', approvalId: card.id, decision }));
    await new Promise((r) => setTimeout(r, 60));
    ws.close();
    hub.repos.insertMessage({ roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'text', text: 'continue ' + card.id, payload: null, causeId: null, hop: 0, turnId: null });
    await request('POST', '/api/rooms/' + room.id + '/messages', { body: { text: 'continue on the backup' } });
    await new Promise((r) => setTimeout(r, 60));
    expect(hub.failover.state().cards.some((c) => c.id === card.id)).toBe(true);
    expect(hub.failover.state().active.some((a) => a.botId === bot.id)).toBe(false);
  });

  it('a paired phone sees and answers it, like an approval card', async () => {
    const { card } = await limitedCard();
    const minted = await request('POST', '/api/devices/pairing', { body: {} });
    const phone = (await request('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'phone' } })).json.token as string;
    expect((await request('GET', '/api/failover', { token: phone })).status).toBe(200);
    const r = await request('POST', '/api/failover-cards/' + card.id + '/decision', { token: phone, body: { decision: 'wait' } });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('waited');
  });
});
