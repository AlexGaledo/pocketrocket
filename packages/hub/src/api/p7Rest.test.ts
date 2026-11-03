import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bot, KnowledgeStatus, VoiceProposal } from '@pocketrocket/shared';
import { botHome } from '../config.js';
import { createHub, type Hub } from '../hub.js';

/** P7 REST: knowledge status/sync, voice.md and its proposals, notes listing, skill import from git. */

let hub: Hub;
let base: string;
let bot: Bot;

beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null });
  base = 'http://127.0.0.1:' + (await hub.listen());
  bot = (await api<Bot>('POST', '/api/bots', { name: 'Voicey', handle: 'voicey' + process.pid })).body;
});
afterAll(async () => {
  fs.rmSync(botHome(bot.id), { recursive: true, force: true });
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

describe('knowledge REST', () => {
  it('reports the knowledge repo as off by default', async () => {
    const r = await api<KnowledgeStatus>('GET', '/api/knowledge');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: '', mode: 'off', dir: null, syncing: false });
  });

  it('rejects a knowledge source that could reach git as an option or command', async () => {
    for (const bad of ['--upload-pack=calc', 'ext::sh -c id', 'not/absolute']) {
      const r = await api<{ error: string }>('PUT', '/api/settings', { knowledgeRepo: bad });
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toMatch(/knowledgeRepo/);
    }
  });

  it('Sync now with nothing configured stays off', async () => {
    const r = await api<KnowledgeStatus>('POST', '/api/knowledge/sync', {});
    expect(r.body).toMatchObject({ mode: 'off', lastError: null });
  });
});

describe('voice REST', () => {
  it('reads and writes voice.md, capped', async () => {
    expect((await api<{ text: string; proposals: VoiceProposal[] }>('GET', '/api/bots/' + bot.id + '/voice')).body).toEqual({ text: '', proposals: [] });
    const put = await api<{ ok: boolean; trimmed: boolean }>('PUT', '/api/bots/' + bot.id + '/voice', { text: '- No emoji\n' });
    expect(put.body).toEqual({ ok: true, trimmed: false });
    expect((await api<{ text: string }>('GET', '/api/bots/' + bot.id + '/voice')).body.text).toBe('- No emoji\n');
    const big = await api<{ trimmed: boolean }>('PUT', '/api/bots/' + bot.id + '/voice', { text: Array.from({ length: 200 }, (_, i) => '- rule ' + i).join('\n') });
    expect(big.body.trimmed).toBe(true);
  });

  it('answers 404 for an unknown proposal', async () => {
    const r = await api('POST', '/api/bots/' + bot.id + '/voice/proposals/nope', { decision: 'approve' });
    expect(r.status).toBe(404);
  });

  it('lists notes', async () => {
    const r = await api<unknown[]>('GET', '/api/bots/' + bot.id + '/notes');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe('skill import from git REST', () => {
  it('answers 400 for a bad source', async () => {
    const r = await api<{ error: string }>('POST', '/api/skills/import-git', { url: 'ext::sh -c id' });
    expect(r.status).toBe(400);
  });
});
