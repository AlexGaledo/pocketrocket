import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../db/db.js';
import { IntegrationVault } from '../services/IntegrationVault.js';
import { IntegrationService, PENDING_TTL_MS } from '../services/IntegrationService.js';
import { pkceChallenge } from './oauth.js';
import { fakeFetch } from './fakeFetch.js';

let dir: string;
let now: number;

function setup() {
  const f = fakeFetch();
  const svc = new IntegrationService({
    db: new Db(':memory:'),
    vault: new IntegrationVault({ file: path.join(dir, 'integrations.json'), keyFile: path.join(dir, 'vault.key') }),
    fetch: f.fetch,
    sleep: async () => undefined,
    now: () => now,
  });
  return { svc, f };
}

/** A GitHub token endpoint that, like the real one, only honours a code_verifier matching the challenge. */
function githubWithPkce(f: ReturnType<typeof fakeFetch>, challenge: () => string) {
  f.on('POST', 'https://github.com/login/oauth/access_token', (c) => {
    const form = new URLSearchParams(c.body);
    if (form.get('code') !== 'good-code') return { json: { error: 'bad_verification_code' } };
    if (pkceChallenge(form.get('code_verifier') ?? '') !== challenge()) return { json: { error: 'invalid_grant', error_description: 'PKCE verification failed' } };
    return { json: { access_token: 'gho_accesstoken0123456789abcdef', scope: 'repo,notifications' } };
  });
  f.on('GET', 'https://api.github.com/user', () => ({ json: { login: 'octo' }, headers: { 'x-oauth-scopes': 'repo, notifications' } }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-oauth-'));
  now = 1_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('browser OAuth (state + PKCE + loopback)', () => {
  it('builds an authorize URL with state, an S256 challenge and a loopback redirect', () => {
    const { svc } = setup();
    svc.setApp('github', { clientId: 'Iv1.client', clientSecret: 'shh-secret' });
    const { url, redirectUri } = svc.startBrowser('github', '127.0.0.1:7790');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(redirectUri).toBe('http://127.0.0.1:7790/oauth/callback/github');
    expect(u.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain('shh-secret');
    expect(svc.hasPendingBrowser()).toBe(true);
  });

  it('teams uses localhost (port ignored by Microsoft) and the tenant', () => {
    const { svc } = setup();
    svc.setApp('teams', { clientId: 'aad-client-id', tenant: 'contoso.onmicrosoft.com' });
    const { url, redirectUri } = svc.startBrowser('teams', '127.0.0.1:7790');
    expect(redirectUri).toBe('http://localhost:7790/oauth/callback/teams');
    expect(url).toContain('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
  });

  it('completes: exchanges the code with the matching verifier and stores the connection', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client', clientSecret: 'shh-secret' });
    const { url } = svc.startBrowser('github', '127.0.0.1:7790');
    const u = new URL(url);
    githubWithPkce(f, () => u.searchParams.get('code_challenge')!);
    const r = await svc.completeBrowser('github', new URLSearchParams({ code: 'good-code', state: u.searchParams.get('state')! }));
    expect(r.ok).toBe(true);
    const conn = svc.repo.byProvider('github')!;
    expect(conn).toMatchObject({ method: 'oauth', accountLabel: 'octo', status: 'connected' });
    expect(svc.vault.get('conn:' + conn.id)?.accessToken).toBe('gho_accesstoken0123456789abcdef');
    // the token never lands in the rows the UI reads
    expect(JSON.stringify(svc.state())).not.toContain('gho_accesstoken');
    expect(svc.hasPendingBrowser()).toBe(false);
  });

  it('rejects a callback when no start is pending', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client', clientSecret: 'shh-secret' });
    const r = await svc.completeBrowser('github', new URLSearchParams({ code: 'good-code', state: 'anything' }));
    expect(r).toMatchObject({ ok: false, unsolicited: true });
    expect(f.calls).toHaveLength(0);
    expect(svc.repo.list()).toHaveLength(0);
  });

  it('rejects a state mismatch, and the real state is still single-use afterwards', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client', clientSecret: 'shh-secret' });
    const { url } = svc.startBrowser('github', '127.0.0.1:7790');
    const state = new URL(url).searchParams.get('state')!;
    expect(await svc.completeBrowser('github', new URLSearchParams({ code: 'good-code', state: state + 'x' }))).toMatchObject({ ok: false, unsolicited: true });
    expect(f.calls).toHaveLength(0);
    githubWithPkce(f, () => pkceChallenge('irrelevant'));
    await svc.completeBrowser('github', new URLSearchParams({ code: 'bad', state }));
    // replaying the same state again is refused without a token call
    const before = f.calls.length;
    expect(await svc.completeBrowser('github', new URLSearchParams({ code: 'good-code', state }))).toMatchObject({ ok: false, unsolicited: true });
    expect(f.calls.length).toBe(before);
  });

  it('rejects a callback for a different provider than the one started', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client', clientSecret: 'shh-secret' });
    svc.setApp('google', { clientId: 'g.apps.googleusercontent.com', clientSecret: 'gsecret' });
    const state = new URL(svc.startBrowser('github', '127.0.0.1:7790').url).searchParams.get('state')!;
    expect(await svc.completeBrowser('google', new URLSearchParams({ code: 'good-code', state }))).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });

  it('rejects when the PKCE verifier does not match the challenge (no connection is made)', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client', clientSecret: 'shh-secret' });
    const state = new URL(svc.startBrowser('github', '127.0.0.1:7790').url).searchParams.get('state')!;
    githubWithPkce(f, () => pkceChallenge('a-verifier-some-other-flow-made'));
    const r = await svc.completeBrowser('github', new URLSearchParams({ code: 'good-code', state }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/invalid_grant/);
    expect(svc.repo.list()).toHaveLength(0);
  });

  it('rejects an expired start', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client', clientSecret: 'shh-secret' });
    const state = new URL(svc.startBrowser('github', '127.0.0.1:7790').url).searchParams.get('state')!;
    now += PENDING_TTL_MS + 1;
    expect(await svc.completeBrowser('github', new URLSearchParams({ code: 'good-code', state }))).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses to start without a saved app, and GitHub browser flow without a secret', () => {
    const { svc } = setup();
    expect(() => svc.startBrowser('google', '127.0.0.1:7790')).toThrow(/OAuth app/);
    svc.setApp('github', { clientId: 'Iv1.client' });
    expect(() => svc.startBrowser('github', '127.0.0.1:7790')).toThrow(/client secret/);
    expect(() => svc.startBrowser('slack', '127.0.0.1:7790')).toThrow(/paste a token/);
  });

  it('keeps the stored secret when the app is re-saved without one, and never reports it', () => {
    const { svc } = setup();
    svc.setApp('google', { clientId: 'g.apps.googleusercontent.com', clientSecret: 'gsecret-value' });
    expect(svc.setApp('google', { clientId: 'g.apps.googleusercontent.com' })).toEqual({ configured: true, clientId: 'g.apps.googleusercontent.com', hasSecret: true, tenant: null });
    expect(JSON.stringify(svc.state())).not.toContain('gsecret-value');
  });
});

