import {
  INTEGRATION_PROVIDERS,
  type IntegrationInfo, type IntegrationProvider, type IntegrationsState, type OAuthAppInput, type OAuthAppStatus,
  type PendingConnect, type TokenConnectInput,
} from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import { IntegrationRepo } from '../db/integrationRepo.js';
import { events } from '../events.js';
import { IntegrationVault } from './IntegrationVault.js';
import { IntegrationError, type Fetch } from '../integrations/http.js';
import type { ClientDeps } from '../integrations/base.js';
import { GitHubClient } from '../integrations/github.js';
import { GoogleClient } from '../integrations/google.js';
import { SlackClient } from '../integrations/slack.js';
import { ClickUpClient } from '../integrations/clickup.js';
import { TeamsClient } from '../integrations/teams.js';
import {
  OAUTH, authorizeUrl, exchangeCode, pollDevice, randomToken, refreshTokens, startDevice,
  type OAuthApp, type TokenSet,
} from '../integrations/oauth.js';

/** Provider → its client class. P5 pollers get these through `IntegrationService.client()`. */
export interface IntegrationClients {
  github: GitHubClient;
  google: GoogleClient;
  slack: SlackClient;
  clickup: ClickUpClient;
  teams: TeamsClient;
}
const CLIENTS: { [P in IntegrationProvider]: new (d: ClientDeps) => IntegrationClients[P] } = {
  github: GitHubClient, google: GoogleClient, slack: SlackClient, clickup: ClickUpClient, teams: TeamsClient,
};

/** Providers that accept a pasted key/token (research: Google and Teams have no viable paste option). */
export const TOKEN_PROVIDERS: readonly IntegrationProvider[] = ['github', 'slack', 'clickup'];

/** How long a browser sign-in waits for its callback. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before the access token runs out. */
const REFRESH_SKEW_MS = 60_000;

interface BrowserPending { provider: IntegrationProvider; verifier: string; redirectUri: string; startedAt: number; expiresAt: number }
interface DevicePending { pc: PendingConnect; cancelled: boolean }

export type CallbackResult =
  | { ok: true; info: IntegrationInfo }
  /** `unsolicited`: no start was pending for this state, so the request proves nothing and feeds the rate limiter. */
  | { ok: false; status: number; message: string; unsolicited: boolean };

export interface IntegrationServiceOptions {
  db: Db;
  vault?: IntegrationVault;
  fetch?: Fetch;
  /** Device-flow poll wait; tests pass a fast one. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Integrations (P4): shared connections (one per provider), the user's own OAuth apps, PKCE + loopback and
 * device sign-in, token refresh, per-bot grants, and the provider clients that hub tools and P5 pollers use.
 *
 * Human-only: REST (`api/integrations.ts`, `api/oauth.ts`) is the only writer. No bot tool reaches a method
 * that changes connections, apps or grants; bots get `createIntegrationTools`, which only reads and (behind
 * an approval card) writes through the provider clients.
 */
export class IntegrationService {
  readonly repo: IntegrationRepo;
  readonly vault: IntegrationVault;
  private fetch: Fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private browser = new Map<string, BrowserPending>();
  private device = new Map<IntegrationProvider, DevicePending>();
  private refreshing = new Map<string, Promise<string>>();

