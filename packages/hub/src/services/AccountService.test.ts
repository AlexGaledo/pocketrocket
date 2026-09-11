import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthApiError, AuthRetryableFetchError, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import type { AccountState, ServerEvent } from '@pocketrocket/shared';
import { events } from '../events.js';
import { AccountError, AccountService, FileStorage, type AccountClient } from './AccountService.js';

const URL_ = 'https://proj.supabase.co';
const USER = { id: 'u1', email: 'alex@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const SESSION = {
  access_token: 'at', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'refresh-secret', user: USER,
} as unknown as Session;

let dir: string;
let file: string;
let seen: AccountState[];
let off: () => void;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-account-'));
  file = path.join(dir, 'account.json');
  seen = [];
  off = events.onEvent((ev: ServerEvent) => { if (ev.type === 'account.changed') seen.push(ev.account); });
});
afterEach(() => {
  off();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the Supabase client: records calls, answers like the real one, never touches the network. */
function fake() {
  let listener: ((e: AuthChangeEvent, s: Session | null) => void) | null = null;
  const profile: { row: unknown; error: { message: string } | null } = { row: { display_name: 'Alex', plan: 'pro' }, error: null };
  const auth = {
    signInWithOtp: vi.fn(async (_: unknown) => ({ data: { user: null, session: null }, error: null as unknown })),
    verifyOtp: vi.fn(async ({ token }: { token: string }) => token === '123456'
      ? { data: { user: USER, session: SESSION }, error: null }
      : { data: { user: null, session: null }, error: new AuthApiError('Token has expired or is invalid', 403, 'otp_expired') }),
    exchangeCodeForSession: vi.fn(async (code: string) => code === 'good'
      ? { data: { user: USER, session: SESSION }, error: null }
      : { data: { user: null, session: null }, error: new AuthApiError('invalid flow state, no valid flow state found', 404, 'flow_state_not_found') }),
    signInWithOAuth: vi.fn(async ({ provider }: { provider: string }) => ({ data: { provider, url: URL_ + '/auth/v1/authorize?provider=' + provider }, error: null })),
    signOut: vi.fn(async (_: unknown): Promise<{ error: unknown }> => { listener?.('SIGNED_OUT', null); return { error: null }; }),
    getSession: vi.fn(async (): Promise<{ data: { session: Session | null }; error: unknown }> => ({ data: { session: null }, error: null })),
    onAuthStateChange: vi.fn((cb: typeof listener) => { listener = cb; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
    stopAutoRefresh: vi.fn(async () => undefined),
  };
  const from = vi.fn((_: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile.row, error: profile.error }) }) }),
  }));
  return { client: { auth, from } as unknown as AccountClient, auth, from, profile, emit: (e: AuthChangeEvent, s: Session | null) => listener?.(e, s) };
}

const flagsOk = (external: Record<string, boolean> = { google: true, github: false, email: true }) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ external }), { status: 200 }));
const offline = () => vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => { throw new TypeError('fetch failed'); });

function service(f = fake(), fetchImpl: typeof fetch = flagsOk()) {
  return new AccountService({ url: URL_, key: 'sb_publishable_x', file, client: f.client, fetch: fetchImpl });
}
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;

