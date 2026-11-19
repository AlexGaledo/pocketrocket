// New layout (docs/specs/toki-ui.md, W5): a project room's header. The project's name and where its plan stands,
// Chat | Map tabs, then a slim line for the room itself with today's faces, badges and buttons in today's order.
// App.tsx draws it above both the chat and the Map tab, so switching tabs never moves it.
import { Inbox } from 'lucide-react';
import type { Room } from '@pocketrocket/shared';
import { useStore } from '../store';
import type { ProjectInfo } from '../lib/api';
import { PANEL_INLINE_MIN } from '../lib/panes';
import { useInbox } from '../lib/useInbox';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useMapDrawing, useOverview } from '../lib/useProject';
import { Badge, Button, Chip, StagePips, Tabs, TabsList, TabsTrigger } from './ui';
import { HeaderButtons, HeaderFaces, RoomBadges, useMembers } from './ChatHeader';

/** The two tab panels, both drawn by App.tsx. */
export const PROJECT_TAB_IDS = {
  chat: { tab: 'project-tab-chat', panel: 'project-panel-chat' },
  map: { tab: 'project-tab-map', panel: 'project-panel-map' },
} as const;

const PANEL_QUERY = '(min-width: ' + PANEL_INLINE_MIN + 'px)';

export function ProjectHeader({ project, room }: { project: ProjectInfo; room: Room }) {
  const tab = useStore((s) => (s.page?.kind === 'map' ? 'map' : 'chat'));
  const openPage = useStore((s) => s.openPage);
  const closePage = useStore((s) => s.closePage);
  const openDialog = useStore((s) => s.openDialog);
  const device = useStore((s) => s.device);
  const members = useMembers(room);
  const overview = useOverview(project.slug);
  const waiting = useInbox().filter((i) => i.roomId === room.id).length;
  // While a bot draws the map, the room line says so; it is the way to the Map tab from the chat.
  const drawing = useMapDrawing(project.slug);
  const drawingMap = drawing.phase === 'sent' && drawing.running && tab === 'chat';

  // Where the overview has no room beside the chat, this opens it over the window. Also the way back to it on a
  // wide window if it was closed there.
  const panelOpen = useStore((s) => s.panelOpen);
  const panelKind = useStore((s) => s.panelKind);
  const openOverview = useStore((s) => s.openOverview);
  const wide = useMediaQuery(PANEL_QUERY);
  const overviewReachable = panelOpen && (panelKind === 'overview' || wide);

  return (
    <header className="shrink-0">
      <div className="flex min-h-14 flex-wrap items-center gap-x-4 border-b border-line px-5 max-md:pl-14 @max-[640px]:pt-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 @max-[640px]:pb-1">
          <h1 className="min-w-0 text-title [overflow-wrap:anywhere]">{project.name}</h1>
          {/* Nothing while it loads, so "No plan yet" never flashes up before the real plan. */}
          {overview !== undefined && <StagePips plan={overview?.plan ?? null} wrap />}
        </div>
        {!overviewReachable && (
          <Button size="sm" className="shrink-0 pointer-coarse:h-10 pointer-coarse:min-w-10" title="Project overview" aria-label={waiting ? 'Needs you, ' + waiting : 'Project overview'} onClick={() => openOverview({ rail: false })}>
            <Inbox size={14} aria-hidden className="text-muted" />
            {/* Narrow: the icon and the count say it, so the plan beside the title keeps its line. */}
            <span aria-hidden className="@max-[640px]:hidden">Needs you</span>
            {waiting > 0 && <span aria-hidden><Badge tone="needs">{waiting}</Badge></span>}
          </Button>
        )}
        <Tabs value={tab} onValueChange={(v) => (v === 'map' ? openPage({ kind: 'map', slug: project.slug }) : closePage())} className="flex self-stretch @max-[640px]:h-11 @max-[640px]:basis-full">
          <TabsList variant="underline" className="items-stretch">
            <TabsTrigger value="chat" id={PROJECT_TAB_IDS.chat.tab} controls={PROJECT_TAB_IDS.chat.panel}>Chat</TabsTrigger>
            <TabsTrigger value="map" id={PROJECT_TAB_IDS.map.tab} controls={PROJECT_TAB_IDS.map.panel}>Map</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {/* The room line: today's header, minus the title the line above now carries. */}
      {/* A long room name wraps rather than being cut off; the line grows to fit it. */}
      <div className="flex min-h-12 min-w-0 items-center gap-3 px-5 py-1.5">
        {!device
          ? <button type="button" className="min-w-0 rounded-xs text-left text-ui font-medium [overflow-wrap:anywhere] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title="Group details" onClick={() => openDialog({ kind: 'room', room })}><span aria-hidden className="text-dim"># </span>{room.name}</button>
          : <span className="min-w-0 text-ui font-medium [overflow-wrap:anywhere]"><span aria-hidden className="text-dim"># </span>{room.name}</span>}
        <HeaderFaces room={room} members={members} />
        {drawingMap && (
          <button type="button" className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={'@' + (drawing.bot?.handle ?? 'bot') + ' is drawing the map. Open the map'} onClick={() => openPage({ kind: 'map', slug: project.slug })}>
            <Chip className="chip-running font-mono text-accent">map</Chip>
          </button>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden @max-[640px]:hidden">
          <RoomBadges room={room} members={members} />
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <HeaderButtons room={room} members={members} />
        </span>
      </div>
    </header>
  );
}
