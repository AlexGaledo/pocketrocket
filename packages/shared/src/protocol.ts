import { z } from 'zod';
import { AUTO_MEMORY_EVERY, MAX_AVATAR_LENGTH, MAX_ROOM_BOTS, MAX_ROUTING_BYTES, isBotIconKey, isChatModel, isMediaRef, type Bot, type BotState, type Message, type Room, type UsageTotals, type ApprovalPayload, type OpenApproval } from './models.js';
import type { KnowledgeStatus } from './models.js';
import type { Settings, ProviderId } from './providers.js';
import type { AccountState } from './account.js';
import type { ComputerStatus } from './models.js';
import type { TriggerFireStatus } from './triggers.js';
import { COMPUTER_CONTROLS, type ApprovalPolicy, type ControlStatus } from './models.js';
import type { RecorderStatus } from './teach.js';
import type { Task } from './tasks.js';
import { FormAnswersSchema } from './cards.js';

// ---------- server -> client ----------
export type ServerEvent =
  | { type: 'hello'; bots: Bot[]; rooms: Room[]; botStates: Record<string, BotState>; settings: Settings; /** Who this connection is (P9): a paired device has narrower rights (guard.ts DEVICE_ALLOW). */ principal?: 'hub' | 'device'; /** This connection carries a browser session (owner password), so it may allow sign-in-required cards. */ signedIn?: boolean; /** Every card still waiting, including ones in rooms this client has not loaded. */ openApprovals?: OpenApproval[] }
  | { type: 'settings.changed'; settings: Settings }
  /** Provider switched (or its check changed); clients refetch GET /api/providers. */
  | { type: 'providers.changed'; active: ProviderId }
  | { type: 'bots.changed'; bots: Bot[] }
  | { type: 'rooms.changed'; rooms: Room[] }
  | { type: 'message.new'; message: Message }
  | { type: 'message.update'; id: string; roomId: string; patch: Partial<Message> }
  | { type: 'turn.start'; turnId: string; botId: string; roomId: string; causeId: string; hop: number }
  | { type: 'turn.delta'; turnId: string; roomId: string; botId: string; text: string }
  | { type: 'turn.end'; turnId: string; roomId: string; botId: string; messageId?: string; costUsd?: number; error?: string }
  | { type: 'bot.state'; botId: string; state: BotState; roomId?: string; note?: string }
  | { type: 'approval.request'; roomId: string; botId: string; messageId: string; approval: ApprovalPayload }
  | { type: 'approval.resolved'; approvalId: string; decision: ApprovalPayload['status'] }
  | { type: 'memory.updated'; botId: string; text: string }
  | { type: 'routine.fired'; routineId: string; runId: string; botId: string; roomId: string }
  | { type: 'usage.updated'; botId: string; roomId: string; totals: UsageTotals }
  | { type: 'account.changed'; account: AccountState }
  | { type: 'error'; message: string; context?: string }
  /** Liveness probe (B6), every {@link WS_PING_MS}. The client answers with a `pong` client event; old clients just ignore it. */
  | { type: 'ping'; t: number }
  // ---- P3: routines v2 ----
  /** A routine was created, changed or deleted (REST or a bot tool); clients refetch GET /api/routines. */
  | { type: 'routines.changed' }
  // ---- P7: knowledge repo, voice ----
  | { type: 'knowledge.status'; status: KnowledgeStatus }
  /** voice.md or its pending proposals changed; clients refetch GET /api/bots/:id/voice. */
  | { type: 'voice.updated'; botId: string }
  // P1: a bot's computer changed state (asleep/starting/live), keep-awake or disk usage.
  | { type: 'computer.state'; status: ComputerStatus }
  // P4: integrations. A connection, grant, OAuth app or pending sign-in changed; clients refetch GET /api/integrations.
  | { type: 'integrations.changed' }
  // P5: event triggers. A trigger was created, changed or deleted, or its poll status moved; refetch GET /api/triggers.
  | { type: 'triggers.changed' }
  /** A trigger fired, was skipped, or one of its fires finished; refetch its fires. */
  | { type: 'trigger.fired'; triggerId: string; fireId: string; status: TriggerFireStatus }
  // ---- P2: take over, hand back, approval rules ----
  /** Who drives a bot's computer changed (agent / user / paused), or its takeover request did. */
  | { type: 'computer.control'; status: ControlStatus }
  /** Approval rules changed (created or revoked); clients refetch GET /api/approval-policies. */
  | { type: 'policies.changed'; policies: ApprovalPolicy[] }
  // ---- P6: teach by demonstration, skill versions ----
  /** A recording started, stopped or grew (sent at most every few seconds while recording). */
  | { type: 'recorder.state'; status: RecorderStatus }
  /** The skill pool or a skill's versions changed; clients refetch GET /api/skills (and the open versions list). */
  | { type: 'skills.changed'; skillId?: string }
  /** A bot's training setting or proposals changed; clients refetch GET /api/bots/:id/training. */
  | { type: 'training.changed'; botId: string }
  /**
   * Something in a room's folder changed through /api/rooms/:id/files. `path` is the folder whose listing changed
   * ('' for the room's folder itself); a move sends one event per folder. An open Files panel showing it refetches.
   */
  | { type: 'files.changed'; roomId: string; path: string }
  /**
   * The PC runner's pairing, online state or a job changed. Carries no job content (paired phones get every
   * event); the desktop's Settings > PC runner refetches GET /api/pc-runner and /api/pc-runner/jobs.
   */
  | { type: 'pc-runner.changed'; jobId?: string }
  /** A task on a room's board was created or changed (REST or a bot tool). Carries the whole task. */
  | { type: 'task.changed'; roomId: string; task: Task };

