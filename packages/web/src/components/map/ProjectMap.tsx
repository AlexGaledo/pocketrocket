// The project map's canvas (docs/specs/toki-ui.md, W7), drawn by hand: HTML boxes and an SVG layer under them, in
// one "world" that is panned and zoomed with a CSS transform. MapPage loads it with React.lazy, so it stays out of
// the entry bundle like the workflow canvas.
//   - Drag empty space to pan; the wheel or a pinch zooms; Fit and the zoom buttons do the same from the keyboard.
//   - Every box is a button in reading order, so Tab reaches each one. Enter or a click focuses it: an accent ring, a
//     faint static sphere behind it, and two bubbles, "Ask about it" and "Details". Escape clears the focus.
//   - Nothing moves on its own: no keyframes, no animated edges, and the view only changes when the owner moves it.
//   - Read-only (narrow windows): pan and pinch only, so the boxes are plain text.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Info, Maximize, MessageSquarePlus, Minus, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, Tooltip, cn } from '../ui';
import { ToolButtonShell } from './ToolButtonShell';
import { NODE_H, NODE_W, edgePath, fitView, type MapLayout, type PlacedNode } from '../../lib/mapLayout';

export interface ProjectMapProps {
  layout: MapLayout;
  /** "System map" or "Roadmap", for the canvas's accessible name. */
  title: string;
  /** Ids of the boxes picked into the prompt bar. */
  picked: string[];
  onAsk: (node: PlacedNode) => void;
  readOnly: boolean;
  /** Goes at the end of the toolbar (the Regenerate popover). */
  toolbarEnd?: ReactNode;
  /** Space the prompt bar takes at the bottom of the stage, so Fit keeps the boxes clear of it. */
  bottomInset: number;
}

interface View { s: number; tx: number; ty: number }
const MIN_S = 0.35;
const MAX_S = 2;
/** On a wide stage Fit never shrinks the boxes below this, so labels stay readable; a wider map is panned. A narrow
 * (read-only) stage fits the whole map, as an overview. */
const FIT_MIN_S = 0.8;
const clampS = (s: number) => Math.min(MAX_S, Math.max(MIN_S, s));