describe('AccountService', () => {
  it('is disabled without a URL and key, and then never touches the file', async () => {
    const s = new AccountService({ url: '', key: '', file });
    expect(s.state()).toEqual({ enabled: false, signedIn: false, user: null, oauth: { google: false, github: false }, pendingEmail: null });
    await s.start();
    await expect(s.sendMagicLink('a@b.co', 'http://127.0.0.1:7788/auth/callback')).rejects.toMatchObject({ status: 409 });
    await s.signOut();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('sends a magic link, then shows the email as pending and keeps it across a restart', async () => {
    const f = fake();
    const s = service(f);
    await s.sendMagicLink('  Alex@Example.com ', 'http://127.0.0.1:7788/auth/callback');
    expect(f.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'alex@example.com', options: { emailRedirectTo: 'http://127.0.0.1:7788/auth/callback', shouldCreateUser: true },
    });
    expect(s.state().pendingEmail).toBe('alex@example.com');
    expect(s.pending()).toBe(true);
    expect(seen.at(-1)?.pendingEmail).toBe('alex@example.com');

    const again = service(fake());
    await again.start();
    expect(again.state().pendingEmail).toBe('alex@example.com');

    expect(s.cancelPending().pendingEmail).toBeNull();
    expect(s.pending()).toBe(false);
  });

  it('rejects a malformed email before calling Supabase', async () => {
    const f = fake();
    const s = service(f);
    await expect(s.sendMagicLink('not-an-email', 'http://x')).rejects.toBeInstanceOf(AccountError);
    expect(f.auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it('turns a Supabase send failure into a readable error and leaves nothing pending', async () => {
    const f = fake();
    f.auth.signInWithOtp.mockResolvedValueOnce({ data: { user: null, session: null }, error: new AuthApiError('email rate limit exceeded', 429, 'over_email_send_rate_limit') });
    const s = service(f);
    await expect(s.sendMagicLink('a@b.co', 'http://x')).rejects.toMatchObject({ status: 429, message: 'email rate limit exceeded' });
    f.auth.signInWithOtp.mockResolvedValueOnce({ data: { user: null, session: null }, error: new AuthRetryableFetchError('fetch failed', 0) });
    await expect(s.sendMagicLink('a@b.co', 'http://x')).rejects.toMatchObject({ status: 503 });
    expect(s.state().pendingEmail).toBeNull();
  });

  it('verifies the 6-digit code and signs in with the plan from the profile', async () => {
    const f = fake();
    const s = service(f);
    await s.sendMagicLink('alex@example.com', 'http://x');
    const st = await s.verifyCode('alex@example.com', '123 456');
    expect(f.auth.verifyOtp).toHaveBeenCalledWith({ email: 'alex@example.com', token: '123456', type: 'email' });
    expect(f.from).toHaveBeenCalledWith('profiles');
    expect(st).toMatchObject({ signedIn: true, pendingEmail: null, user: { id: 'u1', email: 'alex@example.com', displayName: 'Alex', plan: 'pro' } });
    expect(s.pending()).toBe(false);
    expect(seen.at(-1)?.user?.plan).toBe('pro');
  });

  it('answers a wrong code with a 400 the UI can show', async () => {
    const s = service();
    await expect(s.verifyCode('alex@example.com', '000000')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('wrong or has expired') });
    await expect(s.verifyCode('alex@example.com', 'abc')).rejects.toMatchObject({ status: 400 });
    expect(s.state().signedIn).toBe(false);
  });

  it('treats a missing profile row as a free account', async () => {
    const f = fake();
    f.profile.row = null;
    const st = await service(f).verifyCode('alex@example.com', '123456');
    expect(st.user).toEqual({ id: 'u1', email: 'alex@example.com', displayName: null, plan: 'free' });
  });

  it('exchanges the link code only while a sign-in is waiting', async () => {
    const f = fake();
    const s = service(f);
    await expect(s.exchangeCode('good')).rejects.toMatchObject({ status: 409 });
    expect(f.auth.exchangeCodeForSession).not.toHaveBeenCalled();

    await s.sendMagicLink('alex@example.com', 'http://x');
    await expect(s.exchangeCode('bad')).rejects.toMatchObject({ status: 400 });
    const st = await s.exchangeCode('good');
    expect(st).toMatchObject({ signedIn: true, pendingEmail: null, user: { plan: 'pro' } });
  });

  it('signs out locally and deletes account.json', async () => {
    const f = fake();
    const s = service(f);
    await s.verifyCode('alex@example.com', '123456');
    expect(fs.existsSync(file)).toBe(true);
    const st = await s.signOut();
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(st).toMatchObject({ signedIn: false, user: null, pendingEmail: null });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('still signs out locally when Supabase is unreachable', async () => {
    const f = fake();
    f.auth.signOut.mockResolvedValueOnce({ error: new AuthRetryableFetchError('fetch failed', 0) });
    const s = service(f);
    await s.verifyCode('alex@example.com', '123456');
    expect((await s.signOut()).signedIn).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('restores a saved session on start and reloads the profile', async () => {
    const f = fake();
    f.auth.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    f.profile.row = { display_name: null, plan: 'free' };
    const s = service(f);
    await s.start();
    expect(s.state()).toMatchObject({ signedIn: true, user: { id: 'u1', plan: 'free' } });
  });

  it('starts offline without waiting on the network, from the cached sign-in', async () => {
    new FileStorage(file).setItem('pocketrocket-user', JSON.stringify({ id: 'u1', email: 'alex@example.com', displayName: 'Alex', plan: 'pro' }));
    const f = fake();
    f.auth.getSession.mockReturnValue(new Promise(() => undefined)); // the refresh never comes back
    const s = service(f, offline());
    void s.start();
    expect(s.state()).toMatchObject({ signedIn: true, user: { plan: 'pro' }, oauth: { google: false, github: false } });
  });

  it('keeps the cached sign-in when the restore fails offline, and shows signed out when there is none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = fake();
      f.auth.getSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError('fetch failed', 0) });
      await service(f, offline()).start();
      expect(seen.every((st) => !st.signedIn)).toBe(true);

      new FileStorage(file).setItem('pocketrocket-user', JSON.stringify({ id: 'u1', email: 'alex@example.com', displayName: null, plan: 'pro' }));
      const s = service(f, offline());
      await s.start();
      expect(s.state()).toMatchObject({ signedIn: true, user: { plan: 'pro' } });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('follows sign-out and token refresh reported by supabase-js', async () => {
    const f = fake();
    const s = service(f);
    await s.start();
    f.emit('SIGNED_IN', SESSION);
    expect(s.state().signedIn).toBe(true);
    await vi.waitFor(() => expect(s.state().user?.plan).toBe('pro'));
    f.emit('SIGNED_OUT', null);
    expect(s.state()).toMatchObject({ signedIn: false, user: null });
  });

  it('reads the OAuth switches from the public auth settings, with the publishable key', async () => {
    const fetchImpl = flagsOk();
    const f = fake();
    const s = service(f, fetchImpl);
    await s.start();
    await vi.waitFor(() => expect(s.state().oauth).toEqual({ google: true, github: false }));
    expect(fetchImpl.mock.calls[0][0]).toBe(URL_ + '/auth/v1/settings');
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ apikey: 'sb_publishable_x' });

    await expect(s.oauthUrl('github', 'http://x')).rejects.toMatchObject({ status: 400 });
    expect(await s.oauthUrl('google', 'http://127.0.0.1:7788/auth/callback')).toBe(URL_ + '/auth/v1/authorize?provider=google');
    expect(f.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google', options: { redirectTo: 'http://127.0.0.1:7788/auth/callback', skipBrowserRedirect: true },
    });
    expect(s.pending()).toBe(true);
    expect(s.state().pendingEmail).toBeNull();
  });

  it('leaves both OAuth switches off when the settings probe fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = service(fake(), offline());
    await s.start();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('sign-in options')));
    expect(s.state().oauth).toEqual({ google: false, github: false });
    warn.mockRestore();
  });
});

