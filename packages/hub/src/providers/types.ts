import type { z } from 'zod';
import type { Bot, ModelInfo, ProviderCheck, ProviderId, ProviderLimitKind, ProviderStaticInfo, Room } from '@pocketrocket/shared';
import type { TurnUsage } from '../services/UsageTracker.js';
import type { OutsideMcpServer } from '../services/outsideMcp.js';

/**
 * A hub tool, independent of any provider SDK. `providers/claude.ts` wraps these with the Agent SDK's
 * `tool()` helper; CLI-based providers reach the same handlers over the HTTP MCP endpoint (`mcp/httpServer.ts`).
 */
export interface HubTool {
  name: string;
  description: string;
  /** Plain zod object. Per the zod-4 + SDK rule, optional fields use `.optional()`, never `.default()`. */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (input: Record<string, unknown>) => Promise<ToolOutput>;
  readOnly?: boolean;
}

export interface ToolOutput {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/** A picture the person attached, saved where the bot can open it (U2a). */
export interface TurnImage {
  /** Absolute path inside the bot's own folder. */
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** The bytes, for providers that take image input. Never logged. Absent when the picture is too big to inline: it is then reachable by `path` only. */
  data?: Buffer;
}

/** Everything an adapter needs to run one turn. Built by BotRunner; adapters never touch the DB. */
export interface TurnContext {
  turnId: string;
  bot: Bot;
  room: Room;
  members: Bot[];
  /** From PromptBuilder. The adapter decides how to deliver it (system prompt append, prompt prefix, ...). */
  systemPrompt: string;
  /** Injected room text for this turn. Already names each picture's path (see agent/attachments.ts). */
  input: string;
  /** Pictures the person attached since this bot last looked. Adapters that accept image input send them; the rest rely on the paths in `input`. */
  images?: TurnImage[];
  /** Provider session / thread id to resume, when the stored one belongs to this provider. */
  resumeToken: string | null;
  workspaceDir: string;
  botHome: string;
  tools: HubTool[];
  /** Built-in tool names the bot may use: Read/Write/Edit/Glob/Grep/Bash/WebSearch/WebFetch/Browser/Desktop/... */
  allowedBuiltins: string[];
  /**
   * Approvals bypassed (read per turn): run with no permission checks at all — the adapter should put its
   * CLI / SDK in its own "skip permissions" mode (bypassPermissions, danger-full-access, no sandbox,
   * allow-all config) rather than routing asks through `permission`, which would allow them anyway.
   */
  bypassPermissions?: boolean;
  /**
   * The turn is strict (a routine, trigger or workflow step; decision Q6): approvals apply even under bypass, so
   * `bypassPermissions` is already false. An adapter that can pick its agent's approval mode starts it in the most
   * restrictive one that still asks (M7, ACP).
   */
  strictApprovals?: boolean;
  /** Route a tool call through the PermissionBroker (approval cards). */
  permission: (
    toolName: string,
    input: Record<string, unknown>,
    extra?: { blockedPath?: string; reason?: string; danger?: boolean },
  ) => Promise<'allow' | 'deny'>;
  /**
   * Claude-only escape hatch: the raw PermissionBroker decision, so an `always` answer can still carry the
   * SDK's `updatedPermissions`. Every other adapter uses `permission` above.
   */
  permissionDetailed?: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown; blockedPath?: string },
  ) => Promise<unknown>;
  /** Claude-only: materialized skill plugin directory for this bot, or null. Other adapters ignore it. */
  pluginDir?: string | null;
  model: string;
  /** What this run may spend, in dollars, on its own (not counting earlier turns of a resumed session). */
  maxBudgetUsd: number;
  /**
   * Claude: the SDK's cumulative `total_cost_usd` already recorded for the session in `resumeToken` (the SDK reports
   * a running total across resumes). The adapter subtracts it to get this run's own cost, and adds it to the SDK's
   * budget flag so that check is per run too. null = unknown (a session from before the hub tracked it); ignored
   * on a fresh session.
   */
  sessionCostUsd?: number | null;
  /**
   * Token brake: once this run has read this many cache tokens (summed over its top-level model calls), the
   * adapter stops it and reports `braked`. Undefined = no brake. Applies with dollar caps off.
   */
  cacheReadBudget?: number;
  maxTurns: number;
  signal: AbortSignal;
  /** Loopback MCP endpoint exposing `tools` for this turn only; CLI adapters point their config at it. */
  mcp: { url: string; token: string };
  /** P7: the knowledge repo folder, readable but never writable by the bot; null/absent when none is set up. */
  knowledgeDir?: string | null;
  /** Folders this bot reads without a card and cannot write without one (the Support bot's view of the app source). */
  readOnlyDirs?: string[];
  /** Project folders this bot is a member of, a working root like its home. */
  projectDirs?: string[];
  /** Why this tool call may not touch a project folder, or null. Holds with approvals bypassed. */
  projectGuard?: (toolName: string, input: Record<string, unknown>, cwd: string) => string | null;
  /** Why this shell command may not ship, or null. Holds with approvals bypassed. */
  shipGuard?: (command: string, cwd: string) => string | null;
  /** Bridge P1: why this write may not touch a shared file (decisions.md is append-only), or null. Holds with approvals bypassed. */
  fileGuard?: (toolName: string, input: Record<string, unknown>, cwd: string) => string | null;
  /** Bridge P1: after a Write/Edit tool succeeded, so the hub records who changed a shared file. Never blocks. */
  fileWritten?: (toolName: string, input: Record<string, unknown>, cwd: string) => void;
  // P1: per-bot computers. Unset = no computer this turn, so no Browser tool.
  /** Chromium DevTools endpoint of this bot's own computer, for the Browser tool. */
  cdpUrl?: string;
  /** Owner-configured outside MCP servers for this bot (data/mcp-servers.json). Claude only; never pre-approved. */
  outsideMcp?: OutsideMcpServer[];
  /**
   * Runs before each call to an outside server whose `approve` asks for a card (services/outsideMcp.ts):
   * raises the owner's card, under bypass too. A string refuses the call; null means the owner allowed it.
   */
  outsideMcpGate?: (toolName: string, input: Record<string, unknown>) => Promise<string | null>;
  /** The bot's own computer disk (Desktop, Downloads): an extra root its file tools may use without asking. */
  computerFilesDir?: string;
  /** Bridge P7: more folders the sandbox mounts writable, such as a session's VPS worktree. Ignored with the sandbox off. */
  sandboxWritableDirs?: string[];
  // ---- P2 ----
  /**
   * Control interlock: why this bot's desktop/Browser tools must not act right now (the user has control, or
   * the bot is paused), or null. Adapters must enforce it in bypass mode too; it is not an approval.
   */
  controlGuard?: () => string | null;
  /** Runs before each Browser or desktop call, after `controlGuard`: starts the computer if needed. A string refuses the call. */
  computerGate?: (toolName: string, input?: Record<string, unknown>) => Promise<string | null>;
  /**
   * Steers an earlier run of this turn was given but never consumed (see `TurnOutcome.steers`). A steering provider
   * sends each as its own message after `input`, under its original uuid, so it is tracked like a live steer.
   */
  carriedSteers?: SteerInput[];
}

