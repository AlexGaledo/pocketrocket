import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationsState } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import type { Db } from '../db/db.js';
import { IntegrationService } from '../services/IntegrationService.js';
import { IntegrationVault } from '../services/IntegrationVault.js';
import { fakeFetch } from '../integrations/fakeFetch.js';
import { checkToken } from './guard.js';

const TOKEN = 'integrations-test-token';
let hub: Hub;
let port: number;
let dir: string;
const f = fakeFetch();

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-int-rest-'));
  const vault = new IntegrationVault({ file: path.join(dir, 'a.json'), keyFile: path.join(dir, 'a.key') });
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, integrations: (db) => new IntegrationService({ db, vault, fetch: f.fetch }) });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null; contentType?: string } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.body !== undefined || opts.contentType) headers['content-type'] = opts.contentType ?? 'application/json';
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

describe('integration routes', () => {
  it('the callback is token-exempt but /oauth/start and /api/integrations are not', () => {
    const req = (method: string) => ({ method, headers: {} }) as http.IncomingMessage;
    expect(checkToken(req('GET'), new URL('http://x/oauth/callback/github?code=a&state=b'), 't')).toBe(true);
    expect(checkToken(req('POST'), new URL('http://x/oauth/callback/github'), 't')).toBe(false);
    expect(checkToken(req('POST'), new URL('http://x/oauth/start/github'), 't')).toBe(false);
    expect(checkToken(req('GET'), new URL('http://x/api/integrations'), 't')).toBe(false);
  });

  it('GET /api/integrations needs the token and returns state with loopback redirect URIs', async () => {
    expect((await request('GET', '/api/integrations', { token: null })).status).toBe(401);
    const r = await request('GET', '/api/integrations');
    expect(r.status).toBe(200);
    const s = JSON.parse(r.text) as IntegrationsState;
    expect(s.connections).toEqual([]);
    expect(s.redirectUris.github).toBe('http://127.0.0.1:' + port + '/oauth/callback/github');
    expect(s.redirectUris.teams).toBe('http://localhost:' + port + '/oauth/callback/teams');
    expect(s.redirectUris.slack).toBe('');
  });

  it('a callback with no sign-in pending is refused with a page, not a token prompt', async () => {
    const r = await request('GET', '/oauth/callback/github?code=x&state=y', { token: null });
    expect(r.status).toBe(400);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.text).toContain('No sign-in is waiting');
  });

  it('POST /oauth/start needs the token and a JSON content type', async () => {
    expect((await request('POST', '/oauth/start/github', { token: null, body: {} })).status).toBe(401);
    expect((await request('POST', '/oauth/start/github', { contentType: 'text/plain' })).status).toBe(415);
    const r = await request('POST', '/oauth/start/github', { body: {} });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toMatch(/OAuth app/);
  });

  it('rejects an unknown provider and grants for unknown bots', async () => {
    expect((await request('PUT', '/api/integrations/apps/myspace', { body: { clientId: 'abcd' } })).status).toBe(404);
    expect((await request('PUT', '/api/integrations/nope/grants', { body: { botIds: ['ghost'] } })).status).toBe(400);
  });
});

describe('integration REST over a fake provider', () => {
  let h: Hub;
  let p: number;
  beforeAll(async () => {
    const integrations = (db: Db) => new IntegrationService({
      db, fetch: f.fetch, vault: new IntegrationVault({ file: path.join(dir, 'i.json'), keyFile: path.join(dir, 'vault.key') }),
    });
    h = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, integrations });
    p = await h.listen();
  });
  afterAll(() => h.shutdown());

  const req = (method: string, url: string, body?: unknown, host?: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const headers: Record<string, string> = { host: host ?? '127.0.0.1:' + p, authorization: 'Bearer ' + TOKEN };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = http.request({ host: '127.0.0.1', port: p, method, path: url, headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });

  it('a refused pasted token is a 400, never a 401 (which the UI reads as a bad hub token)', async () => {
    f.on('GET', 'https://api.github.com/user', () => ({ status: 401, json: { message: 'Bad credentials' } }));
    const r = await req('POST', '/api/integrations/token/github', { token: 'ghp_0123456789abcdefghijABCDEFGHIJ0123' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('Bad credentials');
    expect(r.text).not.toContain('ghp_0123');
  });

  it('full browser round trip: save app → start → callback → connected → grant → disconnect', async () => {
    expect((await req('PUT', '/api/integrations/apps/github', { clientId: 'Iv1.client', clientSecret: 'shh' })).status).toBe(200);
    const start = JSON.parse((await req('POST', '/oauth/start/github', {})).text) as { url: string };
    const state = new URL(start.url).searchParams.get('state')!;
    f.on('POST', 'https://github.com/login/oauth/access_token', () => ({ json: { access_token: 'gho_fromcallback0123456789abcdef' } }));
    f.on('GET', 'https://api.github.com/user', () => ({ json: { login: 'octo' }, headers: { 'x-oauth-scopes': 'repo, notifications' } }));
    const cb = await new Promise<{ status: number; text: string }>((resolve) => {
      http.get({ host: '127.0.0.1', port: p, path: '/oauth/callback/github?code=c&state=' + state, headers: { host: '127.0.0.1:' + p } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
    });
    expect(cb.status).toBe(200);
    expect(cb.text).toContain('GitHub is connected');
    const st = JSON.parse((await req('GET', '/api/integrations')).text) as IntegrationsState;
    expect(st.connections).toHaveLength(1);
    expect(st.connections[0]).toMatchObject({ provider: 'github', accountLabel: 'octo', botIds: [] });
    expect(JSON.stringify(st)).not.toMatch(/gho_|shh/);

    const bot = h.repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'm1', allowedTools: [], maxBudgetUsd: 2 });
    const g = await req('PUT', '/api/integrations/' + st.connections[0].id + '/grants', { botIds: [bot.id] });
    expect(JSON.parse(g.text).botIds).toEqual([bot.id]);
    expect((await req('DELETE', '/api/integrations/' + st.connections[0].id)).status).toBe(200);
    expect((JSON.parse((await req('GET', '/api/integrations')).text) as IntegrationsState).connections).toEqual([]);
  });
});
