import { useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Plus, Hand, Settings2, PanelLeftClose, QrCode, Search, UserPlus, MessagesSquare, Inbox, Upload, ListChecks, Monitor } from 'lucide-react';
import { useStore, botById, NARROW_SIDEBAR_QUERY } from '../store';
import { Avatar, Badge, Button, Menu, MenuContent, MenuItem, SectionLabel, Skeleton, SkeletonGroup, Tooltip, cn } from './ui';
import { useInbox } from '../lib/useInbox';
import { Podium } from './Podium';
import { ImportBotDialog } from './dialogs/BotFileDialogs';
import { ProfileMenu } from './ProfileMenu';
import { api } from '../lib/api';
import { getJson, setJson } from '../lib/persist';
import { useMediaQuery } from '../lib/useMediaQuery';
import { STATUS_LABEL, avatarStatus, isWorking, useBotStatus, type BotStatus } from '../lib/botStatus';
import { toolPhrase } from '../lib/toolPhrases';
import { PopoutButton } from './PopoutButton';
import { activeFor, onBackupText } from '../lib/failover';
import { useLayout } from '../lib/layout';
import { buildProjectTree, type ProjectNode } from '../lib/projectTree';
import type { InboxItem } from '../lib/inbox';
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
  const ids = getJson(COLLAPSED_KEY, Array.isArray as (v: unknown) => v is unknown[], []);
  return new Set(ids.filter((id): id is string => typeof id === 'string'));
}

/** Which sidebar sections are folded. Kept per device: a phone and a desktop want different lists. */
function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    setJson(COLLAPSED_KEY, [...next]); // a blocked store keeps it in memory until reload
  };
  return { collapsed, toggle };
}

const PROJECT_FOLDS_KEY = 'pocketrocket.projectFolds';
const isFolds = (v: unknown): v is Record<string, boolean> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Which projects are unfolded in the new layout. By default only the one you are in; a project you fold or unfold
 * yourself stays that way, per device, like the classic sections.
 */
