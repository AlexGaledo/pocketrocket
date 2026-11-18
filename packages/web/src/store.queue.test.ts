import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaneQueue } from '@pocketrocket/shared';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)),
  };
}
const stubWindow = () => vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });

const lane = (botId: string, over: Partial<LaneQueue> = {}): LaneQueue => ({
  botId, roomId: 'r1', paused: false, running: true,
  items: [{ journalId: 'j-' + botId, messageId: 'm1', kind: 'message', authorType: 'user', authorId: 'me', preview: 'hi', reason: 'shortcut', position: 1, editable: true, cancellable: true }],
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
/** The hub's REST answers, by method and path. */
let answers: Record<string, () => Response>;

async function boot() {
  vi.resetModules();
  stubWindow();
  const { useStore } = await import('./store');
  return useStore;
}

beforeAll(async () => {
  stubWindow();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  await import('./store');
  vi.unstubAllGlobals();
}, 60_000);
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  answers = {};
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => (answers[(init?.method ?? 'GET') + ' ' + path.split('?')[0]] ?? (() => new Response('[]', { status: 200 })))());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe('store: queues', () => {
  it('keeps each lane from queue.changed, and drops it when it empties', async () => {
    const store = await boot();
    store.getState().applyEvent({ type: 'queue.changed', queue: lane('ada') });
    expect(Object.keys(store.getState().queues)).toEqual(['ada:r1']);
    store.getState().applyEvent({ type: 'queue.changed', queue: lane('ada', { items: [] }) });
    expect(store.getState().queues).toEqual({});
  });

  it('does not touch state for an empty lane it never had', async () => {
    const store = await boot();
    const before = store.getState().queues;
    store.getState().applyEvent({ type: 'queue.changed', queue: lane('ada', { items: [], running: false }) });
    expect(store.getState().queues).toBe(before);
  });

  it("loads the room's snapshot with its messages", async () => {
    const store = await boot();
    answers['GET /api/rooms/r1/messages'] = json([]);
    answers['GET /api/rooms/r1/queue'] = json([lane('ada'), lane('bo', { items: [], paused: true })]);
    await store.getState().loadMessages('r1');
    await vi.waitFor(() => expect(Object.keys(store.getState().queues).sort()).toEqual(['ada:r1', 'bo:r1']));
  });

  it('forgets every lane on a new hello, since events may have been missed', async () => {
    const store = await boot();
    // hello applies the theme and font to <html>.
    vi.stubGlobal('document', { documentElement: { classList: { toggle: () => undefined }, dataset: {} } });
    store.getState().applyEvent({ type: 'queue.changed', queue: lane('ada') });
    store.getState().applyEvent({ type: 'hello', bots: [], rooms: [], botStates: {}, settings: store.getState().settings });
    expect(store.getState().queues).toEqual({});
  });

  it('keeps the chips empty when an older hub has no queue route', async () => {
    const store = await boot();
    answers['GET /api/rooms/r1/queue'] = json({ error: 'Not found' }, 404);
    await store.getState().loadQueue('r1');
    expect(store.getState().queues).toEqual({});
  });

  it("returns the hub's refusal in words, for the popover to show", async () => {
    const store = await boot();
    answers['POST /api/rooms/r1/queue/edit'] = json({ error: 'A bot has already read it.' }, 409);
    expect(await store.getState().queueEdit('r1', 'j-ada', 'new text')).toBe('A bot has already read it.');
    const [, init] = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/queue/edit'))!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ journalId: 'j-ada', text: 'new text' });
  });

  it('applies the lanes a pause answers with, before the event arrives', async () => {
    const store = await boot();
    answers['POST /api/rooms/r1/queue/pause'] = json([lane('ada', { paused: true })]);
    expect(await store.getState().queuePause('r1', 'ada', true)).toBeNull();
    expect(store.getState().queues['ada:r1'].paused).toBe(true);
  });

  it('cancels and sends now by journal id and bot id', async () => {
    const store = await boot();
    answers['POST /api/rooms/r1/queue/cancel'] = json({ id: 'm1' });
    answers['POST /api/rooms/r1/queue/send-now'] = json({ interrupted: true });
    expect(await store.getState().queueCancel('r1', 'j-ada')).toBeNull();
    expect(await store.getState().queueSendNow('r1', 'ada')).toBeNull();
    const bodies = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/queue/')).map((c) => [c[0], JSON.parse((c[1] as RequestInit).body as string)]);
    expect(bodies).toEqual([['/api/rooms/r1/queue/cancel', { journalId: 'j-ada' }], ['/api/rooms/r1/queue/send-now', { botId: 'ada' }]]);
  });
});
