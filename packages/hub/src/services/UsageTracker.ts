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

export class UsageTracker {
  constructor(private repos: Repos) {}
  record(botId: string, roomId: string, turnId: string, causeId: string | null, u: TurnUsage, meta: UsageMeta = {}) {
    this.repos.recordUsage({ botId, roomId, turnId, causeId, ...u, ...meta });
    events.emitEvent({ type: 'usage.updated', botId, roomId, totals: this.repos.usageTotals({ botId, roomId }) });
  }
  causeCost(causeId: string) {
    return this.repos.usageTotals({ causeId }).costUsd;
  }
}