function useProjectFolds() {
  const [open, setOpen] = useState(() => getJson(PROJECT_FOLDS_KEY, isFolds, {}));
  const isOpen = (slug: string, active: boolean) => open[slug] ?? active;
  const toggle = (slug: string, active: boolean) => {
    const next = { ...open, [slug]: !isOpen(slug, active) };
    setOpen(next);
    setJson(PROJECT_FOLDS_KEY, next);
  };
  return { isOpen, toggle };
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
  const failoverActive = useStore((s) => s.failover.active);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const toast = useStore((s) => s.toast);
  const { statusOf, needsYouRoom } = useBotStatus();
  const inbox = useInbox();
  const waiting = inbox.length;
  const inboxOpen = useStore((s) => s.page?.kind === 'inbox');
  const tasksOpen = useStore((s) => s.page?.kind === 'tasks');
  const pcSessionsOpen = useStore((s) => s.page?.kind === 'pcsessions');
  const [importing, setImporting] = useState(false);
  const connected = useStore((s) => s.connected);
  const helloReceived = useStore((s) => s.helloReceived);
  // P9: a paired phone may not create or edit bots and rooms, change settings or open the workspace (403).
  const device = useStore((s) => s.device);
  // The project-first layout (docs/specs/toki-ui.md) is per browser; a paired phone keeps the classic tree.
  const toki = useLayout() === 'toki' && !device;
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
    const onBackup = activeFor(failoverActive, b.id, Date.now());
    return (
      <BotRow
        key={b.id}
        bot={b}
        status={statusOf(b.id)}
        backupText={onBackup ? onBackupText(onBackup, providers) : null}
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
          <Tooltip content="Search every chat"><button className={ROUND} aria-label="Search every chat" onClick={() => openDialog({ kind: 'search' })}><Search size={16} /></button></Tooltip>
          {!device && (
            <Menu.Root>
              <Menu.Trigger className={ROUND} title="New" aria-label="New"><Plus size={17} /></Menu.Trigger>
              <Menu.Portal>
                <MenuContent align="end">
                  <MenuItem onSelect={() => openDialog({ kind: 'bot', bot: null })}><UserPlus size={15} aria-hidden /> New bot</MenuItem>
                  <MenuItem onSelect={() => openDialog({ kind: 'room', room: null })}><MessagesSquare size={15} aria-hidden /> New group chat</MenuItem>
                  <MenuItem onSelect={() => setImporting(true)}><Upload size={15} aria-hidden /> Import a bot...</MenuItem>
                </MenuContent>
              </Menu.Portal>
            </Menu.Root>
          )}
        </div>
      </div>
      <button
        className={cn(
          'mx-2 flex items-center gap-2.5 rounded-lg px-2.5 text-left text-ui hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          // New layout: a pinned, bordered row, so the one place that waits on you reads as its own thing.
          toki ? 'mb-2 h-10 ring-1 ring-inset ring-line' : 'mb-1 py-1.5',
          inboxOpen ? 'bg-active text-fg' : toki ? 'text-fg' : 'text-muted hover:text-fg',
        )}
        aria-current={inboxOpen ? 'page' : undefined}
        onClick={() => { useStore.getState().openPage({ kind: 'inbox' }); leaveDrawer(); }}
      >
        <Inbox size={15} aria-hidden className={cn('shrink-0', toki && 'text-muted')} />
        <span className={cn('flex-1', toki && 'font-medium')}>Needs you</span>
        {waiting > 0 && <Badge tone={toki ? 'needs' : 'warn'}>{waiting}<span className="sr-only"> waiting</span></Badge>}
      </button>
      {!device && (
        <button
          className={cn('mx-2 mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', tasksOpen ? 'bg-active text-fg' : 'text-muted hover:text-fg')}
          aria-current={tasksOpen ? 'page' : undefined}
          onClick={() => { useStore.getState().openPage({ kind: 'tasks' }); leaveDrawer(); }}
        >
          <ListChecks size={15} aria-hidden className="shrink-0" />
          <span className="flex-1">Tasks</span>
        </button>
      )}
      {!device && (
        <button
          className={cn('mx-2 mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', pcSessionsOpen ? 'bg-active text-fg' : 'text-muted hover:text-fg')}
          aria-current={pcSessionsOpen ? 'page' : undefined}
          onClick={() => { useStore.getState().openPage({ kind: 'pcsessions' }); leaveDrawer(); }}
        >
          <Monitor size={15} aria-hidden className="shrink-0" />
          <span className="flex-1">PC sessions</span>
        </button>
      )}
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

      <div className="flex-1 overflow-y-auto overscroll-contain px-1 pb-2">
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
        {toki ? (
          <ProjectsTree
            inbox={inbox}
            statusOf={statusOf}
            podiumBots={podiumBots}
            dmFor={dmFor}
            collapsed={collapsed}
            toggle={toggle}
            row={row}
            openRoom={openRoom}
            openDm={(id) => void openDm(id)}
            onRoomSettings={device ? undefined : (r) => openDialog({ kind: 'room', room: r })}
          />
        ) : (<>
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
        </>)}
      </div>

      <div className="flex items-center gap-1 pr-2.5">
        <div className="min-w-0 flex-1"><ProfileMenu onNavigate={leaveDrawer} /></div>
        <Tooltip content="Pair a phone"><button className={ROUND} aria-label="Pair a phone" onClick={() => openDialog({ kind: 'settings', section: 'devices' })}><QrCode size={16} /></button></Tooltip>
      </div>
      {importing && <ImportBotDialog onClose={() => setImporting(false)} />}
    </aside>
  );
}

/** Left edge of every label in the new layout: past the fold chevron, in line with the project dots and room names. */
const TREE_LABEL = 'pl-8';

/**
 * The new layout's list (docs/specs/toki-ui.md, W4): Projects (each unfolding to its group chat and bots), then the
 * group chats that belong to no project, then Bots (podium and solo), then "Show paused". The rows themselves are the
 * classic ones: BotRow, GroupHeader and the fold chevron.
 */
