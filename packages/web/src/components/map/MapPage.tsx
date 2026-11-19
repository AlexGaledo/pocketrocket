// New layout: a project's Map tab (docs/specs/toki-ui.md, W7/W8). It reads map.json through the hub and shows one
// of: loading, no map yet, a bot drawing it, no map made, a map that could not be read, or the map itself (canvas or
// list). Nothing is faked: the canvas only ever draws what the hub returned, and "drawing" only shows while the bot
// that was asked has a turn running in this room.
import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Map as MapIcon, RefreshCw } from 'lucide-react';
import type { Bot, Room } from '@pocketrocket/shared';
import { useStore, botById } from '../../store';
import { importChunk } from '../../lib/lazyChunk';
import { useMapDrawing } from '../../lib/useProject';
import { useBotStatus } from '../../lib/botStatus';
import { MAP_KIND_LABEL, layoutMap, type PlacedNode } from '../../lib/mapLayout';
import type { ProjectInfo } from '../../lib/api';
import { Button, EmptyState, Skeleton, SkeletonGroup, Tabs, TabsList, TabsTrigger, cn } from '../ui';
import { GenerateMap } from './GenerateMap';
import { MapList } from './MapList';
import { MapPrompt } from './MapPrompt';
import { ToolButtonShell } from './ToolButtonShell';

const ProjectMap = lazy(() => importChunk(() => import('./ProjectMap')));

/** Narrower than this, the map is read-only and opens as the list. */
const NARROW = 640;
const PROMPT_INSET = 64;
const CHIPS_INSET = 36;

/** The width of an element, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = useRef<T>(null);
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** The bot the prompt bar talks to: the room's coordinator, else its first member that is not paused. */
export function useMapLead(room: Room): Bot | null {
  const bots = useStore((s) => s.bots);
  const { statusOf } = useBotStatus();
  const ids = room.coordinatorBotId ? [room.coordinatorBotId, ...room.memberIds] : room.memberIds;
  const id = ids.find((x) => statusOf(x) !== 'paused') ?? null;
  return id ? botById(bots, id) ?? null : null;
}

