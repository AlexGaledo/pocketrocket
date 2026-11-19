import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getItem, getJson, removeItem, resetPersistMemory, setItem, setJson, versionedKey } from './persist';

/** A Storage that works. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
/** A Storage that throws on every call, like a blocked or full one. */
function brokenStorage(): Storage {
  const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
  return { get length() { return boom(); }, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
}

beforeEach(() => resetPersistMemory());
afterEach(() => vi.unstubAllGlobals());

describe('persist with working storage', () => {
  it('round-trips strings and JSON under the exact key it is given', () => {
    const ls = memoryStorage();
    vi.stubGlobal('localStorage', ls);
    expect(setItem('pocketrocket.sidebar', '0')).toBe(true);
    expect(ls.getItem('pocketrocket.sidebar')).toBe('0'); // existing key names and values are untouched
    expect(getItem('pocketrocket.sidebar')).toBe('0');
    setJson('pocketrocket.collapsedSections', ['a', 'b']);
    expect(ls.getItem('pocketrocket.collapsedSections')).toBe('["a","b"]');
    expect(getJson('pocketrocket.collapsedSections', Array.isArray as (v: unknown) => v is unknown[], [])).toEqual(['a', 'b']);
    removeItem('pocketrocket.sidebar');
    expect(getItem('pocketrocket.sidebar')).toBeNull();
  });

  it('keeps the two areas apart', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    setItem('k', 'local');
    setItem('k', 'session', 'session');
    expect(getItem('k')).toBe('local');
    expect(getItem('k', 'session')).toBe('session');
  });

  it('returns the fallback for junk or the wrong shape', () => {
    const ls = memoryStorage();
    vi.stubGlobal('localStorage', ls);
    const isNum = (v: unknown): v is number => typeof v === 'number';
    ls.setItem('a', '{not json');
    ls.setItem('b', '"text"');
    expect(getJson('a', isNum, 7)).toBe(7);
    expect(getJson('b', isNum, 7)).toBe(7);
    expect(getJson('missing', isNum, 7)).toBe(7);
  });

  it('builds versioned keys', () => {
    expect(versionedKey('draft', 1)).toBe('pocketrocket.draft.v1');
  });
});

describe('persist with storage that throws', () => {
  it('never throws, and holds what was written for the session', () => {
    vi.stubGlobal('localStorage', brokenStorage());
    expect(() => getItem('k')).not.toThrow();
    expect(getItem('k')).toBeNull();
    expect(setItem('k', 'v')).toBe(false);
    expect(getItem('k')).toBe('v');
    expect(setJson('j', { a: 1 })).toBe(false);
    expect(getJson('j', (v): v is { a: number } => typeof v === 'object', { a: 0 })).toEqual({ a: 1 });
    removeItem('k');
    expect(getItem('k')).toBeNull();
  });

  it('copes when the storage object itself is missing or its getter throws', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(getItem('k')).toBeNull();
    expect(setItem('k', 'v')).toBe(false);
    expect(getItem('k')).toBe('v');
    resetPersistMemory();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('denied'); } });
    try {
      expect(getItem('t', 'session')).toBeNull();
      expect(setItem('t', 'x', 'session')).toBe(false);
      expect(getItem('t', 'session')).toBe('x');
    } finally {
      delete (globalThis as Record<string, unknown>).sessionStorage;
    }
  });

  it('prefers the in-memory value over a stale stored one after a failed write', () => {
    const ls = memoryStorage();
    vi.stubGlobal('localStorage', ls);
    setItem('k', 'old');
    ls.setItem = () => { throw new Error('quota'); };
    setItem('k', 'new');
    expect(getItem('k')).toBe('new');
  });
});
