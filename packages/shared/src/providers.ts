import { z } from 'zod';
import { MAX_AVATAR_LENGTH, isMediaRef } from './models.js';

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
  /**
   * Subscription plan behind the login, ready to show ("Max", "Pro", "Team"). The desktop app reads this exact
   * field from POST /api/providers/claude/check, so it keeps this name.
   */
  plan?: string;
  /** How the CLI says it signed in ("claude.ai", "console"), when it says. */
  authMethod?: string;
  /** Organization the login belongs to, when the provider exposes it. */
  orgName?: string;
  /** The CLI binary the check looked for, so a "not found" message can say where it looked. */
  exePath?: string;
  /**
   * The binary exists but did not answer in time (a cold start, an antivirus scan, a busy disk). It is
   * installed, so the fix is to check again, not to reinstall.
   */
  unresponsive?: boolean;
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
/**
 * 'read-only' = nothing writes: file edits, shell commands not on the safe/read allowlist, fleet/room/routine
 * changes and integration sends are all refused with no card, not even asked. 'ask' = the approval flow:
 * anything outside the workspace, risky shell commands and fleet changes raise a card. 'bypass' = no cards
 * at all. `POCKETROCKET_BYPASS_PERMISSIONS` on the hub overrides the stored value and locks it to 'ask' or
 * 'bypass' (GET /api/health → `approvalsLocked`); it has no read-only setting.
 */
export const APPROVALS = ['read-only', 'ask', 'bypass'] as const;
export type Approvals = (typeof APPROVALS)[number];

/** True for a time zone this runtime knows (`Asia/Manila`, `UTC`, …). */
export function isTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const SettingsSchema = z.object({
  provider: z.enum(PROVIDER_IDS).default('claude'),
  /** Default model for new bots: `auto`, or an id that belongs to `provider`. */
  defaultModel: z.string().default('auto'),
  /** How bots address the human. */
  userName: z.string().min(1).max(40).default('you'),
  /** The human's picture (an uploaded reference, see isMediaRef), or '' for their initial. */
  userAvatar: z.string().max(MAX_AVATAR_LENGTH).refine((v) => v === '' || isMediaRef(v), 'not an uploaded picture').default(''),
  sounds: z.boolean().default(true),
  onboarded: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  font: z.enum(['google-sans', 'figtree']).default('google-sans'),
  /** Read per turn, so a change applies from the next turn. Only the REST API writes it; no bot tool can. */
  approvals: z.enum(APPROVALS).default('ask'),
  /**
   * Retired: Auto decides inside the turn, with no call before it. Kept so saved settings still parse; nothing reads it.
   */
  routerClassifier: z.boolean().default(false),
  // ---- P3: routines v2 ----
  /**
   * IANA time zone routines are scheduled in (and the one the UI shows times in). The hub fills in the
   * system zone until the user picks one, the way it fills in `userName`.
   */
  timezone: z.string().max(64).refine(isTimeZone, 'not a known IANA time zone').default('UTC'),
  // ---- P7: knowledge repo ----
  /**
   * A git URL (https://, ssh://, git@host:path, file://) cloned to `data/knowledge`, or an absolute local
   * folder linked there. Every bot reads it; none can write it. Empty = off. Validated by the hub.
   */
  knowledgeRepo: z.string().max(500).default(''),
  /** The bots shown large above the sidebar's bot list, in order. Ids of deleted bots are ignored when read. */
  podiumBotIds: z.array(z.string().max(64)).max(3).default([]),
  /**
   * The one bot that gets `read_owner_messages`, or '' for none. Only the REST API writes it, so no bot can grant
   * itself the owner's messages from every chat.
   */
  personaBotId: z.string().max(64).default(''),
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
