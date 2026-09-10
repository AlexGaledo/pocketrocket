import type { z } from 'zod';
import type { Bot, ModelInfo, ProviderCheck, ProviderId, ProviderInfo, Room } from '@pocketrocket/shared';
import type { TurnUsage } from '../services/UsageTracker.js';

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

/** Everything an adapter needs to run one turn. Built by BotRunner; adapters never touch the DB. */
export interface TurnContext {
  turnId: string;
  bot: Bot;
  room: Room;
  members: Bot[];
  /** From PromptBuilder. The adapter decides how to deliver it (system prompt append, prompt prefix, ...). */
  systemPrompt: string;
  /** Injected room text for this turn. */
  input: string;
  /** Provider session / thread id to resume, when the stored one belongs to this provider. */
  resumeToken: string | null;
  workspaceDir: string;
  botHome: string;
  tools: HubTool[];
  /** Built-in tool names the bot may use: Read/Write/Edit/Glob/Grep/Bash/WebSearch/WebFetch/Browser/Desktop/... */
  allowedBuiltins: string[];
  /**
   * BYPASS_PERMISSIONS: run with no permission checks at all — the adapter should put its CLI / SDK in its
   * own "skip permissions" mode (bypassPermissions, danger-full-access, no sandbox, allow-all config) rather
   * than routing asks through `permission`, which would allow them anyway.
   */
  bypassPermissions?: boolean;
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
  maxBudgetUsd: number;
  maxTurns: number;
  signal: AbortSignal;
  /** Loopback MCP endpoint exposing `tools` for this turn only; CLI adapters point their config at it. */
  mcp: { url: string; token: string };
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
}

export interface ProviderInit {
  apiKeySource?: string;
  model?: string;
  version?: string;
  tools?: string[];
  skills?: string[];
}

export interface TurnOutcome {
  ok: boolean;
  error?: string;
  costUsd: number;
  usage: TurnUsage;
  durationMs: number;
}

export interface AgentProvider {
  id: ProviderId;
  label: string;
  /** Static description for the picker card + settings UI. */
  info: Omit<ProviderInfo, 'check' | 'models'>;
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
  shutdown?(): Promise<void>;
}

export const EMPTY_USAGE: TurnUsage = {
  costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: undefined, durationMs: 0,
};