  constructor(opts: IntegrationServiceOptions) {
    this.repo = new IntegrationRepo(opts.db);
    this.vault = opts.vault ?? new IntegrationVault();
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  private changed() {
    events.emitEvent({ type: 'integrations.changed' });
  }
  private connKey = (id: string) => 'conn:' + id;
  private appKey = (p: IntegrationProvider) => 'app:' + p;

  // ---------------------------------------------------------------- state
  state(host?: string): IntegrationsState {
    const apps = {} as Record<IntegrationProvider, OAuthAppStatus>;
    const redirectUris = {} as Record<IntegrationProvider, string>;
    for (const p of INTEGRATION_PROVIDERS) {
      apps[p] = this.appStatus(p);
      redirectUris[p] = OAUTH[p] ? this.redirectUri(p, host) : '';
    }
    const connections = this.repo.list().map((i) => (i.provider === 'slack' ? { ...i, hasAppToken: !!this.safeVault(this.connKey(i.id))?.appToken } : i));
    return { connections, apps, pending: this.pending(), redirectUris };
  }

  /** A vault read for display: an unreadable vault must not take the whole Settings page down. */
  private safeVault(key: string): Record<string, string> | null {
    try { return this.vault.get(key); } catch { return null; }
  }

  pending(): PendingConnect[] {
    const t = this.now();
    for (const [s, b] of this.browser) if (b.expiresAt <= t) this.browser.delete(s);
    const out: PendingConnect[] = [...this.browser.values()].map((b) => ({ provider: b.provider, kind: 'browser' as const, startedAt: b.startedAt, expiresAt: b.expiresAt }));
    for (const d of this.device.values()) out.push({ ...d.pc });
    return out;
  }

  /** `http://<127.0.0.1|localhost>:<port>/oauth/callback/<provider>`, port taken from the request's Host. */
  redirectUri(p: IntegrationProvider, host?: string): string {
    const port = /:(\d{1,5})$/.exec(host ?? '')?.[1];
    return 'http://' + (OAUTH[p]?.redirectHost ?? '127.0.0.1') + (port ? ':' + port : '') + '/oauth/callback/' + p;
  }

  // ---------------------------------------------------------------- OAuth apps
  app(p: IntegrationProvider): OAuthApp | null {
    const e = this.vault.get(this.appKey(p));
    return e?.clientId ? { clientId: e.clientId, clientSecret: e.clientSecret, tenant: e.tenant } : null;
  }

  appStatus(p: IntegrationProvider): OAuthAppStatus {
    const e = this.safeVault(this.appKey(p));
    return { configured: !!e?.clientId, clientId: e?.clientId ?? null, hasSecret: !!e?.clientSecret, tenant: e?.tenant ?? null };
  }

  setApp(p: IntegrationProvider, input: OAuthAppInput): OAuthAppStatus {
    if (!OAUTH[p]) throw new IntegrationError(label(p) + ' does not offer a loopback OAuth flow; paste a token instead', 400);
    const cur = this.vault.get(this.appKey(p)) ?? {};
    this.vault.set(this.appKey(p), {
      clientId: input.clientId,
      // An empty or missing secret keeps the saved one, as the key fields elsewhere in Settings do.
      clientSecret: input.clientSecret || (cur.clientId === input.clientId ? cur.clientSecret ?? '' : ''),
      tenant: p === 'teams' ? input.tenant || 'common' : '',
    });
    this.changed();
    return this.appStatus(p);
  }

  deleteApp(p: IntegrationProvider): OAuthAppStatus {
    this.vault.delete(this.appKey(p));
    this.cancel(p);
    return this.appStatus(p);
  }

  private requireApp(p: IntegrationProvider): { spec: NonNullable<(typeof OAUTH)[IntegrationProvider]>; app: OAuthApp } {
    const spec = OAUTH[p];
    if (!spec) throw new IntegrationError(label(p) + ' does not offer a loopback OAuth flow; paste a token instead', 400);
    const app = this.app(p);
    if (!app) throw new IntegrationError('Save your ' + label(p) + ' OAuth app (client id) first', 400);
    return { spec, app };
  }

  // ---------------------------------------------------------------- browser sign-in (PKCE + loopback)
  /** Mint state + PKCE verifier, remember them, and return the provider's authorize URL. */
  startBrowser(p: IntegrationProvider, host: string | undefined): { url: string; redirectUri: string } {
    const { spec, app } = this.requireApp(p);
    if ((p === 'github' || p === 'clickup') && !app.clientSecret) {
      throw new IntegrationError(label(p) + "'s browser sign-in needs the client secret" + (spec.device ? ' (or use a device code, which does not)' : ''), 400);
    }
    for (const [s, b] of this.browser) if (b.provider === p) this.browser.delete(s);
    const state = randomToken();
    const verifier = randomToken();
    const redirectUri = this.redirectUri(p, host);
    const t = this.now();
    this.browser.set(state, { provider: p, verifier, redirectUri, startedAt: t, expiresAt: t + PENDING_TTL_MS });
    this.changed();
    return { url: authorizeUrl(spec, app, { redirectUri, state, verifier }), redirectUri };
  }

  /** True while some browser sign-in is waiting for its callback. */
  hasPendingBrowser(): boolean {
    return this.pending().some((x) => x.kind === 'browser');
  }

  /**
   * The provider sent the browser back. Accepted only for a `state` this hub minted, for the same provider,
   * within its lifetime, and only once; the code is then exchanged together with the PKCE verifier.
   */
  async completeBrowser(p: IntegrationProvider, params: URLSearchParams): Promise<CallbackResult> {
    const state = params.get('state') ?? '';
    const pend = state ? this.browser.get(state) : undefined;
    if (!pend) return { ok: false, status: 400, message: 'No sign-in is waiting for this callback. Start again from Settings → Integrations.', unsolicited: true };
    this.browser.delete(state);
    this.changed();
    if (pend.provider !== p) return { ok: false, status: 400, message: 'This callback does not belong to the sign-in that was started.', unsolicited: true };
    if (pend.expiresAt <= this.now()) return { ok: false, status: 400, message: 'The sign-in took too long. Start again from Settings → Integrations.', unsolicited: false };
    const providerError = params.get('error_description') || params.get('error');
    if (providerError) return { ok: false, status: 400, message: providerError, unsolicited: false };
    const code = params.get('code');
    if (!code) return { ok: false, status: 400, message: 'The callback carried no authorization code.', unsolicited: true };
    try {
      const { spec, app } = this.requireApp(p);
      const tokens = await exchangeCode(this.fetch, spec, app, { code, redirectUri: pend.redirectUri, verifier: pend.verifier }, this.now());
      return { ok: true, info: await this.finishOAuth(p, tokens) };
    } catch (e) {
      return { ok: false, status: 400, message: e instanceof IntegrationError ? e.message : 'Sign-in failed.', unsolicited: false };
    }
  }

  // ---------------------------------------------------------------- device sign-in (RFC 8628)
  async startDevice(p: IntegrationProvider): Promise<PendingConnect> {
    const { spec, app } = this.requireApp(p);
    if (!spec.device) throw new IntegrationError(label(p) + ' has no device-code sign-in', 400);
    this.cancel(p);
    const ds = await startDevice(this.fetch, spec, app);
    const t = this.now();
    const entry: DevicePending = {
      pc: { provider: p, kind: 'device', startedAt: t, expiresAt: t + ds.expiresInSec * 1000, userCode: ds.userCode, verificationUri: ds.verificationUri },
      cancelled: false,
    };
    this.device.set(p, entry);
    this.changed();
    void this.runDevice(p, entry, ds.deviceCode, ds.intervalSec);
    return { ...entry.pc };
  }

  private async runDevice(p: IntegrationProvider, entry: DevicePending, deviceCode: string, intervalSec: number) {
    let interval = Math.max(1, intervalSec);
    while (!entry.cancelled && this.now() < entry.pc.expiresAt) {
      await this.sleep(interval * 1000);
      if (entry.cancelled) return;
      try {
        const { spec, app } = this.requireApp(p);
        const r = await pollDevice(this.fetch, spec, app, deviceCode, this.now());
        if (r === 'pending') continue;
        if (r === 'slow_down') { interval += 5; continue; }
        await this.finishOAuth(p, r);
        if (this.device.get(p) === entry) this.device.delete(p);
        this.changed();
        return;
      } catch (e) {
        entry.pc.error = e instanceof IntegrationError ? e.message : 'Sign-in failed.';
        this.changed();
        return;
      }
    }
    if (!entry.cancelled) {
      entry.pc.error = 'The code expired before it was entered. Start again.';
      this.changed();
    }
  }

  /** Forget any sign-in waiting for this provider. */
  cancel(p: IntegrationProvider) {
    let any = false;
    for (const [s, b] of this.browser) if (b.provider === p) { this.browser.delete(s); any = true; }
    const d = this.device.get(p);
    if (d) { d.cancelled = true; this.device.delete(p); any = true; }
    if (any) this.changed();
  }

  private async finishOAuth(p: IntegrationProvider, tokens: TokenSet): Promise<IntegrationInfo> {
    const who = await this.identify(p, async () => tokens.accessToken);
    const info = this.repo.upsert({
      provider: p, method: 'oauth', accountLabel: who.label,
      scopes: tokens.scopes.length ? tokens.scopes : who.scopes.length ? who.scopes : OAUTH[p]?.scopes ?? [],
      warnings: who.warnings,
    });
    this.vault.set(this.connKey(info.id), {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt ? String(tokens.expiresAt) : '',
    });
    this.changed();
    return this.repo.get(info.id)!;
  }

  // ---------------------------------------------------------------- pasted tokens
  async connectToken(p: IntegrationProvider, input: TokenConnectInput): Promise<IntegrationInfo> {
    if (!TOKEN_PROVIDERS.includes(p)) throw new IntegrationError(label(p) + ' connects with OAuth only', 400);
    const token = input.token?.trim() ?? '';
    const appToken = input.appToken?.trim() ?? '';
    if (appToken && p !== 'slack') throw new IntegrationError('Only Slack takes an app-level token', 400);
    if (appToken && !appToken.startsWith('xapp-')) throw new IntegrationError('A Slack app-level token starts with xapp-', 400);

    const cur = this.repo.byProvider(p);
    if (!token) {
      // Slack: add or replace the app token on an existing connection without re-pasting the bot token.
      if (!appToken || !cur) throw new IntegrationError('Paste a token', 400);
      this.vault.patch(this.connKey(cur.id), { appToken });
      this.changed();
      return this.state().connections.find((c) => c.id === cur.id)!;
    }
    const shape: Record<string, RegExp> = {
      github: /^(ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,}$/,
      slack: /^xox[bp]-[A-Za-z0-9-]{10,}$/,
      clickup: /^pk_[A-Za-z0-9_]{10,}$/,
    };
    if (!shape[p].test(token)) {
      throw new IntegrationError(
        { github: 'That does not look like a GitHub token (ghp_… or github_pat_…).', slack: 'Paste the bot token, which starts with xoxb-.', clickup: 'A ClickUp personal token starts with pk_.' }[p as 'github' | 'slack' | 'clickup'],
        400,
      );
    }
    const who = await this.identify(p, async () => token);
    const warnings = [...who.warnings];
    if (p === 'github' && token.startsWith('github_pat_')) {
      warnings.push('Fine-grained tokens cannot read notifications, so github_notifications will fail. Use a classic token (repo + notifications) for that.');
    }
    const prevApp = cur && cur.method === 'token' ? this.vault.get(this.connKey(cur.id))?.appToken ?? '' : '';
    const info = this.repo.upsert({ provider: p, method: 'token', accountLabel: who.label, scopes: who.scopes, warnings });
    this.vault.set(this.connKey(info.id), { accessToken: token, appToken: appToken || prevApp });
    this.changed();
    return this.state().connections.find((c) => c.id === info.id)!;
  }

  /** Account label, scopes and warnings, read with the given credential. Throws IntegrationError when it is refused. */
  private async identify(p: IntegrationProvider, token: (refresh?: boolean) => Promise<string>): Promise<{ label: string; scopes: string[]; warnings: string[] }> {
    const deps: ClientDeps = { fetch: this.fetch, token };
    switch (p) {
      case 'github': {
        const w = await new GitHubClient(deps).whoami();
        const warnings: string[] = [];
        if (w.scopes.length && !w.scopes.includes('notifications') && !w.scopes.includes('repo')) warnings.push('This token has neither the repo nor the notifications scope; most GitHub tools will fail.');
        else if (w.scopes.length && !w.scopes.includes('notifications')) warnings.push('This token lacks the notifications scope, so github_notifications will fail.');
        return { label: w.login, scopes: w.scopes, warnings };
      }
      case 'google':
        return { label: (await new GoogleClient(deps).whoami()).email, scopes: [], warnings: [] };
      case 'slack': {
        const a = await new SlackClient(deps).authTest();
        return { label: a.team + ' · ' + a.user, scopes: [], warnings: [] };
      }
      case 'clickup': {
        const u = await new ClickUpClient(deps).whoami();
        return { label: u.email || u.username, scopes: [], warnings: [] };
      }
      case 'teams': {
        const u = await new TeamsClient(deps).whoami();
        return { label: u.email || u.name, scopes: [], warnings: [] };
      }
    }
  }

  // ---------------------------------------------------------------- manage
  /** "Test connection": one identity call with the stored credential (refreshing if needed). */
  async test(id: string): Promise<IntegrationInfo> {
    const info = this.repo.get(id);
    if (!info) throw new IntegrationError('Connection not found', 404);
    try {
      const who = await this.identify(info.provider, (r?: boolean) => this.token(id, r));
      this.repo.setStatus(id, 'connected', null, who.label);
    } catch (e) {
      const ie = e instanceof IntegrationError ? e : new IntegrationError(String((e as Error).message ?? e), 0);
      this.repo.setStatus(id, ie.auth ? 'expired' : 'error', ie.message);
    }
    this.changed();
    return this.state().connections.find((c) => c.id === id)!;
  }

  /** Forget the connection and its stored tokens. It is not revoked at the provider (the UI says where to). */
  disconnect(id: string): void {
    if (!this.repo.get(id)) throw new IntegrationError('Connection not found', 404);
    this.vault.delete(this.connKey(id));
    this.repo.delete(id);
    this.changed();
  }

  setGrants(id: string, botIds: string[]): IntegrationInfo {
    if (!this.repo.get(id)) throw new IntegrationError('Connection not found', 404);
    this.repo.setGrants(id, botIds);
    this.changed();
    return this.state().connections.find((c) => c.id === id)!;
  }

  pruneGrants(liveBotIds: string[]) {
    if (this.repo.pruneGrants(liveBotIds)) this.changed();
  }

  // ---------------------------------------------------------------- credentials + clients
  /**
   * The access token for a connection, refreshed when it is about to expire or when `refresh` is set (after
   * a 401). Concurrent callers share one refresh. A refused refresh marks the connection `expired`.
   */
  async token(id: string, refresh = false): Promise<string> {
    const entry = this.vault.get(this.connKey(id));
    if (!entry?.accessToken) throw new IntegrationError('This connection has no stored credential; reconnect it in Settings → Integrations', 401, true);
    const exp = Number(entry.expiresAt) || 0;
    const due = refresh || (exp > 0 && exp - REFRESH_SKEW_MS <= this.now());
    if (!due || !entry.refreshToken) return entry.accessToken;
    const running = this.refreshing.get(id);
    if (running) return running;
    const job = (async () => {
      const info = this.repo.get(id);
      if (!info) throw new IntegrationError('Connection not found', 404);
      try {
        const { spec, app } = this.requireApp(info.provider);
        const ts = await refreshTokens(this.fetch, spec, app, entry.refreshToken, this.now());
        this.vault.patch(this.connKey(id), {
          accessToken: ts.accessToken,
          refreshToken: ts.refreshToken ?? entry.refreshToken,
          expiresAt: ts.expiresAt ? String(ts.expiresAt) : '',
        });
        return ts.accessToken;
      } catch (e) {
        const ie = e instanceof IntegrationError ? e : new IntegrationError(String((e as Error).message ?? e), 0);
        this.repo.setStatus(id, ie.auth ? 'expired' : 'error', 'Token refresh failed: ' + ie.message);
        this.changed();
        throw new IntegrationError('Token refresh failed: ' + ie.message, 401, true);
      } finally {
        this.refreshing.delete(id);
      }
    })();
    this.refreshing.set(id, job);
    return job;
  }

  /**
   * A client for a connected provider. **This is the entry point P5 pollers use** (see
   * docs/specs/integrations-client-api.md). It reads the credential per call, so it never goes stale.
   */
  client<P extends IntegrationProvider>(p: P): IntegrationClients[P] {
    const info = this.repo.byProvider(p);
    if (!info) throw new IntegrationError(label(p) + ' is not connected', 404);
    const id = info.id;
    return new CLIENTS[p]({
      fetch: this.fetch,
      token: (r) => this.token(id, r),
      appToken: async () => this.vault.get(this.connKey(id))?.appToken ?? null,
    }) as IntegrationClients[P];
  }

  /** Run one call through a provider's client; a refused credential marks the connection `expired`. */
  async run<P extends IntegrationProvider, T>(p: P, fn: (c: IntegrationClients[P]) => Promise<T>): Promise<T> {
    const c = this.client(p);
    try {
      const out = await fn(c);
      const info = this.repo.byProvider(p);
      if (info && info.status !== 'connected') {
        this.repo.setStatus(info.id, 'connected', null);
        this.changed();
      }
      return out;
    } catch (e) {
      const info = this.repo.byProvider(p);
      if (info && e instanceof IntegrationError && e.auth && info.status !== 'expired') {
        this.repo.setStatus(info.id, 'expired', e.message);
        this.changed();
      }
      throw e;
    }
  }
}

export function label(p: IntegrationProvider): string {
  return { github: 'GitHub', google: 'Google', slack: 'Slack', clickup: 'ClickUp', teams: 'Microsoft Teams' }[p];
}
