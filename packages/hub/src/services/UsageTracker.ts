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

export class UsageTracker {
  constructor(private repos: Repos) {}
  record(botId: string, roomId: string, turnId: string, causeId: string | null, u: TurnUsage) {
    this.repos.recordUsage({ botId, roomId, turnId, causeId, ...u });
    events.emitEvent({ type: 'usage.updated', botId, roomId, totals: this.repos.usageTotals({ botId, roomId }) });
  }
  causeCost(causeId: string) {
    return this.repos.usageTotals({ causeId }).costUsd;
  }
}
