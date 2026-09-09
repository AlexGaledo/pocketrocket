import { z } from 'zod';

// ---------- Providers (global choice) ----------
// The hub runs every bot through ONE provider at a time (settings.provider). Models are chosen per bot
// from that provider's list. Adapters live in packages/hub/src/providers/.

export const PROVIDER_IDS = ['claude', 'codex', 'opencode', 'grok'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ModelInfo {
  id: string;
  label: string;
  /** Short note shown next to the label: "cheapest", "strongest", pricing hint. */
  note?: string;
  default?: boolean;
}

export type ProviderAuth = 'subscription' | 'apiKey' | 'none' | 'unknown';

export interface ProviderCheck {
  ok: boolean;
  /** CLI / SDK version string when detectable. */
  version?: string;
  auth: ProviderAuth;
  /** Logged-in account, when the provider exposes it. */
  account?: string;
  /** Why the check failed (missing CLI, not logged in, no API key). */
  error?: string;
  /** What the user should do next: install command, login command, where to get a key. Markdown, 1-3 lines. */
  hint?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** One-liner for the picker card. */
  blurb: string;
  /** How this provider authenticates; drives which fields the settings UI shows. */
  authModes: ProviderAuth[];
  /** Secret keys this provider can use (env var names); settings UI offers an input for each. */
  secretKeys: string[];
  /** Approval-card parity: 'full' = every out-of-workspace/dangerous op is intercepted; 'best-effort' = provider sandbox + request_approval tool. */
  permissions: 'full' | 'best-effort';
  /**
   * 'verified' = driven end to end against the real CLI, live login and all. 'untested' = written to the
   * CLI's documented contract and covered by fixtures, but never run against a real account, so the
   * picker says as much rather than presenting it as a peer of the two that were.
   */
  maturity: 'verified' | 'untested';
  check: ProviderCheck;
  models: ModelInfo[];
}

/** GET /api/providers */
export interface ProvidersResponse {
  active: ProviderId;
  providers: ProviderInfo[];
}

// ---------- Settings (global, stored in the `settings` table) ----------
export const SettingsSchema = z.object({
  provider: z.enum(PROVIDER_IDS).default('claude'),
  /** Default model id for new bots (must belong to `provider`). */
  defaultModel: z.string().default('claude-sonnet-5'),
  /** How bots address the human. */
  userName: z.string().min(1).max(40).default('you'),
  sounds: z.boolean().default(true),
  onboarded: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** PUT /api/settings body: any subset. Response: full Settings. Emits WS `settings.changed`. */
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/**
 * Secrets are never returned by the API; GET /api/secrets returns only which keys are set.
 * PUT /api/secrets { XAI_API_KEY: '...' } sets; empty string clears. Stored in <data>/secrets.json (env vars override).
 */
export const SecretsPatchSchema = z.record(z.string(), z.string());
export interface SecretsStatus { keys: Record<string, boolean> }

/** POST /api/providers/:id/check → ProviderCheck (re-runs the detection, e.g. after the user logs in). */