export function MapPage({ project, room }: { project: ProjectInfo; room: Room }) {
  const slug = project.slug;
  const reply = useStore((s) => s.maps[slug]);
  const known = useStore((s) => slug in s.maps);
  const loadMap = useStore((s) => s.loadMap);
  const closePage = useStore((s) => s.closePage);
  useEffect(() => { if (!known) void loadMap(slug); }, [known, loadMap, slug]);

  const [rootRef, width] = useWidth<HTMLDivElement>();
  const narrow = width !== null && width < NARROW;
  const [chosen, setChosen] = useState<'map' | 'list' | null>(null);
  const view = chosen ?? (narrow ? 'list' : 'map');

  const lead = useMapLead(room);
  const drawing = useMapDrawing(slug);
  const map = reply?.map ?? null;
  const layout = useMemo(() => (map ? layoutMap(map) : null), [map]);

  const [picked, setPicked] = useState<string[]>([]);
  const promptRef = useRef<HTMLInputElement>(null);
  const pickedNodes = (layout?.nodes ?? []).filter((n) => picked.includes(n.id));
  const ask = (n: PlacedNode) => {
    setPicked((p) => (p.includes(n.id) ? p : [...p, n.id]));
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const generate = (trigger: React.ReactElement, tip?: string) => (
    <GenerateMap slug={slug} room={room} current={map?.kind ?? null} trigger={trigger} tip={tip} />
  );
  const generateButton = <Button variant="primary">{map ? 'Redraw map' : 'Generate map'}</Button>;
  const drawingLine = drawing.phase === 'sent' && drawing.bot && (
    drawing.running
      ? <span className="chip-running inline-flex items-center rounded-full px-3 py-1 font-mono text-label text-accent">@{drawing.bot.handle} is reading the project…</span>
      : <span className="inline-flex items-center rounded-full bg-card2 px-3 py-1 text-label text-muted">Asked @{drawing.bot.handle}. It starts when it is free.</span>
  );

  let body: ReactNode;
  if (reply === undefined) {
    body = (
      <SkeletonGroup label="Loading the map…" className="flex flex-1 items-center justify-center gap-6 bg-canvas">
        <Skeleton className="h-14 w-40 rounded-lg" /><Skeleton className="h-14 w-40 rounded-lg" /><Skeleton className="h-14 w-40 rounded-lg" />
      </SkeletonGroup>
    );
  } else if (reply === null) {
    body = (
      <Centre>
        <EmptyState icon={<MapIcon size={18} />} title="The map is not available" as="h2" action={<Button onClick={() => void loadMap(slug)}>Try again</Button>}>
          The hub did not answer for this project's map.
        </EmptyState>
      </Centre>
    );
  } else if (!map || !layout) {
    const failed = drawing.phase === 'done' && !drawing.running;
    body = (
      <Centre>
        <EmptyState
          icon={<MapIcon size={18} />}
          as="h2"
          title={drawing.phase === 'sent' ? 'Drawing the map' : reply.error ? 'The map could not be read' : failed ? 'No map was made' : 'No map yet'}
          action={drawing.phase === 'sent' ? drawingLine : (
            <>
              {generate(generateButton)}
              {(failed || reply.error) && <Button onClick={closePage}>Open chat</Button>}
            </>
          )}
        >
          {reply.error
            ? <span className="font-mono text-label [overflow-wrap:anywhere]">{reply.error}</span>
            : drawing.phase === 'sent' ? 'It shows here once map.json is written.'
              : failed ? "The bot's reply is in the chat."
                : 'A bot with the project-map skill can draw it.'}
        </EmptyState>
      </Centre>
    );
  } else {
    const title = MAP_KIND_LABEL[map.kind] + ' of ' + project.name;
    const credit = 'by @' + map.generatedBy.replace(/^@/, '') + ' · ' + map.generatedAt + (reply.droppedEdges ? ' · ' + reply.droppedEdges + ' broken links left out' : '');
    const showPrompt = !narrow && !!lead && view === 'map';
    const switcher = (
      <Tabs value={view} onValueChange={(v) => setChosen(v as 'map' | 'list')}>
        <TabsList><TabsTrigger value="map">Map</TabsTrigger><TabsTrigger value="list">List</TabsTrigger></TabsList>
      </Tabs>
    );
    body = (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {view === 'map' ? (
          <>
            <div data-map-ui className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(50%-8rem)] flex-col items-start gap-1 @max-[640px]:max-w-none">
              <div className="pointer-events-auto rounded-md bg-panel shadow-[var(--shadow)] ring-1 ring-line [&_[role=tablist]]:m-0">{switcher}</div>
              <span className="truncate pl-2 text-hint text-dim @max-[640px]:hidden">{credit}</span>
            </div>
            <MapBoundary fallback={<div className="p-6"><MapList layout={layout} roadmap={map.kind === 'roadmap'} picked={picked} /></div>}>
              <Suspense fallback={<div aria-hidden className="flex-1 bg-canvas" />}>
                <ProjectMap
                  layout={layout}
                  title={title}
                  picked={picked}
                  onAsk={ask}
                  readOnly={narrow || !lead}
                  bottomInset={showPrompt ? PROMPT_INSET + (picked.length ? CHIPS_INSET : 0) : 0}
                  toolbarEnd={generate(<ToolButtonShell label="Redraw the map"><RefreshCw size={14} aria-hidden /></ToolButtonShell>, 'Redraw the map')}
                />
              </Suspense>
            </MapBoundary>
            {drawingLine && <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center">{drawingLine}</div>}
            {showPrompt && lead && <MapPrompt ref={promptRef} lead={lead} room={room} picked={pickedNodes} onUnpick={(id) => setPicked((p) => p.filter((x) => x !== id))} onSent={() => setPicked([])} />}
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[720px] px-5 pb-10 pt-4">
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="[&_[role=tablist]]:m-0">{switcher}</span>
                <span className="text-hint text-dim">{credit}</span>
                <span className="ml-auto">{generate(<Button size="sm">{'Redraw map'}</Button>)}</span>
              </div>
              {drawingLine && <div className="mb-4">{drawingLine}</div>}
              <h2 className="sr-only">{title}</h2>
              <MapList layout={layout} roadmap={map.kind === 'roadmap'} picked={picked} onAsk={!narrow && lead ? (n) => { setChosen('map'); ask(n); } : undefined} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return <div ref={rootRef} className={cn('flex min-h-0 flex-1 flex-col bg-canvas')}>{body}</div>;
}

function Centre({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-canvas">{children}</div>;
}

/** If the canvas chunk cannot load, the list still shows the map. */
class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
