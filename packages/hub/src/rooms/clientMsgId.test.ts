import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WS_PING_MS, type ServerEvent } from '@pocketrocket/shared';
import { Db, hasColumn } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SCHEMA_SQL } from '../db/schema.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { events } from '../events.js';
import { attachWs } from '../api/ws.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import type { SettingsStore } from '../services/SettingsStore.js';
import { RoomRouter } from './RoomRouter.js';

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const bot = repos.createBot({ name: 'ann', handle: 'ann', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
  const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [bot.id], coordinatorBotId: null });
  const reqs: TurnRequest[] = [];
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; },
    // A provider that cannot steer: a message to a busy bot queues.
    steer: () => ({ status: 'queued', reason: 'provider' }),
  } as unknown as BotRunner;
  return { repos, router, room, reqs };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('onUserMessage with a clientMsgId', () => {
  it('posts one message and runs one turn however often the same id arrives', async () => {
    const { repos, router, room, reqs } = setup();
    const first = router.onUserMessage(room.id, 'hello', 'c-1');
    const again = router.onUserMessage(room.id, 'hello', 'c-1');
    await settle();
    expect(again.id).toBe(first.id);
    expect(first.clientMsgId).toBe('c-1');
    expect(repos.listMessages(room.id, { limit: 50 }).filter((m) => m.authorType === 'user')).toHaveLength(1);
    expect(reqs).toHaveLength(1);
  });

  it('announces a repeat again so a client that missed the first echo can settle its outbox', () => {
    const { router, room } = setup();
    const seen: string[] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'message.new') seen.push(ev.message.id); });
    const first = router.onUserMessage(room.id, 'hi', 'c-2');
    router.onUserMessage(room.id, 'hi', 'c-2');
    if (typeof off === 'function') off();
    expect(seen).toEqual([first.id, first.id]);
  });

  it('keeps ids apart per room and still accepts sends without one', async () => {
    const { repos, router, room } = setup();
    const bot2 = repos.createBot({ name: 'bob', handle: 'bob', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
    const room2 = repos.createRoom({ kind: 'dm', name: 'b', memberIds: [bot2.id], coordinatorBotId: null });
    const a = router.onUserMessage(room.id, 'x', 'same');
    const b = router.onUserMessage(room2.id, 'x', 'same');
    const c = router.onUserMessage(room.id, 'x');
    const d = router.onUserMessage(room.id, 'x');
    await settle();
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4);
  });

  it('refuses a second row with the same (room, id) at the database', () => {
    const { repos, room } = setup();
    const row = { roomId: room.id, authorType: 'user' as const, authorId: null, kind: 'text' as const, text: 't', payload: null, causeId: null, hop: 0, turnId: null, clientMsgId: 'dup' };
    repos.insertMessage(row);
    expect(() => repos.insertMessage(row)).toThrow(/UNIQUE/);
  });
});

describe('client_msg_id migration', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('upgrades an existing database, keeps its messages, and enforces the unique index', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-cmid-'));
    dirs.push(d);
    const file = path.join(d, 'p.db');
    const old = new DatabaseSync(file);
    old.exec(SCHEMA_SQL);
    old.prepare("INSERT INTO messages (id, room_id, seq, author_type, kind, text, created_at) VALUES ('m1', 'r1', 1, 'user', 'text', 'old', 1)").run();
    old.close();

    const db = new Db(file);
    expect(hasColumn(db.raw, 'messages', 'client_msg_id')).toBe(true);
    expect(db.get<{ text: string; client_msg_id: string | null }>("SELECT text, client_msg_id FROM messages WHERE id='m1'")).toEqual({ text: 'old', client_msg_id: null });
    // Rows without an id never collide with each other.
    db.run("INSERT INTO messages (id, room_id, seq, author_type, kind, text, created_at) VALUES ('m2', 'r1', 2, 'user', 'text', 'b', 2)");
    db.run("INSERT INTO messages (id, room_id, seq, author_type, kind, text, created_at, client_msg_id) VALUES ('m3', 'r1', 3, 'user', 'text', 'c', 3, 'x')");
    expect(() => db.run("INSERT INTO messages (id, room_id, seq, author_type, kind, text, created_at, client_msg_id) VALUES ('m4', 'r1', 4, 'user', 'text', 'd', 4, 'x')")).toThrow(/UNIQUE/);
    db.raw.close();
  });
});

describe('websocket', () => {
  /** A stand-in socket: send records, emit('message') feeds the hub. */
  function fakeSocket() {
    return Object.assign(new EventEmitter(), { readyState: 1, sent: [] as ServerEvent[], send(s: string) { this.sent.push(JSON.parse(s)); } });
  }
  function wire(pingMs?: number) {
    const { repos, router, room } = setup();
    const wss = attachWs({} as never, { repos, router, broker: {} as PermissionBroker, settings: { get: () => ({}) } as unknown as SettingsStore, pingMs });
    const ws = fakeSocket();
    wss.clients.add(ws as never);
    wss.emit('connection', ws);
    return { wss, ws, router, room, repos };
  }

  it('hands clientMsgId to the router and ignores pong', async () => {
    const { wss, ws, room, repos } = wire();
    ws.emit('message', JSON.stringify({ type: 'message.send', roomId: room.id, text: 'a', clientMsgId: 'w-1' }));
    ws.emit('message', JSON.stringify({ type: 'message.send', roomId: room.id, text: 'a', clientMsgId: 'w-1' }));
    ws.emit('message', JSON.stringify({ type: 'pong' }));
    await settle();
    expect(repos.listMessages(room.id, { limit: 50 }).filter((m) => m.authorType === 'user')).toHaveLength(1);
    expect(ws.sent.filter((e) => e.type === 'error')).toEqual([]);
    wss.close();
  });

  it('still accepts an old client that sends no clientMsgId', () => {
    const { wss, ws, room, repos } = wire();
    ws.emit('message', JSON.stringify({ type: 'message.send', roomId: room.id, text: 'legacy' }));
    expect(repos.listMessages(room.id, { limit: 50 }).some((m) => m.text === 'legacy')).toBe(true);
    wss.close();
  });

  it('tags a failed send with its clientMsgId', () => {
    const { wss, ws } = wire();
    ws.emit('message', JSON.stringify({ type: 'message.send', roomId: 'nope', text: 'a', clientMsgId: 'w-9' }));
    expect(ws.sent.find((e) => e.type === 'error')).toMatchObject({ message: 'Room not found', context: 'w-9' });
    wss.close();
  });

  it('pings every open client on a timer and stops once the server closes', async () => {
    vi.useFakeTimers();
    try {
      const { wss, ws } = wire();
      const pings = () => ws.sent.filter((e) => e.type === 'ping').length;
      vi.advanceTimersByTime(WS_PING_MS - 1);
      expect(pings()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(pings()).toBe(1);
      vi.advanceTimersByTime(WS_PING_MS * 2);
      expect(pings()).toBe(3);
      // ws announces its close once its last client is gone (hub.ts terminates them first), which clears the timer.
      wss.clients.delete(ws as never);
      const closed = new Promise((r) => wss.once('close', r));
      wss.close();
      await closed;
      wss.clients.add(ws as never); // a timer that outlived the server would reach it
      vi.advanceTimersByTime(WS_PING_MS * 2);
      expect(pings()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
