import type { CauseKind } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';

export interface TurnUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelUsage: unknown;
  durationMs: number;
}

/** P8: which model ran, why the router picked it, and what started the turn. */
export interface UsageMeta {
  model?: string;
  routeReason?: string;
  causeKind?: CauseKind;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageTrackerDeps {
  /** $ threshold for the rolling-24h alert. 0 (the default) turns it off. Read live, not cached. */
  alertThresholdUsd?: () => number;
}

export class UsageTracker {
  /** botId -> when it was last alerted, so one crossing posts once per rolling day, not once per turn. */
  private lastAlertAt = new Map<string, number>();
  constructor(private repos: Repos, private deps: UsageTrackerDeps = {}) {}
  record(botId: string, roomId: string, turnId: string, causeId: string | null, u: TurnUsage, meta: UsageMeta = {}) {
    this.repos.recordUsage({ botId, roomId, turnId, causeId, ...u, ...meta });
    events.emitEvent({ type: 'usage.updated', botId, roomId, totals: this.repos.usageTotals({ botId, roomId }) });
    this.checkDailyAlert(botId, roomId);
  }
  causeCost(causeId: string) {
    return this.repos.usageTotals({ causeId }).costUsd;
  }
  /** Visibility only: never throttles the turn that triggered it (spend caps are off by design). */
  private checkDailyAlert(botId: string, roomId: string) {
    const threshold = this.deps.alertThresholdUsd?.() ?? 0;
    if (!threshold) return;
    const nowMs = Date.now();
    const lastAlert = this.lastAlertAt.get(botId) ?? 0;
    if (nowMs - lastAlert < DAY_MS) return;
    const spentUsd = this.repos.usageTotals({ botId, sinceMs: nowMs - DAY_MS }).costUsd;
    if (spentUsd < threshold) return;
    this.lastAlertAt.set(botId, nowMs);
    const bot = this.repos.getBot(botId);
    if (!bot || !this.repos.getRoom(roomId)) return;
    const msg = this.repos.insertMessage({
      roomId, authorType: 'system', authorId: botId, kind: 'system',
      text: '@' + bot.handle + ' has spent $' + spentUsd.toFixed(2) + ' in the last 24h, over the $' +
        threshold.toFixed(2) + ' alert threshold. Visibility only, nothing was throttled.',
      payload: null, causeId: null, hop: 0, turnId: null,
    });
    events.emitEvent({ type: 'message.new', message: msg });
  }
}
