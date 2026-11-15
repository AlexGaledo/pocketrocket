import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bot, Room, Task } from '@pocketrocket/shared';
import { events } from '../events.js';
import { createHub, type Hub } from '../hub.js';

let hub: Hub;
let base: string;
beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null });
  base = 'http://127.0.0.1:' + (await hub.listen());
});
afterAll(async () => { await hub.shutdown(); });

async function api<T>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as T };
}

describe('tasks REST (G1)', () => {
  it('creates, lists, patches, validates and broadcasts', async () => {
    const bot = (await api<Bot>('POST', '/api/bots', { name: 'T', handle: 'tbot', title: '', description: 'x', model: 'claude-sonnet-5', maxBudgetUsd: 1, allowedTools: ['Read'] })).body;
    const room = (await api<Room>('POST', '/api/rooms', { kind: 'group', name: 'Tasks', memberIds: [bot.id] })).body;
    const seen: string[] = [];
    const off = events.onEvent((e) => { if (e.type === 'task.changed') seen.push(e.task.id); });
    const t = (await api<Task>('POST', '/api/rooms/' + room.id + '/tasks', { title: 'First', assigneeBotId: bot.id })).body;
    expect(t).toMatchObject({ title: 'First', status: 'todo', assigneeBotId: bot.id });
    const p = (await api<Task>('PATCH', '/api/rooms/' + room.id + '/tasks/' + t.id, { status: 'doing' })).body;
    expect(p).toMatchObject({ status: 'doing', title: 'First' });
    expect((await api<Task[]>('GET', '/api/rooms/' + room.id + '/tasks')).body).toHaveLength(1);
    off();
    expect(seen).toEqual([t.id, t.id]);
    expect((await api('POST', '/api/rooms/' + room.id + '/tasks', { title: '' })).status).toBe(400);
    expect((await api('POST', '/api/rooms/' + room.id + '/tasks', { title: 'x', assigneeBotId: 'nobody' })).status).toBe(400);
    expect((await api('PATCH', '/api/rooms/' + room.id + '/tasks/nope', { status: 'done' })).status).toBe(404);
    expect((await api('GET', '/api/rooms/missing/tasks')).status).toBe(404);
  });

  it('serves feedback read-only and lists bot reports', async () => {
    expect((await api<unknown[]>('GET', '/api/feedback')).status).toBe(200);
    expect((await api<unknown[]>('GET', '/api/bot-reports')).body).toEqual([]);
    expect((await api('POST', '/api/feedback', { text: 'x' })).status).toBe(404);
    expect((await api('PATCH', '/api/bot-reports/none', { status: 'resolved' })).status).toBe(404);
  });
});
