import { useState } from 'react';
import { ChevronRight, Plus, Hand, Settings2, PanelLeftClose, QrCode, Search, UserPlus, MessagesSquare } from 'lucide-react';
import { useStore, botById, NARROW_SIDEBAR_QUERY } from '../store';
import { Avatar, Menu, MenuContent, MenuItem, cn } from './ui';
import { Podium } from './Podium';
import { ProfileMenu } from './ProfileMenu';
import { api } from '../lib/api';
import { useMediaQuery } from '../lib/useMediaQuery';
import { STATUS_LABEL, avatarStatus, isWorking, useBotStatus, type BotStatus } from '../lib/botStatus';
import { toolPhrase } from '../lib/toolPhrases';
import type { Bot, Message, ProviderInfo, Room } from '@pocketrocket/shared';

/** Shared by bot and room rows: a whole-row button, so Tab reaches every chat and Enter/Space opens it. */
/** The round buttons at the top and bottom of the sidebar. */
const ROUND = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted ring-1 ring-line hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

const ROW = 'flex w-full min-w-0 items-center gap-2.5 rounded-sm px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';

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

const COLLAPSED_KEY = 'pocketrocket.collapsedSections';
/** The section of bots outside every group. Groups use their room id. */
const SOLO_SECTION = 'bots';

function readCollapsed(): Set<string> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Which sidebar sections are folded. Kept per device: a phone and a desktop want different lists. */
function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* still works until reload */ }
  };
  return { collapsed, toggle };
}

