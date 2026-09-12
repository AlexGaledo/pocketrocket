import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bot, HealthInfo, ProvidersResponse, SecretsStatus, Settings } from '@pocketrocket/shared';
import { APPROVALS_ENV, ENABLED_PROVIDERS } from '../config.js';
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
    expect((await api<HealthInfo>('GET', '/api/health')).body).toMatchObject({ approvals: 'ask', approvalsLocked: false });

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
