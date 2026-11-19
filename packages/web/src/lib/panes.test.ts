import { describe, expect, it, vi } from 'vitest';

// lib/persist touches localStorage on import paths only when called; nothing here reads storage.
vi.mock('./persist', () => ({ getItem: () => null, setItem: () => undefined }));
const { PANES, PANEL_INLINE_MIN, RAIL_W, paneLayout, paneRange, separatorPane } = await import('./panes');

const base = { paneW: { sidebar: 260, panel: 600, overview: 320 }, sidebarOpen: true, panelOpen: true, panelExpanded: false };

describe('paneLayout with the overview', () => {
  it('gives the overview its own width, not the screen panel one', () => {
    expect(paneLayout(1440, { ...base, panelKind: 'overview' }).panel).toBe(320);
    expect(paneLayout(1440, { ...base, panelKind: 'files' }).panel).toBe(600);
  });

  it('keeps the overview within its limits', () => {
    expect(paneLayout(1440, { ...base, panelKind: 'overview', paneW: { ...base.paneW, overview: 900 } }).panel).toBe(PANES.overview.max);
    expect(paneLayout(1440, { ...base, panelKind: 'overview', paneW: { ...base.paneW, overview: 10 } }).panel).toBe(PANES.overview.min);
  });

  it('folds to a fixed rail', () => {
    expect(paneLayout(1440, { ...base, panelKind: 'overview', overviewRail: true }).panel).toBe(RAIL_W);
    // The rail is the overview's: a screen opened over it has its usual width.
    expect(paneLayout(1440, { ...base, panelKind: 'screen', overviewRail: true }).panel).toBe(600);
  });

  it('ignores expanded, which is a screen thing', () => {
    expect(paneLayout(1440, { ...base, panelKind: 'overview', panelExpanded: true }).panel).toBe(320);
  });

  it('never squeezes the sidebar out, and takes no inline width below the three-pane width', () => {
    const narrow = PANEL_INLINE_MIN - 60;
    const w = paneLayout(narrow, { ...base, panelKind: 'overview' });
    expect(w.panel).toBe(0);
    expect(w.sidebar).toBeGreaterThan(0);
    // Files at the same width still fold the sidebar away, as before.
    expect(paneLayout(narrow, { ...base, panelKind: 'files' }).sidebar).toBe(0);
  });

  it('is unchanged for the classic layout (no kind given)', () => {
    expect(paneLayout(1440, base)).toEqual({ sidebar: 260, panel: 600 });
  });

  it('points the right separator at the overview limits', () => {
    expect(separatorPane('panel', { panelKind: 'overview' })).toBe('overview');
    expect(separatorPane('panel', { panelKind: 'screen' })).toBe('panel');
    expect(separatorPane('sidebar', { panelKind: 'overview' })).toBe('sidebar');
    expect(paneRange('panel', 1440, { ...base, panelKind: 'overview' })).toEqual({ min: PANES.overview.min, max: PANES.overview.max });
  });
});