/** How often the hub pings each WebSocket client (B6). The client calls the link stale after two missed pings. */
export const WS_PING_MS = 20_000;

// ---------- client -> server ----------
export const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.send'),
    roomId: z.string(),
    /** May be empty when `attachments` is not (a picture sent on its own). */
    text: z.string(),
    /**
     * Pictures from `POST /api/media?for=attachment` (U2a), at most {@link MAX_ATTACHMENTS}. The hub checks every one
     * and refuses the whole send when any is unknown or not an allowed image; the cap is enforced there too, so the
     * refusal can name the client's id (`context`). Left out, the message has no pictures.
     */
    attachments: z.array(z.string().max(80)).max(32).optional(),
    /**
     * Optional id the client made up for this send (B5). The hub posts one message per (room, id) however many
     * times it is repeated, so a client may replay its outbox after a reconnect. Clients that omit it still work.
     */
    clientMsgId: z.string().min(1).max(64).optional(),
  }).refine((e) => e.text.trim().length > 0 || (e.attachments?.length ?? 0) > 0, { message: 'Message is empty', path: ['text'] }),
  /** Answer to a server `ping` (B6). Carries nothing; it only proves the path is alive. */
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: z.string(),
    decision: z.enum(['allow', 'always', 'deny']),
  }),
  /** U4: the owner's answers to a request_form card (formId is the card's message id). The hub checks them against the stored fields. */
  z.object({ type: z.literal('form.submit'), formId: z.string().max(64), answers: FormAnswersSchema }),
  z.object({ type: z.literal('form.cancel'), formId: z.string().max(64) }),
  z.object({ type: z.literal('turn.interrupt'), turnId: z.string() }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

// ---------- REST bodies ----------
// Anything but a key or a picture reference becomes '' (automatic), so a client cached from before icons can still save.
const AvatarSchema = z.string().max(MAX_AVATAR_LENGTH).transform((v): string => (isBotIconKey(v) || isMediaRef(v) ? v : ''));

/**
 * POST /api/media. Biggest picture the hub stores. The bytes travel as base64 in JSON, so the request stays inside
 * the 1 MB body cap and the JSON-only rule on mutating routes (guard.ts) needs no exception.
 */
export const MAX_MEDIA_BYTES = 512 * 1024;
export const MediaUploadSchema = z.object({
  data: z.string().max(Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64'),
});

/** U2a: pictures a person attaches to a chat message. Larger than an avatar; the browser downscales before upload. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/**
 * The most one picture may weigh. Pictures are base64-inlined into the Claude turn and the API refuses an image over
 * about 5 MB (counted after encoding, which adds a third), so the raw cap sits below it with headroom.
 */
export const MAX_ATTACHMENT_IMAGE_BYTES = 3.5 * 1024 * 1024;
/** Most pictures on one message. */
export const MAX_ATTACHMENTS = 4;
export const AttachmentUploadSchema = z.object({
  data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64'),
});

/** The longest a bot's description may be, however it is written. */
export const MAX_BOT_DESCRIPTION_CHARS = 4000;

export const BotInputSchema = z.object({
  name: z.string().min(1).max(40),
  handle: z.string().regex(/^[a-z0-9_-]{2,24}$/),
  title: z.string().max(80).default(''),
  description: z.string().max(MAX_BOT_DESCRIPTION_CHARS).default(''),
  avatar: AvatarSchema.default(''),
  model: z.string().default('claude-sonnet-5'),
  allowedTools: z.array(z.string()).default(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']),
  maxBudgetUsd: z.number().min(0.05).max(50).default(50),
  // Optional rather than defaulted: the hub fills them in (on, every 10), so existing clients and
  // templates need not send them.
  autoMemory: z.boolean().optional(),
  autoMemoryEvery: z.number().int().min(AUTO_MEMORY_EVERY.min).max(AUTO_MEMORY_EVERY.max).optional(),
});
export type BotInput = z.infer<typeof BotInputSchema>;

export const RoomInputSchema = z.object({
  kind: z.enum(['dm', 'group']),
  name: z.string().min(1).max(60),
  memberIds: z.array(z.string()).min(1).max(MAX_ROOM_BOTS),
  coordinatorBotId: z.string().nullable().default(null),
  avatar: AvatarSchema.optional(),
});
export type RoomInput = z.infer<typeof RoomInputSchema>;

/** PUT /api/rooms/:id/model: the composer's pick for this chat. null goes back to each bot's own model. */
export const RoomModelInputSchema = z.object({
  model: z.string().refine(isChatModel, 'Not a model the picker offers').nullable(),
});

/** PUT /api/routing: the owner's rules. Bots only ever propose a line, through an approval card. */
export const RoutingInputSchema = z.object({ text: z.string().max(MAX_ROUTING_BYTES) });

export const RoutineInputSchema = z.object({
  botId: z.string(),
  roomId: z.string(),
  name: z.string().min(1).max(60),
  /** Croner pattern in `settings.timezone`. Empty for a one-shot routine (`onceAt`). */
  cron: z.string().max(200).default(''),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  // ---- P3: one-shot routines ----
  /**
   * One-shot: epoch ms, or a local date-time `YYYY-MM-DDTHH:mm[:ss]` the hub reads in `settings.timezone`.
   * Set it and the routine fires once (cron is ignored) and then disables itself. null clears it.
   */
  onceAt: z.union([z.number().int().positive(), z.string().min(10).max(40)]).nullable().optional(),
});
export type RoutineInput = z.infer<typeof RoutineInputSchema>;

// ---- P2: take over, hand back, approval rules ----
/** PUT /api/computers/:botId/control. `note` goes to the bot on hand-back (control: agent). */
export const ControlInputSchema = z.object({
  control: z.enum(COMPUTER_CONTROLS),
  holder: z.string().max(64).optional(),
  note: z.string().max(2000).optional(),
});
export type ControlInput = z.infer<typeof ControlInputSchema>;

/**
 * POST /api/approval-policies. Either from an answered card (`approvalId`, the hub derives bot, tool and
 * pattern from it; `pattern` may narrow or widen it) or spelled out (`botId` + `tool` + `pattern`).
 */
export const ApprovalPolicyInputSchema = z.object({
  approvalId: z.string().max(40).optional(),
  botId: z.string().max(64).optional(),
  tool: z.string().min(1).max(120).optional(),
  pattern: z.string().min(1).max(500).optional(),
  decision: z.enum(['allow', 'deny']).default('allow'),
  /** Limit the rule to one machine (`pc`, `vps`); omit for any. */
  machine: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).nullable().optional(),
  /** Epoch ms after which the rule no longer applies; omit for never. */
  expiresAt: z.number().int().positive().nullable().optional(),
});
export type ApprovalPolicyInput = z.infer<typeof ApprovalPolicyInputSchema>;

/** Longest maintenance hold one call may ask for, in minutes. */
export const MAX_MAINTENANCE_HOLD_MINUTES = 30;
/** POST /api/maintenance/hold: no new bot turn starts until released or `minutes` pass (default 10). */
export const MaintenanceHoldInputSchema = z.object({
  minutes: z.number().int().min(1).max(MAX_MAINTENANCE_HOLD_MINUTES).default(10),
});
export type MaintenanceHoldInput = z.infer<typeof MaintenanceHoldInputSchema>;
