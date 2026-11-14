import { z } from 'zod';

/** A task on a room's board (G1). Local to the hub: it never syncs anywhere and never grants anything. */
export const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MAX_TASK_TITLE = 200;
export const MAX_TASK_NOTES_BYTES = 4096;
/** Tasks that are not `done`, per room. */
export const MAX_OPEN_TASKS_PER_ROOM = 200;

export interface Task {
  id: string;
  roomId: string;
  /** The bot that created it, or null when the owner did. */
  botId: string | null;
  assigneeBotId: string | null;
  title: string;
  notes: string;
  status: TaskStatus;
  dueAt: number | null;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

const notes = z.string().refine((s) => new TextEncoder().encode(s).length <= MAX_TASK_NOTES_BYTES, 'notes are over 4 KB');

export const TaskInputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TASK_TITLE),
  notes: notes.default(''),
  status: z.enum(TASK_STATUSES).default('todo'),
  assigneeBotId: z.string().nullable().default(null),
  dueAt: z.number().int().nonnegative().nullable().default(null),
  parentId: z.string().nullable().default(null),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
