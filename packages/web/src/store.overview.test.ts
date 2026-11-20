import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(init));
  return {
    get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)),
  };
}

/** A fresh store in a window of `width`, with the new layout on or off. */
async function boot(width: number, toki: boolean, stored: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubGlobal('localStorage', memoryStorage({ 'pocketrocket.layout': toki ? 'toki' : 'classic', ...stored }));
  vi.stubGlobal('window', { innerWidth: width, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, location: { search: '', hash: '', pathname: '/' } });
  vi.stubGlobal('document', { hasFocus: () => true, documentElement: { dataset: {} } });
  const { useStore } = await import('./store');
  return useStore;
}

beforeAll(async () => { await boot(1440, false); }, 60000);
afterEach(() => vi.unstubAllGlobals());

describe('the overview in the store (new layout)', () => {
  it('opens on a wide window, as the rail below 1280', async () => {
    let s = (await boot(1440, true)).getState();
    expect([s.panelOpen, s.panelKind, s.overviewRail]).toEqual([true, 'overview', false]);
    s = (await boot(1100, true)).getState();
    expect([s.panelOpen, s.panelKind, s.overviewRail]).toEqual([true, 'overview', true]);
    s = (await boot(900, true)).getState();
    expect(s.panelOpen).toBe(false);
  });

  it('remembers the rail once chosen', async () => {
    const s = (await boot(1440, true, { 'pocketrocket.overviewRail': '1' })).getState();
    expect(s.overviewRail).toBe(true);
  });

  it('leaves the classic layout as it was', async () => {
    const store = await boot(1440, false);
    expect([store.getState().panelOpen, store.getState().panelKind]).toEqual([false, 'screen']);
    store.getState().openFiles();
    store.getState().closePanel();
    expect(store.getState().panelOpen).toBe(false);
  });

  it('goes back to the overview when the screen or files close', async () => {
    const store = await boot(1440, true);
    store.getState().openScreen();
    expect(store.getState().panelKind).toBe('screen');
    store.getState().closePanel();
    expect([store.getState().panelOpen, store.getState().panelKind]).toEqual([true, 'overview']);
    store.getState().openFiles();
    store.getState().closePanel();
    expect([store.getState().panelOpen, store.getState().panelKind]).toEqual([true, 'overview']);
  });

  it('closes for real when the overview itself, or anything covering a phone, closes', async () => {
    let store = await boot(1440, true);
    store.getState().closePanel();
    expect(store.getState().panelOpen).toBe(false);
    store = await boot(390, true);
    store.getState().openFiles();
    store.getState().closePanel();
    // Closed, and the next open is the overview rather than the files again.
    expect([store.getState().panelOpen, store.getState().panelKind]).toEqual([false, 'overview']);
  });

  it('refetches projects on a bare projects.changed', async () => {
    const store = await boot(1440, true);
    const load = vi.fn(async () => undefined);
    store.setState({ loadProjects: load });
    store.getState().applyEvent({ type: 'projects.changed' });
    expect(load).toHaveBeenCalledOnce();
  });

  it("remembers who was asked for a map until that bot's turn in the room ends, then refetches it", async () => {
    const store = await boot(1440, true);
    const sent: string[] = [];
    const loadMap = vi.fn(async () => undefined);
    store.setState({
      activeRoomId: 'r1', projects: [{ slug: 'toki', name: 'Toki', dir: 'x', memberIds: ['b1'], roomId: 'r1', templateVersion: 3, createdAt: 0 }],
      maps: { toki: { map: null, error: null, mtime: null, droppedEdges: 0 } }, sendMessage: (t: string) => void sent.push(t), loadMap,
    });
    store.getState().askForMap('toki', 'b1', '@lead draw it');
    expect(sent).toEqual(['@lead draw it']);
    expect(store.getState().mapAsks.toki).toEqual({ botId: 'b1', roomId: 'r1', phase: 'sent' });
    store.getState().applyEvent({ type: 'turn.end', turnId: 't', roomId: 'r1', botId: 'b2' });
    expect(store.getState().mapAsks.toki.phase).toBe('sent');
    store.getState().applyEvent({ type: 'turn.end', turnId: 't', roomId: 'r1', botId: 'b1' });
    expect(store.getState().mapAsks.toki.phase).toBe('done');
    expect(loadMap).toHaveBeenCalledWith('toki');
  });
});
