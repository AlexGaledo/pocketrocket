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
  it('is classic for anything but an explicit toki', async () => {
    const { layout } = await load();
    expect(layout.parseLayout('toki')).toBe('toki');
    for (const raw of [null, '', 'classic', 'TOKI', 'new', '"toki"']) expect(layout.parseLayout(raw)).toBe('classic');
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
  it('starts classic on a browser that never chose', async () => {
    const { layout } = await load();
    expect(layout.getLayout()).toBe('classic');
  });

  it('survives a reload', async () => {
    const first = await load();
    first.layout.setLayout('toki');
    expect(first.ls.getItem('pocketrocket.layout')).toBe('toki');
    const second = await load({ 'pocketrocket.layout': 'toki' });
    expect(second.layout.getLayout()).toBe('toki');
  });

  it('tells subscribers when it flips, and only then', async () => {
    const { layout: { setLayout, getLayout, subscribeLayout } } = await load();
    const seen: string[] = [];
    const unsubscribe = subscribeLayout(() => seen.push(getLayout()));
    setLayout('classic'); // no change
    setLayout('toki');
    setLayout('toki'); // no change
    setLayout('classic');
    unsubscribe();
    setLayout('toki'); // no longer listening
    expect(seen).toEqual(['toki', 'classic']);
  });

  it('shows the switch to everyone from phase 3', async () => {
    expect((await load()).layout.layoutSwitchShown()).toBe(true);
    expect((await load({ 'pocketrocket.layout': 'toki' })).layout.layoutSwitchShown()).toBe(true);
  });
});
