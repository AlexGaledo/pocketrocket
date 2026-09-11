import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AuthApiError, type Session } from '@supabase/supabase-js';
import type { AccountState } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { AccountService, type AccountClient } from '../services/AccountService.js';
import { checkToken } from './guard.js';
import { escapeHtml, failurePage, successPage } from './authCallback.js';

const TOKEN = 'account-test-token';
const USER = { id: 'u1', email: 'alex@example.com' };
const SESSION = { access_token: 'at', refresh_token: 'rt', user: USER } as unknown as Session;

const auth = {
  signInWithOtp: vi.fn(async (_: unknown) => ({ data: {}, error: null })),
  verifyOtp: vi.fn(async ({ token }: { token: string }) => token === '123456'
    ? { data: { user: USER, session: SESSION }, error: null }
    : { data: { user: null, session: null }, error: new AuthApiError('Token has expired or is invalid', 403, 'otp_expired') }),
  exchangeCodeForSession: vi.fn(async (code: string) => code === 'good'
    ? { data: { user: USER, session: SESSION }, error: null }
    : { data: { user: null, session: null }, error: new AuthApiError('<b>bad</b> code', 400, 'bad_code') }),
  signInWithOAuth: vi.fn(async ({ provider }: { provider: string }) => ({ data: { provider, url: 'https://proj.supabase.co/auth/v1/authorize?provider=' + provider }, error: null })),
  signOut: vi.fn(async (_: unknown) => ({ error: null })),
  getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => undefined } } })),
  stopAutoRefresh: vi.fn(async () => undefined),
};
const from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { display_name: null, plan: 'pro' }, error: null }) }) }) });

let hub: Hub;
let port: number;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-account-rest-'));
  const account = new AccountService({
    url: 'https://proj.supabase.co', key: 'sb_publishable_x', file: path.join(dir, 'account.json'),
    client: { auth, from } as unknown as AccountClient,
    fetch: (async () => new Response(JSON.stringify({ external: { google: true, github: false } }))) as unknown as typeof fetch,
  });
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, account });
  port = await hub.listen();
  await vi.waitFor(() => expect(hub.account.state().oauth.google).toBe(true));
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await hub.account.signOut();
});