function ProjectsTree({ inbox, statusOf, podiumBots, dmFor, collapsed, toggle, row, openRoom, openDm, onRoomSettings }: {
  inbox: InboxItem[];
  statusOf: (botId: string) => BotStatus;
  podiumBots: Bot[];
  dmFor: (botId: string) => Room | undefined;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  row: (b: Bot) => ReactNode;
  openRoom: (roomId: string) => void;
  openDm: (botId: string) => void;
  onRoomSettings?: (room: Room) => void;
}) {
  const projects = useStore((s) => s.projects);
  const rooms = useStore((s) => s.rooms);
  const bots = useStore((s) => s.bots);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const unread = useStore((s) => s.unread);
  const helloReceived = useStore((s) => s.helloReceived);
  const device = useStore((s) => s.device);
  const [showPaused, setShowPaused] = useState(false);
  const folds = useProjectFolds();
  const projectsLabel = useId();
  const roomsLabel = useId();
  const podiumIds = useMemo(() => new Set(podiumBots.map((b) => b.id)), [podiumBots]);
  const tree = buildProjectTree({ projects, rooms, bots, statusOf, activeRoomId, podiumIds, showPaused });

  if (!helloReceived) return <SkeletonRows count={4} />;

  const isOpenDm = (b: Bot) => dmFor(b.id)?.id === activeRoomId;
  /** A folded section still shows the chat you are in. */
  const shown = (open: boolean, list: Bot[]) => (open ? list : list.filter(isOpenDm));
  const unreadOf = (list: Bot[]) => list.reduce((n, b) => { const dm = dmFor(b.id); return n + (dm ? unread[dm.id] ?? 0 : 0); }, 0);
  const waitingIn = (roomId: string | undefined) => (roomId ? inbox.filter((i) => i.roomId === roomId).length : 0);
  const soloOpen = !collapsed.has(SOLO_SECTION);
  const soloShown = shown(soloOpen, tree.solo);
  // Only what pressing the button would bring into view: paused bots inside a folded section don't count.
  const hiddenCount = tree.hidden
    + (soloOpen ? tree.hiddenSolo : 0)
    + tree.projects.reduce((n, p) => n + (folds.isOpen(p.project.slug, p.active) ? p.hiddenBots : 0), 0)
    + tree.rooms.reduce((n, r) => n + (collapsed.has(r.room.id) ? 0 : r.hiddenBots), 0);

  return (
    <>
      {tree.projects.length > 0 && (
        <section aria-labelledby={projectsLabel} className="mb-3">
          <SectionLabel as="h2" id={projectsLabel} className={cn(TREE_LABEL, 'pt-2')}>Projects</SectionLabel>
          <ul className="space-y-0.5">
            {tree.projects.map((node) => {
              const open = folds.isOpen(node.project.slug, node.active);
              const room = node.room;
              return (
                <ProjectItem
                  key={node.project.slug}
                  node={node}
                  open={open}
                  waiting={waitingIn(room?.id)}
                  unread={room ? unread[room.id] ?? 0 : 0}
                  roomActive={!!room && room.id === activeRoomId}
                  onToggle={() => folds.toggle(node.project.slug, node.active)}
                  onOpen={() => (room ? openRoom(room.id) : folds.toggle(node.project.slug, node.active))}
                  onRoomSettings={room && onRoomSettings ? () => onRoomSettings(room) : undefined}
                >
                  {shown(open, node.bots).map(row)}
                </ProjectItem>
              );
            })}
          </ul>
        </section>
      )}

      {tree.rooms.length > 0 && (
        <section aria-labelledby={roomsLabel} className="mb-3">
          <SectionLabel as="h2" id={roomsLabel} className={cn(TREE_LABEL, 'pt-2')}>Rooms</SectionLabel>
          {tree.rooms.map(({ room, bots: members }) => {
            const visible = shown(!collapsed.has(room.id), members);
            return (
              <section key={room.id} aria-label={room.name} className={collapsed.has(room.id) ? 'mb-1' : 'mb-2'}>
                <GroupHeader
                  room={room}
                  statusOf={statusOf}
                  active={room.id === activeRoomId}
                  unread={(unread[room.id] ?? 0) + unreadOf(members.filter((b) => !visible.includes(b)))}
                  collapsed={collapsed.has(room.id)}
                  count={members.length}
                  onToggle={() => toggle(room.id)}
                  onClick={() => openRoom(room.id)}
                  onSettings={onRoomSettings ? () => onRoomSettings(room) : undefined}
                  asRow
                />
                {visible.length > 0 && <ul className="ml-[15px] space-y-0.5 border-l border-line pl-1.5">{visible.map(row)}</ul>}
              </section>
            );
          })}
        </section>
      )}

      {bots.length > 0 && (
        <SoloHeader collapsed={!soloOpen} count={tree.solo.length} unread={unreadOf(tree.solo.filter((b) => !soloShown.includes(b)))} onToggle={() => toggle(SOLO_SECTION)} />
      )}
      {bots.length > 0 && (
        <Podium
          bots={podiumBots}
          statusOf={statusOf}
          activeBotId={rooms.find((r) => r.id === activeRoomId && r.kind === 'dm')?.memberIds[0] ?? null}
          unreadOf={(id) => { const dm = dmFor(id); return dm ? unread[dm.id] ?? 0 : 0; }}
          onOpen={openDm}
          canEdit={!device}
        />
      )}
      <ul className="mb-2 space-y-0.5">{soloShown.map(row)}</ul>
      {!bots.length && <div className={cn(TREE_LABEL, 'py-2 text-ui text-muted')}>No bots yet.</div>}

      {(hiddenCount > 0 || showPaused) && (
        <Button variant="ghost" size="sm" className="ml-6 text-hint" aria-pressed={showPaused} onClick={() => setShowPaused(!showPaused)}>
          {showPaused ? 'Hide paused' : <>Show paused (<span className="font-mono">{hiddenCount}</span>)</>}
        </Button>
      )}
    </>
  );
}

