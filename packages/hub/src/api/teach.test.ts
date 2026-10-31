import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess } from './guard.js';
import { SKILLS_DIR } from '../config.js';

/** P6 REST: teach / recordings / skill versions / reflection, and what a paired phone may reach. */

const TOKEN = 'p6-hub-token';
const uniq = 'p6r' + process.pid.toString(36);
const recRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-p6-rest-'));

let hub: Hub;
let port: number;
beforeAll(async () => {
  // No `available` override: on this test machine (no per-bot computers) Teach must say it is not available.
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, recorder: { dir: (b) => path.join(recRoot, b) } });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(recRoot, { recursive: true, force: true });
  for (const n of [uniq + '-skill']) {
    fs.rmSync(path.join(SKILLS_DIR, n), { recursive: true, force: true });
    fs.rmSync(path.join(SKILLS_DIR, '.versions', n), { recursive: true, force: true });
  }
});

function req(method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
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

async function pair(): Promise<string> {
  const minted = await req('POST', '/api/devices/pairing', { token: TOKEN, body: {} });
  const r = await req('POST', '/api/devices/pair', { body: { code: minted.json.code, name: 'Phone' } });
  expect(r.status).toBe(200);
  return r.json.token;
}

describe('device allowlist for the P6 routes', () => {
  it('lets a phone read recordings, versions and the reflection setting, and end a recording', () => {
    for (const [m, p] of [
      ['GET', '/api/computers/b1/recorder'],
      ['POST', '/api/computers/b1/recorder/stop'],
      ['GET', '/api/computers/b1/recordings'],
      ['GET', '/api/computers/b1/recordings/2026-11-01T09-30-00-000Z'],
      ['GET', '/api/skills/s1/versions'],
      ['GET', '/api/skills/s1/versions/v1'],
      ['GET', '/api/bots/b1/skill-reflection'],
    ]) expect(deviceMayAccess(m, p), m + ' ' + p).toBe(true);
  });
  it('keeps starting a recording, distilling, corrections, reflection opt-in and approvals on the desktop', () => {
    for (const [m, p] of [
      ['POST', '/api/computers/b1/recorder/start'],
      ['DELETE', '/api/computers/b1/recordings/2026-11-01T09-30-00-000Z'],
      ['POST', '/api/computers/b1/recordings/2026-11-01T09-30-00-000Z/distill'],
      ['POST', '/api/skills/s1/versions/v1'],
      ['POST', '/api/skills/s1/corrections'],
      ['PUT', '/api/bots/b1/skill-reflection'],
    ]) expect(deviceMayAccess(m, p), m + ' ' + p).toBe(false);
  });
});

describe('P6 REST', () => {
  it('says Teach is not available without per-bot computers, and refuses to start', async () => {
    const bot = hub.repos.createBot({ name: 'Shopper', handle: 'shopper6', title: '', description: '', avatar: '🛒', model: 'auto', allowedTools: ['Browser'], maxBudgetUsd: 1 });
    const st = await req('GET', '/api/computers/' + bot.id + '/recorder', { token: TOKEN });
    expect(st.status).toBe(200);
    expect(st.json).toMatchObject({ botId: bot.id, available: false, active: null });
    const start = await req('POST', '/api/computers/' + bot.id + '/recorder/start', { token: TOKEN, body: { title: 'x' } });
    expect(start.status).toBe(409);
    expect(hub.control.get(bot.id).control).toBe('agent');
    expect((await req('GET', '/api/computers/' + bot.id + '/recordings', { token: TOKEN })).json).toEqual([]);
    expect((await req('GET', '/api/computers/nobody/recorder', { token: TOKEN })).status).toBe(404);
  });

  it('lists versions with a diff, and only the desktop approves', async () => {
    const n = uniq + '-skill';
    const created = await req('POST', '/api/skills', { token: TOKEN, body: { name: n, description: 'Export', markdown: '# Export\n1. Click Download\n' } });
    expect(created.status).toBe(200);
    const v = hub.skills.proposeVersion(created.json.id, '# Export\n1. Click Export\n', { origin: 'correction', note: 'use Export' });
    const phone = await pair();

    const list = await req('GET', '/api/skills/' + created.json.id + '/versions', { token: phone });
    expect(list.status).toBe(200);
    expect(list.json).toEqual([expect.objectContaining({ id: v.id, version: 2, status: 'pending' })]);
    const detail = await req('GET', '/api/skills/' + created.json.id + '/versions/' + v.id, { token: phone });
    expect(detail.json.diff.filter((l: { op: string }) => l.op !== ' ')).toEqual([{ op: '-', text: '1. Click Download' }, { op: '+', text: '1. Click Export' }]);
    const pool = await req('GET', '/api/skills', { token: TOKEN });
    expect(pool.json.find((s: { id: string }) => s.id === created.json.id)).toMatchObject({ pendingVersions: 1, version: 1 });
    expect(pool.json.some((s: { name: string }) => s.name.includes('@v'))).toBe(false);

    const byPhone = await req('POST', '/api/skills/' + created.json.id + '/versions/' + v.id, { token: phone, body: { decision: 'approve' } });
    expect(byPhone.status).toBe(403);
    expect((await req('POST', '/api/skills/' + created.json.id + '/corrections', { token: phone, body: { text: 'no, use Export' } })).status).toBe(403);
    const ok = await req('POST', '/api/skills/' + created.json.id + '/versions/' + v.id, { token: TOKEN, body: { decision: 'approve' } });
    expect(ok.status).toBe(200);
    expect(ok.json.skill).toMatchObject({ version: 2, reviewStatus: 'approved' });
    const again = await req('POST', '/api/skills/' + created.json.id + '/versions/' + v.id, { token: TOKEN, body: { decision: 'reject' } });
    expect(again.status).toBe(409);
    expect((await req('POST', '/api/skills/' + created.json.id + '/versions/nope', { token: TOKEN, body: { decision: 'reject' } })).status).toBe(404);
  });

  it('reflection is off until the desktop turns it on', async () => {
    const bot = hub.repos.createBot({ name: 'Refl', handle: 'refl6', title: '', description: '', avatar: '🤖', model: 'auto', allowedTools: [], maxBudgetUsd: 1 });
    const phone = await pair();
    expect((await req('GET', '/api/bots/' + bot.id + '/skill-reflection', { token: phone })).json).toMatchObject({ enabled: false, every: 5, dailyCapUsd: 0.25 });
    expect((await req('PUT', '/api/bots/' + bot.id + '/skill-reflection', { token: phone, body: { enabled: true } })).status).toBe(403);
    const on = await req('PUT', '/api/bots/' + bot.id + '/skill-reflection', { token: TOKEN, body: { enabled: true, every: 3 } });
    expect(on.json).toMatchObject({ enabled: true, every: 3 });
    expect((await req('PUT', '/api/bots/' + bot.id + '/skill-reflection', { token: TOKEN, body: { dailyCapUsd: 50 } })).status).toBe(400);
  });
});
