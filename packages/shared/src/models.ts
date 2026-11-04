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

/** A person on this hub. The id is who they are; the display name can change at any time. */
export interface User {
  id: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
  previousNames: string[];
  createdAt: number;
}

/** One browser signed in with the owner's password. Never carries the token or its hash. */
export interface UserSessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

/** One row of the activity log. Labels and ids only, never request bodies. */
export interface AuditEntry {
  id: number;
  at: number;
  actorKind: 'session' | 'hub-token' | 'device' | 'bot' | 'anonymous';
  actorId: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5 (default)' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * The line icons a bot can wear. The web app maps each key to a glyph; the bot tools use this list as their enum.
 */
export const BOT_ICON_KEYS = [
  'bot', 'cpu', 'compass', 'wrench', 'pen', 'smile', 'brain', 'shield', 'radar', 'anchor', 'atom', 'feather', 'hammer', 'map', 'orbit', 'hexagon',
  'search', 'terminal', 'globe', 'sparkles', 'palette', 'rocket', 'database',
  'blob-ember', 'blob-bloom', 'blob-cloud', 'blob-pebble', 'blob-clover', 'blob-star', 'blob-bean', 'blob-drop', 'blob-gem', 'blob-spike',
] as const;
export type BotIconKey = (typeof BOT_ICON_KEYS)[number];
export const isBotIconKey = (v: unknown): v is BotIconKey => (BOT_ICON_KEYS as readonly unknown[]).includes(v);
/** The icons drawn as a whole character rather than a line glyph on a tinted circle. */
export type BotCharacterKey = Extract<BotIconKey, `blob-${string}`>;
export const isBotCharacterKey = (v: unknown): v is BotCharacterKey => isBotIconKey(v) && v.startsWith('blob-');
/** How many bots fit on the sidebar's podium. */
export const MAX_PODIUM_BOTS = 3;

/** Longest stored avatar: `img:` plus a SHA-256 in hex. */
export const MAX_AVATAR_LENGTH = 68;
/** An uploaded picture, named by the SHA-256 of its bytes. The hash is the only thing about it a client ever supplies. */
export const isMediaRef = (v: unknown): v is string => typeof v === 'string' && /^img:[0-9a-f]{64}$/.test(v);
/** The hash inside a reference. Call after {@link isMediaRef}. */
export const mediaHash = (ref: string): string => ref.slice('img:'.length);

export interface Bot {
  id: string;
  name: string;
  handle: string; // lowercase, no spaces; mentioned as @handle
  title: string;
  description: string; // becomes CLAUDE.md / identity
  avatar: string; // a BOT_ICON_KEYS key, an uploaded picture (isMediaRef), or '' to derive the icon from the id
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
  /** Group chats: a BOT_ICON_KEYS key, an uploaded picture (isMediaRef), or '' for the plain group mark. */
  avatar?: string;
  /**
   * The composer's model pick for this chat (one of CHAT_MODELS), or null for each bot's own model. It applies to
   * turns a person starts here, never to hand-offs or schedules, and never changes the bot.
   */
  chatModel?: string | null;
}

export type AuthorType = 'user' | 'bot' | 'system';
export type MessageKind = 'text' | 'tool' | 'approval' | 'handoff' | 'routine' | 'system' | 'trigger' | 'takeover';

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
  /** P2: a routine/trigger turn stopped waiting on this card; it resumes when the card is answered. */
  parked?: boolean;
}
export interface HandoffPayload {
  fromBotId: string;
  toBotId: string;
  task: string;
  context?: string;
  /** Set when the target works outside this chat, in its own: the chat that holds its work. */
  workRoomId?: string;
}
/** On a `text` message: a bot outside this chat reporting back. `workRoomId` is the chat that holds its work. */
export interface HandoffResultPayload {
  workRoomId: string;
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
  authorId: string | null; // bot id for bots, user id for people, null for system
  kind: MessageKind;
  text: string;
  payload: ToolPayload | ApprovalPayload | HandoffPayload | HandoffResultPayload | RoutinePayload | TriggerPayload | TakeoverPayload | TurnFailurePayload | null;
  causeId: string | null;
  hop: number;
  turnId: string | null;
  createdAt: number;
  /** Bot messages only (P8): the model that wrote it, and why the router chose that model. */
  model?: string;
  modelReason?: string;
  /** Pictures attached to this message, each an uploaded reference (see {@link isMediaRef}). */
  attachments?: string[];
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
  // ---- P6: skill refinement ----
  /** The version now live (1 for a skill that was never revised). */
  version?: number;
  /** Always null for a pool skill; candidate versions are listed under GET /api/skills/:id/versions. */
  parentId?: string | null;
  /** Candidate versions waiting for review. */
  pendingVersions?: number;
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
 * triage work, Sonnet by default, Opus when asked, when the bot moves itself up or when a turn has to be retried.
 * It always picks from the active provider's own list and never changes the bot's budget.
 */
export const AUTO_MODEL = 'auto';
export const AUTO_MODEL_INFO = { id: AUTO_MODEL, label: 'Auto', note: 'moves up when needed' } as const;

/** What the composer's picker offers (Claude only; other providers keep each bot's own model). */
export const CHAT_MODELS = [
  { id: AUTO_MODEL, label: 'Auto', note: 'Sonnet 5, moves up when needed' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Everyday work' },
  { id: 'claude-opus-5', label: 'Opus 5', note: 'Hard problems, uses more of your plan' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku', note: 'Quick checks' },
] as const;
export const isChatModel = (v: unknown): boolean => CHAT_MODELS.some((m) => m.id === v);

/** The owner's routing rules ride every prompt, so they stay short. */
export const MAX_ROUTING_BYTES = 2048;

/**
 * What started a turn. `user` a person's message, `bot` a hand-off from another bot, `routine` a scheduled
 * routine, `trigger` an outside event (P5), `memory` the auto-memory pass, `reflection` a skill reflection pass,
 * `training` a bot training pass.
 */
export const CAUSE_KINDS = ['user', 'bot', 'routine', 'trigger', 'memory', 'reflection', 'training'] as const;
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

/** An approval card still waiting for an answer, sent in `hello` so Needs you is right before its room has loaded. */
export interface OpenApproval {
  approvalId: string;
  botId: string;
  roomId: string;
}

/** asleep = stopped (disk kept); starting = unit started, waiting for Chromium; live = running. */
export type ComputerState = 'asleep' | 'starting' | 'live';
export interface ComputerStatus {
  botId: string;
  /** False when this hub has no per-bot computers (desktop app, or a server with them turned off). */
  perBot: boolean;
  state: ComputerState;
  /** 1-based slot (display, ports) once assigned; null before the bot ever needed one. */
  slot: number | null;
  /** Shown as Always on: never stopped when idle, and started again after a server reboot. */
  keepAwake: boolean;
  /** How many computers are Always on, and how many may be. One place under the cap always stays out of it. */
  alwaysOn?: { used: number; limit: number };
  /** Last `du` of the computer's folder (bytes), refreshed hourly. */
  diskBytes: number;
  /** Soft quota (bytes): warned at 80%, refused to start at 100%. */
  quotaBytes: number;
  lastUsedAt: number | null;
  /** Why the last start failed (quota, every slot in use, ...), when it did. */
  reason?: string;
}

// ---------------------------------------------------------------------------------------------------
// P2: take over, hand back, approvals while away (docs/specs/grok-bot-parity.md §2.2, §2.4).

/**
 * Who drives a bot's computer. `agent`: the bot; the viewer is view-only. `user`: a person; the bot's desktop
 * and browser tools refuse. `paused`: nobody acts; the bot's turns wait in their lanes.
 */
export const COMPUTER_CONTROLS = ['agent', 'user', 'paused'] as const;
export type ComputerControl = (typeof COMPUTER_CONTROLS)[number];

export interface ControlStatus {
  botId: string;
  control: ComputerControl;
  /** Device id of whoever took control (client-chosen, informational), or null. */
  holder: string | null;
  /** Epoch ms of the last change. */
  since: number;
  /** The bot's open `request_takeover`, while there is one. `parked`: its turn ended and resumes on hand-back. */
  takeover: { messageId: string; roomId: string; reason: string; parked: boolean } | null;
}

/** `kind: 'takeover'` message: a bot asked the user to take over its computer (log in, solve a captcha, ...). */
/**
 * On the system note of a turn that ended in an error. `behaviour`: something the bot itself could do differently.
 * `external`: it was stopped, signed out, out of budget or could not reach its provider.
 */
export const TURN_FAILURE_BEHAVIOUR = 'behaviour';
export interface TurnFailurePayload {
  turnFailure: typeof TURN_FAILURE_BEHAVIOUR | 'external';
}

export interface TakeoverPayload {
  botId: string;
  reason: string;
  /** waiting: the bot waits in its turn; parked: its turn ended and resumes on hand-back; done: handed back. */
  status: 'waiting' | 'parked' | 'done' | 'expired';
  /** The user's hand-back note, once handed back. */
  note?: string;
  /** Routine run the parked turn belongs to, so a restart can still close it. */
  runId?: string | null;
}

/**
 * A persisted approval rule (Settings › Bots › Approvals). Only the user creates one, over REST; no bot tool
 * reaches this table. `pattern` is matched against the call's subject (a Bash command, a path, a URL): `*`
 * matches anything, a trailing `*` is a prefix match, anything else must match exactly.
 */
export interface ApprovalPolicy {
  id: string;
  botId: string;
  tool: string;
  pattern: string;
  decision: 'allow' | 'deny';
  createdAt: number;
}
