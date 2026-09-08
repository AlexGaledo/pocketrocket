/**
 * Approximate rate card for the models `codex exec -m` accepts, in USD per 1M tokens.
 *
 * Source: https://developers.openai.com/api/docs/pricing (standard tier, fetched 2026-09-08).
 * Model line-up: https://developers.openai.com/codex/models.md.
 *
 * `codex exec --json` reports token counts only, never a cost, so every number the hub shows for this
 * provider is an ESTIMATE computed here. Two known ways it can be wrong:
 *  - ChatGPT subscription users are not billed per token at all (the estimate is what the same work would
 *    have cost on the API), and
 *  - Batch/Flex (-50%) and Fast (x2) tiers are not modelled.
 * Edit the table when OpenAI changes its prices.
 */
export interface CodexRate {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M cached input tokens. */
  cachedInput: number;
  /** USD per 1M output tokens (reasoning tokens are a subset of output tokens, not an extra line). */
  output: number;
}

export const CODEX_RATES: Record<string, CodexRate> = {
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

/** Fallback for a model the user typed by hand: the balanced one, so an unknown id is never free. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra';

/** Exact id first, then longest known id that the model starts with (covers dated snapshots). */
export function rateFor(model: string): CodexRate {
  const id = (model || '').trim();
  if (CODEX_RATES[id]) return CODEX_RATES[id];
  const prefix = Object.keys(CODEX_RATES)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return CODEX_RATES[prefix ?? DEFAULT_CODEX_MODEL];
}

export interface CodexTokens {
  /** `usage.input_tokens` — the OpenAI total, cached tokens INCLUDED. */
  inputTokens: number;
  /** `usage.cached_input_tokens` — the subset of the above that was a cache read. */
  cachedInputTokens: number;
  outputTokens: number;
}

/** Approximate USD for one turn. Never negative, even if a CLI reports cached > input. */
export function estimateCostUsd(model: string, t: CodexTokens): number {
  const r = rateFor(model);
  const cached = Math.max(0, t.cachedInputTokens);
  const fresh = Math.max(0, t.inputTokens - cached);
  const usd = (fresh * r.input + cached * r.cachedInput + Math.max(0, t.outputTokens) * r.output) / 1_000_000;
  // 6 decimals: enough for sub-cent turns, keeps float noise out of the DB.
  return Math.round(usd * 1e6) / 1e6;
}
