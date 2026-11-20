import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPersistMemory } from './persist';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

/** A fresh copy of the module, so its remembered layout comes from the storage stubbed for this test. */
async function load(seed: Record<string, string> = {}) {
  vi.resetModules();
  const ls = memoryStorage(seed);
  vi.stubGlobal('localStorage', ls);
  return { ls, layout: await import('./layout') };
}

beforeEach(() => resetPersistMemory());
afterEach(() => vi.unstubAllGlobals());

describe('parseLayout', () => {
  it('is the new layout for anything but an explicit classic', async () => {
    const { layout } = await load();
    expect(layout.parseLayout('classic')).toBe('classic');
    for (const raw of [null, '', 'toki', 'CLASSIC', 'new', '"classic"']) expect(layout.parseLayout(raw)).toBe('toki');
  });
});

describe('the hub setting', () => {
  it('maps auto, a missing setting and toki to the new layout', async () => {
    const { layout } = await load();
    expect(layout.layoutFromSetting('classic')).toBe('classic');
    for (const s of ['auto', 'toki', undefined] as const) expect(layout.layoutFromSetting(s)).toBe('toki');
  });

  it('copies a deliberate classic from this browser to a hub with no choice yet, and nothing else', async () => {
    const chose = await load({ 'pocketrocket.layout': 'classic' });
    expect(chose.layout.layoutToMigrate('auto')).toBe('classic');
    expect(chose.layout.layoutToMigrate(undefined)).toBe('classic');
    expect(chose.layout.layoutToMigrate('toki')).toBeNull(); // the hub's own choice wins
    expect((await load({ 'pocketrocket.layout': 'toki' })).layout.layoutToMigrate('auto')).toBeNull();
    expect((await load()).layout.layoutToMigrate('auto')).toBeNull();
  });
});

describe('asksForPreview', () => {
  it('reads layout=preview from the query only', async () => {
    const { layout } = await load();
    expect(layout.asksForPreview('?layout=preview')).toBe(true);
    expect(layout.asksForPreview('?x=1&layout=preview')).toBe(true);
    expect(layout.asksForPreview('')).toBe(false);
    expect(layout.asksForPreview('?layout=toki')).toBe(false);
  });
});

describe('the stored layout', () => {
  it('starts on the new layout on a browser that never chose', async () => {
    const { layout } = await load();
    expect(layout.getLayout()).toBe('toki');
  });

  it('keeps a browser that chose classic on classic', async () => {
    expect((await load({ 'pocketrocket.layout': 'classic' })).layout.getLayout()).toBe('classic');
  });

  it('survives a reload', async () => {
    const first = await load();
    first.layout.setLayout('classic');
    expect(first.ls.getItem('pocketrocket.layout')).toBe('classic');
    const second = await load({ 'pocketrocket.layout': 'classic' });
    expect(second.layout.getLayout()).toBe('classic');
  });

  it('tells subscribers when it flips, and only then', async () => {
    const { layout: { setLayout, getLayout, subscribeLayout } } = await load();
    const seen: string[] = [];
    const unsubscribe = subscribeLayout(() => seen.push(getLayout()));
    setLayout('toki'); // no change
    setLayout('classic');
    setLayout('classic'); // no change
    setLayout('toki');
    unsubscribe();
    setLayout('classic'); // no longer listening
    expect(seen).toEqual(['classic', 'toki']);
  });

  it('shows the switch to everyone from phase 3', async () => {
    expect((await load()).layout.layoutSwitchShown()).toBe(true);
    expect((await load({ 'pocketrocket.layout': 'toki' })).layout.layoutSwitchShown()).toBe(true);
  });
});
