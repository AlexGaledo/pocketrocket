/**
 * The "New layout" toggle (docs/specs/toki-ui.md, W2). `classic` is today's app; `toki` is the project-first layout
 * being built behind it. Per browser, so it never touches the hub's settings: `pocketrocket.layout` holds the
 * choice and `public/theme-init.js` mirrors it onto `<html data-layout>` before first paint.
 *
 * From phase 3 the switch in Settings › Appearance is shown to everyone. Phases 1-2 hid it until this browser had
 * opened the app with `?layout=preview`; that visit is still remembered and the parameter still stripped, so old
 * links stay tidy.
 */
import { useSyncExternalStore } from 'react';
import { getItem, setItem } from './persist';

export type Layout = 'classic' | 'toki';

export const LAYOUT_KEY = 'pocketrocket.layout';
export const LAYOUT_PREVIEW_KEY = 'pocketrocket.layoutPreview';

/** Anything but an explicit `toki` is the classic layout, so junk in storage can never strand someone. */
export function parseLayout(raw: string | null): Layout {
  return raw === 'toki' ? 'toki' : 'classic';
}

/** True when the URL's query carries `layout=preview` (the hash, which holds the token, is never read here). */
export function asksForPreview(search: string): boolean {
  return new URLSearchParams(search).get('layout') === 'preview';
}

const listeners = new Set<() => void>();
let current: Layout = parseLayout(getItem(LAYOUT_KEY));

function apply(layout: Layout) {
  if (typeof document !== 'undefined') document.documentElement.dataset.layout = layout;
}

export function getLayout(): Layout {
  return current;
}

export function setLayout(next: Layout): void {
  if (next === current) return;
  current = next;
  setItem(LAYOUT_KEY, next); // a blocked store keeps it for this session only
  apply(next);
  for (const l of listeners) l();
}

/** Whether Settings shows the "New layout" switch: always, now that the project map is in (phase 3). */
export function layoutSwitchShown(): boolean {
  return true;
}

/**
 * Runs once before the first render: remembers a `?layout=preview` visit, then drops the parameter from the address
 * bar (keeping the path and the hash) so a copied link doesn't carry it.
 */
export function initLayout(): void {
  apply(current);
  try {
    if (!asksForPreview(window.location.search)) return;
    setItem(LAYOUT_PREVIEW_KEY, '1');
    const params = new URLSearchParams(window.location.search);
    params.delete('layout');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
  } catch {
    // No window or no history (tests, a sandboxed frame): the switch just stays hidden.
  }
}

/** For useSyncExternalStore (and tests): calls `onChange` after each flip. */
export function subscribeLayout(onChange: () => void) {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** The layout in force for this browser; re-renders when the switch flips. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, getLayout, getLayout);
}
