import { Plus, Hash, Settings2, Settings, Sun, Moon, BarChart3, PanelLeftClose, FolderOpen } from 'lucide-react';
import { MODELS } from '@pocketrocket/shared';
import { useStore, botById, NARROW_SIDEBAR_QUERY } from '../store';
import { Avatar, STATE_LABEL, cn } from './ui';
import { BotGroupHeader, useBotGroups } from './BotGroups';
import { RocketMark } from './RocketMark';
import { resolveDark } from '../lib/theme';
import { api } from '../lib/api';
import { useMediaQuery } from '../lib/useMediaQuery';
import type { Bot, Message, ProviderInfo, Room } from '@pocketrocket/shared';

/** Shared by bot and room rows: a whole-row button, so Tab reaches every chat and Enter/Space opens it. */
const ROW = 'flex w-full min-w-0 items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60';

/**
 * The dot on the provider chip. Green only when the hub is connected and says the provider is ready;
 * the hard-coded green it replaced stayed green through a signed-out CLI and a dead hub alike.
 */
function providerStatus(connected: boolean, provider: ProviderInfo | undefined, loaded: boolean): { dot: string; label: string | null } {
  if (!connected) return { dot: 'bg-dim', label: 'Not connected' };
  if (!loaded || !provider) return { dot: 'bg-dim', label: null };
  const { check } = provider;
  if (check.ok) return { dot: 'bg-ok', label: null };
  if (check.unresponsive) return { dot: 'bg-warn', label: provider.label + " didn't respond" };
  if (!check.version) return { dot: 'bg-warn', label: provider.label + " isn't set up" };
  return { dot: 'bg-warn', label: provider.label + ' needs sign-in' };
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
  const name = p.name.replace('mcp__pocketrocket__', '').replace('mcp__browser__browser_', 'web ');
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
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const updateSettings = useStore((s) => s.updateSettings);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const toast = useStore((s) => s.toast);
  const connected = useStore((s) => s.connected);
  const helloReceived = useStore((s) => s.helloReceived);
  // On a narrow window this sidebar is a drawer over the chat (App.tsx), so picking a chat closes it.
  const inDrawer = useMediaQuery(NARROW_SIDEBAR_QUERY);
  const leaveDrawer = () => { if (inDrawer) setSidebarOpen(false); };
  const dark = resolveDark(settings.theme);
  const toggleTheme = () => void updateSettings({ theme: dark ? 'light' : 'dark' });
  /**
   * The workspace lives on whatever computer the hub runs on, so the hub is what opens it. On a server hub
   * that is the virtual desktop, and the toast says so rather than leaving the user staring at their own
   * unchanged screen waiting for a window that was never going to appear here.
   */
  const openWorkspace = async () => {
    try {
      const r = await api.openWorkspace();
      if (!r.ok) return toast(r.error ? 'Could not open the workspace: ' + r.error : 'Could not open the workspace', true);
      const WHERE: Record<string, string> = {
        explorer: 'Workspace opened in File Explorer',
        finder: 'Workspace opened in Finder',
        screen: 'Workspace opened on the virtual desktop — see the Screen tab',
        'file-manager': 'Workspace opened in your file manager',
      };
      toast(WHERE[r.where] ?? 'Workspace opened');
    } catch (e) {
      toast('Could not open the workspace: ' + (e as Error).message, true);
    }
  };

  const activeProvider = providers?.providers.find((p) => p.id === settings.provider);
  const modelLabel = activeProvider?.models.find((m) => m.id === settings.defaultModel)?.label
    ?? MODELS.find((m) => m.id === settings.defaultModel)?.label
    ?? settings.defaultModel;
  const status = providerStatus(connected, activeProvider, !!providers);

  const dms = rooms.filter((r) => r.kind === 'dm');
  const groups = rooms.filter((r) => r.kind === 'group');
  const dmFor = (botId: string) => dms.find((r) => r.memberIds[0] === botId);
  const busy = bots.filter((b) => ['thinking', 'working', 'blocked', 'waiting'].includes(botStates[b.id] ?? 'idle')).length;

  const { sections, collapsed, toggle, move } = useBotGroups(bots, groups);

  const openRoom = (roomId: string) => {
    setActiveRoom(roomId);
    leaveDrawer();
  };
  const openDm = async (botId: string) => {
    const existing = dmFor(botId);
    if (existing) return openRoom(existing.id);
    const bot = botById(bots, botId);
    if (!bot) return;
    try {
      const room = await api.rooms.create({ kind: 'dm', name: bot.name, memberIds: [botId], coordinatorBotId: null });
      openRoom(room.id);
    } catch (e) {
      toast("Couldn't open a chat with " + bot.name + ': ' + (e as Error).message, true);
    }
  };

  return (
    <aside className="flex w-[236px] max-w-full shrink-0 flex-col">
      <div className="flex h-11 items-center justify-between px-3">
        <div className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
          <RocketMark size={24} />
          PocketRocket
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11.5px] text-dim">{busy ? busy + ' working' : ''}</span>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-full text-dim hover:bg-panel/70 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            title="Hide bots (Ctrl+B)"
            aria-label="Hide bots"
            onClick={toggleSidebar}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      </div>
      <button
        className={cn('mx-3 mb-1 flex items-center gap-1.5 self-start rounded-full bg-card2 px-2.5 py-1 text-[11.5px] hover:text-fg', status.label && connected ? 'text-warn' : 'text-muted')}
        title="Provider settings"
        onClick={() => openDialog({ kind: 'settings' })}
      >
        <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
        {status.label ?? (activeProvider?.label ?? 'Claude') + ' · ' + modelLabel}
      </button>

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        <SectionHeader label="Bots" onAdd={() => openDialog({ kind: 'bot', bot: null })} addTitle="New bot" />
        <div className="mb-3">
          {sections.map((section, i) => (
            <div key={section.key}>
              <BotGroupHeader
                group={section}
                index={i}
                count={section.bots.length}
                isCollapsed={collapsed.includes(section.key)}
                onToggle={() => toggle(section.key)}
                onMove={move}
              />
              {!collapsed.includes(section.key) && (
                // Indented past the header's chevron: without this the rows start left of their own
                // heading and the grouping reads as flat.
                <ul className="ml-2 space-y-0.5 border-l border-line/60 pl-1">
                  {section.bots.map((b) => {
            const dm = dmFor(b.id);
            const active = dm && dm.id === activeRoomId;
            const n = dm ? unread[dm.id] ?? 0 : 0;
            const state = botStates[b.id] ?? 'idle';
            const activity = activityFor(b, messages);
            const sub = state === 'idle' ? b.title || '@' + b.handle : activity ? activity : STATE_LABEL[state];
            return (
              <li key={b.id} className={cn('group flex items-center rounded-2xl hover:bg-panel/70', active && 'bg-panel shadow-[var(--shadow)]')}>
                <button className={ROW} aria-current={active ? 'page' : undefined} onClick={() => void openDm(b.id)}>
                  <Avatar bot={b} state={state} size={34} />
                  <span className="block min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-medium">{b.name}</span>
                      {n > 0 && <span className="rounded-full bg-ink px-1.5 text-[10.5px] font-semibold text-ink-fg">{n}<span className="sr-only"> unread</span></span>}
                    </span>
                    <span className={cn('block truncate text-[11.5px]', state === 'idle' ? 'text-muted' : state === 'blocked' ? 'text-warn' : state === 'error' ? 'text-bad' : 'text-ok', activity && 'font-mono')}>{sub}</span>
                  </span>
                </button>
                {/* A sibling of the row button, not inside it. Shown on hover, whenever focus is anywhere in the
                    row (so Tab finds it), and always on touch screens, which have no hover to reveal it. */}
                <button
                  className="mr-1.5 shrink-0 rounded-full p-1.5 text-muted opacity-0 hover:bg-card2 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  title="Bot settings"
                  aria-label={b.name + ' settings'}
                  onClick={() => openDialog({ kind: 'bot', bot: b })}
                >
                  <Settings2 size={14} />
                </button>
              </li>
            );
                  })}
                </ul>
              )}
            </div>
          ))}
          {/* Before the hub's hello there is nothing to show yet, which is not the same as having no bots. */}
          {!helloReceived ? <SkeletonRows count={3} /> : !bots.length && <div className="px-3 py-2 text-[12.5px] text-muted">No bots yet.</div>}
        </div>

        <SectionHeader label="Group chats" onAdd={() => openDialog({ kind: 'room', room: null })} addTitle="New group chat" />
        {!helloReceived ? (
          <SkeletonRows count={1} />
        ) : (
          <ul className="space-y-0.5">
            {groups.map((r) => (
              <RoomItem key={r.id} room={r} active={r.id === activeRoomId} unread={unread[r.id] ?? 0} onClick={() => openRoom(r.id)} />
            ))}
            {!groups.length && <li className="px-3 py-2 text-[12.5px] text-muted">Put a few bots in a room and they hand work to each other.</li>}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-1 px-2 pb-1">
        <button className="flex h-8 flex-1 items-center gap-2 rounded-full px-3 text-[12.5px] text-muted hover:bg-panel/70 hover:text-fg" onClick={() => { leaveDrawer(); openPanel('usage'); }}>
          <BarChart3 size={14} /> Usage
        </button>
        <button className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-panel/70 hover:text-fg" title="Open the shared workspace folder" onClick={() => void openWorkspace()}>
          <FolderOpen size={15} />
        </button>
        <button className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-panel/70 hover:text-fg" title="Settings" onClick={() => openDialog({ kind: 'settings' })}>
          <Settings size={15} />
        </button>
        <button className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-panel/70 hover:text-fg" title={dark ? 'Light theme' : 'Dark theme'} onClick={toggleTheme}>
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
      <button className={cn(ROW, 'hover:bg-panel/70', active && 'bg-panel shadow-[var(--shadow)]')} aria-current={active ? 'page' : undefined} onClick={onClick}>
        <span aria-hidden className={cn('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-card2', busy ? 'text-ok' : 'text-muted')}><Hash size={15} /></span>
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{room.name}</span>
          <span className="block truncate text-[11.5px] text-muted">{busy ? busy + ' of ' + room.memberIds.length + ' working' : room.memberIds.map((id) => botById(bots, id)?.avatar ?? '').join(' ')}</span>
        </span>
        {unread > 0 && <span className="rounded-full bg-ink px-1.5 text-[10.5px] font-semibold text-ink-fg">{unread}<span className="sr-only"> unread</span></span>}
      </button>
    </li>
  );
}

/** Placeholder rows while the hub has not said hello yet. Hidden from screen readers, which get the text instead. */
function SkeletonRows({ count }: { count: number }) {
  return (
    <div role="status">
      <span className="sr-only">Loading…</span>
      <ul aria-hidden className="space-y-0.5">
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="flex items-center gap-2.5 px-2.5 py-2">
            <span className="h-[34px] w-[34px] shrink-0 rounded-full bg-card2 motion-safe:animate-pulse" />
            <span className="flex-1 space-y-1.5">
              <span className="block h-2.5 w-2/3 rounded-full bg-card2 motion-safe:animate-pulse" />
              <span className="block h-2 w-1/2 rounded-full bg-card2/70 motion-safe:animate-pulse" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