export default function ProjectMap({ layout, title, picked, onAsk, readOnly, toolbarEnd, bottomInset }: ProjectMapProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  // Until the owner moves the view, it keeps fitting the map as the stage resizes (panels opening, the window).
  const moved = useRef(false);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const focused = focus ? byId.get(focus) ?? null : null;
  // A roadmap's current milestone carries the sphere while nothing else is focused.
  const sphereAt = focused ?? layout.nodes.find((n) => n.state === 'now') ?? null;

  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    moved.current = false;
    setView(fitView(layout.bounds, el.clientWidth, el.clientHeight, { top: 68, right: 24, bottom: bottomInset + 24, left: 24 }, el.clientWidth < 640 ? MIN_S : FIT_MIN_S));
  }, [layout, bottomInset]);

  useLayoutEffect(() => {
    fit();
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (!moved.current) fit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // A focus that names a box the new map no longer has is dropped.
  useEffect(() => { if (focus && !byId.has(focus)) setFocus(null); }, [byId, focus]);

  /** Zooms by `k` around a point of the stage (its centre by default). */
  const zoomBy = useCallback((k: number, px?: number, py?: number) => {
    const v = viewRef.current, el = stageRef.current;
    if (!v || !el) return;
    const cx = px ?? el.clientWidth / 2, cy = py ?? el.clientHeight / 2;
    const s = clampS(v.s * k);
    moved.current = true;
    setView({ s, tx: cx - ((cx - v.tx) / v.s) * s, ty: cy - ((cy - v.ty) / v.s) * s });
  }, []);

  // The wheel zooms. React's onWheel is passive, so the listener is added by hand to be able to stop the page scroll.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // Panning with one pointer on empty space, pinching with two.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, [data-map-ui]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const pts = pointers.current, prev = pts.get(e.pointerId), v = viewRef.current, el = stageRef.current;
    if (!prev || !v || !el) return;
    if (pts.size === 1) {
      moved.current = true;
      setView({ ...v, tx: v.tx + e.clientX - prev.x, ty: v.ty + e.clientY - prev.y });
    } else if (pts.size === 2) {
      const other = [...pts.entries()].find(([id]) => id !== e.pointerId)?.[1];
      if (other) {
        const before = Math.hypot(prev.x - other.x, prev.y - other.y), after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        const r = el.getBoundingClientRect();
        if (before > 0) zoomBy(after / before, (e.clientX + other.x) / 2 - r.left, (e.clientY + other.y) / 2 - r.top);
      }
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); };

  /** Keyboard focus on a box that is off screen pans just enough to show it. */
  const reveal = (n: PlacedNode) => {
    const v = viewRef.current, el = stageRef.current;
    if (!v || !el) return;
    const x = v.tx + n.x * v.s, y = v.ty + n.y * v.s, hw = (NODE_W / 2) * v.s + 16, hh = (NODE_H / 2) * v.s + 16;
    const W = el.clientWidth, H = el.clientHeight - bottomInset;
    const dx = x - hw < 0 ? hw - x : x + hw > W ? W - hw - x : 0;
    const dy = y - hh < 56 ? 56 + hh - y : y + hh > H ? H - hh - y : 0;
    if (dx || dy) { moved.current = true; setView({ ...v, tx: v.tx + dx, ty: v.ty + dy }); }
  };

  const s = view?.s ?? 1;
  const linked = (id: string) => layout.edges.filter((e) => e.from === id || e.to === id).map((e) => byId.get(e.from === id ? e.to : e.from)?.label).filter(Boolean) as string[];

  return (
    <div
      ref={stageRef}
      role="group"
      aria-label={title}
      className="relative h-full w-full touch-none select-none overflow-hidden bg-canvas"
      style={view ? { backgroundImage: 'radial-gradient(var(--canvas-dot) 1.1px, transparent 1.3px)', backgroundSize: 24 * s + 'px ' + 24 * s + 'px', backgroundPosition: view.tx + 'px ' + view.ty + 'px' } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(e) => { if (e.key === 'Escape' && focus) { e.stopPropagation(); setFocus(null); } }}
    >
      {/* First in the DOM so Tab meets the tools before the boxes, as the eye does. */}
      <div data-map-ui role="toolbar" aria-label="Map tools" className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 @max-[640px]:left-auto @max-[640px]:right-3 @max-[640px]:translate-x-0 items-center gap-0.5 rounded-full bg-panel p-1 shadow-[var(--shadow)] ring-1 ring-line">
        <ToolButton label="Fit to view" onClick={fit}><Maximize size={14} aria-hidden /></ToolButton>
        <ToolButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)} disabled={s <= MIN_S + 0.001}><Minus size={14} aria-hidden /></ToolButton>
        <span className="min-w-11 text-center font-mono text-hint tabular-nums text-muted" aria-live="polite" aria-label={'Zoom ' + Math.round(s * 100) + '%'}>{Math.round(s * 100)}%</span>
        <ToolButton label="Zoom in" onClick={() => zoomBy(1.2)} disabled={s >= MAX_S - 0.001}><Plus size={14} aria-hidden /></ToolButton>
        {toolbarEnd && <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />}
        {toolbarEnd}
      </div>
      {view && (
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
          <svg aria-hidden className="absolute left-0 top-0 overflow-visible" width="1" height="1">
            {sphereAt && <Sphere x={sphereAt.x} y={sphereAt.y} />}
            {layout.edges.map((e, i) => {
              const a = byId.get(e.from), b = byId.get(e.to);
              if (!a || !b) return null;
              const near = !!focus && (e.from === focus || e.to === focus);
              return (
                <path
                  key={i}
                  d={edgePath(a, b)}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                  stroke={near || e.tone === 'active' ? 'var(--accent)' : 'var(--edge)'}
                  strokeWidth={near ? 1.6 : 1.2}
                  strokeDasharray={near ? undefined : e.tone === 'active' ? '5 4' : e.tone === 'off' ? '1.5 4' : undefined}
                  strokeLinecap="round"
                  opacity={e.tone === 'off' && !near ? 0.8 : 1}
                />
              );
            })}
          </svg>
          {layout.groups.map((g) => (
            <span key={g.name} aria-hidden className="absolute -translate-x-1/2 whitespace-nowrap font-mono text-hint lowercase text-dim" style={{ left: g.x, top: g.y }}>{g.name}</span>
          ))}
          {layout.nodes.map((n) => (
            <MapNode key={n.id} node={n} focused={focus === n.id} picked={picked.includes(n.id)} readOnly={readOnly}
              onFocusBox={() => reveal(n)}
              onToggle={() => setFocus(focus === n.id ? null : n.id)} />
          ))}
          {focused && !readOnly && (
            <>
              <Bubble x={focused.x - NODE_W / 2 - 26} y={focused.y} label={'Ask about ' + focused.label} onClick={() => onAsk(focused)}>
                <MessageSquarePlus size={14} aria-hidden />
              </Bubble>
              <Popover>
                <Tooltip content="Details">
                  <PopoverTrigger asChild>
                    <button type="button" aria-label={'Details of ' + focused.label} data-map-ui className={BUBBLE} style={{ left: focused.x + NODE_W / 2 + 26, top: focused.y }}>
                      <Info size={14} aria-hidden />
                    </button>
                  </PopoverTrigger>
                </Tooltip>
                <PopoverContent side="bottom" className="w-64 space-y-1">
                  <div className="font-mono text-label lowercase text-fg [overflow-wrap:anywhere]">{focused.label}</div>
                  {focused.tech && <div className="text-hint text-muted [overflow-wrap:anywhere]">{focused.tech}</div>}
                  <div className="text-hint text-muted">{[focused.state, focused.group].filter(Boolean).join(' · ') || 'No group'}</div>
                  <div className="text-hint text-muted [overflow-wrap:anywhere]">{linked(focused.id).length ? 'Links: ' + linked(focused.id).join(', ') : 'No links'}</div>
                </PopoverContent>
              </Popover>
            </>
          )}
        </div>
      )}

    </div>
  );
}

