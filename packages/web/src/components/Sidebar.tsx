import { useState } from 'react';
import { ChevronRight, Plus, Hand, Settings2, PanelLeftClose } from 'lucide-react';
import { useStore, botById, NARROW_SIDEBAR_QUERY } from '../store';
import { Avatar, RoomAvatar, cn } from './ui';
import { BotGroupHeader, useBotGroups } from './BotGroups';
import { ProfileMenu } from './ProfileMenu';
import { RocketMark } from './RocketMark';
import { api } from '../lib/api';
import { useMediaQuery } from '../lib/useMediaQuery';
import { STATUS_LABEL, avatarStatus, isWorking, useBotStatus, type BotStatus } from '../lib/botStatus';
import { toolPhrase } from '../lib/toolPhrases';
import type { Bot, Message, ProviderInfo, Room } from '@pocketrocket/shared';

/** Shared by bot and room rows: a whole-row button, so Tab reaches every chat and Enter/Space opens it. */
const ROW = 'flex w-full min-w-0 items-center gap-2.5 rounded-sm px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';

const GROUPS_COLLAPSED_KEY = 'pocketrocket.groupChatsCollapsed';
/** Browser storage is a convenience here: with none, the list just starts expanded. */
function readGroupsCollapsed() {
  try {
    return localStorage.getItem(GROUPS_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

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

/**
 * What a bot is doing right now, from its latest unfinished tool call in any loaded room. In plain words: tool
 * identifiers and command text stay out of a list that gets screen-shared.
 */
function activityFor(bot: Bot, messages: Record<string, Message[]>): { text: string; toBot: string | null } | null {
  let latest: Message | null = null;
  for (const list of Object.values(messages)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.authorId === bot.id && m.kind === 'tool') { if (!latest || m.createdAt > latest.createdAt) latest = m; break; }
    }
  }
  if (!latest || !latest.payload || (latest.payload as { done?: boolean }).done) return null;
  const p = latest.payload as { name: string; input: Record<string, unknown> };
  const file = String(p.input?.file_path ?? '').split(/[\\/]/).pop() ?? '';
  const toBot = typeof p.input?.to_bot === 'string' ? p.input.to_bot.replace(/^@/, '') : null;
  return { text: (toolPhrase(p.name, 'now') + ' ' + file).trim(), toBot };
}

export function Sidebar() {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const messages = useStore((s) => s.messages);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const unread = useStore((s) => s.unread);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const openDialog = useStore((s) => s.openDialog);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const toast = useStore((s) => s.toast);
  const { statusOf, needsYouRoom } = useBotStatus();
  const connected = useStore((s) => s.connected);
  const helloReceived = useStore((s) => s.helloReceived);
  // P9: a paired phone may not create or edit bots and rooms, change settings or open the workspace (403).
  const device = useStore((s) => s.device);
  // On a narrow window this sidebar is a drawer over the chat (App.tsx), so picking a chat closes it.
  const inDrawer = useMediaQuery(NARROW_SIDEBAR_QUERY);
  const leaveDrawer = () => { if (inDrawer) setSidebarOpen(false); };
  const [groupsCollapsed, setGroupsCollapsed] = useState(readGroupsCollapsed);
  const toggleGroups = () => {
    setGroupsCollapsed(!groupsCollapsed);
    try {
      localStorage.setItem(GROUPS_COLLAPSED_KEY, groupsCollapsed ? '0' : '1');
    } catch {
      /* storage unavailable; the list still folds for this session */
    }
  };

  const activeProvider = providers?.providers.find((p) => p.id === settings.provider);
  const status = providerStatus(connected, activeProvider, !!providers);

  const dms = rooms.filter((r) => r.kind === 'dm');
  const groups = rooms.filter((r) => r.kind === 'group');
  const dmFor = (botId: string) => dms.find((r) => r.memberIds[0] === botId);
  // Who the user is holding up, pinned above every group so it can't be missed in a fleet.
  const needsYou = bots.filter((b) => statusOf(b.id) === 'needs_you');

  const { sections, collapsed, toggle, move } = useBotGroups(bots, groups);

  const openRoom = (roomId: string) => {
    useStore.getState().closePage();
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
    <aside className="flex w-full min-w-0 flex-col">
      <div className="flex h-14 items-center justify-between gap-1.5 pl-3 pr-1.5">
        <div className="flex min-w-0 items-center gap-2 text-ui font-semibold">
          <RocketMark size={24} />
          <span className="truncate">PocketRocket</span>
        </div>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title="Hide bots (Ctrl+B)"
          aria-label="Hide bots"
          onClick={toggleSidebar}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>
      {status.label && (
        <button
          className={cn('mx-3 mb-1 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 self-start rounded-full bg-card2 px-2.5 py-1 text-hint hover:text-fg', status.label && connected ? 'text-warn' : 'text-muted')}
          title="Claude settings"
          onClick={() => openDialog({ kind: 'settings' })}
        >
          <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status.dot)} />
          <span className="truncate">{status.label}</span>
        </button>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {needsYou.length > 0 && (
          <section aria-label={'Needs you: ' + needsYou.length} className="mb-1">
            <div className="mb-0.5 flex items-center gap-1.5 px-3 pt-2 text-label text-warn">
              <Hand size={13} aria-hidden /> Needs you <span className="text-hint">{needsYou.length}</span>
            </div>
            <ul className="ml-2 space-y-0.5 border-l border-warn/60 pl-1">
              {needsYou.map((b) => {
                const roomId = needsYouRoom(b.id);
                return (
                  <BotRow
                    key={b.id}
                    bot={b}
                    status="needs_you"
                    activity={null}
                    active={!!roomId && roomId === activeRoomId}
                    unread={roomId ? unread[roomId] ?? 0 : 0}
                    onOpen={() => (roomId ? openRoom(roomId) : void openDm(b.id))}
                    onSettings={device ? undefined : () => openDialog({ kind: 'bot', bot: b })}
                  />
                );
              })}
            </ul>
          </section>
        )}
        <SectionHeader label="Bots" onAdd={device ? undefined : () => openDialog({ kind: 'bot', bot: null })} addTitle="New bot" />
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
            return (
              <BotRow
                key={b.id}
                bot={b}
                status={statusOf(b.id)}
                activity={activityFor(b, messages)}
                active={!!dm && dm.id === activeRoomId}
                unread={dm ? unread[dm.id] ?? 0 : 0}
                onOpen={() => void openDm(b.id)}
                onSettings={device ? undefined : () => openDialog({ kind: 'bot', bot: b })}
              />
            );
                  })}
                </ul>
              )}
            </div>
          ))}
          {/* Before the hub's hello there is nothing to show yet, which is not the same as having no bots. */}
          {!helloReceived ? <SkeletonRows count={3} /> : !bots.length && <div className="px-3 py-2 text-ui text-muted">No bots yet.</div>}
        </div>

        <SectionHeader
          label="Group chats"
          onAdd={device ? undefined : () => openDialog({ kind: 'room', room: null })}
          addTitle="New group chat"
          collapsed={groupsCollapsed}
          onToggle={toggleGroups}
          unread={groups.reduce((n, r) => n + (unread[r.id] ?? 0), 0)}
        />
        {groupsCollapsed ? null : !helloReceived ? (
          <SkeletonRows count={1} />
        ) : (
          <ul className="space-y-0.5">
            {groups.map((r) => (
              <RoomItem key={r.id} room={r} statusOf={statusOf} active={r.id === activeRoomId} unread={unread[r.id] ?? 0} onClick={() => openRoom(r.id)} />
            ))}
            {!groups.length && <li className="px-3 py-2 text-ui text-muted">Bots here pass work to each other.</li>}
          </ul>
        )}
      </div>

      <ProfileMenu onNavigate={leaveDrawer} />
    </aside>
  );
}

