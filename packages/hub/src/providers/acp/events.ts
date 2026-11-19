import type { ContentBlock, SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TurnSink } from '../types.js';

/** Longest tool output kept per call; BotRunner caps again before storing. */
const MAX_TOOL_OUTPUT = 20_000;

/** The quiet note for a compaction the agent finished (P4-1). The runner puts the bot's name in front. */
export const COMPACTION_NOTE = 'compacted its conversation context to make room; earlier details may be summarised.';

/** The text of one content block, or '' for anything that is not text. */
export function blockText(b: ContentBlock | null | undefined): string {
  return b && b.type === 'text' ? b.text : '';
}

/** A tool call's output as plain text: its text content, the files it changed, else its raw output. */
export function toolOutputText(u: Pick<ToolCallUpdate, 'content' | 'rawOutput'>): string {
  const parts: string[] = [];
  for (const c of (u.content ?? []) as ToolCallContent[]) {
    if (c.type === 'content') {
      const t = blockText(c.content);
      if (t) parts.push(t);
    } else if (c.type === 'diff') {
      parts.push('changed ' + c.path);
    } else if (c.type === 'terminal') {
      parts.push('(terminal ' + c.terminalId + ')');
    }
  }
  if (!parts.length && u.rawOutput !== undefined && u.rawOutput !== null) {
    parts.push(typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput));
  }
  return parts.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

/** What the room shows as the tool's input: its raw input when the agent sends one, else what the call says about itself. */
function toolInput(u: Pick<ToolCall, 'title' | 'kind' | 'locations' | 'rawInput'>): unknown {
  if (u.rawInput !== undefined && u.rawInput !== null) return u.rawInput;
  return { title: u.title, ...(u.kind ? { kind: u.kind } : {}), ...(u.locations?.length ? { paths: u.locations.map((l) => l.path) } : {}) };
}

/**
 * Turns ACP `session/update` notifications into TurnSink calls (spec 01 §3, P2-1a). One instance per run.
 *
 * - `agent_message_chunk` streams as deltas; the text block is handed to `onText` when a tool call starts and at the
 *   end, the way the Claude adapter hands over each assistant text block.
 * - `tool_call` / `tool_call_update` become tool chips, settled once the call reports `completed` or `failed`.
 * - `usage_update` gives the context size (`used`), and the session's cost when the agent reports it in dollars.
 * - `notice` with severity error/warning is kept for the provider's limit matcher; nothing is posted from it.
 * - `compaction_update` (M8, P4-1): a compaction that completed becomes one quiet note (`onNote`), once per compaction id.
 *   The agent's summary is not posted; the context size drops on the next `usage_update`.
 */
export class AcpEventMapper {
  /** Input tokens in the session's context, from the last `usage_update`. */
  contextTokens?: number;
  /** The context window the agent reported alongside. */
  contextSize?: number;
  /** The session's cumulative cost in USD, when the agent reports one in dollars (ACP `cost` is optional). */
  sessionCostUsd?: number;
  /** Error and warning notices, in order, for the limit matcher. */
  readonly notices: string[] = [];
  /** True once any assistant text arrived this run. */
  answered = false;
  /** True once the agent did anything this run: text or a tool call (a hand-off with no reply still spent tokens). */
  worked = false;
  /**
   * Swallow updates: `session/load` replays the whole earlier conversation as updates, which must not be posted again.
   */
  muted = false;
  private block = '';
  private tools = new Map<string, { done: boolean }>();
  private compactions = new Set<string>();

  constructor(private sink: TurnSink) {}

  push(u: SessionUpdate): void {
    if (this.muted) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = blockText(u.content);
        if (!t) return;
        if (!this.block) this.sink.onState('thinking');
        this.block += t;
        this.answered = true;
        this.worked = true;
        this.sink.onDelta(t);
        return;
      }
      case 'agent_thought_chunk':
        this.sink.onState('thinking');
        return;
      case 'tool_call': {
        this.flush();
        this.sink.onState('working');
        this.open(u.toolCallId, u.name ?? u.title, toolInput(u));
        this.settle(u.toolCallId, u);
        return;
      }
      case 'tool_call_update': {
        if (!this.tools.has(u.toolCallId)) {
          this.flush();
          this.open(u.toolCallId, u.name ?? u.title ?? 'tool', toolInput({ title: u.title ?? 'tool', kind: u.kind ?? undefined, locations: u.locations ?? undefined, rawInput: u.rawInput }));
        }
        this.settle(u.toolCallId, u);
        return;
      }
      case 'usage_update':
        this.contextTokens = u.used;
        this.contextSize = u.size;
        if (u.cost && /^usd$/i.test(u.cost.currency) && Number.isFinite(u.cost.amount)) this.sessionCostUsd = u.cost.amount;
        return;
      case 'notice':
        if (u.severity === 'error' || u.severity === 'warning') this.notices.push(u.title + (u.description ? ': ' + u.description : ''));
        return;
      case 'compaction_update':
        if (u.status !== 'completed' || this.compactions.has(u.compactionId)) return;
        this.compactions.add(u.compactionId);
        this.sink.onNote?.(COMPACTION_NOTE);
        return;
      default:
        // plan, mode/config/commands updates, session info, compaction summary chunks: nothing to show yet.
        return;
    }
  }

  /** Hands the current text block to `onText`. Call at the end of the run. */
  flush(): void {
    if (this.block.trim()) this.sink.onText(this.block);
    this.block = '';
  }

  private open(id: string, name: string, input: unknown) {
    if (this.tools.has(id)) return;
    this.worked = true;
    this.tools.set(id, { done: false });
    this.sink.onToolUse(id, name, input);
  }

  private settle(id: string, u: Pick<ToolCallUpdate, 'status' | 'content' | 'rawOutput'>) {
    const t = this.tools.get(id);
    if (!t || t.done || (u.status !== 'completed' && u.status !== 'failed')) return;
    t.done = true;
    this.sink.onToolResult(id, toolOutputText(u), u.status === 'failed');
  }
}
