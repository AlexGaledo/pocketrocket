import crypto from 'node:crypto';
import type { IntegrationProvider } from '@pocketrocket/shared';
import { apiRequest, IntegrationError, type Fetch } from './http.js';

/** The user's own OAuth app (decision Q4: no PocketRocket-owned apps). */
export interface OAuthApp {
  clientId: string;
  clientSecret?: string;
  tenant?: string;
}

/**
 * How one provider does OAuth (docs/research/oauth-loopback.md). Slack is absent on purpose: its loopback
 * flow needs PKCE, and PKCE blocks bot scopes, so Slack connects by pasting tokens.
 */
export interface OAuthSpec {
  authorizeUrl(app: OAuthApp): string;
  tokenUrl(app: OAuthApp): string;
  scopes: string[];
  /** S256 PKCE. ClickUp does not support it; the state check still applies. */
  pkce: boolean;
  /** Extra authorize parameters. */
  extra?: Record<string, string>;
  /**
   * Host in the redirect URI. Microsoft public clients register `http://localhost/...` and ignore the port;
   * Google Desktop clients accept `http://127.0.0.1:<any port>`; GitHub accepts a different port at runtime.
   */
  redirectHost: '127.0.0.1' | 'localhost';
  /** Device authorization grant (RFC 8628), for a hub on a VPS where the browser cannot reach the loopback. */
  device?: { codeUrl(app: OAuthApp): string; tokenUrl(app: OAuthApp): string };
  /** Whether the token endpoint takes the scope on refresh (Microsoft does). */
  scopeOnRefresh?: boolean;
  /** Microsoft: public client, never send a secret even if one was pasted. */
  publicClient?: boolean;
}

const ms = (app: OAuthApp) => 'https://login.microsoftonline.com/' + encodeURIComponent(app.tenant || 'common') + '/oauth2/v2.0/';

export const OAUTH: Partial<Record<IntegrationProvider, OAuthSpec>> = {
  github: {
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    tokenUrl: () => 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'notifications', 'read:user'],
    pkce: true,
    redirectHost: '127.0.0.1',
    device: { codeUrl: () => 'https://github.com/login/device/code', tokenUrl: () => 'https://github.com/login/oauth/access_token' },
  },
  google: {
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid', 'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    pkce: true,
    // Without both, Google hands out no refresh token (or only on the very first consent).
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    redirectHost: '127.0.0.1',
  },
  clickup: {
    // Unverified: whether ClickUp accepts a loopback redirect. Pasting a pk_ token is the default.
    authorizeUrl: () => 'https://app.clickup.com/api',
    tokenUrl: () => 'https://api.clickup.com/api/v2/oauth/token',
    scopes: [],
    pkce: false,
    redirectHost: '127.0.0.1',
  },
  teams: {
    authorizeUrl: (app) => ms(app) + 'authorize',
    tokenUrl: (app) => ms(app) + 'token',
    // Channel messages (ChannelMessage.Read.All) need admin consent; chats do not.
    scopes: ['offline_access', 'User.Read', 'Chat.ReadWrite', 'ChatMessage.Send'],
    pkce: true,
    redirectHost: 'localhost',
    device: { codeUrl: (app) => ms(app) + 'devicecode', tokenUrl: (app) => ms(app) + 'token' },
    scopeOnRefresh: true,
    publicClient: true,
  },
};

export const supportsOAuth = (p: IntegrationProvider) => !!OAUTH[p];
export const supportsDevice = (p: IntegrationProvider) => !!OAUTH[p]?.device;

