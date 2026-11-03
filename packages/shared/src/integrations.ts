// P4: integrations (GitHub, Google, Slack, ClickUp, Teams). The hub holds every credential in its
// IntegrationVault; the UI and the bots only ever see the shapes below, which carry no secret.
import { z } from 'zod';

export const INTEGRATION_PROVIDERS = ['github', 'google', 'slack', 'clickup', 'teams'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** How a connection was made: the user's own OAuth app, or a pasted key/token. */
export type IntegrationMethod = 'oauth' | 'token';

/**
 * `connected`: the last call worked. `error`: the last test or tool call failed for a reason other than auth.
 * `expired`: the provider refused the credential (revoked, refresh failed); the user must reconnect.
 */
export type IntegrationStatus = 'connected' | 'error' | 'expired';

/** One shared connection (decision Q7: shared at the account level, opt-in per bot). */
export interface IntegrationInfo {
  id: string;
  provider: IntegrationProvider;
  method: IntegrationMethod;
  /** Account name as the provider reports it (an email, a login, a workspace). The UI masks it. */
  accountLabel: string;
  scopes: string[];
  status: IntegrationStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  /** Bots granted this connection. A bot without a grant does not get the provider's tools at all. */
  botIds: string[];
  /** Provider-specific notes worth showing, e.g. a fine-grained GitHub PAT cannot read notifications. */
  warnings: string[];
  /** Slack only: whether an `xapp-` app-level token (Socket Mode, used by P5 triggers) is stored. */
  hasAppToken?: boolean;
}

/** The user's own OAuth app for a provider. The secret is never sent back, only whether one is stored. */
export interface OAuthAppStatus {
  configured: boolean;
  /** The client id is not secret; shown so the user can tell which app is saved. */
  clientId: string | null;
  hasSecret: boolean;
  /** Microsoft only: tenant id or `common` / `organizations` / `consumers`. */
  tenant: string | null;
}

/** A browser or device-code sign-in the hub is waiting on. */
export interface PendingConnect {
  provider: IntegrationProvider;
  kind: 'browser' | 'device';
  startedAt: number;
  expiresAt: number;
  /** Device flow only: the code to type at `verificationUri`. */
  userCode?: string;
  verificationUri?: string;
  /** Set when a device flow ended in an error the user should see (denied, expired). */
  error?: string;
}

export interface IntegrationsState {
  connections: IntegrationInfo[];
  apps: Record<IntegrationProvider, OAuthAppStatus>;
  pending: PendingConnect[];
  /** `http://<host>/oauth/callback/<provider>` for each provider, as this hub would send it. */
  redirectUris: Record<IntegrationProvider, string>;
}

// ---------- REST bodies ----------
export const OAuthAppInputSchema = z.object({
  clientId: z.string().trim().min(4).max(300),
  /** Optional: Microsoft public clients and GitHub device flow need none. Empty keeps the stored secret. */
  clientSecret: z.string().trim().max(500).optional(),
  tenant: z.string().trim().regex(/^[A-Za-z0-9.-]{1,100}$/).optional(),
});
export type OAuthAppInput = z.infer<typeof OAuthAppInputSchema>;

export const TokenConnectSchema = z.object({
  /** GitHub PAT, Slack `xoxb-` bot token or ClickUp `pk_` token. Optional only to update `appToken` alone. */
  token: z.string().trim().max(2000).optional(),
  /** Slack only: the `xapp-` app-level token. */
  appToken: z.string().trim().max(2000).optional(),
});
export type TokenConnectInput = z.infer<typeof TokenConnectSchema>;

export const IntegrationGrantsSchema = z.object({ botIds: z.array(z.string()).max(200) });