const BUBBLE = 'absolute z-10 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-panel text-fg shadow-[var(--glow)] ring-1 ring-accent/60 hover:bg-card2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:h-11 pointer-coarse:w-11';

function Bubble({ x, y, label, onClick, children }: { x: number; y: number; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} data-map-ui className={BUBBLE} style={{ left: x, top: y }} onClick={onClick}>{children}</button>
    </Tooltip>
  );
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={label} side="bottom">
      <ToolButtonShell label={label} disabled={disabled} onClick={onClick}>{children}</ToolButtonShell>
    </Tooltip>
  );
}

const PORTS = [
  { left: 'calc(50% - 3px)', top: -3.5 }, { left: 'calc(50% - 3px)', bottom: -3.5 },
  { top: 'calc(50% - 3px)', left: -3.5 }, { top: 'calc(50% - 3px)', right: -3.5 },
];

/** One box: a lowercase mono label and a tech line, with four port dots that show on hover and focus. */
function MapNode({ node: n, focused, picked, readOnly, onToggle, onFocusBox }: { node: PlacedNode; focused: boolean; picked: boolean; readOnly: boolean; onToggle: () => void; onFocusBox: () => void }) {
  const state = n.state === 'done' ? 'done' : n.state === 'now' ? 'now' : n.state === 'next' ? 'next' : '';
  const box = cn(
    'group absolute flex -translate-y-1/2 flex-col items-start justify-center rounded-lg border px-3 py-2 text-left',
    'bg-node',
    focused || picked || n.state === 'now' ? 'border-accent' : n.state === 'done' ? 'border-line2' : n.state === 'next' ? 'border-dashed border-line2' : 'border-node-line',
    focused && 'ring-2 ring-accent/50 shadow-[var(--glow)]',
  );
  const style = { left: n.x - NODE_W / 2, top: n.y, width: NODE_W, minHeight: NODE_H };
  const body = (
    <>
      {state && state !== 'next' && <span className={cn('absolute -top-2 left-2.5 rounded-full bg-canvas px-1 font-mono text-hint lowercase', state === 'now' ? 'text-accent' : 'text-dim')}>{state}</span>}
      <span className={cn('w-full font-mono text-label lowercase [overflow-wrap:anywhere]', n.state === 'done' || n.state === 'next' ? 'text-muted' : 'text-fg')}>{n.label}</span>
      {n.tech && <span className="w-full font-mono text-hint text-muted [overflow-wrap:anywhere]">{n.tech}</span>}
      {!readOnly && PORTS.map((p, i) => (
        <i key={i} aria-hidden className={cn('absolute h-1.5 w-1.5 rounded-full opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100', focused ? 'bg-accent opacity-100' : 'bg-node-line')} style={p} />
      ))}
    </>
  );
  const name = n.label + (n.tech ? ', ' + n.tech : '') + (n.state ? ', ' + n.state : '');
  if (readOnly) return <div role="img" aria-label={name} className={box} style={style}>{body}</div>;
  return (
    <button type="button" aria-label={name} aria-pressed={focused} className={cn(box, 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent')} style={style} onClick={onToggle} onFocus={onFocusBox}>
      {body}
    </button>
  );
}

/** The focus sphere: a static wireframe (a circle, three meridians, an equator) in the accent at low strength. */
function Sphere({ x, y }: { x: number; y: number }) {
  const R = 118;
  return (
    <g transform={`translate(${x} ${y})`} stroke="var(--accent)" fill="none" strokeWidth="0.8" vectorEffect="non-scaling-stroke">
      <defs>
        <radialGradient id="map-sphere-fill">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.10" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle r={R * 1.2} fill="url(#map-sphere-fill)" stroke="none" />
      <g opacity="0.25">
        <circle r={R} />
        <ellipse rx={R * 0.62} ry={R} />
        <ellipse rx={R * 0.24} ry={R} />
        <ellipse rx={R} ry={R * 0.3} />
      </g>
    </g>
  );
}