/** 256 bits of randomness, base64url. Used for `state` and the PKCE verifier. */
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
/** RFC 7636 S256: base64url(sha256(verifier)). */
export const pkceChallenge = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export function authorizeUrl(spec: OAuthSpec, app: OAuthApp, o: { redirectUri: string; state: string; verifier: string }): string {
  const u = new URL(spec.authorizeUrl(app));
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('state', o.state);
  u.searchParams.set('response_type', 'code');
  if (spec.scopes.length) u.searchParams.set('scope', spec.scopes.join(' '));
  if (spec.pkce) {
    u.searchParams.set('code_challenge', pkceChallenge(o.verifier));
    u.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(spec.extra ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/** What every token endpoint is normalised to. `expiresAt` is ms since epoch, or null for tokens that do not expire. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
}

type RawToken = { access_token?: string; refresh_token?: string; expires_in?: number | string; scope?: string; error?: string; error_description?: string };

function normalise(t: RawToken, now: number, prevRefresh: string | null = null): TokenSet {
  if (!t.access_token) throw new IntegrationError('No access token in the answer' + (t.error ? ': ' + (t.error_description ?? t.error) : ''), 400, true);
  const exp = Number(t.expires_in);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? prevRefresh,
    expiresAt: Number.isFinite(exp) && exp > 0 ? now + exp * 1000 : null,
    scopes: (t.scope ?? '').split(/[ ,]+/).filter(Boolean),
  };
}

/** POST to a token endpoint. GitHub answers 200 with an `error` field, so both shapes are checked. */
async function tokenRequest(fetchFn: Fetch, url: string, form: Record<string, string>): Promise<RawToken> {
  const r = await apiRequest<RawToken>(fetchFn, url, { form, allow: [400, 401] });
  const d = r.data ?? {};
  if (r.status >= 400 || d.error) {
    const err = d.error ?? 'http_' + r.status;
    const e = new IntegrationError('Token endpoint refused: ' + err + (d.error_description ? ' (' + d.error_description + ')' : ''), r.status, err === 'invalid_grant' || err === 'invalid_client' || r.status === 401);
    (e as IntegrationError & { code?: string }).code = err;
    throw e;
  }
  return d;
}

const clientAuth = (spec: OAuthSpec, app: OAuthApp): Record<string, string> =>
  ({ client_id: app.clientId, ...(app.clientSecret && !spec.publicClient ? { client_secret: app.clientSecret } : {}) });

/** Authorization code → tokens. The verifier proves this hub started the flow (PKCE). */
export async function exchangeCode(fetchFn: Fetch, spec: OAuthSpec, app: OAuthApp, o: { code: string; redirectUri: string; verifier: string }, now = Date.now()): Promise<TokenSet> {
  const form: Record<string, string> = { ...clientAuth(spec, app), grant_type: 'authorization_code', code: o.code, redirect_uri: o.redirectUri };
  if (spec.pkce) form.code_verifier = o.verifier;
  if (spec.scopeOnRefresh) form.scope = spec.scopes.join(' ');
  return normalise(await tokenRequest(fetchFn, spec.tokenUrl(app), form), now);
}

export async function refreshTokens(fetchFn: Fetch, spec: OAuthSpec, app: OAuthApp, refreshToken: string, now = Date.now()): Promise<TokenSet> {
  const form: Record<string, string> = { ...clientAuth(spec, app), grant_type: 'refresh_token', refresh_token: refreshToken };
  if (spec.scopeOnRefresh) form.scope = spec.scopes.join(' ');
  return normalise(await tokenRequest(fetchFn, spec.tokenUrl(app), form), now, refreshToken);
}

export interface DeviceStart { deviceCode: string; userCode: string; verificationUri: string; intervalSec: number; expiresInSec: number }

export async function startDevice(fetchFn: Fetch, spec: OAuthSpec, app: OAuthApp): Promise<DeviceStart> {
  if (!spec.device) throw new IntegrationError('This provider has no device sign-in', 400);
  const r = await apiRequest<{ device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number }>(
    fetchFn, spec.device.codeUrl(app), { form: { client_id: app.clientId, scope: spec.scopes.join(' ') } },
  );
  return {
    deviceCode: r.data.device_code, userCode: r.data.user_code, verificationUri: r.data.verification_uri,
    intervalSec: r.data.interval ?? 5, expiresInSec: r.data.expires_in ?? 900,
  };
}

/** One poll of a device grant: tokens, or `pending` / `slow_down` to keep waiting. Anything else throws. */
export async function pollDevice(fetchFn: Fetch, spec: OAuthSpec, app: OAuthApp, deviceCode: string, now = Date.now()): Promise<TokenSet | 'pending' | 'slow_down'> {
  try {
    const raw = await tokenRequest(fetchFn, spec.device!.tokenUrl(app), {
      ...clientAuth(spec, app), device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    return normalise(raw, now);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'authorization_pending') return 'pending';
    if (code === 'slow_down') return 'slow_down';
    throw e;
  }
}
