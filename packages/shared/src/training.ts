import { z } from 'zod';

// ---------------------------------------------------------------------------------------------------
// Bot training pilot: per bot, learn from its own failures, propose one small rule, have an independent verifier
// check it, and let the owner decide. Nothing reaches a bot without the owner's Approve.

/** Sunday 03:00, read in the owner's `settings.timezone`. */
export const TRAINING_CRON = '0 3 * * 0';
/**
 * Most one pass (proposer plus verifier) may spend: two calls at the size of REFLECTION_PASS_BUDGET_USD ($0.05).
 * Spending stops at the CLI's own check, so one call can run slightly over; the weekly cap counts what it really cost.
 */
export const TRAINING_PASS_BUDGET_USD = 0.1;
/** Most one bot's passes may spend in any 7 days. Same size as REFLECTION_DAILY_CAP's default and DISTILL_BUDGET_USD. */
export const TRAINING_WEEKLY_CAP_USD = 0.25;
/** The longest rule a proposal may carry. */
export const TRAINING_RULE_MAX_CHARS = 300;
/** The most evidence one pass reads; the newest items are kept. */
export const TRAINING_EVIDENCE_MAX_CHARS = 20_000;
/** A bot with this many proposals waiting skips its pass, so nothing is spent while nobody is reviewing. */
export const MAX_TRAINING_PENDING = 10;

export type TrainingStatus = 'pending' | 'blocked' | 'approved' | 'rejected' | 'undone';

export interface TrainingProposal {
  id: string;
  botId: string;
  status: TrainingStatus;
  rule: string;
  /** The proposer's one line, citing the evidence. */
  reason: string;
  /** What the pass read, as counts. The evidence itself is not stored. */
  evidenceSummary: string;
  verifierNote: string;
  /** The description just before this rule was approved; null until then. A record: undo does not restore it. */
  descriptionBefore: string | null;
  createdAt: number;
  decidedAt: number | null;
  undoneAt: number | null;
}

/** GET /api/bots/:id/training */
export interface TrainingState {
  botId: string;
  enabled: boolean;
  /** The end of the evidence window of the last pass that finished; null before the first. */
  lastRunAt: number | null;
  proposals: TrainingProposal[];
  /** What this bot's passes cost in the last 7 days. */
  spentThisWeekUsd: number;
}

/** How a pass ended. Only `proposed` and `blocked` add a proposal; REST refuses `off` and `unavailable` with a 409. */
export type TrainingOutcome = 'off' | 'unavailable' | 'no_evidence' | 'pending_full' | 'budget' | 'failed' | 'no_change' | 'proposed' | 'blocked';

export interface TrainingPassResult {
  outcome: TrainingOutcome;
  message: string;
  proposal?: TrainingProposal;
}

export const TrainingPatchSchema = z.object({ enabled: z.boolean() });
export const TrainingDecisionSchema = z.object({ decision: z.enum(['approve', 'reject', 'undo']) });
export type TrainingDecision = z.infer<typeof TrainingDecisionSchema>['decision'];
