/**
 * Which layout the web app shows (docs/specs/toki-ui.md, W2 and W12). `toki` is the project-first layout and, from
 * phase 7, the default; `classic` is the old app, kept as the escape hatch ("Classic layout" in Settings ›
 * Appearance).
 *
 * The choice lives in the hub's settings (`settings.layout`), so it follows the owner across browsers. This module
 * keeps a copy in `pocketrocket.layout` so the first paint, before the hub answers, is already right;
 * `public/theme-init.js` mirrors it onto `<html data-layout>`. Paired phones keep the classic layout: every caller
 * checks the device flag (useToki, useNewLayout, the store).
 *
 * Before phase 7 the choice was per browser and written only when someone flipped the switch, so a stored `classic`
 * is a deliberate choice. The store copies it to the hub once, while the hub still says `auto` (layoutToMigrate).
 * The old `?layout=preview` parameter is still stripped from the address bar, so old links stay tidy.
 */
import { useSyncExternalStore } from 'react';
import { getItem, setItem } from './persist';

export type Layout = 'classic' | 'toki';

export const LAYOUT_KEY = 'pocketrocket.layout';
export const LAYOUT_PREVIEW_KEY = 'pocketrocket.layoutPreview';

/** Only an explicit `classic` is the classic layout; nothing stored (or junk) is the default, the new layout. */
export function parseLayout(raw: string | null): Layout {
  return raw === 'classic' ? 'classic' : 'toki';
}

type LayoutSetting = 'auto' | 'toki' | 'classic' | undefined;

/** The hub's setting as a layout: `auto` (or a hub too old to have the setting) is the default. */
export function layoutFromSetting(setting: LayoutSetting): Layout {
  return setting === 'classic' ? 'classic' : 'toki';
}

/**
 * The browser's own choice from before phase 7, worth copying to the hub while the hub has none (`auto`): only a
 * deliberate `classic`. A stored `toki` matches the default already.
 */
export function layoutToMigrate(setting: LayoutSetting): Layout | null {
  return (setting ?? 'auto') === 'auto' && getItem(LAYOUT_KEY) === 'classic' ? 'classic' : null;
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

/** Whether Settings shows the "Classic layout" switch: always (from phase 3; from phase 7 as the escape hatch). */
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