/** Raw request, so the test controls Host and can leave the token off. */
function request(
  method: string, p: string, opts: { body?: unknown; token?: string | null; host?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const headers: Record<string, string> = { host: opts.host ?? '127.0.0.1:' + port };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}
const json = <T>(r: { text: string }) => JSON.parse(r.text) as T;

describe('account REST', () => {
  it('GET /api/account needs the hub token and returns the AccountState', async () => {
    expect((await request('GET', '/api/account', { token: null })).status).toBe(401);
    const r = await request('GET', '/api/account');
    expect(r.status).toBe(200);
    expect(json<AccountState>(r)).toEqual({
      enabled: true, signedIn: false, user: null, oauth: { google: true, github: false }, pendingEmail: null,
    });
  });

  it('every /api/account route stays behind the token', async () => {
    for (const p of ['/api/account/magic-link', '/api/account/verify', '/api/account/oauth', '/api/account/cancel', '/api/account/sign-out']) {
      expect((await request('POST', p, { token: null, body: {} })).status, p).toBe(401);
    }
  });

  it('POST /api/account/magic-link answers 204 and points the link back at this Host', async () => {
    const r = await request('POST', '/api/account/magic-link', { body: { email: 'alex@example.com' }, host: 'localhost:' + port });
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
    expect(auth.signInWithOtp).toHaveBeenLastCalledWith({
      email: 'alex@example.com', options: { emailRedirectTo: 'http://localhost:' + port + '/auth/callback', shouldCreateUser: true },
    });
    expect(json<AccountState>(await request('GET', '/api/account')).pendingEmail).toBe('alex@example.com');
    expect((await request('POST', '/api/account/magic-link', { body: { email: 'nope' } })).status).toBe(400);
  });

  it('POST /api/account/verify signs in, and a bad code is a readable 400', async () => {
    const bad = await request('POST', '/api/account/verify', { body: { email: 'alex@example.com', code: '000000' } });
    expect(bad.status).toBe(400);
    expect(json<{ error: string }>(bad).error).toMatch(/wrong or has expired/);
    const ok = await request('POST', '/api/account/verify', { body: { email: 'alex@example.com', code: '123456' } });
    expect(ok.status).toBe(200);
    expect(json<AccountState>(ok)).toMatchObject({ signedIn: true, user: { email: 'alex@example.com', plan: 'pro' } });
  });

  it('POST /api/account/oauth returns the URL for an enabled provider, 400 otherwise', async () => {
    const ok = await request('POST', '/api/account/oauth', { body: { provider: 'google' } });
    expect(ok.status).toBe(200);
    expect(json<{ url: string }>(ok).url).toContain('provider=google');
    expect(auth.signInWithOAuth).toHaveBeenLastCalledWith({
      provider: 'google', options: { redirectTo: 'http://127.0.0.1:' + port + '/auth/callback', skipBrowserRedirect: true },
    });
    expect((await request('POST', '/api/account/oauth', { body: { provider: 'github' } })).status).toBe(400);
    expect((await request('POST', '/api/account/oauth', { body: { provider: 'facebook' } })).status).toBe(400);
  });

  it('cancel and sign-out return the AccountState', async () => {
    await request('POST', '/api/account/magic-link', { body: { email: 'alex@example.com' } });
    const c = await request('POST', '/api/account/cancel', { body: {} });
    expect(json<AccountState>(c).pendingEmail).toBeNull();
    await request('POST', '/api/account/verify', { body: { email: 'alex@example.com', code: '123456' } });
    const out = await request('POST', '/api/account/sign-out', { body: {} });
    expect(json<AccountState>(out)).toMatchObject({ signedIn: false, user: null });
  });
});

describe('GET /auth/callback', () => {
  it('works without the hub token and signs in when a sign-in is waiting', async () => {
    await request('POST', '/api/account/magic-link', { body: { email: 'alex@example.com' } });
    const r = await request('GET', '/auth/callback?code=good', { token: null });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.text).toContain('Signed in to PocketRocket');
    expect(r.text).toContain('alex@example.com');
    expect(hub.account.state().signedIn).toBe(true);
  });

  it('refuses a code when no sign-in is waiting, without calling Supabase', async () => {
    auth.exchangeCodeForSession.mockClear();
    const r = await request('GET', '/auth/callback?code=good', { token: null });
    expect(r.status).toBe(400);
    expect(r.text).toContain('No sign-in is waiting');
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('escapes the Supabase error and a failed exchange', async () => {
    await request('POST', '/api/account/magic-link', { body: { email: 'alex@example.com' } });
    const e = await request('GET', '/auth/callback?error=access_denied&error_description=' + encodeURIComponent('<script>alert(1)</script> expired'), { token: null });
    expect(e.status).toBe(400);
    expect(e.text).not.toContain('<script>');
    expect(e.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; expired');

    const bad = await request('GET', '/auth/callback?code=nope', { token: null });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('&lt;b&gt;bad&lt;/b&gt; code');
    expect(bad.text).not.toContain('<b>bad</b>');
  });

  it('keeps the Host check (DNS rebinding) on the callback', async () => {
    const r = await request('GET', '/auth/callback?code=good', { token: null, host: 'evil.example:' + port });
    expect(r.status).toBe(403);
  });

  it('exempts exactly GET /auth/callback and nothing near it', async () => {
    for (const p of ['/auth/callback/', '/auth/callbackx', '/auth/callback/x', '/auth', '/auth/other', '/api/auth/callback']) {
      expect((await request('GET', p, { token: null })).status, p).toBe(401);
    }
    expect((await request('POST', '/auth/callback', { token: null, body: {} })).status).toBe(401);
  });
});

describe('checkToken exemption for the callback', () => {
  const req = (method: string) => ({ method, headers: { host: '127.0.0.1:7788' } }) as http.IncomingMessage;
  const u = (p: string) => new URL(p, 'http://localhost');
  it('lets only a GET of the exact path through', () => {
    expect(checkToken(req('GET'), u('/auth/callback?code=x'), 'tok')).toBe(true);
    expect(checkToken(req('POST'), u('/auth/callback'), 'tok')).toBe(false);
    expect(checkToken(req('GET'), u('/auth/callback/'), 'tok')).toBe(false);
    expect(checkToken(req('GET'), u('/auth/callbacks'), 'tok')).toBe(false);
    expect(checkToken(req('GET'), u('/auth/'), 'tok')).toBe(false);
  });
});

describe('callback page', () => {
  it('escapes every HTML metacharacter', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(successPage('"><img src=x onerror=alert(1)>@x.co')).not.toContain('<img');
    expect(failurePage('<img src=x>')).toContain('&lt;img src=x&gt;');
  });

  it('is self-contained: inline CSS, light and dark, no external assets or scripts', () => {
    const html = successPage('a@b.co');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//);
  });
});
