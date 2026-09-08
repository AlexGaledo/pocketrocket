import type { TurnSink } from '../types.js';

/**
 * Pure translation of one OpenCode session's SSE events into TurnSink calls, kept free of HTTP so it can be
 * driven from fixtures in `events.test.ts`. Event/part shapes below were read off the live server's OpenAPI
 * document (`GET /doc`, opencode 1.17.6) and confirmed against captured runs.
 */

export interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface OcPart {
  id?: string;
  messageID?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  cost?: number;
  time?: { start?: number; end?: number };
  state?: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
  };
}

/** MCP tools reach OpenCode as `<serverName>_<tool>`; the hub registers its server as `pocketrocket`. */
export const MCP_TOOL_PREFIX = 'pocketrocket_';

const TOOL_CHIPS: Record<string, string> = {
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', grep: 'Grep', list: 'List',
  webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite', task: 'Task', skill: 'Skill',
  apply_patch: 'ApplyPatch', patch: 'Patch', question: 'Question', invalid: 'Invalid',
};

/** OpenCode tool id -> the chip name the web UI shows. Hub tools keep their plain name. */
export function chipName(tool: string): string {
  if (tool.startsWith(MCP_TOOL_PREFIX)) return tool.slice(MCP_TOOL_PREFIX.length);
  return TOOL_CHIPS[tool] ?? tool.replace(/(^|_)([a-z])/g, (_m: string, _s: string, c: string) => c.toUpperCase());
}

export interface PermissionAsk {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
}

/**
 * Turn an OpenCode permission ask into the (toolName, input) pair the hub's PermissionBroker understands, so
 * its normal path/bash rules decide and only genuinely out-of-workspace or dangerous calls raise a card.
 * `toolFor(callID)` supplies the OpenCode tool that triggered the ask (`external_directory` fires for reads
 * and writes alike, and only the tool name tells them apart).
 */
