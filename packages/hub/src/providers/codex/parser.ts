import type { TurnSink } from '../types.js';

/**
 * `codex exec --json` emits one JSON object per line. This turns that stream into TurnSink calls.
 *
 * Schema reference (fetched 2026-09-08):
 *   https://developers.openai.com/codex/noninteractive  (thread.started / turn.* / item.* / error)
 *   https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/ (per-item field names)
 *
 * Everything here is defensive: unknown event types, unknown item types and missing fields are ignored
 * rather than thrown on, because the CLI adds item types faster than the docs describe them.
 */

export interface CodexUsageTotals {
  /** OpenAI's `input_tokens` (cached reads INCLUDED). */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  message?: string;
}

export interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: Record<string, unknown>;
  error?: { message?: string } | string;
  message?: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Flatten an MCP CallToolResult (or anything else) into the text the tool chip shows. */
function resultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = c as { type?: string; text?: string };
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '[' + (block.type ?? 'block') + ']';
      })
      .join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function errorText(e: unknown): string | null {
  if (!e) return null;
  if (typeof e === 'string') return e;
  const m = (e as { message?: unknown }).message;
  if (typeof m === 'string' && m) return m;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** add -> Write, delete -> Delete, anything else (update/modify/rename) -> Edit. */
function fileToolName(kind: string | undefined): string {
  if (kind === 'add' || kind === 'create') return 'Write';
  if (kind === 'delete' || kind === 'remove') return 'Delete';
  return 'Edit';
}

export class CodexEventParser {
  /** `thread.started.thread_id` — the id `codex exec resume <id>` wants. */
  threadId: string | null = null;
  usage: CodexUsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  /** Set by turn.completed. A stream that ends without it died mid-turn. */
  completed = false;
  /** First fatal error seen (turn.failed / error event). */
  error: string | null = null;
  /** Number of `turn.completed` events, so the caller can re-check the budget after each one. */
  turns = 0;

  private buf = '';
  /** Tool-use ids already announced via onToolUse, so a result always has a matching chip. */
  private opened = new Set<string>();
  /** Per-item text already streamed as deltas (agent_message arrives whole on completion). */
  private streamed = new Map<string, string>();

  constructor(private sink: TurnSink) {}

  /** Feed a raw stdout chunk; complete lines are parsed, the trailing partial line is buffered. */
  push(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      this.line(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
    }
  }

  /** Flush whatever is left when the process exits without a trailing newline. */
  end(): void {
    if (this.buf.trim()) this.line(this.buf);
    this.buf = '';
  }

  line(raw: string): void {
    const text = raw.trim();
    // The CLI also prints human-readable banners on stdout in some versions; skip anything not JSON.
    if (!text || text[0] !== '{') return;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(text) as CodexEvent;
    } catch {
      return;
    }
    this.event(ev);
  }

  event(ev: CodexEvent): void {
    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) {
          this.threadId = ev.thread_id;
          this.sink.onSession(ev.thread_id);
        }
        return;
      case 'turn.started':
        this.sink.onState('thinking');
        return;
      case 'turn.completed': {
        const u = ev.usage ?? {};
        this.usage.inputTokens += num(u.input_tokens);
        this.usage.cachedInputTokens += num(u.cached_input_tokens);
        this.usage.outputTokens += num(u.output_tokens);
        this.usage.reasoningTokens += num(u.reasoning_output_tokens);
        this.completed = true;
        this.turns++;
        return;
      }
      case 'turn.failed':
        this.error = this.error ?? errorText(ev.error) ?? 'turn failed';
        return;
      case 'error':
        this.error = this.error ?? errorText(ev.error) ?? ev.message ?? 'codex reported an error';
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        if (ev.item) this.item(ev.type, ev.item);
        return;
      default:
        return; // unknown event type: ignore
    }
  }

  private item(evType: string, item: CodexItem): void {
    const id = item.id ?? 'item';
    const done = evType === 'item.completed';
    switch (item.type) {
      case 'agent_message': {
        const text = item.text ?? '';
        if (!done) {
          // Some CLI versions stream partial text through item.updated; forward only the new suffix.
          const seen = this.streamed.get(id) ?? '';
          if (text.startsWith(seen) && text.length > seen.length) this.sink.onDelta(text.slice(seen.length));
          this.streamed.set(id, text);
          return;
        }
        if (text.trim()) this.sink.onText(text);
        this.streamed.delete(id);
        return;
      }
      case 'reasoning':
        this.sink.onState('thinking');
        return;
      case 'command_execution': {
        this.open(id, 'Bash', { command: item.command ?? '' });
        if (!done) return;
        const exit = item.exit_code;
        const failed = item.status === 'failed' || (typeof exit === 'number' && exit !== 0);
        const out = item.aggregated_output ?? '';
        this.sink.onToolResult(id, failed ? out + '\n(exit code ' + String(exit ?? '?') + ')' : out, failed);
        this.sink.onState('thinking');
        return;
      }
      // 'patch' / 'patch_apply' are older aliases of 'file_change'.
      case 'file_change':
      case 'patch':
      case 'patch_apply': {
        if (!done) return;
        const changes = item.changes ?? [];
        changes.forEach((c, i) => {
          const cid = id + ':' + String(i);
          this.open(cid, fileToolName(c.kind), { path: c.path ?? '' });
          this.sink.onToolResult(cid, (c.kind ?? 'change') + ' ' + (c.path ?? ''), item.status === 'failed');
        });
        this.sink.onState('thinking');
        return;
      }
      case 'mcp_tool_call': {
        const name = 'mcp__' + (item.server ?? 'mcp') + '__' + (item.tool ?? 'tool');
        this.open(id, name, (item.arguments ?? {}) as Record<string, unknown>);
        if (!done) return;
        const err = errorText(item.error);
        const failed = !!err || item.status === 'failed';
        this.sink.onToolResult(id, err ?? resultText(item.result), failed);
        this.sink.onState('thinking');
        return;
      }
      case 'web_search': {
        if (!done) return;
        this.open(id, 'WebSearch', { query: item.query ?? '' });
        this.sink.onToolResult(id, item.query ?? '', false);
        return;
      }
      case 'error':
        // An item-level error (e.g. truncated output) is not fatal; keep it only if nothing worse turned up.
        this.error = this.error ?? item.message ?? null;
        return;
      default:
        return; // todo_list and anything new: ignore
    }
  }

  /** Emit onToolUse exactly once per id, whether the CLI sent item.started or only item.completed. */
  private open(id: string, name: string, input: Record<string, unknown>): void {
    if (this.opened.has(id)) return;
    this.opened.add(id);
    this.sink.onToolUse(id, name, input);
    this.sink.onState('working');
  }
}
