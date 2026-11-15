import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot, Message, ServerEvent } from '@pocketrocket/shared';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)),
  };
}

let focused = false;
let invoke: ReturnType<typeof vi.fn>;

/** A fresh store, in a window that is (or is not) the desktop app. */
async function boot(desktop = true) {
  vi.resetModules();
  invoke = vi.fn(async (cmd: string) => (cmd.endsWith('is_permission_granted') ? true : undefined));
  vi.stubGlobal('window', {
    innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined,
    ...(desktop ? { __TAURI__: { core: { invoke } } } : {}),
  });
  vi.stubGlobal('document', { hasFocus: () => focused });
  const { useStore } = await import('./store');
  const bot = { id: 'b1', name: 'Ada', handle: 'ada', avatar: '', title: '' } as unknown as Bot;
  useStore.setState({ bots: [bot], activeRoomId: 'r1' });
  return useStore;
}
const notified = () => invoke.mock.calls.filter((c) => String(c[0]).endsWith('|notify')).map((c) => (c[1] as { options: { title: string; body: string } }).options);
const flush = () => new Promise((r) => setTimeout(r, 0));

const approvalReq: ServerEvent = {
  type: 'approval.request', roomId: 'r2', botId: 'b1', messageId: 'm1',
  approval: { approvalId: 'a1', toolName: 'Bash', toolInput: {}, reason: 'secret reason', danger: false, status: 'pending' },
};
const msg = (over: Partial<Message>): Message =>
  ({ id: 'x', roomId: 'r3', seq: 1, authorType: 'bot', authorId: 'b1', kind: 'text', text: '', payload: null, causeId: null, hop: 0, turnId: null, createdAt: 1, ...over });

// The first dynamic import of the store is cold and can outlast the default 5s: warm it once, and allow more time.
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  await import('./store');
  vi.unstubAllGlobals();
}, 60_000);
beforeEach(() => {
  focused = false;
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('desktop notifications from hub events', () => {
  it('notifies for an approval while unfocused, content-free by default', async () => {
    const store = await boot();
    store.getState().applyEvent(approvalReq);
    await flush();
    expect(notified()).toEqual([{ title: 'PocketRocket', body: 'A bot needs you' }]);
  });

  it('stays quiet while the window is focused', async () => {
    focused = true;
    const store = await boot();
    store.getState().applyEvent(approvalReq);
    await flush();
    expect(notified()).toEqual([]);
  });

  it('stays quiet in a plain browser, where there is no desktop shell', async () => {
    const store = await boot(false);
    store.getState().applyEvent(approvalReq);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('respects the master switch', async () => {
    const store = await boot();
    const { setNotificationsEnabled } = await import('./lib/notifyEvents');
    setNotificationsEnabled(false);
    store.getState().applyEvent(approvalReq);
    await flush();
    expect(notified()).toEqual([]);
  });

  it('shows the bot name only after the text option is turned on, and never the card reason', async () => {
    const store = await boot();
    const { setNotificationText } = await import('./lib/notifyEvents');
    setNotificationText(true);
    store.getState().applyEvent(approvalReq);
    await flush();
    expect(notified()).toEqual([{ title: 'Ada needs your approval', body: 'Ada needs your approval' }]);
    expect(JSON.stringify(notified())).not.toContain('secret reason');
  });

  it('notifies when a turn finishes, but not for an error, and coalesces per room', async () => {
    const store = await boot();
    store.getState().applyEvent({ type: 'turn.end', turnId: 't1', roomId: 'r5', botId: 'b1', error: 'boom' });
    await flush();
    expect(notified()).toEqual([]);
    store.getState().applyEvent({ type: 'turn.end', turnId: 't2', roomId: 'r5', botId: 'b1' });
    store.getState().applyEvent({ type: 'turn.end', turnId: 't3', roomId: 'r5', botId: 'b1' });
    await flush();
    expect(notified()).toHaveLength(1);
  });

  it('does not let a finished turn hide an approval in the same room', async () => {
    const store = await boot();
    store.getState().applyEvent({ type: 'turn.end', turnId: 't1', roomId: 'r2', botId: 'b1' });
    store.getState().applyEvent(approvalReq);
    await flush();
    expect(notified()).toHaveLength(2);
  });

  it('notifies for a takeover request', async () => {
    const store = await boot();
    store.getState().applyEvent({ type: 'message.new', message: msg({ id: 'tm', kind: 'takeover', text: 'log in' }) });
    await flush();
    expect(notified()).toHaveLength(1);
  });

  it('never notifies for the user own message', async () => {
    const store = await boot();
    store.getState().applyEvent({ type: 'message.new', message: msg({ id: 'u1', authorType: 'user', authorId: 'me', text: 'hi' }) });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });
});