describe('AccountService over the real supabase-js client', () => {
  /** Answers the handful of Supabase endpoints the flow touches; records every request. */
  function supabaseStub() {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      const p = new URL(url).pathname;
      if (p === '/auth/v1/settings') return json({ external: { google: false, github: true } });
      if (p === '/auth/v1/otp') return json({});
      if (p === '/auth/v1/token') return json(SESSION);
      if (p === '/auth/v1/logout') return new Response(null, { status: 204 });
      if (p === '/rest/v1/profiles') return json([{ display_name: 'Alex', plan: 'pro' }]);
      return json({ message: 'unexpected ' + p }, 404);
    });
    return { fn, calls };
  }

  it('keeps the PKCE verifier and then the session in account.json, and signs in from the link', async () => {
    const stub = supabaseStub();
    const s = new AccountService({ url: URL_, key: 'sb_publishable_x', file, fetch: stub.fn as unknown as typeof fetch });
    try {
      await s.start();
      await s.sendMagicLink('alex@example.com', 'http://127.0.0.1:7788/auth/callback');
      const otp = stub.calls.find((c) => c.url.includes('/auth/v1/otp'))!;
      expect(new URL(otp.url).searchParams.get('redirect_to')).toBe('http://127.0.0.1:7788/auth/callback');
      expect(otp.body).toMatchObject({ email: 'alex@example.com', create_user: true, code_challenge_method: 's256' });
      expect(Object.keys(onDisk()).some((k) => k.startsWith('pocketrocket-auth-code-verifier'))).toBe(true);

      const st = await s.exchangeCode('the-code');
      const token = stub.calls.find((c) => c.url.includes('/auth/v1/token'))!;
      expect(token.body).toMatchObject({ auth_code: 'the-code' });
      expect(st).toMatchObject({ signedIn: true, user: { email: 'alex@example.com', displayName: 'Alex', plan: 'pro' } });
      expect(onDisk()['pocketrocket-auth']).toContain('refresh-secret');

      // A new process picks the session straight back up from the file.
      const again = new AccountService({ url: URL_, key: 'sb_publishable_x', file, fetch: stub.fn as unknown as typeof fetch });
      await again.start();
      expect(again.state()).toMatchObject({ signedIn: true, user: { id: 'u1', plan: 'pro' } });
      again.stop();

      await s.signOut();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      s.stop();
    }
  });
});

describe('FileStorage', () => {
  it('writes owner-only JSON and removes the file once the last key goes', () => {
    const st = new FileStorage(file);
    expect(st.getItem('a')).toBeNull();
    st.setItem('a', '1');
    st.setItem('b', '2');
    expect(onDisk()).toEqual({ a: '1', b: '2' });
    if (process.platform !== 'win32') expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    st.removeItem('a');
    expect(st.getItem('b')).toBe('2');
    st.removeItem('b');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reads a corrupt file as empty', () => {
    fs.writeFileSync(file, 'not json');
    expect(new FileStorage(file).getItem('a')).toBeNull();
  });
});
