import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = (): Storage => { const m = new Map<string, string>(); return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)) }; };
beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', mem());
  vi.stubGlobal('sessionStorage', mem());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('form refusals', () => {
  it('routes a hub error naming a sent form to its card, not a toast', async () => {
    const { useStore } = await import('../store');
    const s = useStore.getState();
    s.formSent('f1');
    s.applyEvent({ type: 'error', message: 'Forms are not for secrets', context: 'f1' });
    expect(useStore.getState().formErrors['f1']?.message).toBe('Forms are not for secrets');
    expect(useStore.getState().toasts).toEqual([]);
    // sent again: the old refusal clears until the hub answers
    useStore.getState().formSent('f1');
    expect(useStore.getState().formErrors['f1']).toBeUndefined();
    // an unrelated error still toasts
    useStore.getState().applyEvent({ type: 'error', message: 'boom', context: 'other' });
    expect(useStore.getState().toasts).toHaveLength(1);
  }, 60_000);
});
