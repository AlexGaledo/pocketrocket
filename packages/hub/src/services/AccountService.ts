import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  createClient, isAuthPKCECodeVerifierMissingError, isAuthRetryableFetchError,
  type AuthChangeEvent, type AuthError, type Session, type SupabaseClient, type SupportedStorage, type User,
} from '@supabase/supabase-js';
import { SIGNED_OUT, type AccountState, type AccountUser } from '@pocketrocket/shared';
import { ACCOUNT_EMAIL, ACCOUNT_PATH, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, restrictFile } from '../config.js';
import { events } from '../events.js';

/** Fixed, so account.json reads the same whatever the project URL is. */
const STORAGE_KEY = 'pocketrocket-auth';
/** Our entries next to supabase-js's in account.json: the last known user (for an offline start) and a sign-in in flight. */
const USER_KEY = 'pocketrocket-user';
const FLOW_KEY = 'pocketrocket-flow';
/** A link older than this is not worth waiting for (Supabase's default OTP expiry is one hour). */
const FLOW_TTL_MS = 60 * 60 * 1000;
/** How long a failed OAuth-settings probe is left alone before GET /api/account retries it. */
const FLAGS_RETRY_MS = 60 * 1000;

export type OAuthProvider = 'google' | 'github';
/** The slice of the Supabase client the service touches; tests hand in a fake. */
export type AccountClient = Pick<SupabaseClient, 'auth' | 'from'>;

/** An account operation refused; rest.ts answers with `status`. */
export class AccountError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 429 | 503 = 400) {
    super(message);
  }
}

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const Flow = z.object({ email: z.string().nullable(), at: z.number() });
const CachedUser = z.object({
  id: z.string(), email: z.string(), displayName: z.string().nullable(), plan: z.enum(['free', 'pro']),
});
const Profile = z.object({
  display_name: z.string().nullish(),
  // A plan this build does not know yet reads as free rather than breaking the account.
  plan: z.enum(['free', 'pro']).catch('free'),
});
const AuthSettings = z.object({ external: z.record(z.string(), z.unknown()).optional() });

/**
 * supabase-js auth storage in one JSON file: the session (refresh token included), PKCE verifiers, and our two
 * keys. Rewritten and re-restricted to the owner on every change, like secrets.json, and removed once empty.
 */
export class FileStorage implements SupportedStorage {
  constructor(readonly file: string) {}

  private read(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>) {
    if (!Object.keys(all).length) return this.clear();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
    restrictFile(this.file);
  }

  getItem(key: string): string | null {
    return this.read()[key] ?? null;
  }
  setItem(key: string, value: string): void {
    const all = this.read();
    if (all[key] === value) return;
    all[key] = value;
    this.write(all);
  }
  removeItem(key: string): void {
    const all = this.read();
    if (!(key in all)) return;
    delete all[key];
    this.write(all);
  }
  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

export interface AccountOptions {
  url?: string;
  key?: string;
  file?: string;
  /** A ready client instead of `createClient` (tests). */
  client?: AccountClient;
  /** fetch for the auth-settings probe and for a client built here. */
  fetch?: typeof fetch;
  /** Offer email link/code sign-in (default: ACCOUNT_EMAIL). */
  email?: boolean;
}

/**
 * The optional PocketRocket account. The hub, not the browser, owns the Supabase session: the UI runs in the
 * Tauri webview or in a browser over an SSH tunnel, and the email link opens in the default browser, which
 * shares storage with neither. The UI only ever sees AccountState (GET /api/account, `account.changed`).
 *
 * Nothing here blocks the hub: start() is fire-and-forget, and a failure offline leaves the state signed out
 * or signed in from the cached user, with a warning.
 */
export class AccountService {
  readonly enabled: boolean;
  private client: AccountClient | null = null;
  private storage: FileStorage;
  private url: string;
  private key: string;
  private fetchImpl: typeof fetch;
  private current: AccountState;
  private unsubscribe: (() => void) | null = null;
  private profileLoad: { id: string; p: Promise<void> } | null = null;
  private flags: { ok: boolean; at: number } = { ok: false, at: 0 };

  constructor(opts: AccountOptions = {}) {
    this.url = (opts.url ?? SUPABASE_URL).replace(/\/+$/, '');
    this.key = opts.key ?? SUPABASE_PUBLISHABLE_KEY;
    this.fetchImpl = opts.fetch ?? fetch;
    this.storage = new FileStorage(opts.file ?? ACCOUNT_PATH);
    if (this.url && this.key) {
      try {
        this.client = opts.client ?? createClient(this.url, this.key, {
          auth: {
            flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
            storage: this.storage, storageKey: STORAGE_KEY,
          },
          global: opts.fetch ? { fetch: opts.fetch } : undefined,
        });
      } catch (e) {
        console.warn('[pocketrocket] account: disabled, bad Supabase config (' + errMsg(e) + ')');
      }
    }
    this.enabled = this.client !== null;
    this.current = { ...SIGNED_OUT, enabled: this.enabled, email: this.enabled && (opts.email ?? ACCOUNT_EMAIL) };
  }

