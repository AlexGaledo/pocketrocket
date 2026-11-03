import { z } from 'zod';

// ---------------------------------------------------------------------------------------------------
// P6: teach by demonstration and skill refinement (docs/specs/grok-bot-parity.md §2.8).

/** What a typed value in a password, card or one-time-code field is recorded as. Never the value. */
export const SECRET_PLACEHOLDER = '«secret»';

/** One recording of the user doing a task on a bot's computer (`computers/<botId>/recordings/<id>/`). */
export interface RecordingInfo {
  /** The folder name: a sortable UTC timestamp such as `2026-11-01T09-30-00-000Z`. */
  id: string;
  botId: string;
  /** What the user said they were showing (optional). */
  title: string;
  startedAt: number;
  endedAt: number | null;
  state: 'recording' | 'stopped';
  /** Trace lines written (navigations, clicks, typing, keys, downloads, windows). */
  events: number;
  /** Screenshots kept. */
  frames: number;
  /** Screenshots dropped because a secret field was focused or filled. */
  framesDropped: number;
  /** Trace plus frames on disk. */
  bytes: number;
  /** Which caps were hit: `events`, `frames`, `bytes`, `duration`. */
  capped: string[];
  /** The pending skill (or skill version) a distill produced from it, once one did. */
  skillId: string | null;
  error?: string;
}

/** GET /api/computers/:botId/recorder. */
export interface RecorderStatus {
  botId: string;
  /** False on the desktop app (local mode) and on a server without per-bot computers. */
  available: boolean;
  reason?: string;
  /** The recording in progress, if any. */
  active: RecordingInfo | null;
}

/** One line of a recording's trace.jsonl. `ts` is ms since the recording started. */
export interface TraceEvent {
  ts: number;
  t: 'start' | 'nav' | 'click' | 'type' | 'change' | 'key' | 'submit' | 'download' | 'window' | 'frame' | 'cap' | 'stop';
  [k: string]: unknown;
}

export type SkillVersionOrigin = 'demo' | 'correction' | 'reflection' | 'bot';
export type SkillVersionStatus = 'pending' | 'approved' | 'rejected';

/** A proposed revision of a pool skill. It changes nothing until the user approves it. */
export interface SkillVersion {
  id: string;
  /** The pool skill it revises. */
  skillId: string;
  version: number;
  status: SkillVersionStatus;
  origin: SkillVersionOrigin;
  /** The correction text, or the reflection's one-line reason. */
  note: string;
  createdByBot: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

export interface SkillVersionDetail extends SkillVersion {
  markdown: string;
  /** The live SKILL.md this version was proposed against. */
  base: string;
  /** Line diff base → markdown. */
  diff: DiffLine[];
  /** True when the live skill changed after this version was proposed (approving replaces it whole). */
  stale: boolean;
}

/** Per-bot opt-in post-run reflection (6.3). Off by default. */
export interface SkillReflectionConfig {
  botId: string;
  enabled: boolean;
  /** A reflection pass runs after every `every` runs of one skill. */
  every: number;
  /** Most the passes of this bot may spend in one day (UTC). */
  dailyCapUsd: number;
}

export const REFLECTION_EVERY = { min: 1, max: 100, default: 5 } as const;
export const REFLECTION_DAILY_CAP = { min: 0.01, max: 2, default: 0.25 } as const;

export const RecorderStartSchema = z.object({ title: z.string().max(120).optional() });
export const DistillInputSchema = z.object({
  /** Skill name to use (kebab-case); the model picks one otherwise. */
  name: z.string().max(49).optional(),
  /** Extra words from the user: what the task was, what should be a parameter. */
  hint: z.string().max(1000).optional(),
});
export const SkillCorrectionSchema = z.object({ text: z.string().min(3).max(2000) });
export const SkillVersionDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });
export const SkillReflectionPatchSchema = z.object({
  enabled: z.boolean().optional(),
  every: z.number().int().min(REFLECTION_EVERY.min).max(REFLECTION_EVERY.max).optional(),
  dailyCapUsd: z.number().min(REFLECTION_DAILY_CAP.min).max(REFLECTION_DAILY_CAP.max).optional(),
});
