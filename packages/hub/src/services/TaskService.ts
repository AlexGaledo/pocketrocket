import { nanoid } from 'nanoid';
import { MAX_OPEN_TASKS_PER_ROOM, MAX_TASK_NOTES_BYTES, MAX_TASK_TITLE, TASK_STATUSES, type Task, type TaskStatus } from '@pocketrocket/shared';
import type { Db, Row } from '../db/db.js';
import { events } from '../events.js';

export class TaskError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface TaskCreate {
  title: string; notes?: string; status?: TaskStatus; assigneeBotId?: string | null; dueAt?: number | null; parentId?: string | null;
}
export type TaskPatch = Partial<TaskCreate>;

/**
 * A room's task board (G1). Rows are local data only: nothing here grants a permission or changes a setting, and
 * title/notes are free text anyone in the room can write, so readers must treat them as untrusted.
 */
export class TaskService {
  constructor(private db: Db, private now: () => number = Date.now) {}

  private row(r: Row): Task {
    return {
      id: r.id as string, roomId: r.room_id as string, botId: (r.bot_id as string) ?? null,
      assigneeBotId: (r.assignee_bot_id as string) ?? null, title: r.title as string, notes: (r.notes as string) ?? '',
      status: r.status as TaskStatus, dueAt: (r.due_at as number) ?? null, parentId: (r.parent_id as string) ?? null,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
    };
  }
  get(id: string): Task | undefined {
    const r = this.db.get('SELECT * FROM tasks WHERE id=?', id);
    return r && this.row(r);
  }
  list(roomId: string, o: { status?: TaskStatus; assigneeBotId?: string; includeDone?: boolean; limit?: number } = {}): Task[] {
    const where = ['room_id=?'];
    const args: Array<string | number> = [roomId];
    if (o.status) { where.push('status=?'); args.push(o.status); }
    else if (!o.includeDone) where.push("status<>'done'");
    if (o.assigneeBotId) { where.push('assignee_bot_id=?'); args.push(o.assigneeBotId); }
    return this.db
      .all('SELECT * FROM tasks WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC, rowid DESC LIMIT ?', ...args, Math.min(o.limit ?? 100, 500))
      .map((r) => this.row(r));
  }
  openCount(roomId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE room_id=? AND status<>'done'", roomId)?.n ?? 0;
  }

  private check(i: TaskPatch, roomId: string, selfId?: string) {
    if (i.title !== undefined && (!i.title.trim() || i.title.length > MAX_TASK_TITLE)) throw new TaskError(400, 'title must be 1-' + MAX_TASK_TITLE + ' characters');
    if (i.notes !== undefined && Buffer.byteLength(i.notes, 'utf8') > MAX_TASK_NOTES_BYTES) throw new TaskError(400, 'notes are over 4 KB');
    if (i.status !== undefined && !TASK_STATUSES.includes(i.status)) throw new TaskError(400, 'bad status');
    if (i.parentId) {
      const p = this.get(i.parentId);
      if (!p || p.roomId !== roomId) throw new TaskError(400, 'parent task is not in this room');
      if (i.parentId === selfId) throw new TaskError(400, 'a task cannot be its own parent');
    }
  }

  create(roomId: string, botId: string | null, i: TaskCreate): Task {
    this.check(i, roomId);
    const status = i.status ?? 'todo';
    if (status !== 'done' && this.openCount(roomId) >= MAX_OPEN_TASKS_PER_ROOM) {
      throw new TaskError(409, 'This room already has ' + MAX_OPEN_TASKS_PER_ROOM + ' open tasks; finish or close some first.');
    }
    const t = this.now();
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO tasks (id,room_id,bot_id,assignee_bot_id,title,notes,status,due_at,parent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, roomId, botId, i.assigneeBotId ?? null, i.title.trim(), i.notes ?? '', status, i.dueAt ?? null, i.parentId ?? null, t, t,
    );
    return this.emit(this.get(id)!);
  }

  update(id: string, patch: TaskPatch): Task {
    const cur = this.get(id);
    if (!cur) throw new TaskError(404, 'Task not found');
    this.check(patch, cur.roomId, id);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Task & TaskPatch;
    if (cur.status === 'done' && next.status !== 'done' && this.openCount(cur.roomId) >= MAX_OPEN_TASKS_PER_ROOM) {
      throw new TaskError(409, 'This room already has ' + MAX_OPEN_TASKS_PER_ROOM + ' open tasks; finish or close some first.');
    }
    this.db.run(
      'UPDATE tasks SET assignee_bot_id=?, title=?, notes=?, status=?, due_at=?, parent_id=?, updated_at=? WHERE id=?',
      next.assigneeBotId ?? null, next.title.trim(), next.notes, next.status, next.dueAt ?? null, next.parentId ?? null, this.now(), id,
    );
    return this.emit(this.get(id)!);
  }

  private emit(task: Task): Task {
    events.emitEvent({ type: 'task.changed', roomId: task.roomId, task });
    return task;
  }
}
