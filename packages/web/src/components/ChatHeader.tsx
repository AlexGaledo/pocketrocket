// The chat's header: the room's name, its badges, the members' faces and the Files and Screen toggles. Moved out of
// ChatPane so the new layout's project header (ProjectHeader.tsx) is built from the same pieces in the same order.
import { FolderOpen, Monitor, Settings2, Users } from 'lucide-react';
import type { Bot, Room } from '@pocketrocket/shared';
import { useStore, botById } from '../store';
import { Avatar, Badge, Button, RoomAvatar, cn } from './ui';
import { avatarStatus, isWorking, useBotStatus } from '../lib/botStatus';
import { selectScreenSize } from '../lib/screenView';
import { laneKey } from '../lib/queue';
import { activeFor, onBackupText } from '../lib/failover';
import { ContextMeter } from './ContextMeter';

/** A room can hold 10 bots; past this the header says +N, so the name and buttons keep their width. */
const HEADER_AVATARS = 4;

/** The room's members the store knows, in the room's order. */
export function useMembers(room: Room): Bot[] {
  const bots = useStore((s) => s.bots);
  return room.memberIds.map((id) => botById(bots, id)).filter((b): b is Bot => !!b);
}

/** Coordinator, held screens, paused queues and bots on their backup, as badges. Nothing when all is ordinary. */
export function RoomBadges({ room, members }: { room: Room; members: Bot[] }) {
  const bots = useStore((s) => s.bots);
  const control = useStore((s) => s.control);
  const queues = useStore((s) => s.queues);
  const failoverActive = useStore((s) => s.failover.active);
  const providers = useStore((s) => s.providers);
  // A deleted coordinator leaves its id on the room; no badge rather than "@undefined".
  const coordinator = room.coordinatorBotId ? botById(bots, room.coordinatorBotId) : undefined;
  // P2: in a group, say which bots' screens the user holds or paused.
  const held = room.kind === 'group' ? members.filter((m) => (control[m.id]?.control ?? 'agent') !== 'agent') : [];
  const queuePaused = members.filter((m) => queues[laneKey(m.id, room.id)]?.paused);
  // M8: bots whose attended turns run on their backup until the limit resets ("On Gemini until 14:00").
  const onBackup = members.flatMap((m) => { const a = activeFor(failoverActive, m.id, Date.now()); return a ? [{ m, text: onBackupText(a, providers) }] : []; });
  return (
    <>
      {coordinator && <Badge tone="accent">coordinator @{coordinator.handle}</Badge>}
      {held.map((m) => <Badge key={m.id} tone="warn">@{m.handle} {control[m.id]?.control === 'paused' ? 'paused' : 'screen: you'}</Badge>)}
      {/* The queue's pause, worded apart from the screen's "paused" above. Resume is on the chip by the composer. */}
      {queuePaused.map((m) => <Badge key={'q' + m.id} tone="warn">{room.kind === 'dm' ? 'Queue paused' : '@' + m.handle + ' queue paused'}</Badge>)}
      {onBackup.map(({ m, text }) => <Badge key={'b' + m.id}>{room.kind === 'dm' ? text : '@' + m.handle + ' ' + text.charAt(0).toLowerCase() + text.slice(1)}</Badge>)}
    </>
  );
}

/** The members' faces with their state rings; in a group each opens that bot's page. */
export function HeaderFaces({ room, members, className }: { room: Room; members: Bot[]; className?: string }) {
  const { statusOf } = useBotStatus();
  const openPage = useStore((s) => s.openPage);
  return (
    <div className={cn('flex shrink-0 -space-x-2', className)}>
      {members.slice(0, HEADER_AVATARS).map((m) => room.kind === 'dm' ? (
        <span key={m.id} className="rounded-full ring-2 ring-bg"><Avatar bot={m} {...avatarStatus(statusOf(m.id))} size={26} /></span>
      ) : (
        <button key={m.id} type="button" className="rounded-full ring-2 ring-bg" aria-label={'Open ' + m.name + "'s page"} title={'Open ' + m.name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: m.id, tab: 'memory' })}>
          <Avatar bot={m} {...avatarStatus(statusOf(m.id))} size={26} />
        </button>
      ))}
      {members.length > HEADER_AVATARS && (
        <span className="flex h-[26px] items-center rounded-full bg-card2 px-1.5 text-hint text-muted ring-2 ring-bg" title={members.slice(HEADER_AVATARS).map((m) => m.name).join(', ')}>+{members.length - HEADER_AVATARS}</span>
      )}
    </div>
  );
}

