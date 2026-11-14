// The Tasks board: one room's to-do list, in four columns. Tasks are notes the owner and the bots keep together
// (G1); a task never grants an approval or changes a setting. Statuses change with a plain select, so the board
// works from the keyboard and on a phone. A `task.changed` event from a bot or another window refreshes it.
import { useCallback, useEffect, useState } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import { TASK_STATUSES, type Task, type TaskStatus } from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom } from '../store';
import { api } from '../lib/api';
import { Banner, Button, EmptyState, Input, Label, Select, Skeleton, SkeletonGroup, cn } from './ui';
import { FleetHeader, PageBody } from './FleetPages';

const LABEL: Record<TaskStatus, string> = { todo: 'To do', doing: 'Doing', blocked: 'Blocked', done: 'Done' };
const COLUMNS: TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

export function TasksPage() {
  const rooms = useStore((s) => s.rooms);
  const active = useStore(selectActiveRoom);
  const [roomId, setRoomId] = useState(active?.id ?? rooms[0]?.id ?? '');
  const room = rooms.find((r) => r.id === roomId);
  return (
    <>
      <FleetHeader title="Tasks" sub={room ? room.name : 'Pick a chat'} />
      <PageBody>
        <div className="mb-4 max-w-xs">
          <Label htmlFor="tasks-room">Chat</Label>
          <Select id="tasks-room" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </div>
        {room ? <Board key={room.id} roomId={room.id} /> : <EmptyState icon={<ListChecks size={18} />} title="No chats yet">Tasks live in a chat. Start one first.</EmptyState>}
      </PageBody>
    </>
  );
}

function Board({ roomId }: { roomId: string }) {
  const toast = useStore((s) => s.toast);
  const rev = useStore((s) => s.tasksRev[roomId] ?? 0);
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId));
  const bots = useStore((s) => s.bots);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const members = (room?.memberIds ?? []).map((id) => botById(bots, id)).filter((b): b is NonNullable<typeof b> => !!b);

  const load = useCallback(() => {
    api.tasks.list(roomId).then((t) => { setTasks(t); setError(null); }, (e: Error) => setError(e.message));
  }, [roomId]);
  useEffect(load, [load, rev]);

  const add = async () => {
    setBusy(true);
    try {
      await api.tasks.create(roomId, { title: title.trim(), assigneeBotId: assignee || null });
      setTitle('');
      load();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const patch = async (t: Task, p: { status?: TaskStatus; assigneeBotId?: string | null }) => {
    try {
      const next = await api.tasks.update(roomId, t.id, p);
      setTasks((cur) => cur && cur.map((x) => (x.id === next.id ? next : x)));
    } catch (e) { toast((e as Error).message, true); load(); }
  };

  return (
    <>
      {error && <Banner tone="error" className="mb-3" action={<Button size="sm" onClick={load}>Retry</Button>}>{error}</Banner>}
      <form className="mb-5 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void add(); }}>
        <div className="min-w-48 flex-1">
          <Label htmlFor="task-title">New task</Label>
          <Input id="task-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
        </div>
        <div className="w-44">
          <Label htmlFor="task-assignee">Assign to</Label>
          <Select id="task-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Nobody</option>
            {members.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </div>
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}><Plus size={14} aria-hidden /> Add</Button>
      </form>
      {tasks === null && !error && (
        <SkeletonGroup label="Loading tasks…" className="space-y-2"><Skeleton className="h-14 w-full rounded-lg" /><Skeleton className="h-14 w-full rounded-lg" /></SkeletonGroup>
      )}
      {tasks?.length === 0 && (
        <EmptyState icon={<ListChecks size={18} />} title="No tasks in this chat">Add one above, or ask a bot to keep a list with create_task.</EmptyState>
      )}
      {tasks && tasks.length > 0 && (
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-4">
          {COLUMNS.map((st) => {
            const col = tasks.filter((t) => t.status === st);
            return (
              <section key={st} aria-label={LABEL[st] + ', ' + col.length}>
                <h3 className="mb-2 flex items-center justify-between text-label text-fg">{LABEL[st]}<span className="text-hint text-muted">{col.length}</span></h3>
                <ul className="space-y-2">
                  {col.map((t) => (
                    <li key={t.id} className={cn('rounded-lg bg-card2/40 p-3 ring-1 ring-line', st === 'done' && 'opacity-70')}>
                      <div className={cn('text-ui', st === 'done' && 'line-through')}>{t.title}</div>
                      {t.notes && <p className="mt-1 line-clamp-3 text-hint text-muted">{t.notes}</p>}
                      <div className="mt-2 flex gap-2">
                        <Select aria-label={'Status of ' + t.title} value={t.status} onChange={(e) => void patch(t, { status: e.target.value as TaskStatus })}>
                          {TASK_STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
                        </Select>
                        <Select aria-label={'Assignee of ' + t.title} value={t.assigneeBotId ?? ''} onChange={(e) => void patch(t, { assigneeBotId: e.target.value || null })}>
                          <option value="">Nobody</option>
                          {members.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </Select>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
