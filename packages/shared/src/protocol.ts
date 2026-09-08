import { z } from 'zod';
import type { Bot, BotState, Message, Room, UsageTotals, ApprovalPayload } from './models.js';

// ---------- server -> client ----------
export type ServerEvent =
  | { type: 'hello'; bots: Bot[]; rooms: Room[]; botStates: Record<string, BotState> }
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
  | { type: 'error'; message: string; context?: string };

// ---------- client -> server ----------
export const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message.send'), roomId: z.string(), text: z.string().min(1) }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: z.string(),
    decision: z.enum(['allow', 'always', 'deny']),
  }),
  z.object({ type: z.literal('turn.interrupt'), turnId: z.string() }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

// ---------- REST bodies ----------
export const BotInputSchema = z.object({
  name: z.string().min(1).max(40),
  handle: z.string().regex(/^[a-z0-9_-]{2,24}$/),
  title: z.string().max(80).default(''),
  description: z.string().max(4000).default(''),
  avatar: z.string().max(8).default('🤖'),
  model: z.string().default('claude-sonnet-5'),
  allowedTools: z.array(z.string()).default(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']),
  maxBudgetUsd: z.number().min(0.05).max(50).default(2),
});
export type BotInput = z.infer<typeof BotInputSchema>;

export const RoomInputSchema = z.object({
  kind: z.enum(['dm', 'group']),
  name: z.string().min(1).max(60),
  memberIds: z.array(z.string()).min(1).max(6),
  coordinatorBotId: z.string().nullable().default(null),
});
export type RoomInput = z.infer<typeof RoomInputSchema>;

export const RoutineInputSchema = z.object({
  botId: z.string(),
  roomId: z.string(),
  name: z.string().min(1).max(60),
  cron: z.string().min(5),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type RoutineInput = z.infer<typeof RoutineInputSchema>;