/** Group details (or the bot's page in a one-on-one chat), then Files and Screen, in that order. */
export function HeaderButtons({ room, members }: { room: Room; members: Bot[] }) {
  const panelOpen = useStore((s) => s.panelOpen);
  const panelKind = useStore((s) => s.panelKind);
  const openFiles = useStore((s) => s.openFiles);
  const openScreen = useStore((s) => s.openScreen);
  const closePanel = useStore((s) => s.closePanel);
  const openPage = useStore((s) => s.openPage);
  const openDialog = useStore((s) => s.openDialog);
  const screenSize = useStore(selectScreenSize);
  // P9: a paired phone may not create or edit bots and rooms (the hub answers 403), so it is not offered.
  const device = useStore((s) => s.device);
  const filesShown = panelOpen && panelKind === 'files';
  const screenShown = panelOpen && panelKind === 'screen';
  return (
    <>
      {room.kind === 'group' && !device && (
        <Button variant="ghost" size="icon" title="Group details" aria-label="Group details" onClick={() => openDialog({ kind: 'room', room })}><Users size={16} /></Button>
      )}
      {room.kind === 'dm' && members[0] && (
        <Button variant="ghost" size="icon" title="Memory, skills and automations" aria-label={'Open ' + members[0].name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: members[0].id, tab: 'memory' })}><Settings2 size={16} /></Button>
      )}
      {screenSize !== 'focus' && (
        <>
          <Button data-files-toggle variant="ghost" size="icon" className="aria-pressed:bg-active aria-pressed:text-fg" title={filesShown ? 'Hide files' : 'Files'} aria-label="Files" aria-pressed={filesShown} onClick={() => (filesShown ? closePanel() : openFiles())}><FolderOpen size={16} /></Button>
          <Button variant="ghost" size="icon" className="aria-pressed:bg-active aria-pressed:text-fg" title={screenShown ? 'Hide screen' : 'Watch screen'} aria-label="Screen" aria-pressed={screenShown} onClick={() => (screenShown ? closePanel() : openScreen())}><Monitor size={16} /></Button>
        </>
      )}
    </>
  );
}

/** Today's header, unchanged: every room in the classic layout, and rooms with no project in the new one. */
export function ChatHeader({ room, members }: { room: Room; members: Bot[] }) {
  const { statusOf } = useBotStatus();
  const openPage = useStore((s) => s.openPage);
  const openDialog = useStore((s) => s.openDialog);
  const device = useStore((s) => s.device);
  const working = members.filter((m) => isWorking(statusOf(m.id)));
  const needs = members.filter((m) => statusOf(m.id) === 'needs_you').length;
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 px-5 max-md:pl-14">
      {room.kind === 'group' && <RoomAvatar room={room} size={30} />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {room.kind === 'dm' && members[0]
            ? <button type="button" className="min-w-24 truncate rounded-xs text-left text-body font-semibold hover:underline" title={'Open ' + members[0].name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: members[0].id, tab: 'memory' })}>{room.name}</button>
            : room.kind === 'group' && !device
              ? <button type="button" className="min-w-24 truncate rounded-xs text-left text-body font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title="Group details" onClick={() => openDialog({ kind: 'room', room })}>{room.name}</button>
              : <span className="min-w-24 truncate text-body font-semibold">{room.name}</span>}
          <span className="flex min-w-0 items-center gap-2 overflow-hidden @max-[640px]:hidden">
            <RoomBadges room={room} members={members} />
          </span>
        </div>
        <div className="truncate text-hint text-muted">
          {room.kind === 'dm' ? members[0]?.title || '@' + members[0]?.handle : members.map((m) => '@' + m.handle).join('  ')}
          {needs > 0 && <span className="ml-2 text-warn">{room.kind === 'dm' ? 'Needs you' : needs + (needs === 1 ? ' needs you' : ' need you')}</span>}
          {working.length > 0 && <span className="ml-2 text-ok">{working.length} working</span>}
        </div>
      </div>
      {room.kind === 'dm' && members[0] && <ContextMeter botId={members[0].id} roomId={room.id} className="w-44 shrink-0 @max-[640px]:hidden" />}
      {/* A narrow group header has the group's own picture, and the sidebar lists its bots: the name keeps the room.
          In a one-on-one chat the name and the button beside this already open the bot's page, so the face only shows
          its state. */}
      <HeaderFaces room={room} members={members} className={room.kind === 'group' ? '@max-[480px]:hidden' : undefined} />
      <HeaderButtons room={room} members={members} />
    </header>
  );
}
