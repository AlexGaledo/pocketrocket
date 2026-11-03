import { AUTO_MODEL, DEFAULT_MODEL, type Bot, type CauseKind, type ModelInfo } from '@pocketrocket/shared';
import type { TurnUsage } from '../services/UsageTracker.js';

/**
 * Model router (P8, grok-bot-parity.md §2.7). A bot whose model is `auto` gets one picked per turn:
 *
 *   1. auto-memory and skill reflection          → Haiku   (`background`)
 *   2. the person's newest message on a turn they started says "think hard" or `/opus` → Opus (`explicit`)
 *      or a skill the message invokes that declares `model: opus`  (`skill`)
 *   3. a routine                                  → Sonnet  (`routine`)
 *      a trigger's triage                         → Haiku   (`triage`)
 *   4. optional Haiku classifier, when switched on in Settings     (`classifier`)
 *   5. everything else                            → Sonnet  (`default`)
 *   and, mid-turn, a retry after `error_max_turns` or an error     → Opus (`retry`, see `escalate`)
 *
 * The explicit ask never reads the injected transcript: that holds forwarded emails and other bots' text, and an
 * outsider must not be able to pick Opus. Memory and reflection passes are one-shot and never escalate.
 *
 * Each turn is routed on its own and nothing is stored, so a cheaper turn never holds later turns down.
 *
 * Hard limits:
 * - It only ever returns a model the active provider lists (Q12: the router stays within the provider). A tier
 *   the provider does not offer falls back to the provider's own default, then to its first model.
 * - It decides the model and nothing else. There is no budget anywhere in its input or output, so it cannot
 *   raise `max_budget_usd`; BotRunner computes the budget on its own, exactly as for a pinned bot.
 * - A bot with a pinned model is passed through untouched (reason `pinned`).
 */

export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export type RouteReason = 'pinned' | 'background' | 'explicit' | 'skill' | 'routine' | 'triage' | 'classifier' | 'default' | 'retry';

export interface RouteRequest {
  bot: Pick<Bot, 'model'>;
  /** What started the turn. P3 (routines) and P5 (triggers) pass 'routine' / 'trigger' through TurnRequest.causeKind. */
  causeKind: CauseKind;
  /** The text the bot is about to read (BotRunner's injected transcript). */
  input: string;
  /** The newest message a person wrote in `input`. Only this, on a turn a person started, can be an explicit ask. */
  latestUserText?: string;
  /** The active provider's models (`provider.modelsSync()`). Only these are ever chosen. */
  models: readonly ModelInfo[];
  /** Approved skills of this bot whose SKILL.md declares `model: opus` (SkillService.opusSkillNames). */
  opusSkills?: readonly string[];
  /** Used only when `models` is empty (a provider whose list is still loading): usually settings.defaultModel. */
  fallbackModel?: string;
}

export interface RouteChoice {
  /** The model id to run. Never `auto`. */
  model: string;
  /** Null for a pinned model. */
  tier: ModelTier | null;
  reason: RouteReason;
  /** One line for the chat chip's tooltip, e.g. 'Auto: Haiku to triage a routine'. */
  detail: string;
}

export interface ClassifierResult {
  tier: ModelTier | null;
  /** What the classifier call cost; recorded as its own usage row. */
  usage?: TurnUsage;
}
/** One cheap call that sorts a request into a tier. Must not throw; answer `{ tier: null }` when unsure. */
export type Classifier = (input: string) => Promise<ClassifierResult>;

const TIER_LABEL: Record<ModelTier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

/** The Claude ids for each tier, tried first. */
const PREFERRED: Record<ModelTier, readonly string[]> = {
  haiku: ['claude-haiku-4-5-20251001'],
  sonnet: ['claude-sonnet-5'],
  opus: ['claude-opus-5'],
};
/**
 * For other providers, or a renamed Claude id: matched in order against `id label note`, lowercased. The
 * notes on the Codex and Grok lists say "cheapest" and "hardest tasks" / "strongest", which is what these key on.
 */
const HINTS: Record<ModelTier, readonly RegExp[]> = {
  haiku: [/haiku/, /cheapest/, /\bmini\b|\bfast(est)?\b|\blite\b|\bcheap/],
  sonnet: [/sonnet/],
  opus: [/opus/, /hardest|strongest/],
};

export function isAuto(bot: Pick<Bot, 'model'>): boolean {
  return bot.model === AUTO_MODEL;
}