export function permissionToTool(
  ask: PermissionAsk,
  toolFor: (callID: string) => string | undefined,
  inputFor: (callID: string) => Record<string, unknown> | undefined = () => undefined,
): { name: string; input: Record<string, unknown>; reason: string; danger: boolean } {
  const md = (ask.metadata ?? {}) as Record<string, unknown>;
  // `read` asks carry an empty metadata object (verified on 1.17.6), so fall back to the triggering tool
  // call's own input, which holds the absolute path once OpenCode has parsed the arguments.
  const toolInput = ask.tool ? (inputFor(ask.tool.callID) ?? {}) : {};
  const str = (k: string) => {
    for (const src of [md, toolInput]) {
      const v = src[k] ?? src[k === 'filepath' ? 'filePath' : k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  const triggering = ask.tool ? toolFor(ask.tool.callID) : undefined;
  switch (ask.permission) {
    case 'bash':
      return { name: 'Bash', input: { command: str('command') ?? '' }, reason: str('description') ?? 'shell command', danger: false };
    case 'edit':
      return {
        name: chipName(triggering ?? 'edit'),
        input: { file_path: str('filepath') ?? '' },
        reason: 'edit ' + (str('filepath') ?? ''),
        danger: false,
      };
    case 'external_directory':
      return {
        name: chipName(triggering ?? 'read'),
        input: { file_path: str('filepath') ?? str('parentDir') ?? '' },
        reason: 'outside the OpenCode project: ' + (str('filepath') ?? str('parentDir') ?? ''),
        danger: false,
      };
    case 'read':
    case 'glob':
    case 'grep':
    case 'list':
      // These are `allow` in the shipped config; handled anyway so flipping them to `ask` behaves sanely.
      return {
        name: chipName(triggering ?? ask.permission),
        input: { file_path: str('filepath') ?? str('path') ?? str('pattern') ?? ask.patterns?.[0] ?? '' },
        reason: ask.permission + ' ' + (ask.patterns?.[0] ?? ''),
        danger: false,
      };
    case 'webfetch':
      return { name: 'WebFetch', input: { url: str('url') ?? '' }, reason: 'fetch ' + (str('url') ?? ''), danger: false };
    case 'websearch':
      return { name: 'WebSearch', input: { query: str('query') ?? '' }, reason: 'web search', danger: false };
    default:
      return { name: chipName(triggering ?? ask.permission), input: { ...md }, reason: ask.permission + ' requires approval', danger: false };
  }
}

export interface TurnHooks {
  sink: TurnSink;
  /** Route to the hub's PermissionBroker (approval cards). */
  permission: (name: string, input: Record<string, unknown>, extra: { reason: string; danger: boolean }) => Promise<'allow' | 'deny'>;
  /** Answer OpenCode: `once` lets the blocked tool call proceed, `reject` fails it. */
  reply: (permissionID: string, response: 'once' | 'reject') => Promise<void>;
  /** Accumulated cost passed `maxBudgetUsd`; the provider aborts the session. */
  onOverBudget: (costUsd: number) => void;
  /** An MCP tool call started (true) or ended (false); the hub MCP bridge routes on this. */
  onMcpToolPending?: (toolName: string, pending: boolean) => void;
}

export interface TurnTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Accumulates one turn: text/tool parts to the sink, per-assistant-message cost + tokens, permission asks,
 * and the `session.idle` / `session.error` terminators.
 */
export class TurnTracker {
  /** Resolved when the turn is over (idle, error, or aborted). */
  readonly finished: Promise<void>;
  error?: string;
  /** How many permission asks were routed to the hub this turn (logging + tests). */
  asks = 0;

  private resolveFinished!: () => void;
  private settled = false;
  private sawActivity = false;
  private idleGrace: ReturnType<typeof setTimeout> | null = null;
  /** partID -> part type, so `message.part.delta` knows whether it streams visible text or reasoning. */
  private partTypes = new Map<string, string>();
  /** callID -> OpenCode tool id, for the permission mapping and the tool chips. */
  private toolByCall = new Map<string, string>();
  /** callID -> the tool call's parsed input, the fallback path source for permission asks. */
  private inputByCall = new Map<string, Record<string, unknown>>();
  private announced = new Set<string>();
  private finishedCalls = new Set<string>();
  private emittedText = new Set<string>();
  /** Ids of user messages, so the echoed prompt part is never posted back to the room as bot text. */
  private userMessages = new Set<string>();
  /** tool+input -> the decision already asked for this turn, so one action never shows two cards. */
  private decided = new Map<string, Promise<'allow' | 'deny'>>();
  /** assistant messageID -> its latest cost/token snapshot (they are cumulative per message). */
  private perMessage = new Map<string, TurnTotals>();
  private overBudget = false;

  constructor(
    readonly sessionID: string,
    private hooks: TurnHooks,
    private maxBudgetUsd: number,
  ) {
    this.finished = new Promise<void>((r) => (this.resolveFinished = r));
  }

  totals(): TurnTotals {
    const t: TurnTotals = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const m of this.perMessage.values()) {
      t.costUsd += m.costUsd;
      t.inputTokens += m.inputTokens;
      t.outputTokens += m.outputTokens;
      t.cacheReadTokens += m.cacheReadTokens;
      t.cacheWriteTokens += m.cacheWriteTokens;
    }
    return t;
  }

  finish(error?: string) {
    if (this.settled) return;
    this.settled = true;
    if (this.idleGrace) clearTimeout(this.idleGrace);
    if (error && !this.error) this.error = error;
    this.resolveFinished();
  }

  /** Feed one SSE event. The caller filters events down to this session. */
  handle(ev: OcEvent): void {
    const p = (ev.properties ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case 'session.status': {
        const status = (p.status as { type?: string } | undefined)?.type;
        if (status === 'busy') this.sawActivity = true;
        return;
      }
      case 'session.idle':
        // `session.idle` can land before the prompt has been picked up: only end the turn once the session
        // actually went busy, or after a short grace period if it never does.
        if (this.sawActivity) this.finish();
        else if (!this.idleGrace) this.idleGrace = setTimeout(() => this.finish(), 5000);
        return;
      case 'session.error': {
        const err = p.error as { name?: string; data?: { message?: string } } | undefined;
        this.finish(err?.data?.message ?? err?.name ?? 'session error');
        return;
      }
      case 'message.part.delta':
        this.onDelta(p);
        return;
      case 'message.part.updated':
        this.onPart(p.part as OcPart | undefined);
        return;
      case 'message.updated':
        this.onMessage(p.info as Record<string, unknown> | undefined);
        return;
      case 'permission.asked':
        void this.onPermission(p as unknown as PermissionAsk);
        return;
      default:
        return;
    }
  }

  private onDelta(p: Record<string, unknown>) {
    if (p.field !== 'text') return;
    const partID = String(p.partID ?? '');
    // Reasoning parts stream on the same channel; only visible assistant text reaches the room.
    if (this.partTypes.get(partID) !== 'text') return;
    const delta = String(p.delta ?? '');
    if (delta) this.hooks.sink.onDelta(delta);
  }

  private onPart(part: OcPart | undefined) {
    if (!part) return;
    this.sawActivity = true;
    if (part.id) this.partTypes.set(part.id, part.type);
    if (part.messageID && this.userMessages.has(part.messageID)) return;
    if (part.type === 'text') {
      // A text part is created empty, streams via message.part.delta, then repeats with time.end once done.
      if (part.time?.end && part.id && !this.emittedText.has(part.id)) {
        this.emittedText.add(part.id);
        if (part.text && part.text.trim()) this.hooks.sink.onText(part.text);
      }
      return;
    }
    if (part.type !== 'tool' || !part.callID || !part.tool) return;
    const callID = part.callID;
    const tool = part.tool;
    const isMcp = tool.startsWith(MCP_TOOL_PREFIX);
    this.toolByCall.set(callID, tool);
    const state = part.state;
    if (state?.input && Object.keys(state.input).length) this.inputByCall.set(callID, state.input);
    if (!state || state.status === 'pending') {
      if (isMcp) this.hooks.onMcpToolPending?.(tool, true);
      return;
    }
    if (!this.announced.has(callID)) {
      this.announced.add(callID);
      if (isMcp) this.hooks.onMcpToolPending?.(tool, true);
      this.hooks.sink.onToolUse(callID, chipName(tool), state.input ?? {});
      this.hooks.sink.onState('working');
    }
    if (this.finishedCalls.has(callID)) return;
    if (state.status === 'completed') {
      this.finishedCalls.add(callID);
      if (isMcp) this.hooks.onMcpToolPending?.(tool, false);
      this.hooks.sink.onToolResult(callID, state.output ?? '', false);
      this.hooks.sink.onState('thinking');
    } else if (state.status === 'error') {
      this.finishedCalls.add(callID);
      if (isMcp) this.hooks.onMcpToolPending?.(tool, false);
      this.hooks.sink.onToolResult(callID, state.error ?? 'tool failed', true);
      this.hooks.sink.onState('thinking');
    }
  }

  private onMessage(info: Record<string, unknown> | undefined) {
    if (!info) return;
    if (info.role === 'user') {
      if (info.id) this.userMessages.add(String(info.id));
      return;
    }
    if (info.role !== 'assistant') return;
    this.sawActivity = true;
    const id = String(info.id ?? '');
    if (!id) return;
    const tok = (info.tokens ?? {}) as { input?: number; output?: number; cache?: { read?: number; write?: number } };
    this.perMessage.set(id, {
      costUsd: typeof info.cost === 'number' ? info.cost : 0,
      inputTokens: tok.input ?? 0,
      outputTokens: tok.output ?? 0,
      cacheReadTokens: tok.cache?.read ?? 0,
      cacheWriteTokens: tok.cache?.write ?? 0,
    });
    const err = info.error as { name?: string; data?: { message?: string } } | undefined;
    if (err) this.error = err.data?.message ?? err.name ?? 'assistant error';
    const cost = this.totals().costUsd;
    if (!this.overBudget && this.maxBudgetUsd > 0 && cost > this.maxBudgetUsd) {
      this.overBudget = true;
      this.error = 'budget of $' + this.maxBudgetUsd + ' exceeded ($' + cost.toFixed(4) + ')';
      this.hooks.onOverBudget(cost);
    }
  }

  private async onPermission(ask: PermissionAsk) {
    this.sawActivity = true;
    this.asks++;
    const mapped = permissionToTool(
      ask,
      (callID) => this.toolByCall.get(callID),
      (callID) => this.inputByCall.get(callID),
    );
    // One write outside the project raises two asks (`edit` and `external_directory`); the user should see
    // one card, so a repeat of the same tool+input inside this turn reuses the first answer.
    const key = mapped.name + '|' + JSON.stringify(mapped.input);
    let decision: 'allow' | 'deny' = 'deny';
    const seen = this.decided.get(key);
    if (seen) {
      decision = await seen;
    } else {
      const pending = (async () => {
        try {
          return await this.hooks.permission(mapped.name, mapped.input, { reason: mapped.reason, danger: mapped.danger });
        } catch {
          return 'deny' as const;
        }
      })();
      this.decided.set(key, pending);
      decision = await pending;
    }
    try {
      await this.hooks.reply(ask.id, decision === 'allow' ? 'once' : 'reject');
    } catch {
      /* the session may already be gone */
    }
  }
}
