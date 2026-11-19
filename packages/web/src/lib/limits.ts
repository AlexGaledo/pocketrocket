// Provider limits (spec 01 P0-5): which plan windows are close to or at their limit, and how to say so. The hub sends
// the full list in GET /api/providers → `limits` and on every WS `provider.limit`; it sends nothing when an entry
// expires, so callers filter by `until` against a clock (`useLimits` re-renders at the next expiry).
import type { Bot, ProviderId, ProviderLimitState, ProvidersResponse } from '@pocketrocket/shared';

/** Entries still in force at `now`. */
export function activeLimits(limits: readonly ProviderLimitState[], now: number): ProviderLimitState[] {
  return limits.filter((l) => l.until > now);
}

/** The provider a bot runs on: its own, or the default (settings.provider) when it names none. */
export function botProvider(bot: Pick<Bot, 'provider'>, defaultProvider: ProviderId): ProviderId {
  return bot.provider ?? defaultProvider;
}

/** True when the provider signs in with an API key. Plan limits and their banner are hidden then (spec 01 P0-5). */
export function usesApiKey(providers: ProvidersResponse | null, id: ProviderId): boolean {
  return providers?.providers.find((p) => p.id === id)?.check.auth === 'apiKey';
}

/** The `held` entry that stops this bot right now, if any: its provider as a whole, or the one model it runs. */
export function heldLimitFor(bot: Pick<Bot, 'provider' | 'model'>, defaultProvider: ProviderId, limits: readonly ProviderLimitState[]): ProviderLimitState | null {
  const provider = botProvider(bot, defaultProvider);
  const hits = limits.filter((l) => l.status === 'held' && l.provider === provider && (!l.model || l.model === bot.model));
  // The longest hold is the one that decides when the bot can reply again.
  return hits.reduce<ProviderLimitState | null>((a, l) => (!a || l.until > a.until ? l : a), null);
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  overage: 'extra usage limit',
};

/** "Claude 5-hour limit", "Claude weekly Opus limit", "Codex usage limit". */
export function limitName(l: Pick<ProviderLimitState, 'window'>, providerLabel: string): string {
  return providerLabel + ' ' + ((l.window && WINDOW_LABEL[l.window]) || 'usage limit');
}

/**
 * Percent used, 0-100. Claude is believed to report 0..1 (not yet confirmed on Max), so a value above 1 is read as a
 * percentage already. A held entry with no figure is at its limit.
 */
export function limitPercent(l: Pick<ProviderLimitState, 'utilization' | 'status'>): number {
  const u = l.utilization;
  if (u == null || !Number.isFinite(u)) return l.status === 'held' ? 100 : 0;
  const pct = u > 1 ? u : u * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** "14:00" today, "Thu 14:00" within a week, "21 Nov 14:00" further out. Local time. */
export function fmtReset(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  if (ts - now < 6 * 24 * 3600_000) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
}

/** "resets 14:00", or null when the provider gave no time. */
export function resetPhrase(l: Pick<ProviderLimitState, 'resetsAt'>, now = Date.now()): string | null {
  return l.resetsAt ? 'resets ' + fmtReset(l.resetsAt, now) : null;
}