/** One bot in the sidebar. The second line says who must act, in words and color, and never names a tool. */
function BotRow({ bot, status, activity, active, unread, onOpen, onSettings }: {
  bot: Bot;
  status: BotStatus;
  activity: { text: string; toBot: string | null } | null;
  active: boolean;
  unread: number;
  onOpen: () => void;
  onSettings?: () => void;
}) {
  const sub = status === 'idle' ? bot.title || '@' + bot.handle
    : status === 'waiting_on_bot' ? (activity?.toBot ? 'Waiting on @' + activity.toBot : STATUS_LABEL[status])
    : status === 'needs_you' || status === 'paused' ? STATUS_LABEL[status]
    : activity?.text ?? STATUS_LABEL[status];
  const tone = status === 'needs_you' || status === 'paused' ? 'text-warn'
    : status === 'idle' || status === 'waiting_on_bot' ? 'text-muted'
    : status === 'error' ? 'text-bad' : 'text-ok';
  return (
    <li className={cn('group flex items-center rounded-sm hover:bg-hover', active && 'bg-active')}>
      <button className={ROW} aria-current={active ? 'page' : undefined} onClick={onOpen}>
        <Avatar bot={bot} {...avatarStatus(status)} size={34} />
        <span className="block min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-ui font-medium" title={bot.name}>{bot.name}</span>
            {unread > 0 && <span className="rounded-full bg-ink px-1.5 text-hint font-medium text-ink-fg">{unread}<span className="sr-only"> unread</span></span>}
          </span>
          <span className={cn('block truncate text-hint', tone)} title={sub}>
            {status === 'needs_you' && <Hand size={11} aria-hidden className="mr-1 inline align-[-1px]" />}
            {sub}
          </span>
        </span>
      </button>
      {/* A sibling of the row button, not inside it. Shown on hover, whenever focus is anywhere in the
          row (so Tab finds it), and always on touch screens, which have no hover to reveal it. */}
      {onSettings && <button
        className="mr-1.5 shrink-0 rounded-sm p-1.5 text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        title="Bot settings"
        aria-label={bot.name + ' settings'}
        onClick={onSettings}
      >
        <Settings2 size={14} />
      </button>}
    </li>
  );
}

