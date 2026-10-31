/** How many bots one room can hold. Rooms bigger than this get noisy and slow, and every mention fans out to all of them. */
export const MAX_ROOM_BOTS = 10;

import type { Approvals } from './providers.js';
import type { TriggerPayload } from './triggers.js';

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
export type MessageKind = 'text' | 'tool' | 'approval' | 'handoff' | 'routine' | 'system' | 'trigger';

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
  /** `expired`: the card was still open when the hub stopped, so nothing is waiting on it any more. */
  status: 'pending' | 'allow' | 'always' | 'deny' | 'timeout' | 'expired';
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
  payload: ToolPayload | ApprovalPayload | HandoffPayload | RoutinePayload | TriggerPayload | null;
  causeId: string | null;
  hop: number;
  turnId: string | null;
  createdAt: number;
  /** Bot messages only (P8): the model that wrote it, and why the router chose that model. */
  model?: string;
  modelReason?: string;
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
  /** P3: one-shot routine. Epoch ms it fires at; null for a cron routine. */
  onceAt: number | null;
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

// ---------- P8: model router and usage ----------
/**
 * A bot whose model is `auto` lets the hub pick one per turn (`agent/ModelRouter.ts`): Haiku for background and
 * triage work, Sonnet by default, Opus when asked or when a turn has to be retried. It always picks from the
 * active provider's own list and never changes the bot's budget.
 */
export const AUTO_MODEL = 'auto';
export const AUTO_MODEL_INFO = { id: AUTO_MODEL, label: 'Auto', note: 'picks Haiku, Sonnet or Opus per turn' } as const;

/**
 * What started a turn. `user` a person's message, `bot` a hand-off from another bot, `routine` a scheduled
 * routine, `trigger` an outside event (P5), `memory` the auto-memory pass, `reflection` a skill reflection pass.
 */
export const CAUSE_KINDS = ['user', 'bot', 'routine', 'trigger', 'memory', 'reflection'] as const;
export type CauseKind = (typeof CAUSE_KINDS)[number];

/** One row of a usage breakdown: `key` is a model id or a cause kind; '' for rows recorded before P8. */
export interface UsageGroup extends UsageTotals {
  key: string;
}

// ---------- P7: knowledge repo, voice ----------
/** GET /api/knowledge, and the WS `knowledge.status` event. */
export interface KnowledgeStatus {
  /** settings.knowledgeRepo as last synced ('' = off). */
  source: string;
  /** 'clone' = a git URL cloned to data/knowledge; 'link' = a local folder linked there; 'off' = none. */
  mode: 'off' | 'clone' | 'link';
  /** Absolute path bots read from, or null while there is nothing to read. */
  dir: string | null;
  syncing: boolean;
  lastSyncedAt: number | null;
  /** Short commit id of the clone after the last successful sync. */
  head: string | null;
  lastError: string | null;
}

/** A style note AutoMemory proposed for a bot's voice.md; applied only when the user approves it. */
export interface VoiceProposal {
  id: string;
  botId: string;
  text: string;
  createdAt: number;
}

/** POST /api/skills/import-git result. Every imported skill starts `pending` review. */
export interface SkillGitImportResult {
  imported: Skill[];
  skipped: { name: string; reason: string }[];
}

// ---------------------------------------------------------------------------------------------------
// P1: per-bot computers. Each bot with Browser or Desktop gets its own display, Chromium profile and ports on
// a server hub. They run as the same OS user, so this is separation, not isolation: never present it as such.

/** asleep = stopped (disk kept); starting = unit started, waiting for Chromium; live = running. */
export type ComputerState = 'asleep' | 'starting' | 'live';
export interface ComputerStatus {
  botId: string;
  /** False when this hub has no per-bot computers (desktop app, or a server with them turned off). */
  perBot: boolean;
  state: ComputerState;
  /** 1-based slot (display, ports) once assigned; null before the bot ever needed one. */
  slot: number | null;
  keepAwake: boolean;
  /** Last `du` of the computer's folder (bytes), refreshed hourly. */
  diskBytes: number;
  /** Soft quota (bytes): warned at 80%, refused to start at 100%. */
  quotaBytes: number;
  lastUsedAt: number | null;
  /** Why the last start failed (quota, every slot in use, ...), when it did. */
  reason?: string;
}