describe('device flow', () => {
  it('polls through authorization_pending and connects', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client' });
    f.on('POST', 'https://github.com/login/device/code', () => ({ json: { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 } }));
    let polls = 0;
    f.on('POST', 'https://github.com/login/oauth/access_token', (c) => {
      expect(new URLSearchParams(c.body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      return ++polls < 3 ? { json: { error: 'authorization_pending' } } : { json: { access_token: 'gho_device0123456789abcdefghij', scope: 'repo' } };
    });
    f.on('GET', 'https://api.github.com/user', () => ({ json: { login: 'octo' } }));
    const pc = await svc.startDevice('github');
    expect(pc).toMatchObject({ kind: 'device', userCode: 'ABCD-1234' });
    await expect.poll(() => svc.repo.byProvider('github')?.accountLabel).toBe('octo');
    expect(svc.pending()).toHaveLength(0);
  });

  it('surfaces a denial on the pending entry', async () => {
    const { svc, f } = setup();
    svc.setApp('github', { clientId: 'Iv1.client' });
    f.on('POST', 'https://github.com/login/device/code', () => ({ json: { device_code: 'd', user_code: 'U', verification_uri: 'https://github.com/login/device', interval: 1 } }));
    f.on('POST', 'https://github.com/login/oauth/access_token', () => ({ json: { error: 'access_denied' } }));
    await svc.startDevice('github');
    await expect.poll(() => svc.pending()[0]?.error).toMatch(/access_denied/);
    expect(svc.repo.list()).toHaveLength(0);
  });
});

describe('token refresh', () => {
  async function connectGoogle(s: ReturnType<typeof setup>) {
    s.svc.setApp('google', { clientId: 'g.apps.googleusercontent.com', clientSecret: 'gsecret' });
    const u = new URL(s.svc.startBrowser('google', '127.0.0.1:7790').url);
    expect(u.searchParams.get('access_type')).toBe('offline');
    s.f.on('POST', 'https://oauth2.googleapis.com/token', (c) => {
      const form = new URLSearchParams(c.body);
      if (form.get('grant_type') === 'authorization_code') return { json: { access_token: 'ya29.first-token-abcdefghijklmnop', refresh_token: '1//refresh-abcdefghijklmnop', expires_in: 3600 } };
      return { json: { access_token: 'ya29.second-token-abcdefghijklmno', expires_in: 3600 } };
    });
    s.f.on('GET', 'https://openidconnect.googleapis.com/v1/userinfo', () => ({ json: { email: 'alex@example.com' } }));
    expect((await s.svc.completeBrowser('google', new URLSearchParams({ code: 'c', state: u.searchParams.get('state')! }))).ok).toBe(true);
    return s.svc.repo.byProvider('google')!;
  }

  it('refreshes shortly before expiry and keeps the refresh token', async () => {
    const s = setup();
    const conn = await connectGoogle(s);
    expect(await s.svc.token(conn.id)).toBe('ya29.first-token-abcdefghijklmnop');
    now += 3600_000 - 30_000;
    expect(await s.svc.token(conn.id)).toBe('ya29.second-token-abcdefghijklmno');
    expect(s.svc.vault.get('conn:' + conn.id)?.refreshToken).toBe('1//refresh-abcdefghijklmnop');
  });

  it('retries a 401 once after a refresh', async () => {
    const s = setup();
    await connectGoogle(s);
    let n = 0;
    s.f.on('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', (c) =>
      ++n === 1 ? { status: 401, json: { error: { message: 'expired' } } } : (expect(c.headers.authorization).toBe('Bearer ya29.second-token-abcdefghijklmno'), { json: { historyId: '42' } }));
    expect(await s.svc.client('google').seedGmailHistory()).toBe('42');
  });

  it('marks the connection expired when the refresh is refused', async () => {
    const s = setup();
    const conn = await connectGoogle(s);
    s.f.on('POST', 'https://oauth2.googleapis.com/token', () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
    now += 3600_000;
    await expect(s.svc.token(conn.id)).rejects.toThrow(/refresh failed/);
    expect(s.svc.repo.get(conn.id)?.status).toBe('expired');
  });
});