  state(): AccountState {
    // A hub that started offline never learnt the OAuth switches; try again now and then.
    if (this.client && !this.flags.ok && Date.now() - this.flags.at > FLAGS_RETRY_MS) void this.loadOAuthFlags();
    return this.snapshot();
  }

  private snapshot(): AccountState {
    return { ...this.current, oauth: { ...this.current.oauth }, user: this.current.user && { ...this.current.user } };
  }

  /** True while a magic link or OAuth round trip started here is still worth accepting at /auth/callback. */
  pending(): boolean {
    return this.flow() !== null;
  }

  /** Restore the saved session and read the project's OAuth switches. Never throws. */
  async start(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const cached = this.cachedUser();
    this.set({ pendingEmail: this.flow()?.email ?? null, ...(cached ? { signedIn: true, user: cached } : {}) });
    const { data } = client.auth.onAuthStateChange((event, session) => this.onAuthChange(event, session));
    this.unsubscribe = () => data.subscription.unsubscribe();
    void this.loadOAuthFlags();
    try {
      const { data: got, error } = await client.auth.getSession();
      if (got.session) {
        this.signedIn(got.session.user);
        await this.loadProfile(got.session.user.id);
      } else if (error) {
        // Offline with an expired access token lands here; supabase-js keeps the session and retries.
        console.warn('[pocketrocket] account: could not restore the session (' + error.message + ')' + (cached ? '; showing the cached sign-in' : ''));
      } else {
        this.signedOut();
      }
    } catch (e) {
      console.warn('[pocketrocket] account: could not restore the session (' + errMsg(e) + ')');
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.client?.auth.stopAutoRefresh();
  }

  async sendMagicLink(email: string, redirectTo: string): Promise<void> {
    const client = this.need();
    if (!this.current.email) throw new AccountError('Email sign-in is not available; use GitHub or Google', 409);
    const addr = parseEmail(email);
    if (this.current.signedIn) throw new AccountError('Already signed in; sign out first', 409);
    const { error } = await client.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: redirectTo, shouldCreateUser: true } });
    if (error) throw refused(error);
    this.startFlow(addr);
  }

  /** The 6-digit code from the same email: works when the link was opened on another device. */
  async verifyCode(email: string, token: string): Promise<AccountState> {
    const client = this.need();
    const addr = parseEmail(email);
    const code = token.replace(/\s+/g, '');
    // 6 by default; Supabase lets a project raise it to 10.
    if (!/^\d{6,10}$/.test(code)) throw new AccountError('Enter the code from the email (digits only)');
    const { data, error } = await client.auth.verifyOtp({ email: addr, token: code, type: 'email' });
    if (error) throw refused(error);
    if (!data.user) throw new AccountError('Sign-in did not return a user');
    this.signedIn(data.user);
    await this.loadProfile(data.user.id);
    return this.state();
  }

  /** The link callback: only this hub holds the PKCE verifier the code is exchangeable with. */
  async exchangeCode(code: string): Promise<AccountState> {
    const client = this.need();
    if (!this.pending()) throw new AccountError('No sign-in is waiting on this PocketRocket', 409);
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error) throw refused(error);
    this.signedIn(data.user);
    await this.loadProfile(data.user.id);
    return this.state();
  }

  /** Provider sign-in URL for the UI to open; the provider sends the browser back to /auth/callback. */
  async oauthUrl(provider: OAuthProvider, redirectTo: string): Promise<string> {
    const client = this.need();
    if (!this.current.oauth[provider]) throw new AccountError(provider + ' sign-in is not enabled for PocketRocket accounts');
    if (this.current.signedIn) throw new AccountError('Already signed in; sign out first', 409);
    const { data, error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } });
    if (error) throw refused(error);
    if (!data.url) throw new AccountError('Supabase returned no sign-in URL');
    this.startFlow(null);
    return data.url;
  }

  cancelPending(): AccountState {
    this.storage.removeItem(FLOW_KEY);
    this.set({ pendingEmail: null });
    return this.state();
  }

  /** Local scope: this hub only, never the user's other devices. The file goes even when Supabase is unreachable. */
  async signOut(): Promise<AccountState> {
    if (this.client) {
      try {
        const { error } = await this.client.auth.signOut({ scope: 'local' });
        if (error) console.warn('[pocketrocket] account: sign-out could not reach Supabase (' + error.message + '); signed out locally');
      } catch (e) {
        console.warn('[pocketrocket] account: sign-out failed (' + errMsg(e) + '); signed out locally');
      }
    }
    this.storage.clear();
    this.signedOut();
    return this.state();
  }

  // ---- internals

  private need(): AccountClient {
    if (!this.client) throw new AccountError('Accounts are not configured on this hub', 409);
    return this.client;
  }

  private set(patch: Partial<AccountState>) {
    const next = { ...this.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    events.emitEvent({ type: 'account.changed', account: this.snapshot() });
  }

  private onAuthChange(event: AuthChangeEvent, session: Session | null) {
    // start() does the restore itself: it can tell "offline" from "signed out", which INITIAL_SESSION cannot.
    if (event === 'INITIAL_SESSION') return;
    if (event === 'SIGNED_OUT') return this.signedOut();
    if (!session) return;
    this.signedIn(session.user);
    // Token refreshes land here too, which is what picks up a plan change. Deferred: supabase-js advises
    // against calling back into the client from inside this callback.
    const id = session.user.id;
    setTimeout(() => void this.loadProfile(id), 0);
  }

  private signedIn(u: User) {
    const known = [this.current.user, this.cachedUser()].find((c) => c?.id === u.id);
    const user: AccountUser = { id: u.id, email: u.email ?? '', displayName: known?.displayName ?? null, plan: known?.plan ?? 'free' };
    this.storage.removeItem(FLOW_KEY);
    this.remember(user);
    this.set({ signedIn: true, user, pendingEmail: null });
  }

  private signedOut() {
    this.storage.removeItem(USER_KEY);
    this.set({ signedIn: false, user: null, pendingEmail: this.flow()?.email ?? null });
  }

  /** `profiles` row → plan and display name; a missing row is a free account. One load per user at a time. */
  private loadProfile(id: string): Promise<void> {
    if (this.profileLoad?.id === id) return this.profileLoad.p;
    const p = (async () => {
      try {
        const { data, error } = await this.client!.from('profiles').select('display_name, plan').eq('id', id).maybeSingle();
        if (error) throw new Error(error.message);
        const row = data ? Profile.parse(data) : null;
        const cur = this.current.user;
        if (!cur || cur.id !== id) return;
        const user: AccountUser = { ...cur, displayName: row?.display_name ?? null, plan: row?.plan ?? 'free' };
        this.remember(user);
        this.set({ user });
      } catch (e) {
        console.warn('[pocketrocket] account: could not load the profile (' + errMsg(e) + ')');
      }
    })().finally(() => {
      if (this.profileLoad?.p === p) this.profileLoad = null;
    });
    this.profileLoad = { id, p };
    return p;
  }

  /** Which OAuth providers the project has switched on, from its public auth settings. Both off on any failure. */
  private async loadOAuthFlags(): Promise<void> {
    this.flags.at = Date.now();
    try {
      const r = await this.fetchImpl(this.url + '/auth/v1/settings', {
        headers: { apikey: this.key }, signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ext = AuthSettings.parse(await r.json()).external ?? {};
      this.flags.ok = true;
      this.set({ oauth: { google: ext.google === true, github: ext.github === true } });
    } catch (e) {
      console.warn('[pocketrocket] account: could not read the sign-in options (' + errMsg(e) + ')');
    }
  }

  private startFlow(email: string | null) {
    this.storage.setItem(FLOW_KEY, JSON.stringify({ email, at: Date.now() }));
    this.set({ pendingEmail: email });
  }

  private flow(): z.infer<typeof Flow> | null {
    const f = parseJson(Flow, this.storage.getItem(FLOW_KEY));
    if (f && Date.now() - f.at < FLOW_TTL_MS) return f;
    if (f) this.storage.removeItem(FLOW_KEY);
    return null;
  }

  private cachedUser(): AccountUser | null {
    return parseJson(CachedUser, this.storage.getItem(USER_KEY));
  }

  private remember(user: AccountUser) {
    this.storage.setItem(USER_KEY, JSON.stringify(user));
  }
}

function parseEmail(raw: string): string {
  const r = Email.safeParse(raw);
  if (!r.success) throw new AccountError('Enter a valid email address');
  return r.data;
}

function parseJson<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (!raw) return null;
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** A Supabase auth error as something the Account UI can show as is. */
function refused(error: AuthError): AccountError {
  if (isAuthRetryableFetchError(error)) return new AccountError('Could not reach PocketRocket accounts; check your connection and try again', 503);
  if (isAuthPKCECodeVerifierMissingError(error)) {
    return new AccountError('This link was requested from another PocketRocket or already used; enter the code from the email instead');
  }
  if (error.code === 'otp_expired') return new AccountError('That code is wrong or has expired; request a new one');
  if (error.status === 429) return new AccountError(error.message || 'Too many attempts; wait a minute and try again', 429);
  return new AccountError(error.message || 'Sign-in failed');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
