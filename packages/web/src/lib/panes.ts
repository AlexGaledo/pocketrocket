/**
 * Widths of the sidebar and the right panel. Kept per browser, not in hub settings, because a good width
 * depends on the window it was chosen in. The stored value is the wish; `paneLayout` works out what fits, so a
 * small window never overwrites it and the pane grows back when the window does.
 */
export type PaneId = 'sidebar' | 'panel';
export type PaneWidths = Record<PaneId, number>;

export const PANES = {
  sidebar: { def: 260, min: 200, max: 420, key: 'prcrew.width.sidebar' },
  panel: { def: 400, min: 320, max: 1200, key: 'prcrew.width.panel' },
} as const;

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

export const clampPane = (want: number, min: number, max: number, room: number) => Math.max(min, Math.min(want, max, room));

export interface PaneState {
  paneW: PaneWidths;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelExpanded: boolean;
}

/** Width shared by the two panes once the chat has its minimum. */
function paneRoom(vw: number, sidebarOn: boolean) {
  return vw - SEP_W * 2 - CHAT_MIN - (sidebarOn ? 0 : REOPEN_W);
}

/** What each pane actually gets at this window width; 0 when collapsed or shown as a drawer. */
export function paneLayout(vw: number, s: PaneState): PaneWidths {
  const sidebarOn = s.sidebarOpen && vw >= SIDEBAR_INLINE_MIN;
  const panelOn = s.panelOpen && vw >= PANEL_INLINE_MIN;
  const room = paneRoom(vw, sidebarOn);
  const { sidebar: sb, panel: pn } = PANES;
  const panel = panelOn ? clampPane(s.panelExpanded ? pn.max : s.paneW.panel, pn.min, pn.max, room - (sidebarOn ? sb.min : 0)) : 0;
  const sidebar = sidebarOn ? clampPane(s.paneW.sidebar, sb.min, sb.max, room - panel) : 0;
  return { sidebar, panel };
}

/** The range a separator can move in now: the other pane holds its width, so the chat keeps its minimum. */
export function paneRange(pane: PaneId, vw: number, s: PaneState): { min: number; max: number } {
  const now = paneLayout(vw, s);
  const other = pane === 'sidebar' ? now.panel : now.sidebar;
  const { min, max } = PANES[pane];
  return { min, max: Math.max(min, Math.min(max, paneRoom(vw, now.sidebar > 0) - other)) };
}

/** Sets the CSS variables the pane wrappers read. No React render, so a drag never touches the chat or the screen. */
export function applyPaneVars(w: PaneWidths) {
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
    try {
      const v = Number(localStorage.getItem(PANES[pane].key));
      if (v > 0) return clampPane(v, PANES[pane].min, PANES[pane].max, Infinity);
    } catch {
      /* storage blocked: the default below */
    }
    return pane === 'panel' ? panelDefault(vw) : PANES[pane].def;
  };
  return { sidebar: read('sidebar'), panel: read('panel') };
}

export function writePaneWidth(pane: PaneId, width: number) {
  try {
    localStorage.setItem(PANES[pane].key, String(Math.round(width)));
  } catch {
    /* storage unavailable; the width still holds for this session */
  }
}