/** Persistence callbacks. BotRunner owns messages/events; adapters just report what happened. */
export interface TurnSink {
  onSession(token: string): void;
  onDelta(text: string): void;
  /** A complete assistant text block. */
  onText(text: string): void;
  onToolUse(id: string, name: string, input: unknown): void;
  onToolResult(id: string, output: string, isError: boolean): void;
  onState(s: 'thinking' | 'working'): void;
  /** Init/version info for GET /api/health (Claude reports apiKeySource, model, CLI version, ...). */
  onInit?(info: ProviderInit): void;
  /**
   * M5: the provider reported where this login stands against its plan limits (Claude: each `rate_limit_event`).
   * Bookkeeping only: it never decides the turn. A rejected report also ends the run with `TurnOutcome.limit`.
   */
  onLimit?(report: LimitReport): void;
  /**
   * M8 (P4-1): something the provider did to the session that the room should know about, as a quiet system note
   * (an ACP agent compacted its context). Plain text written by the adapter, never the agent's own words.
   */
  onNote?(text: string): void;
}

/** One limit report from a provider, normalised. Times are ms since epoch. */
export interface LimitReport {
  /** `rejected` = the limit is reached; `allowed_warning` = close to it; `allowed` = fine again. */
  status: 'allowed' | 'allowed_warning' | 'rejected';
  kind: ProviderLimitKind;
  window?: string;
  resetsAt?: number;
  utilization?: number;
}

/** Why a run ended on a provider limit rather than on anything the bot did (spec 01 §4.3). Times are ms since epoch. */
export interface TurnLimit {
  kind: ProviderLimitKind;
  resetsAt?: number;
  window?: string;
}

