import fs from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ROOM_BOTS, type Room } from '@pocketrocket/shared';
import type { Bot, HealthInfo, ProvidersResponse, SecretsStatus, Settings } from '@pocketrocket/shared';
import { APPROVALS_ENV, ENABLED_PROVIDERS, botHome } from '../config.js';
import { createHub, type Hub } from '../hub.js';

let hub: Hub;
let base: string;

beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null });
  base = 'http://127.0.0.1:' + (await hub.listen());
});
afterAll(async () => {
  await hub.shutdown();
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
}

describe('settings / secrets / providers REST', () => {
  it('reads and patches settings without clobbering untouched keys', async () => {
    const before = (await api<Settings>('GET', '/api/settings')).body;
    expect(before.provider).toBe('claude');

    const named = (await api<Settings>('PUT', '/api/settings', { userName: 'Alex' })).body;
    expect(named.userName).toBe('Alex');

    // zod 4 keeps `.default()` inside `.partial()`; a one-key patch must not reset the others.
    const after = (await api<Settings>('PUT', '/api/settings', { sounds: false })).body;
    expect(after).toMatchObject({ userName: 'Alex', sounds: false, provider: 'claude' });
    expect((await api<Settings>('GET', '/api/settings')).body.userName).toBe('Alex');
  });

  it('rejects an invalid settings patch with 400', async () => {
    const r = await api('PUT', '/api/settings', { provider: 'nope' });
    expect(r.status).toBe(400);
  });

  it('patches a bot without resetting the fields left out', async () => {
    const bot = (await api<Bot>('POST', '/api/bots', {
      name: 'Patchy', handle: 'patchy', title: 'Tester', description: 'keep me',
      model: 'claude-opus-5', maxBudgetUsd: 7, allowedTools: ['Read'],
    })).body;
    const patched = (await api<Bot>('PATCH', '/api/bots/' + bot.id, { name: 'Renamed' })).body;
    expect(patched).toMatchObject({
      name: 'Renamed', title: 'Tester', description: 'keep me', model: 'claude-opus-5',
      maxBudgetUsd: 7, allowedTools: ['Read'],
    });
  });

  it('defaults auto-memory on (every 10) and patches it within bounds', async () => {
    const bot = (await api<Bot>('POST', '/api/bots', { name: 'Memo', handle: 'memo' })).body;
    expect(bot).toMatchObject({ autoMemory: true, autoMemoryEvery: 10 });
    const off = (await api<Bot>('PATCH', '/api/bots/' + bot.id, { autoMemory: false, autoMemoryEvery: 25 })).body;
    expect(off).toMatchObject({ autoMemory: false, autoMemoryEvery: 25, name: 'Memo' });
    expect((await api('PATCH', '/api/bots/' + bot.id, { autoMemoryEvery: 2 })).status).toBe(400);
    expect((await api('PATCH', '/api/bots/' + bot.id, { autoMemoryEvery: 101 })).status).toBe(400);
    // An edit that leaves the fields out (the bot dialog) keeps them.
    expect((await api<Bot>('PATCH', '/api/bots/' + bot.id, { title: 'x' })).body).toMatchObject({ autoMemory: false, autoMemoryEvery: 25 });
  });

  it('reports secret keys without ever returning values', async () => {
    const status = (await api<SecretsStatus>('GET', '/api/secrets')).body;
    expect(status.keys).toHaveProperty('XAI_API_KEY');
    expect(JSON.stringify(status)).not.toContain('sk-');
  });

  it.skipIf(ENABLED_PROVIDERS.includes('opencode'))('rejects switching to a disabled provider with 400 and will not check one', async () => {
    const r = await api<{ error: string }>('PUT', '/api/settings', { provider: 'opencode' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('not enabled');
    expect((await api<Settings>('GET', '/api/settings')).body.provider).toBe('claude');
    expect((await api('POST', '/api/providers/opencode/check')).status).toBe(404);
  });

  it.skipIf(APPROVALS_ENV !== null)('approvals default to ask and a Settings toggle is live and reported by health', async () => {
    expect((await api<Settings>('GET', '/api/settings')).body.approvals).toBe('ask');
    const health = (await api<HealthInfo>('GET', '/api/health')).body;
    expect(health).toMatchObject({ approvals: 'ask', approvalsLocked: false });
    // Health answers without the token, so it must not carry who is signed in, on which plan, or where
    // their CLI lives — a path under the home directory is the machine's user name spelled out.
    expect(health).not.toHaveProperty('accountEmail');
    expect(health).not.toHaveProperty('subscriptionType');
    expect(health).not.toHaveProperty('claudeExe');
    expect(JSON.stringify(health)).not.toContain(os.homedir());

    const on = await api<Settings>('PUT', '/api/settings', { approvals: 'bypass' });
    expect(on.body.approvals).toBe('bypass');
    expect(hub.runner['broker'].bypassed).toBe(true);
    expect((await api<HealthInfo>('GET', '/api/health')).body.approvals).toBe('bypass');

    await api('PUT', '/api/settings', { approvals: 'ask' });
    expect(hub.runner['broker'].bypassed).toBe(false);
    expect((await api('PUT', '/api/settings', { approvals: 'sometimes' })).status).toBe(400);
  });

  it('lists providers with checks and models', async () => {
    const res = (await api<ProvidersResponse>('GET', '/api/providers')).body;
    expect(res.active).toBe('claude');
    expect(res.providers.map((p) => p.id)).toEqual(ENABLED_PROVIDERS);
    // Every provider reports a real check now (P2A/P2B/P2C landed), so assert the shape rather than a
    // value that depends on which CLIs happen to be installed on the machine running the tests.
    for (const p of res.providers) {
      expect(typeof p.check.ok).toBe('boolean');
      expect(p.check.hint).toBeTruthy();
    }
    // GET /api/providers probes every enabled CLI by spawning it, which lands within a few hundred ms of the
    // 5s default on its own and tips over when the suite runs it in parallel. Slow test, not a slow assert.
  }, 30_000);
});

describe('rooms and bot delete REST', () => {
  const mkBots = async (n: number, tag: string) => {
    const out: Bot[] = [];
    for (let i = 0; i < n; i++) out.push((await api<Bot>('POST', '/api/bots', { name: tag + i, handle: tag + i })).body);
    return out;
  };

  it('accepts up to MAX_ROOM_BOTS members and rejects more', async () => {
    const bots = await mkBots(MAX_ROOM_BOTS + 1, 'cap');
    const ids = bots.map((b) => b.id);
    const ok = await api<Room>('POST', '/api/rooms', { kind: 'group', name: 'Full', memberIds: ids.slice(0, MAX_ROOM_BOTS) });
    expect(ok.status).toBe(200);
    expect(ok.body.memberIds).toHaveLength(MAX_ROOM_BOTS);
    expect((await api('POST', '/api/rooms', { kind: 'group', name: 'Over', memberIds: ids })).status).toBe(400);
    expect((await api('PATCH', '/api/rooms/' + ok.body.id, { memberIds: ids })).status).toBe(400);
  });

  it('keeps a DM at exactly one member on PATCH', async () => {
    const [a, b] = await mkBots(2, 'dmx');
    const dm = (await api<Room>('POST', '/api/rooms', { kind: 'dm', name: 'DM', memberIds: [a.id] })).body;
    expect((await api('PATCH', '/api/rooms/' + dm.id, { memberIds: [a.id, b.id] })).status).toBe(400);
    const group = (await api<Room>('POST', '/api/rooms', { kind: 'group', name: 'G', memberIds: [a.id, b.id] })).body;
    expect((await api('PATCH', '/api/rooms/' + group.id, { kind: 'dm' })).status).toBe(400);
    expect((await api('PATCH', '/api/rooms/' + dm.id, { memberIds: ['nope'] })).status).toBe(404);
    expect((await api<Room>('PATCH', '/api/rooms/' + dm.id, { memberIds: [b.id] })).body.memberIds).toEqual([b.id]);
  });

  it('removes the bot folder when a bot is deleted', async () => {
    const [bot] = await mkBots(1, 'gone');
    expect(fs.existsSync(botHome(bot.id))).toBe(true);
    expect((await api('DELETE', '/api/bots/' + bot.id)).status).toBe(200);
    expect(fs.existsSync(botHome(bot.id))).toBe(false);
  });
});
