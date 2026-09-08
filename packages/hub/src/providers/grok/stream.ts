import type { TokenCounts } from './pricing.js';

/**
 * `grok -p --output-format streaming-json` emits newline-delimited JSON, one `type`-tagged object per line
 * (docs: `$GROK_HOME/docs/user-guide/14-headless-mode.md`). The set is explicitly non-exhaustive, so anything
 * unrecognised is ignored rather than treated as an error.
 */
export interface GrokUsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export type GrokEvent =
  | { type: 'text'; data?: string }
  | { type: 'thought'; data?: string }
  | { type: 'tool_call'; toolCallId?: string; toolName?: string; title?: string; kind?: string; status?: string; rawInput?: unknown }
  | { type: 'tool_call_update'; toolCallId?: string; status?: string; rawOutput?: unknown; content?: unknown }
  | { type: 'usage'; messageId?: string; stopReason?: string; usage?: GrokUsageBlock }
  | { type: 'error'; message?: string; usage?: GrokUsageBlock }
  | {
      type: 'end';
      stopReason?: string;
      sessionId?: string;
      requestId?: string;
      usage?: GrokUsageBlock;
      num_turns?: number;
      modelUsage?: unknown;
      total_cost_usd?: number;
      cost_is_partial?: boolean;
      usage_is_incomplete?: boolean;
    }
  | { type: string; [k: string]: unknown };

/** Splits a chunked stdout stream into whole lines and parses each as JSON. Junk lines are dropped. */
export class NdjsonParser {
  private buf = '';

  push(chunk: string): GrokEvent[] {
    this.buf += chunk;
    const out: GrokEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const ev = parseLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Whatever is left when the process exits without a trailing newline. */
  flush(): GrokEvent[] {
    const rest = this.buf;
    this.buf = '';
    const ev = parseLine(rest);
    return ev ? [ev] : [];
  }
}

function parseLine(line: string): GrokEvent | null {
  const s = line.trim();
  if (!s || s[0] !== '{') return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') return v as GrokEvent;
  } catch {
    /* a half-written or non-JSON line: ignore */
  }
  return null;
}

export function tokensFrom(u: GrokUsageBlock | undefined): TokenCounts {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

/** `tool_call_update.rawOutput`/`content` is free-form; render it for the tool chip. */
export function renderToolOutput(ev: { rawOutput?: unknown; content?: unknown }): string {
  const v = ev.rawOutput ?? ev.content;
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