export interface ProviderInit {
  apiKeySource?: string;
  model?: string;
  version?: string;
  tools?: string[];
  skills?: string[];
  /** Claude: the CLI's protocol capabilities from system/init (`interrupt_receipt_v1`, ...). */
  capabilities?: string[];
}

/** A person's message pushed into a running turn (steering). */
export interface SteerInput {
  /** Stamped on the SDK message; results name the uuids they answered, which is how a steer is known to be consumed. */
  uuid: string;
  /** Formatted like any other injected room line. */
  text: string;
  images?: TurnImage[];
}

/**
 * The answer to a steer. `accepted` only means it was pushed into the live turn, not that the bot answered it:
 * `TurnOutcome.steers` says which were consumed. `queued` means it was not pushed, so the caller queues it:
 * `provider` = this provider (or its installed CLI) cannot take messages mid-turn; `between-runs` = no live turn
 * with that id, or the turn is already ending or has not started reading yet.
 */
export type SteerResult = { status: 'accepted' } | { status: 'queued'; reason: 'provider' | 'between-runs' };

export interface TurnOutcome {
  ok: boolean;
  error?: string;
  /** This run's own cost. */
  costUsd: number;
  usage: TurnUsage;
  durationMs: number;
  /** Claude: the SDK's cumulative cost for the session after this run, to store as the next run's baseline. */
  sessionCostUsd?: number;
  /** Claude: input tokens (uncached + cache read + cache write) of the last top-level model call: the context size. */
  contextTokens?: number;
  /** P4-2: the model's context window, when the provider reports it (Claude's `modelUsage`, ACP `usage_update.size`). */
  contextWindow?: number;
  /** Stopped by the token brake (`cacheReadBudget`). */
  braked?: boolean;
  /**
   * Steering providers: uuids of the steers this run was given (pushed through `steer`, or carried in through
   * `TurnContext.carriedSteers`). `consumed` = a result or reply named it, so it is in the session's transcript;
   * `pending` = never consumed (Stop, the token brake, an error result, a turn that ended before the CLI took it),
   * so the caller must deliver it again. Absent when the run had none.
   */
  steers?: { consumed: string[]; pending: string[] };
  /**
   * M5: the run ended on a provider limit (always with `ok: false`). The provider's own limit text is never posted as
   * the bot's reply; BotRunner writes the note from this instead.
   */
  limit?: TurnLimit;
  /** The model that actually answered, when the provider says and it differs from `TurnContext.model` (an SDK fallback). */
  model?: string;
  /**
   * The provider finished the run and accounted for it, even at $0 and no token counts (an ACP agent that reports
   * neither, e.g. agy on Gemini). BotRunner records a usage row for it, so the run still shows in Usage.
   */
  accounted?: boolean;
}

export interface AgentProvider {
  id: ProviderId;
  label: string;
  /** Static description for the picker card + settings UI. */
  info: ProviderStaticInfo;
  /**
   * M8 (P4-1): runs report `TurnOutcome.contextTokens`, so the runner may rotate a session that grew too large. Without
   * it a session is never rotated on size (there is nothing to measure). Claude and the ACP adapter set it.
   */
  readonly reportsContextTokens?: boolean;
  models(): Promise<ModelInfo[]>;
  /** Synchronous snapshot of `models()` (registry cache); used where async is not possible. */
  modelsSync(): ModelInfo[];
  /**
   * `models()` never blocks, so it answers empty while a provider's cache is still cold. This is the
   * awaiting variant, for the few callers that need a real list more than they need a fast answer.
   * Providers with a static list can leave it out; the registry falls back to `models()`.
   */
  modelsAwaited?(): Promise<ModelInfo[]>;
  check(): Promise<ProviderCheck>;
  runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome>;
  interrupt(turnId: string): boolean;
  /** Push a person's message into the running turn `turnId`. Providers without it never steer: see `steerTurn`. */
  steer?(turnId: string, input: SteerInput): SteerResult;
  /** Whether `steer` can work at all right now (for `ProviderInfo.steer`). Absent = false. */
  canSteer?(): boolean;
  shutdown?(): Promise<void>;
}

/** `provider.steer`, or `queued: provider` for the adapters that have no live input channel (Codex, OpenCode, Grok). */
export function steerTurn(provider: AgentProvider, turnId: string, input: SteerInput): SteerResult {
  return provider.steer ? provider.steer(turnId, input) : { status: 'queued', reason: 'provider' };
}

export const EMPTY_USAGE: TurnUsage = {
  costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: undefined, durationMs: 0,
};
