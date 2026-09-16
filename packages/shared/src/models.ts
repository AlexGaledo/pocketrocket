import type { Approvals } from './providers.js';

export type BotState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'error';

// 'Browser' and 'Desktop' are not Claude Code built-ins: Browser = Playwright MCP attached to the shared screen
// Chromium; Desktop = screenshot/click/type on the virtual desktop (computer use).
export const BUILTIN_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Browser', 'Desktop', 'NotebookEdit', 'Skill',
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5 (default)' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;
export const DEFAULT_MODEL = 'claude-sonnet-5';

export interface Bot {
  id: string;
  name: string;
  handle: string; // lowercase, no spaces; mentioned as @handle
  title: string;
  description: string; // becomes CLAUDE.md / identity
  avatar: string; // emoji or short text
  model: string;
  allowedTools: string[];
  maxBudgetUsd: number; // per turn
  /** Background pass that saves lasting facts from the room to memory.md every `autoMemoryEvery` turns. */
  autoMemory: boolean;
  autoMemoryEvery: number; // completed turns per (bot, room) between passes
  createdAt: number;
}
/** Bounds and default for `Bot.autoMemoryEvery`. */
export const AUTO_MEMORY_EVERY = { default: 10, min: 3, max: 100 } as const;

export type RoomKind = 'dm' | 'group';
export interface Room {
  id: string;
  kind: RoomKind;
  name: string;
  memberIds: string[];
  coordinatorBotId: string | null;
  createdAt: number;
}

export type AuthorType = 'user' | 'bot' | 'system';
export type MessageKind = 'text' | 'tool' | 'approval' | 'handoff' | 'routine' | 'system';

export interface ToolPayload {
  toolUseId: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  done: boolean;
}
export interface ApprovalPayload {
  approvalId: string;
  toolName: string;
  toolInput: unknown;
  reason: string;
  danger: boolean;
  status: 'pending' | 'allow' | 'always' | 'deny' | 'timeout';
}
export interface HandoffPayload {
  fromBotId: string;
  toBotId: string;
  task: string;
  context?: string;
}
export interface RoutinePayload {
  routineId: string;
  runId: string;
  name: string;
}

export interface Message {
  id: string;
  roomId: string;
  seq: number;
  authorType: AuthorType;
  authorId: string | null; // bot id for bots, null for user/system
  kind: MessageKind;
  text: string;
  payload: ToolPayload | ApprovalPayload | HandoffPayload | RoutinePayload | null;
  causeId: string | null;
  hop: number;
  turnId: string | null;
  createdAt: number;
}

export interface Routine {
  id: string;
  botId: string;
  roomId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
}
export interface RoutineRun {
  id: string;
  routineId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'success' | 'error';
  messageId: string | null;
  costUsd: number | null;
}

export type SkillSource = 'imported' | 'authored' | 'bot';
export interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  reviewStatus: 'approved' | 'pending';
  createdByBot: string | null;
}

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

export interface UsageRow extends UsageTotals {
  botId: string;
  roomId: string;
}

export interface HealthInfo {
  /** Whether the active provider's CLI was found. Deliberately not where: see below. */
  ok: boolean;
  apiKeySource?: string;
  // No account email, plan or path to the CLI here: GET /api/health answers without the hub token, and a
  // path under the home directory spells out the machine's user name. All three live on the provider
  // check (GET /api/providers, POST /api/providers/:id/check), which needs the token.
  error?: string;
  /** Approvals mode in force right now: `settings.approvals`, unless the server environment pins it. */
  approvals: Approvals;
  /** True when POCKETROCKET_BYPASS_PERMISSIONS pins `approvals`; Settings cannot change it (PUT answers 409). */
  approvalsLocked: boolean;
}