/** One project: its name opens its group chat; the chevron folds its chat and bots away. */
function ProjectItem({ node, open, waiting, unread, roomActive, onToggle, onOpen, onRoomSettings, children }: {
  node: ProjectNode;
  open: boolean;
  /** Things in its group chat that wait on you. */
  waiting: number;
  unread: number;
  roomActive: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRoomSettings?: () => void;
  /** Its bot rows (already folded down to the open chat when the project is folded). */
  children: ReactNode[];
}) {
  const { project, room, active } = node;
  return (
    <li>
      <div className={cn('group flex items-center rounded-sm hover:bg-hover', active && 'bg-active')}>
        <CollapseToggle name={project.name} collapsed={!open} count={node.bots.length + (room ? 1 : 0)} onToggle={onToggle} />
        <button
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-2.5 text-left text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          title={room ? 'Open ' + project.name : (open ? 'Hide ' : 'Show ') + 'the bots in ' + project.name}
          aria-current={active ? 'page' : undefined}
          aria-expanded={room ? undefined : open}
          onClick={onOpen}
        >
          <span aria-hidden className={cn('h-[7px] w-[7px] shrink-0 rounded-full', active ? 'bg-accent' : 'ring-[1.5px] ring-inset ring-faint')} />
          <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
          {waiting > 0 && <Badge tone="needs">{waiting}<span className="sr-only"> waiting on you</span></Badge>}
          {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-accent"><span className="sr-only">{unread} unread</span></span>}
        </button>
      </div>
      {(open || children.length > 0) && (
        <ul className="ml-[15px] mt-0.5 space-y-0.5 border-l border-line pl-1.5">
          {open && room && (
            <li className="group flex items-center rounded-sm hover:bg-hover">
              <button
                className={cn('flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1 text-left text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', roomActive ? 'text-fg' : 'text-muted hover:text-fg')}
                title={'Open the ' + room.name + ' group chat'}
                onClick={onOpen}
              >
                <span aria-hidden className="font-mono text-dim">#</span>
                <span className="min-w-0 truncate">{room.name}</span>
              </button>
              {onRoomSettings && <button
                className="mr-1.5 hidden shrink-0 rounded-sm p-1 text-muted hover:bg-hover hover:text-fg focus-visible:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:block group-focus-within:block [@media(hover:none)]:block"
                title="Group chat settings"
                aria-label={room.name + ' settings'}
                onClick={onRoomSettings}
              >
                <Settings2 size={13} />
              </button>}
            </li>
          )}
          {children}
        </ul>
      )}
    </li>
  );
}

/** One bot in the sidebar. The second line says who must act, in words and color, and never names a tool. */
function BotRow({ bot, status, backupText, activity, preview, active, unread, onOpen, onSettings }: {
  bot: Bot;
  status: BotStatus;
  /** M8: "On Gemini until 14:00" while its attended turns run on the backup; it stands in for the idle preview. */
  backupText?: string | null;
  activity: { text: string; toBot: string | null } | null;
  /** Its latest message, as plain words. */
  preview: string | null;
  active: boolean;
  unread: number;
  onOpen: () => void;
  onSettings?: () => void;
}) {
  const idle = preview ? preview.replace(/[*_`#>~]/g, '').replace(/\s+/g, ' ').trim() : '@' + bot.handle;
  const sub = status === 'idle' ? backupText ?? idle
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
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-accent"><span className="sr-only">{unread} unread</span></span>}
      </button>
      {/* A sibling of the row button, not inside it. Shown on hover, whenever focus is anywhere in the
          row (so Tab finds it), and always on touch screens, which have no hover to reveal it. */}
      {onSettings && <PopoutButton bot={bot} />}
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
      className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      title={(collapsed ? 'Show ' : 'Hide ') + 'the bots in ' + name}
      aria-label={name + ' bots'}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <ChevronRight size={16} aria-hidden className={cn('motion-safe:transition-transform', !collapsed && 'rotate-90')} />
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
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-accent"><span className="sr-only">{unread} unread</span></span>}
      </span>
    </div>
  );
}

/** A group's name, which opens its chat. Its bots are listed below it, each opening a chat of its own. */
function GroupHeader({ room, statusOf, active, unread, collapsed, count, onToggle, onClick, onSettings, asRow }: {
  room: Room;
  /** New layout: drawn as a row under the "Rooms" label (like a project), not as a section heading of its own. */
  asRow?: boolean;
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
        className={cn(
          'flex min-w-0 flex-1 items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          asRow ? 'gap-2 py-1.5 pl-1.5 pr-2.5 text-ui text-fg' : 'gap-1.5 px-1 py-1 text-label text-dim hover:text-fg',
        )}
        title={'Open the ' + room.name + ' group chat'}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
      >
        {asRow && <span aria-hidden className="w-[7px] shrink-0 text-center font-mono text-dim">#</span>}
        <span className={cn('truncate', active && 'text-fg', asRow && 'min-w-0 flex-1')}>{room.name}</span>
        <FoldedCount collapsed={collapsed} count={count} />
        {needs > 0
          ? (asRow ? <Badge tone="needs">{needs}<span className="sr-only"> {needs === 1 ? 'needs' : 'need'} you</span></Badge> : <span className="shrink-0 text-hint text-warn">{needs} {needs === 1 ? 'needs' : 'need'} you</span>)
          : busy > 0 && <span className="shrink-0 text-hint text-ok">{busy} working</span>}
        {unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-accent"><span className="sr-only">{unread} unread</span></span>}
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
    <SkeletonGroup>
      <ul className="space-y-0.5">
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="flex items-center gap-2.5 px-2.5 py-2">
            <Skeleton className="h-[34px] w-[34px] shrink-0" />
            <span className="flex-1 space-y-1.5">
              <Skeleton className="h-2.5 w-2/3" />
              <Skeleton className="h-2 w-1/2 bg-card2/70" />
            </span>
          </li>
        ))}
      </ul>
    </SkeletonGroup>
  );
}
