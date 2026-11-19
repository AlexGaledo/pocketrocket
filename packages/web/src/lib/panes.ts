/**
 * Widths of the sidebar and the right panel. Kept per browser, not in hub settings, because a good width
 * depends on the window it was chosen in. The stored value is the wish; `paneLayout` works out what fits, so a
 * small window never overwrites it and the pane grows back when the window does.
 */
import { getItem, setItem } from './persist';
export type PaneId = 'sidebar' | 'panel' | 'overview';
/** The widths asked for, per pane. The panel and the overview share one slot and keep a width each. */
export type PaneWidths = Record<PaneId, number>;
/** What the two slots actually get: the sidebar, and the right slot (the panel or the overview). */
export type SlotWidths = { sidebar: number; panel: number };
/** What the right slot shows (store `panelKind`). Missing reads as the screen. */
export type PanelKind = 'screen' | 'files' | 'overview';

export const PANES = {
  sidebar: { def: 260, min: 200, max: 420, key: 'pocketrocket.width.sidebar' },
  panel: { def: 400, min: 320, max: 1200, key: 'pocketrocket.width.panel' },
  /** The project overview in the right slot (new layout, docs/specs/toki-ui.md W6). */
  overview: { def: 300, min: 260, max: 420, key: 'pocketrocket.width.overview' },
} as const;

/** The overview folded to a column of icons. Fixed: there is nothing to resize. */
export const RAIL_W = 56;
/** In the new layout the overview opens by default from this window width; below it, it starts as the rail. */
export const OVERVIEW_OPEN_MIN = 1280;

export const CHAT_MIN = 440;
/** The chat beside a screen the user is driving. */
export const CHAT_RAIL_W = 360;
/** One separator's width. Both stay in the layout while their pane is collapsed. */
export const SEP_W = 10;
/** The button that replaces a collapsed sidebar. */
export const REOPEN_W = 40;
/** How far past the minimum a drag must go to collapse the pane on release. */
export const COLLAPSE_PAST = 48;

export const SIDEBAR_INLINE_MIN = 768;
/** Below this the sidebar's and panel's minimums plus the chat's no longer fit, so the panel is a drawer. */
export const PANEL_INLINE_MIN = PANES.sidebar.min + PANES.panel.min + CHAT_MIN + SEP_W * 2;
/** Without the sidebar the panel still fits beside the chat down to here. */
export const PANEL_SOLO_MIN = PANES.panel.min + CHAT_MIN + SEP_W * 2 + REOPEN_W;

/**
 * Too narrow for all three, wide enough for chat and panel: an open panel takes the sidebar's place rather than
 * covering the whole window, and the sidebar comes back when the panel closes.
 */
export const panelSqueezesSidebar = (vw: number, panelOpen: boolean) => panelOpen && vw >= PANEL_SOLO_MIN && vw < PANEL_INLINE_MIN;

export const clampPane = (want: number, min: number, max: number, room: number) => Math.max(min, Math.min(want, max, room));

export interface PaneState {
  paneW: PaneWidths;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelExpanded: boolean;
  panelKind?: PanelKind;
  /** The overview is folded to its icon rail. */
  overviewRail?: boolean;
}

/** Which stored width the right slot uses now. */
export const slotPane = (s: Pick<PaneState, 'panelKind'>): 'panel' | 'overview' => (s.panelKind === 'overview' ? 'overview' : 'panel');
/** The pane whose limits a separator works with: the sidebar, or whatever the right slot shows. */
export const separatorPane = (pane: 'sidebar' | 'panel', s: Pick<PaneState, 'panelKind'>): PaneId => (pane === 'sidebar' ? 'sidebar' : slotPane(s));
/** The overview's rail has one width; nothing about it is chosen or stored. */
export const isRail = (s: Pick<PaneState, 'panelKind' | 'overviewRail'>) => s.panelKind === 'overview' && !!s.overviewRail;

/** Width shared by the two panes once the chat has its minimum. */
function paneRoom(vw: number, sidebarOn: boolean) {
  return vw - SEP_W * 2 - CHAT_MIN - (sidebarOn ? 0 : REOPEN_W);
}

/** What each pane actually gets at this window width; 0 when collapsed or shown as a drawer. */
export function paneLayout(vw: number, s: PaneState): SlotWidths {
  // The overview never pushes the sidebar out: below the three-pane width it covers the window instead (App.tsx).
  const overview = s.panelKind === 'overview';
  const sidebarOn = s.sidebarOpen && vw >= SIDEBAR_INLINE_MIN && !panelSqueezesSidebar(vw, s.panelOpen && !overview);
  const panelOn = s.panelOpen && vw >= (overview ? PANEL_INLINE_MIN : PANEL_SOLO_MIN);
  const room = paneRoom(vw, sidebarOn);
  const sb = PANES.sidebar;
  const slot = slotPane(s);
  const pn = PANES[slot];
  // Expanded is a screen thing; the overview only ever has its own width or the rail.
  const want = slot === 'panel' && s.panelExpanded ? pn.max : s.paneW[slot];
  const panel = !panelOn ? 0 : isRail(s) ? RAIL_W : clampPane(want, pn.min, pn.max, room - (sidebarOn ? sb.min : 0));
  const sidebar = sidebarOn ? clampPane(s.paneW.sidebar, sb.min, sb.max, room - panel) : 0;
  return { sidebar, panel };
}

/** The range a separator can move in now: the other pane holds its width, so the chat keeps its minimum. */
export function paneRange(pane: 'sidebar' | 'panel', vw: number, s: PaneState): { min: number; max: number } {
  const now = paneLayout(vw, s);
  const other = pane === 'sidebar' ? now.panel : now.sidebar;
  const { min, max } = PANES[separatorPane(pane, s)];
  return { min, max: Math.max(min, Math.min(max, paneRoom(vw, now.sidebar > 0) - other)) };
}

/** Sets the CSS variables the pane wrappers read. No React render, so a drag never touches the chat or the screen. */
export function applyPaneVars(w: SlotWidths) {
  const root = document.documentElement.style;
  root.setProperty('--sidebar-w', w.sidebar + 'px');
  root.setProperty('--panel-w', w.panel + 'px');
}

/** Watching is a split about half and half, not a side tab. `PANES.panel.def` is its floor on a small window. */
export function panelDefault(vw: number) {
  return Math.max(PANES.panel.def, Math.min(PANES.panel.max, Math.round((vw - PANES.sidebar.def - SEP_W * 2) / 2)));
}

/** A stored number, or the default when storage is empty, blocked or holds junk. */
export function readPaneWidths(vw: number): PaneWidths {
  const read = (pane: PaneId) => {
    const v = Number(getItem(PANES[pane].key));
    if (v > 0) return clampPane(v, PANES[pane].min, PANES[pane].max, Infinity);
    return pane === 'panel' ? panelDefault(vw) : PANES[pane].def;
  };
  return { sidebar: read('sidebar'), panel: read('panel'), overview: read('overview') };
}

export function writePaneWidth(pane: PaneId, width: number) {
  setItem(PANES[pane].key, String(Math.round(width))); // a blocked store keeps it in memory for this session
}