/** The phrase that asks for the strongest model, or null. Matches "think hard(er)", "ultrathink" and `/opus`. */
export function explicitRequest(text: string): string | null {
  const m = text.match(/\bthink\s+(?:really\s+|very\s+)?hard(?:er)?\b|\bultrathink\b|(?:^|[\s(])\/opus\b/i);
  return m ? m[0].trim() : null;
}

/** The first of `skills` the text invokes, as `/name` or "the name skill", or null. */
export function invokedSkill(text: string, skills: readonly string[]): string | null {
  for (const name of skills) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(?:^|[\\s(])/' + n + '\\b|\\b' + n + '\\s+skill\\b', 'i').test(text)) return name;
  }
  return null;
}

/**
 * The model for `tier` among `models`, or the provider's default when it has nothing in that tier.
 * `exact` is false when it had to fall back.
 */
export function resolveTier(tier: ModelTier, models: readonly ModelInfo[], fallbackModel?: string): { model: string; exact: boolean } {
  if (!models.length) {
    // Nothing to check against. Settings' default model belongs to the active provider, so it is the safe answer;
    // `auto` there would loop, so it falls through to the built-in default.
    const fb = fallbackModel && fallbackModel !== AUTO_MODEL ? fallbackModel : DEFAULT_MODEL;
    return { model: fb, exact: false };
  }
  for (const id of PREFERRED[tier]) if (models.some((m) => m.id === id)) return { model: id, exact: true };
  const text = (m: ModelInfo) => (m.id + ' ' + m.label + ' ' + (m.note ?? '')).toLowerCase();
  for (const re of HINTS[tier]) {
    const hit = models.find((m) => m.id !== AUTO_MODEL && re.test(text(m)));
    if (hit) return { model: hit.id, exact: true };
  }
  const real = models.filter((m) => m.id !== AUTO_MODEL);
  const def = real.find((m) => m.default) ?? real[0];
  if (!def) return { model: fallbackModel && fallbackModel !== AUTO_MODEL ? fallbackModel : DEFAULT_MODEL, exact: false };
  // Sonnet *is* the default tier, so landing on the provider's default counts as a match there.
  return { model: def.id, exact: tier === 'sonnet' };
}

function choose(req: RouteRequest, tier: ModelTier, reason: RouteReason, why: string): RouteChoice {
  const r = resolveTier(tier, req.models, req.fallbackModel);
  const suffix = r.exact ? '' : ' (no ' + TIER_LABEL[tier] + ' on this provider; using ' + r.model + ')';
  return { model: r.model, tier, reason, detail: 'Auto: ' + TIER_LABEL[tier] + ' ' + why + suffix };
}

function pinned(req: RouteRequest): RouteChoice {
  return { model: req.bot.model, tier: null, reason: 'pinned', detail: 'Set on the bot' };
}

/**
 * The free, rule-based part of the router: no I/O, no spending. Returns the `default` choice when no rule
 * applies; `ModelRouter.pick` may then ask the classifier.
 */
export function route(req: RouteRequest): RouteChoice {
  if (!isAuto(req.bot)) return pinned(req);
  if (req.causeKind === 'memory') return choose(req, 'haiku', 'background', 'for the auto-memory pass');
  if (req.causeKind === 'reflection') return choose(req, 'haiku', 'background', 'for the skill reflection pass');
  const asked = req.causeKind === 'user' ? explicitRequest(req.latestUserText ?? '') : null;
  if (asked) return choose(req, 'opus', 'explicit', 'because the message asked ("' + asked + '")');
  const skill = invokedSkill(req.input, req.opusSkills ?? []);
  if (skill) return choose(req, 'opus', 'skill', 'because skill "' + skill + '" declares model: opus');
  if (req.causeKind === 'routine') return choose(req, 'sonnet', 'routine', 'for a routine');
  if (req.causeKind === 'trigger') return choose(req, 'haiku', 'triage', 'to triage a trigger');
  return choose(req, 'sonnet', 'default', '(default)');
}

/** Most of a classifier prompt's cost is the input, so only the latest part of a long transcript is sent. */
export const CLASSIFIER_MAX_CHARS = 2000;

export interface ModelRouterOptions {
  classify?: Classifier;
  /** Read per turn, so flipping the setting applies from the next turn. */
  classifierEnabled?: () => boolean;
}

export class ModelRouter {
  constructor(private opts: ModelRouterOptions = {}) {}

  /**
   * The model for one turn. Async only because of the optional classifier; with it off this is `route()`.
   * `classifierUsage` is set when the classifier ran, so the caller can record what it cost.
   */
  async pick(req: RouteRequest): Promise<RouteChoice & { classifierUsage?: TurnUsage }> {
    const base = route(req);
    if (base.reason !== 'default' || !this.opts.classify || !this.opts.classifierEnabled?.()) return base;
    let res: ClassifierResult;
    try {
      res = await this.opts.classify(req.input.slice(-CLASSIFIER_MAX_CHARS));
    } catch {
      return base;
    }
    if (!res.tier) return { ...base, classifierUsage: res.usage };
    const why = res.tier === 'haiku' ? '(classifier: simple request)' : res.tier === 'opus' ? '(classifier: hard request)' : '(classifier: normal request)';
    return { ...choose(req, res.tier, 'classifier', why), classifierUsage: res.usage };
  }

  /**
   * The model for a retry inside the same turn: Opus for an auto bot that was not already on it, otherwise
   * `prev` unchanged. Like `pick`, it never touches the budget; the retry spends what is left of the turn's.
   */
  escalate(req: RouteRequest, prev: RouteChoice, after: 'error_max_turns' | 'error'): RouteChoice {
    if (!isAuto(req.bot) || prev.tier === 'opus' || prev.reason === 'background') return prev;
    const next = choose(req, 'opus', 'retry', after === 'error_max_turns' ? 'after the step limit (retry)' : 'after an error (retry)');
    return next.model === prev.model ? prev : next;
  }
}
