import { z } from 'zod';
import { MAX_AVATAR_LENGTH, SEND_MODES, isMediaRef } from './models.js';

// ---------- Providers (per bot) ----------
// Each bot runs on its own provider (`Bot.provider`), or on the default one (settings.provider) when it names none.
// Models are chosen per bot from its provider's list. Adapters live in packages/hub/src/providers/.

// 'gemini' (M7) is Google's Antigravity CLI (`agy acp`) through the generic ACP adapter. Opt-in until the owner's live test.
export const PROVIDER_IDS = ['claude', 'codex', 'opencode', 'grok', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ModelInfo {
  id: string;
  label: string;
  /** Short note shown next to the label: "cheapest", "strongest", pricing hint. */
  note?: string;
  default?: boolean;
}

/**
 * Model ids a provider no longer offers, and the id that replaced each. Read-time only: a stored bot (or backup) on an
 * old id reads as the new one, and the next save writes it. The ids are unique to their provider, so no provider
 * check is needed. Gemini's first list was a guess made before the live test (P2-4); agy 1.5.12 offers other ids.
 */
export const RENAMED_MODELS: Readonly<Record<string, string>> = {
  'gemini-default': 'gemini-3.1-pro',
  'gemini-3-pro': 'gemini-3.1-pro',
  'gemini-3-flash': 'gemini-3.8-flash',
};

/** `id`, or what replaced it. */
export function currentModelId(id: string): string {
  return Object.hasOwn(RENAMED_MODELS, id) ? RENAMED_MODELS[id] : id;
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
  /**
   * M7: the installed CLI's version is outside the range Toki was tested with, or could not be read. A
   * warning only: the provider still runs. Absent when the version is a tested one (or the provider has no range).
   */
  versionWarning?: string;
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
  /** M7: the CLI versions this adapter was tested with, ready to show ("1.4-1.6"). Absent = no range recorded yet. */
  testedVersions?: string;
  /**
   * A message sent to a busy bot can join its running turn (steering). Claude: true once the installed CLI has
   * reported the `interrupt_receipt_v1` capability, so false until its first turn. Other providers: false, and a
   * message to a busy bot waits in the queue. Absent from hubs older than steering: treat as false.
   */
  steer?: boolean;
  check: ProviderCheck;
  models: ModelInfo[];
}

/** What every adapter declares up front; `steer`, `check` and `models` are filled in live. */
export type ProviderStaticInfo = Omit<ProviderInfo, 'check' | 'models' | 'steer'>;

/**
 * Why a provider stopped answering (spec 01 §4.3). `usage` = a plan or rate limit with a reset time, `overloaded` = the
 * provider is busy, `down` = unreachable, `auth` = signed out. Only `usage` is held by the hub (ProviderHealth).
 */
export const PROVIDER_LIMIT_KINDS = ['usage', 'overloaded', 'down', 'auth'] as const;
export type ProviderLimitKind = (typeof PROVIDER_LIMIT_KINDS)[number];

/**
 * A provider, or one of its models, that hit a limit or is close to one. Kept in memory by the hub (never persisted,
 * so a restart forgets it). Sent in `GET /api/providers` → `limits` and the WS `provider.limit` event.
 */
export interface ProviderLimitState {
  provider: ProviderId;
  /** Set when the limit covers one model only (Claude's weekly Opus or Sonnet limit). Absent = the whole provider. */
  model?: string;
  /**
   * `held` = it refused a turn at its limit, and turns on it are expected to fail until `until` (the hub does not block
   * them yet). `warning` = still running, close to the limit.
   */
  status: 'held' | 'warning';
  kind: ProviderLimitKind;
  /** The provider's own window id. Claude: five_hour, seven_day, seven_day_opus, seven_day_sonnet, overage, ... */
  window?: string;
  /** When the provider says the window resets, ms since epoch. Absent when it did not say. */
  resetsAt?: number;
  /** When this entry stops applying, ms since epoch: `resetsAt`, or a short default when the provider gave none. */
  until: number;
  /** How much of the window is used, exactly as the provider reports it (Claude: believed 0..1, not yet confirmed on Max). */
  utilization?: number;
  /** When the hub recorded it, ms since epoch. */
  at: number;
}

// ---------- Failover card (M8, spec 01 §4.7 / P3-1) ----------
/**
 * A bot hit its provider's usage limit and has a backup: the owner may continue the request on the backup, once, or
 * wait for the reset. Person-only (no bot, cta button or chat text answers it); expires at `expiresAt`, after which a
 * quiet note says it was not continued. Persisted, so it survives a restart.
 */
export interface FailoverCard {
  id: string;
  botId: string;
  /** The chat the limited turn ran in; the card belongs there and in Needs you. */
  roomId: string;
  /** The provider (and model) that hit its limit. */
  provider: ProviderId;
  model?: string;
  /** The provider's own window id (`five_hour`, `seven_day`, ...), when it said. */
  window?: string;
  /** What "Continue" runs on: the bot's backup when the card was raised. */
  backup: { provider: ProviderId; model: string };
  /** When the limit resets, if the provider said. */
  resetsAt?: number;
  /** When the card stops being answerable: `resetsAt`, or a short default when the provider gave none. */
  expiresAt: number;
  createdAt: number;
  /** `pending` until answered; `continued` (pressed Continue), `waited` (pressed Wait) or `expired` (nobody answered). */
  status: 'pending' | 'continued' | 'waited' | 'expired';
}
/** A bot whose attended turns run on its backup until `until`, because the owner pressed Continue (the "On Gemini until 14:00" badge). */
export interface FailoverActive {
  botId: string;
  /** The provider that is limited. */
  from: ProviderId;
  backup: { provider: ProviderId; model: string };
  until: number;
}
/** GET /api/failover and the WS `failover.changed` event: open cards (pending only) and bots running on their backup. */
export interface FailoverState {
  cards: FailoverCard[];
  active: FailoverActive[];
}
/** POST /api/failover-cards/:id/decision */
export const FailoverDecisionSchema = z.object({ decision: z.enum(['continue', 'wait']) });
export type FailoverDecision = z.infer<typeof FailoverDecisionSchema>;

/** GET /api/providers */
export interface ProvidersResponse {
  /** The default provider (settings.provider): what a bot with `provider: null` runs on. */
  active: ProviderId;
  providers: ProviderInfo[];
  /** Limits and warnings in force right now (entries past `until` are left out). Absent from hubs older than v0.5. */
  limits?: ProviderLimitState[];
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
  /**
   * The default provider: new bots and every bot whose `provider` is null run on it. Changing it moves only those
   * bots; a bot with its own provider stays where it is. (Before v0.5 it was the one provider every bot ran on.)
   */
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
  /**
   * The web app's layout. 'auto' follows the default, which is the project-first layout since Toki UI phase 7;
   * 'classic' keeps the old one ("Classic layout" in Settings > Appearance). Stored here so the choice follows the
   * owner from browser to browser. A paired phone keeps the classic layout whatever this says.
   */
  layout: z.enum(['auto', 'toki', 'classic']).default('auto'),
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
  /**
   * Bridge P7: run each Claude turn's tools inside a bubblewrap sandbox (Linux servers). `on` fails closed when bubblewrap
   * is unusable, and it lifts the P5 sync refusal for client repos. Only the REST API writes it, so no bot can turn it off.
   */
  sandbox: z.enum(['off', 'on']).default('off'),
  /**
   * $ a bot may spend in a rolling 24h window before a one-line alert posts to the room its turn is running
   * in. Visibility only: it never stops or throttles the turn (spend caps are off, see spendCapsOff). 0 turns
   * the alert off.
   */
  spendAlertThresholdUsd: z.number().min(0).max(1000).default(5),
  /**
   * Steering: what a message to a busy bot does when the sender did not pick (`message.send.mode` left out).
   * `join` = it joins the running turn where the provider can; `queue` = it waits for the turn to end.
   */
  busyMessages: z.enum(SEND_MODES).default('join'),
  /** Bridge P6: the model a moved PC session's turns run on at the VPS. Only the REST API writes it. */
  offloadModel: z.string().min(1).max(80).default('claude-sonnet-5-5'),
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
