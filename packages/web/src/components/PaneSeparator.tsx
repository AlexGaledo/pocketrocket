import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from '../store';
import { COLLAPSE_PAST, PANES, applyPaneVars, panelDefault, paneLayout, paneRange, type PaneId } from '../lib/panes';

const subscribeResize = (onChange: () => void) => {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
};
const windowWidth = () => window.innerWidth;

const STEP = 16;
const STEP_LARGE = 64;

/**
 * The WAI-ARIA window splitter. It stays mounted while its pane is collapsed, so Enter can bring the pane back.
 * During a drag it only sets CSS variables: no store write and no React render, so the chat does not re-render
 * and the screen's iframe is left alone, with no new ticket and no reconnect. The store is written on release.
 */
export function PaneSeparator({ pane, label, controls }: { pane: PaneId; label: string; controls: string }) {
  const open = useStore((s) => (pane === 'sidebar' ? s.sidebarOpen : s.panelOpen));
  const setPaneW = useStore((s) => s.setPaneW);
  const setPaneOpen = useStore((s) => s.setPaneOpen);
  // Subscribed so the values below stay right as the other pane or the window changes size.
  useStore((s) => s.paneW);
  useStore((s) => s.panelExpanded);
  useStore((s) => (pane === 'sidebar' ? s.panelOpen : s.sidebarOpen));
  const vw = useSyncExternalStore(subscribeResize, windowWidth);
  const state = useStore.getState();
  const width = paneLayout(vw, state)[pane];
  const { max } = paneRange(pane, vw, state);

  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; w0: number; raw: number; moved: boolean } | null>(null);
  const dir = pane === 'sidebar' ? 1 : -1;

  const showWidth = (w: number) => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('aria-valuenow', String(w));
    el.setAttribute('aria-valuetext', w + ' pixels');
  };
  const paint = (want: number) => {
    const s = useStore.getState();
    const { min, max: top } = paneRange(pane, window.innerWidth, s);
    const w = Math.max(min, Math.min(want, top));
    applyPaneVars({ ...paneLayout(window.innerWidth, s), [pane]: w });
    showWidth(w);
    return w;
  };
  /** Takes off everything the drag put on the page. */
  const endDrag = () => {
    drag.current = null;
    delete document.body.dataset.paneDrag;
    ref.current?.removeAttribute('data-dragging');
  };
  // Shrinking the window to drawer width mid-drag unmounts this; the iframe guard must not outlive it.
  useEffect(() => () => { if (drag.current) delete document.body.dataset.paneDrag; }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !open) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true }); // So Escape can cancel the drag.
    el.setAttribute('data-dragging', '');
    document.body.dataset.paneDrag = '';
    const w0 = paneLayout(window.innerWidth, useStore.getState())[pane];
    drag.current = { id: e.pointerId, x0: e.clientX, w0, raw: w0, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    d.raw = d.w0 + (e.clientX - d.x0) * dir;
    d.moved ||= e.clientX !== d.x0;
    paint(d.raw);
  };
  // Also runs on lostpointercapture, which follows every release; by then the drag is over and this does nothing.
  const onRelease = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    endDrag();
    if (!d.moved) return;
    // Collapsing keeps the width the drag started from, so reopening restores it.
    if (d.raw < PANES[pane].min - COLLAPSE_PAST) setPaneOpen(pane, false);
    else setPaneW(pane, paint(d.raw));
  };
  /** The store was never written, so going back only means repainting what it holds. */
  const onCancel = () => {
    const d = drag.current;
    if (!d) return;
    endDrag();
    applyPaneVars(paneLayout(window.innerWidth, useStore.getState()));
    showWidth(d.w0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (!drag.current) return;
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter') {
      setPaneOpen(pane, !open);
    } else if (!open) {
      return;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = (e.shiftKey ? STEP_LARGE : STEP) * (e.key === 'ArrowRight' ? dir : -dir);
      setPaneW(pane, paint(width + step));
    } else if (e.key === 'Home') {
      setPaneW(pane, PANES[pane].min);
    } else if (e.key === 'End') {
      setPaneW(pane, max);
    } else {
      return;
    }
    e.preventDefault();
  };
  const onDoubleClick = () => {
    if (!open) setPaneOpen(pane, true);
    setPaneW(pane, pane === 'panel' ? panelDefault(window.innerWidth) : PANES[pane].def);
  };

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={open ? width : 0}
      aria-valuetext={open ? width + ' pixels' : 'collapsed'}
      title="Drag to resize. Double-click to reset."
      data-collapsed={open ? undefined : ''}
      className="pane-sep"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onRelease}
      onPointerCancel={onCancel}
      onLostPointerCapture={onRelease}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}