export function Sidebar() {
  const { collapsed, toggle } = useCollapsedSections();
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const messages = useStore((s) => s.messages);
  const previews = useStore((s) => s.previews);
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

  const activeProvider = providers?.providers.find((p) => p.id === settings.provider);
  const status = providerStatus(connected, activeProvider, !!providers);

  const dms = rooms.filter((r) => r.kind === 'dm');
  const groups = rooms.filter((r) => r.kind === 'group');
  const dmFor = (botId: string) => dms.find((r) => r.memberIds[0] === botId);
  // Who the user is holding up, pinned above every group so it can't be missed in a fleet.
  const needsYou = bots.filter((b) => statusOf(b.id) === 'needs_you');
  // A bot already reachable from its group chat row stays out of this list — otherwise every fleet bot
  // shows up twice, once here and once inside each room it is in.
  const inAnyGroup = new Set(groups.flatMap((r) => r.memberIds));
  const podiumBots = settings.podiumBotIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const soloBots = bots.filter((b) => !inAnyGroup.has(b.id) && !podiumBots.includes(b));

  /** A folded section still shows the chat you are in, so opening one from search never loses your place. */
  const visibleIn = (section: string, list: Bot[]) => {
    if (!collapsed.has(section)) return list;
    return list.filter((b) => { const dm = dmFor(b.id); return !!dm && dm.id === activeRoomId; });
  };
  /** Unread chats folded out of sight, which the section header has to own up to. */
  const hiddenUnread = (list: Bot[], visible: Bot[]) => list
    .filter((b) => !visible.includes(b))
    .reduce((n, b) => { const dm = dmFor(b.id); return n + (dm ? unread[dm.id] ?? 0 : 0); }, 0);

  const row = (b: Bot) => {
    const dm = dmFor(b.id);
    return (
      <BotRow
        key={b.id}
        bot={b}
        status={statusOf(b.id)}
        activity={activityFor(b, messages)}
        preview={previews[b.id]?.text ?? null}
        active={!!dm && dm.id === activeRoomId}
        unread={dm ? unread[dm.id] ?? 0 : 0}
        onOpen={() => void openDm(b.id)}
        onSettings={device ? undefined : () => openDialog({ kind: 'bot', bot: b })}
      />
    );
  };

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
      <div className="flex h-14 items-center justify-between gap-1.5 pl-2.5 pr-1.5">
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title="Hide bots (Ctrl+B)"
          aria-label="Hide bots"
          onClick={toggleSidebar}
        >
          <PanelLeftClose size={15} />
        </button>
        <div className="flex shrink-0 items-center gap-2 pr-1.5">
          <button className={ROUND} title="Search every chat" aria-label="Search every chat" onClick={() => openDialog({ kind: 'search' })}><Search size={16} /></button>
          {!device && (
            <Menu.Root>
              <Menu.Trigger className={ROUND} title="New" aria-label="New"><Plus size={17} /></Menu.Trigger>
              <Menu.Portal>
                <MenuContent align="end">
                  <MenuItem onSelect={() => openDialog({ kind: 'bot', bot: null })}><UserPlus size={15} aria-hidden /> New bot</MenuItem>
                  <MenuItem onSelect={() => openDialog({ kind: 'room', room: null })}><MessagesSquare size={15} aria-hidden /> New group chat</MenuItem>
                </MenuContent>
              </Menu.Portal>
            </Menu.Root>
          )}
        </div>
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
                    preview={null}
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
        {bots.length > 0 && (
          <Podium
            bots={podiumBots}
            statusOf={statusOf}
            activeBotId={rooms.find((r) => r.id === activeRoomId && r.kind === 'dm')?.memberIds[0] ?? null}
            unreadOf={(id) => { const dm = dmFor(id); return dm ? unread[dm.id] ?? 0 : 0; }}
            onOpen={(id) => void openDm(id)}
            canEdit={!device}
          />
        )}
        {soloBots.length > 0 && (
          <SoloHeader
            collapsed={collapsed.has(SOLO_SECTION)}
            count={soloBots.length}
            unread={hiddenUnread(soloBots, visibleIn(SOLO_SECTION, soloBots))}
            onToggle={() => toggle(SOLO_SECTION)}
          />
        )}
        <div className="mb-3">
          {/* Only bots outside every group: one in a group is listed under that group below. */}
          <ul className="space-y-0.5">{visibleIn(SOLO_SECTION, soloBots).map(row)}</ul>
          {/* Before the hub's hello there is nothing to show yet, which is not the same as having no bots. */}
          {!helloReceived ? <SkeletonRows count={3} /> : !bots.length && <div className="px-3 py-2 text-ui text-muted">No bots yet.</div>}
        </div>

        {!helloReceived ? (
          <SkeletonRows count={1} />
        ) : (
          groups.map((r) => {
            const members = r.memberIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b && !podiumBots.includes(b));
            const visible = visibleIn(r.id, members);
            return (
              <section key={r.id} aria-label={r.name} className={collapsed.has(r.id) ? 'mb-1' : 'mb-3'}>
                <GroupHeader
                  room={r}
                  statusOf={statusOf}
                  active={r.id === activeRoomId}
                  unread={(unread[r.id] ?? 0) + hiddenUnread(members, visible)}
                  collapsed={collapsed.has(r.id)}
                  count={members.length}
                  onToggle={() => toggle(r.id)}
                  onClick={() => openRoom(r.id)}
                  onSettings={device ? undefined : () => openDialog({ kind: 'room', room: r })}
                />
                <ul className="space-y-0.5">{visible.map(row)}</ul>
              </section>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-1 pr-2.5">
        <div className="min-w-0 flex-1"><ProfileMenu onNavigate={leaveDrawer} /></div>
        <button className={ROUND} title="Pair a phone" aria-label="Pair a phone" onClick={() => openDialog({ kind: 'settings', section: 'devices' })}><QrCode size={16} /></button>
      </div>
    </aside>
  );
}

/** One bot in the sidebar. The second line says who must act, in words and color, and never names a tool. */
function BotRow({ bot, status, activity, preview, active, unread, onOpen, onSettings }: {
  bot: Bot;
  status: BotStatus;
  activity: { text: string; toBot: string | null } | null;
  /** Its latest message, as plain words. */
  preview: string | null;
  active: boolean;
  unread: number;
  onOpen: () => void;
  onSettings?: () => void;
}) {
  const idle = preview ? preview.replace(/[*_`#>~]/g, '').replace(/\s+/g, ' ').trim() : '@' + bot.handle;
  const sub = status === 'idle' ? idle
    : status === 'waiting_on_bot' ? (activity?.toBot ? 'Waiting on @' + activity.toBot : STATUS_LABEL[status])
    : status === 'needs_you' || status === 'paused' ? STATUS_LABEL[status]
    : activity?.text ?? STATUS_LABEL[status];
  const tone = status === 'needs_you' || status === 'paused' ? 'text-warn'
    : status === 'idle' || status === 'waiting_on_bot' ? 'text-muted'
    : status === 'error' ? 'text-bad' : 'text-ok';
  const label = bot.title ? bot.name + ' · ' + bot.title : bot.name;
  return (
    <li className={cn('group flex items-center rounded-lg hover:bg-hover', active && 'bg-active')}>
      <button className={ROW} aria-current={active ? 'page' : undefined} onClick={onOpen}>
        <Avatar bot={bot} {...avatarStatus(status)} size={34} />
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-ui font-medium" title={label}>{label}</span>
          <span className={cn('block truncate text-hint', tone)} title={sub}>
            {status === 'needs_you' && <Hand size={11} aria-hidden className="mr-1 inline align-[-1px]" />}
            {sub}
          </span>
        </span>
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-[#4aa3ff]"><span className="sr-only">{unread} unread</span></span>}
      </button>
      {/* A sibling of the row button, not inside it. Shown on hover, whenever focus is anywhere in the
          row (so Tab finds it), and always on touch screens, which have no hover to reveal it. */}
      {onSettings && <button
        className="mr-1.5 hidden shrink-0 rounded-sm p-1.5 text-muted hover:bg-hover hover:text-fg focus-visible:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:block group-focus-within:block [@media(hover:none)]:block"
        title="Bot settings"
        aria-label={bot.name + ' settings'}
        onClick={onSettings}
      >
        <Settings2 size={14} />
      </button>}
    </li>
  );
}

/** Folds a section. A separate button from the group's name, because the name opens the group chat. */
function CollapseToggle({ name, collapsed, count, onToggle }: { name: string; collapsed: boolean; count: number; onToggle: () => void }) {
  // Nothing to fold: holds the space so the section names stay lined up.
  if (count === 0) return <span aria-hidden className="ml-1 h-6 w-6 shrink-0" />;
  return (
    <button
      className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      title={(collapsed ? 'Show ' : 'Hide ') + 'the bots in ' + name}
      aria-label={name + ' bots'}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <ChevronRight size={13} aria-hidden className={cn('motion-safe:transition-transform', !collapsed && 'rotate-90')} />
    </button>
  );
}

/** How many bots a folded section is holding. */
function FoldedCount({ collapsed, count }: { collapsed: boolean; count: number }) {
  return collapsed && count > 0 ? <span className="shrink-0 text-hint text-dim">{count}</span> : null;
}

/** The header of the bots outside every group. */
function SoloHeader({ collapsed, count, unread, onToggle }: { collapsed: boolean; count: number; unread: number; onToggle: () => void }) {
  return (
    <div className="mb-0.5 flex items-center pt-2">
      <CollapseToggle name="Bots" collapsed={collapsed} count={count} onToggle={onToggle} />
      <span className="flex min-w-0 items-center gap-1.5 px-1 text-label text-dim">
        Bots
        <FoldedCount collapsed={collapsed} count={count} />
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-[#4aa3ff]"><span className="sr-only">{unread} unread</span></span>}
      </span>
    </div>
  );
}

/** A group's name, which opens its chat. Its bots are listed below it, each opening a chat of its own. */
function GroupHeader({ room, statusOf, active, unread, collapsed, count, onToggle, onClick, onSettings }: {
  room: Room;
  statusOf: (botId: string) => BotStatus;
  active: boolean;
  /** The group chat's unread messages, plus those of any one-on-one chats folded away under it. */
  unread: number;
  collapsed: boolean;
  /** Bots listed under this group. */
  count: number;
  onToggle: () => void;
  onClick: () => void;
  onSettings?: () => void;
}) {
  const busy = room.memberIds.filter((id) => isWorking(statusOf(id))).length;
  const needs = room.memberIds.filter((id) => statusOf(id) === 'needs_you').length;
  return (
    <div className={cn('group mb-0.5 flex items-center rounded-sm hover:bg-hover', active && 'bg-active')}>
      <CollapseToggle name={room.name} collapsed={collapsed} count={count} onToggle={onToggle} />
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left text-label text-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        title={'Open the ' + room.name + ' group chat'}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
      >
        <span className={cn('truncate', active && 'text-fg')}>{room.name}</span>
        <FoldedCount collapsed={collapsed} count={count} />
        {needs > 0 ? <span className="shrink-0 text-hint text-warn">{needs} {needs === 1 ? 'needs' : 'need'} you</span> : busy > 0 && <span className="shrink-0 text-hint text-ok">{busy} working</span>}
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-[#4aa3ff]"><span className="sr-only">{unread} unread</span></span>}
      </button>
      {onSettings && <button
        className="mr-1.5 hidden shrink-0 rounded-sm p-1 text-muted hover:bg-hover hover:text-fg focus-visible:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:block group-focus-within:block [@media(hover:none)]:block"
        title="Group chat settings"
        aria-label={room.name + ' settings'}
        onClick={onSettings}
      >
        <Settings2 size={13} />
      </button>}
    </div>
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
