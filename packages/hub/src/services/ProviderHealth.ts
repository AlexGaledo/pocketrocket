import type { ProviderId, ProviderLimitState } from '@pocketrocket/shared';
import type { LimitReport, TurnLimit } from '../providers/types.js';

/** How long a limit with no reset time is held, and a warning with none is shown. */
export const DEFAULT_HOLD_MS = 10 * 60_000;

export interface ProviderHealthDeps {
  /** Injected so tests can move the clock. */
  now?: () => number;
  /** Called with every limit in force whenever the list changes (hub.ts sends it as the WS `provider.limit` event). */
  onChange?: (limits: ProviderLimitState[]) => void;
}

/**
 * Claude's weekly Opus and Sonnet windows cover one model only; every other window covers the whole login. The hold
 * is keyed by the model that hit it then, so a Sonnet bot keeps running while Opus is limited.
 */
export function limitModel(window: string | undefined, model: string | undefined): string | undefined {
  if (!model || !window) return undefined;
  const m = /_(opus|sonnet)$/.exec(window);
  return m && model.toLowerCase().includes(m[1]) ? model : undefined;
}

/**
 * M5 (spec 01 P0-2): which providers, or which of their models, are at a usage limit right now, and which are close.
 * In memory only: a restart forgets every hold, and the next turn finds out again. Expired entries drop out when read,
 * so nothing needs a timer.
 */
export class ProviderHealth {
  private entries = new Map<string, ProviderLimitState>();
  private now: () => number;

  constructor(private deps: ProviderHealthDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  /** A `rate_limit_event` (or any provider's report) from a running turn. `model` is the model that turn ran. */
  report(provider: ProviderId, r: LimitReport, model?: string) {
    const scope = limitModel(r.window, model);
    if (r.status === 'rejected') {
      this.hold(provider, { kind: r.kind, resetsAt: r.resetsAt, window: r.window }, model, r.utilization);
      return;
    }
    const k = key(provider, scope, r.window);
    if (r.status === 'allowed') {
      // Fine again: a warning or a hold on this window ends early (a reset came sooner, or extra usage was turned on).
      if (this.entries.delete(k)) this.changed();
      return;
    }
    const at = this.now();
    // A warning never replaces a hold still in force on the same window.
    const cur = this.live(k);
    if (cur?.status === 'held') return;
    this.entries.set(k, {
      provider, ...(scope ? { model: scope } : {}), status: 'warning', kind: r.kind, window: r.window,
      resetsAt: r.resetsAt, until: r.resetsAt && r.resetsAt > at ? r.resetsAt : at + DEFAULT_HOLD_MS,
      utilization: r.utilization, at,
    });
    this.changed();
  }

  /**
   * A turn ended on a limit. Only `usage` is held: an overload or an outage has no reset time worth waiting for, and a
   * sign-in problem is the provider check's to report.
   */
  hold(provider: ProviderId, limit: TurnLimit, model?: string, utilization?: number) {
    if (limit.kind !== 'usage') return;
    const at = this.now();
    const scope = limitModel(limit.window, model);
    this.entries.set(key(provider, scope, limit.window), {
      provider, ...(scope ? { model: scope } : {}), status: 'held', kind: 'usage', window: limit.window,
      resetsAt: limit.resetsAt, until: limit.resetsAt && limit.resetsAt > at ? limit.resetsAt : at + DEFAULT_HOLD_MS,
      ...(utilization !== undefined ? { utilization } : {}), at,
    });
    this.changed();
  }

  /** The hold that stops `provider` (or `model` on it) right now, or undefined. A provider-wide hold covers every model. */
  heldFor(provider: ProviderId, model?: string): ProviderLimitState | undefined {
    return this.list().find((l) => l.status === 'held' && l.provider === provider && (!l.model || l.model === model));
  }

  isHeld(provider: ProviderId, model?: string): boolean {
    return !!this.heldFor(provider, model);
  }

  /** Every limit and warning in force, soonest reset first. */
  list(): ProviderLimitState[] {
    const t = this.now();
    for (const [k, v] of this.entries) if (v.until <= t) this.entries.delete(k);
    return [...this.entries.values()].sort((a, b) => a.until - b.until);
  }

  private live(k: string): ProviderLimitState | undefined {
    const v = this.entries.get(k);
    return v && v.until > this.now() ? v : undefined;
  }

  private changed() {
    this.deps.onChange?.(this.list());
  }
}

function key(provider: ProviderId, model: string | undefined, window: string | undefined): string {
  return provider + '|' + (model ?? '') + '|' + (window ?? '');
}