function SectionHeader({ label, onAdd, addTitle, collapsed, onToggle, unread = 0 }: { label: string; onAdd?: () => void; addTitle: string; collapsed?: boolean; onToggle?: () => void; unread?: number }) {
  return (
    <div className="mb-0.5 flex items-center justify-between px-3 pt-2">
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-1 rounded-xs text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <ChevronRight size={12} aria-hidden className={cn('shrink-0 text-dim', !collapsed && 'rotate-90')} />
          <span className="truncate text-label text-dim">{label}</span>
          {/* Folded away, unread messages would otherwise be out of sight. */}
          {collapsed && unread > 0 && <span className="ml-1 shrink-0 rounded-full bg-ink px-1.5 text-hint font-medium text-ink-fg">{unread}<span className="sr-only"> unread</span></span>}
        </button>
      ) : (
        <span className="text-label text-dim">{label}</span>
      )}
      {onAdd && (
        <button className="rounded-sm p-1 text-dim hover:bg-hover hover:text-fg" onClick={onAdd} title={addTitle}>
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}

function RoomItem({ room, statusOf, active, unread, onClick }: { room: Room; statusOf: (botId: string) => BotStatus; active: boolean; unread: number; onClick: () => void }) {
  const bots = useStore((s) => s.bots);
  const busy = room.memberIds.filter((id) => isWorking(statusOf(id))).length;
  const needs = room.memberIds.filter((id) => statusOf(id) === 'needs_you').length;
  return (
    <li>
      <button className={cn(ROW, 'hover:bg-hover', active && 'bg-active')} aria-current={active ? 'page' : undefined} onClick={onClick}>
        <RoomAvatar room={room} size={34} className={busy ? 'text-ok' : 'text-muted'} />
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-ui font-medium">{room.name}</span>
          <span className={cn('block truncate text-hint', needs ? 'text-warn' : 'text-muted')}>{needs ? needs + (needs === 1 ? ' needs you' : ' need you') : busy ? busy + ' of ' + room.memberIds.length + ' working' : room.memberIds.map((id) => botById(bots, id)?.name).filter(Boolean).join(', ')}</span>
        </span>
        {unread > 0 && <span className="rounded-full bg-ink px-1.5 text-hint font-medium text-ink-fg">{unread}<span className="sr-only"> unread</span></span>}
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
