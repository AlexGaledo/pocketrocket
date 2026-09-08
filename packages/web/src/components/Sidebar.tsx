import { useEffect, useState } from 'react';
import { Plus, Hash, Settings2, Sun, Moon, BarChart3 } from 'lucide-react';
import { useStore, botById } from '../store';
import { Avatar, STATE_LABEL, cn } from './ui';
import type { Bot, Message, Room } from '@claudebot/shared';

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('claudebot.theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);
  return [dark, setDark] as const;
}

/** What a bot is doing right now, from its latest unfinished tool call in any loaded room. */
function activityFor(bot: Bot, messages: Record<string, Message[]>): string | null {
  let latest: Message | null = null;
  for (const list of Object.values(messages)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.authorId === bot.id && m.kind === 'tool') { if (!latest || m.createdAt > latest.createdAt) latest = m; break; }
    }
  }
  if (!latest || !latest.payload || (latest.payload as { done?: boolean }).done) return null;
  const p = latest.payload as { name: string; input: Record<string, unknown> };
  const name = p.name.replace('mcp__claudebot__', '').replace('mcp__browser__browser_', 'web ');
  const target = String(p.input?.file_path ?? p.input?.command ?? p.input?.url ?? p.input?.query ?? p.input?.text ?? '').split(/[\\/]/).pop() ?? '';
  return (name + ' ' + target).trim().slice(0, 36);
}

export function Sidebar() {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const botStates = useStore((s) => s.botStates);
  const messages = useStore((s) => s.messages);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const unread = useStore((s) => s.unread);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const openDialog = useStore((s) => s.openDialog);
  const openPanel = useStore((s) => s.openPanel);
  const [dark, setDark] = useTheme();

  const dms = rooms.filter((r) => r.kind === 'dm');
  const groups = rooms.filter((r) => r.kind === 'group');
  const dmFor = (botId: string) => dms.find((r) => r.memberIds[0] === botId);
  const busy = bots.filter((b) => ['thinking', 'working', 'blocked', 'waiting'].includes(botStates[b.id] ?? 'idle')).length;

  const openDm = async (botId: string) => {
    const existing = dmFor(botId);
    if (existing) return setActiveRoom(existing.id);
    const bot = botById(bots, botId)!;
    const { api } = await import('../lib/api');
    const room = await api.rooms.create({ kind: 'dm', name: bot.name, memberIds: [botId], coordinatorBotId: null });
    setActiveRoom(room.id);
  };

  return (
    <aside className="flex w-[236px] shrink-0 flex-col">
      <div className="flex h-11 items-center justify-between px-3">
        <div className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[12px] text-ink-fg">⚡</span>
          Claudebot
        </div>
        <span className="text-[11.5px] text-dim">{busy ? busy + ' working' : ''}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        <SectionHeader label="Team" onAdd={() => openDialog({ kind: 'bot', bot: null })} addTitle="New bot" />
        <ul className="mb-3 space-y-0.5">
          {bots.map((b) => {
            const dm = dmFor(b.id);
            const active = dm && dm.id === activeRoomId;
            const n = dm ? unread[dm.id] ?? 0 : 0;
            const state = botStates[b.id] ?? 'idle';
            const activity = activityFor(b, messages);
            const sub = state === 'idle' ? b.title || '@' + b.handle : activity ? activity : STATE_LABEL[state];
            return (
              <li key={b.id}>
                <div
                  className={cn('group flex cursor-pointer items-center gap-2.5 rounded-2xl px-2.5 py-2 hover:bg-panel/70', active && 'bg-panel shadow-[var(--shadow)]')}
                  onClick={() => void openDm(b.id)}
                >
                  <Avatar bot={b} state={state} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-medium">{b.name}</span>
                      {n > 0 && <span className="rounded-full bg-ink px-1.5 text-[10.5px] font-semibold text-ink-fg">{n}</span>}
                    </div>
                    <div className={cn('truncate text-[11.5px]', state === 'idle' ? 'text-muted' : state === 'blocked' ? 'text-warn' : state === 'error' ? 'text-bad' : 'text-ok', activity && 'font-mono')}>{sub}</div>
                  </div>
                  <button
                    className="hidden rounded-full p-1.5 text-muted hover:bg-card2 hover:text-fg group-hover:block"
                    title="Bot settings"
                    onClick={(e) => { e.stopPropagation(); openPanel('memory', b.id); openDialog({ kind: 'bot', bot: b }); }}
                  >
                    <Settings2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
          {!bots.length && <li className="px-3 py-2 text-[12.5px] text-muted">No teammates yet.</li>}
        </ul>

        <SectionHeader label="Group chats" onAdd={() => openDialog({ kind: 'room', room: null })} addTitle="New group chat" />
        <ul className="space-y-0.5">
          {groups.map((r) => (
            <RoomItem key={r.id} room={r} active={r.id === activeRoomId} unread={unread[r.id] ?? 0} onClick={() => setActiveRoom(r.id)} />
          ))}
          {!groups.length && <li className="px-3 py-2 text-[12.5px] text-muted">Put a few bots in a room and they hand work to each other.</li>}
        </ul>
      </div>

      <div className="flex items-center gap-1 px-2 pb-1">
        <button className="flex h-8 flex-1 items-center gap-2 rounded-full px-3 text-[12.5px] text-muted hover:bg-panel/70 hover:text-fg" onClick={() => openPanel('usage')}>
          <BarChart3 size={14} /> Usage
        </button>
        <button className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-panel/70 hover:text-fg" title={dark ? 'Light theme' : 'Dark theme'} onClick={() => setDark(!dark)}>
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </aside>
  );
}

function SectionHeader({ label, onAdd, addTitle }: { label: string; onAdd: () => void; addTitle: string }) {
  return (
    <div className="mb-0.5 flex items-center justify-between px-3 pt-2">
      <span className="text-[11.5px] font-medium text-dim">{label}</span>
      <button className="rounded-full p-1 text-dim hover:bg-panel/70 hover:text-fg" onClick={onAdd} title={addTitle}>
        <Plus size={14} />
      </button>
    </div>
  );
}

function RoomItem({ room, active, unread, onClick }: { room: Room; active: boolean; unread: number; onClick: () => void }) {
  const bots = useStore((s) => s.bots);
  const botStates = useStore((s) => s.botStates);
  const busy = room.memberIds.filter((id) => ['thinking', 'working', 'blocked', 'waiting'].includes(botStates[id] ?? 'idle')).length;
  return (
    <li>
      <div className={cn('flex cursor-pointer items-center gap-2.5 rounded-2xl px-2.5 py-2 hover:bg-panel/70', active && 'bg-panel shadow-[var(--shadow)]')} onClick={onClick}>
        <span className={cn('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-card2', busy ? 'text-ok' : 'text-muted')}><Hash size={15} /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{room.name}</div>
          <div className="truncate text-[11.5px] text-muted">{busy ? busy + ' of ' + room.memberIds.length + ' working' : room.memberIds.map((id) => botById(bots, id)?.avatar ?? '').join(' ')}</div>
        </div>
        {unread > 0 && <span className="rounded-full bg-ink px-1.5 text-[10.5px] font-semibold text-ink-fg">{unread}</span>}
      </div>
    </li>
  );
}
