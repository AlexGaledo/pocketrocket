import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientEvent, Message, ServerEvent } from '@pocketrocket/shared';
import { WS_PING_MS } from '@pocketrocket/shared';

type Send = Extract<ClientEvent, { type: 'message.send' }>;

/** A WebSocket the test drives by hand. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: ClientEvent[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s) as ClientEvent); }
  close() { this.readyState = FakeSocket.CLOSED; }
  // test side
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  fromHub(ev: ServerEvent) { this.onmessage?.({ data: JSON.stringify(ev) }); }
  drop() { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)),
  };
}

/** Loads fresh copies of the store and ws module, as a new page load would. */
async function boot() {
  // Module loading waits on real timers, so the fake ones only run the test body.
  vi.useRealTimers();
  vi.resetModules();
  const ws = await import('./lib/ws');
  const { useStore, SEND_ACK_MS } = await import('./store');
  vi.useFakeTimers();
  return { ...ws, useStore, SEND_ACK_MS };
}

const userMessage = (id: string, seq: number, text: string, clientMsgId?: string): Message =>
  ({ id, roomId: 'r1', seq, authorType: 'user', authorId: 'me', kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null, createdAt: 1, ...(clientMsgId ? { clientMsgId } : {}) });

/** The hub: takes each message.send once per clientMsgId and echoes it, as RoomRouter.onUserMessage does. */
function runHub(sock: FakeSocket, delivered: string[], seen: Map<string, Message>) {
  for (const ev of sock.sent.splice(0)) {
    if (ev.type !== 'message.send') continue;
    let m = ev.clientMsgId ? seen.get(ev.clientMsgId) : undefined;
    if (!m) {
      m = userMessage('m' + (delivered.length + 1), delivered.length + 1, ev.text, ev.clientMsgId);
      if (ev.clientMsgId) seen.set(ev.clientMsgId, m);
      delivered.push(ev.text);
    }
    sock.fromHub({ type: 'message.new', message: m });
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:7788', pathname: '/', search: '', hash: '' });
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const texts = (s: FakeSocket) => s.sent.filter((e): e is Send => e.type === 'message.send').map((e) => e.text);

describe('send journal', () => {
  it('queues two messages while offline and delivers each once, in order, after reconnect', async () => {
    const { useStore, connectWs } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    useStore.getState().sendMessage('first');
    useStore.getState().sendMessage('second');
    // Shown at once, written to the journal, nothing sent anywhere.
    expect(useStore.getState().outbox.map((e) => [e.text, e.status])).toEqual([['first', 'sending'], ['second', 'sending']]);
    expect(JSON.parse(localStorage.getItem('pocketrocket.outbox.v1')!)).toHaveLength(2);
    expect(FakeSocket.instances).toHaveLength(0);

    connectWs();
    const sock = FakeSocket.instances[0];
    sock.open();
    expect(texts(sock)).toEqual(['first', 'second']);
    expect(useStore.getState().outbox.map((e) => e.status)).toEqual(['sent', 'sent']);

    const delivered: string[] = [];
    runHub(sock, delivered, new Map());
    expect(delivered).toEqual(['first', 'second']);
    expect(useStore.getState().outbox).toEqual([]);
    expect(JSON.parse(localStorage.getItem('pocketrocket.outbox.v1')!)).toEqual([]);
    expect(useStore.getState().messages['r1']?.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('replays a sent-but-unechoed message after the hub restarts, and the hub keeps one copy', async () => {
    const { useStore, connectWs } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    connectWs();
    const a = FakeSocket.instances[0];
    a.open();
    const delivered: string[] = [];
    const seen = new Map<string, Message>();
    useStore.getState().sendMessage('one');
    // The hub took it, but the echo never made it back before the link died.
    const taken = a.sent.splice(0)[0] as Send;
    seen.set(taken.clientMsgId!, userMessage('m1', 1, 'one', taken.clientMsgId));
    delivered.push('one');
    a.drop();
    useStore.getState().sendMessage('two'); // typed while offline

    vi.advanceTimersByTime(2000);
    const b = FakeSocket.instances[1];
    expect(b).toBeDefined();
    b.open();
    expect(texts(b)).toEqual(['one', 'two']); // oldest first
    runHub(b, delivered, seen);
    expect(delivered).toEqual(['one', 'two']);
    expect(useStore.getState().outbox).toEqual([]);
  });

  it('survives a reload: the journal is read back, and a sent entry goes out again as sending', async () => {
    const first = await boot();
    first.useStore.setState({ activeRoomId: 'r1' });
    first.useStore.getState().sendMessage('kept');
    const second = await boot();
    expect(second.useStore.getState().outbox.map((e) => [e.text, e.status])).toEqual([['kept', 'sending']]);
  });

  it('shows an unechoed message as not sent after the wait, and Retry sends it again', async () => {
    const { useStore, connectWs, SEND_ACK_MS } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    connectWs();
    const sock = FakeSocket.instances[0];
    sock.open();
    useStore.getState().sendMessage('hello');
    vi.advanceTimersByTime(SEND_ACK_MS);
    const [entry] = useStore.getState().outbox;
    expect(entry.status).toBe('failed');
    sock.sent.length = 0;
    useStore.getState().retrySend(entry.clientId);
    expect(useStore.getState().outbox[0].status).toBe('sent');
    expect(texts(sock)).toEqual(['hello']);
    expect((sock.sent[0] as Send).clientMsgId).toBe(entry.clientId);
  });

  it('marks the entry failed when the hub answers an error tagged with its id, and Discard removes it', async () => {
    const { useStore, connectWs } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    connectWs();
    const sock = FakeSocket.instances[0];
    sock.open();
    useStore.getState().sendMessage('hello');
    const id = useStore.getState().outbox[0].clientId;
    sock.fromHub({ type: 'error', message: 'Room not found', context: id });
    expect(useStore.getState().outbox[0].status).toBe('failed');
    expect(useStore.getState().toasts).toEqual([]); // it speaks on the bubble, not in a toast
    useStore.getState().discardSend(id);
    expect(useStore.getState().outbox).toEqual([]);
  });
});

describe('flush and reconnect', () => {
  it('does not resend a sent entry or reset its ack timer when flushed again', async () => {
    const { useStore, connectWs, SEND_ACK_MS } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    connectWs();
    const sock = FakeSocket.instances[0];
    sock.open();
    useStore.getState().sendMessage('one');
    expect(texts(sock)).toEqual(['one']);
    vi.advanceTimersByTime(SEND_ACK_MS - 1000);
    useStore.getState().sendMessage('two'); // flushes the whole journal again
    expect(texts(sock)).toEqual(['one', 'two']); // 'one' was not written a second time
    vi.advanceTimersByTime(1000); // the original timer for 'one' still fires on schedule
    expect(useStore.getState().outbox.map((e) => [e.text, e.status])).toEqual([['one', 'failed'], ['two', 'sent']]);
  });

  it('resends an unacked sent entry exactly once on reconnect', async () => {
    const { useStore, connectWs } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    connectWs();
    const a = FakeSocket.instances[0];
    a.open();
    useStore.getState().sendMessage('one');
    const first = a.sent.splice(0)[0] as Send;
    a.drop(); // shorter than the ack wait, so the entry is still 'sent'
    expect(useStore.getState().outbox[0].status).toBe('sent');
    vi.advanceTimersByTime(2000);
    const b = FakeSocket.instances[1];
    b.open();
    expect(b.sent.filter((e) => e.type === 'message.send').map((e) => (e as Send).clientMsgId)).toEqual([first.clientMsgId]);
    expect(useStore.getState().outbox[0].status).toBe('sent');
  });
});

describe('liveness', () => {
  it('answers a ping with a pong', async () => {
    const { connectWs } = await boot();
    connectWs();
    const sock = FakeSocket.instances[0];
    sock.open();
    sock.fromHub({ type: 'ping', t: 1 });
    expect(sock.sent).toEqual([{ type: 'pong' }]);
  });

  it('keeps a link that keeps hearing pings, and drops one that goes quiet for two ping periods', async () => {
    const { useStore, connectWs, STALE_AFTER_MS } = await boot();
    connectWs();
    const sock = FakeSocket.instances[0];
    sock.open();
    expect(useStore.getState().connected).toBe(true);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(WS_PING_MS);
      sock.fromHub({ type: 'ping', t: i });
    }
    expect(useStore.getState().connected).toBe(true);

    vi.advanceTimersByTime(STALE_AFTER_MS);
    expect(useStore.getState().connected).toBe(false);
    expect(useStore.getState().hasConnected).toBe(true); // so the chip says Reconnecting, not Connecting
    expect(useStore.getState().hubIssue).toBeNull();
    // ...and the usual backoff brings up a new socket.
    vi.advanceTimersByTime(1500);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].open();
    expect(useStore.getState().connected).toBe(true);
  });

  it('does nothing while no socket was ever opened', async () => {
    const { useStore, STALE_AFTER_MS } = await boot();
    vi.advanceTimersByTime(STALE_AFTER_MS * 2);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(useStore.getState().connected).toBe(false);
    expect(useStore.getState().hasConnected).toBe(false);
  });
});

describe('send journal with attachments (U2a)', () => {
  const ref = (c: string) => 'img:' + c.repeat(64);

  it('journals the refs, sends them with the text, and a retry sends the same refs once', async () => {
    const { useStore, connectWs } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    connectWs();
    const a = FakeSocket.instances[0];
    a.open();
    useStore.getState().sendMessage('look', [ref('a'), ref('b')]);
    const first = a.sent.splice(0)[0] as Send;
    expect(first.attachments).toEqual([ref('a'), ref('b')]);
    expect(JSON.parse(localStorage.getItem('pocketrocket.outbox.v1')!)[0].attachments).toEqual([ref('a'), ref('b')]);

    // the hub refuses it (an unknown ref): the entry fails, Retry resends the same refs under the same id
    a.fromHub({ type: 'error', message: 'A picture is missing or not allowed. Attach it again.', context: first.clientMsgId });
    expect(useStore.getState().outbox[0].status).toBe('failed');
    useStore.getState().retrySend(first.clientMsgId!);
    const again = a.sent.splice(0)[0] as Send;
    expect(again.clientMsgId).toBe(first.clientMsgId);
    expect(again.attachments).toEqual([ref('a'), ref('b')]);
  });

  it('allows a message that is only pictures, and still refuses an empty one', async () => {
    const { useStore } = await boot();
    useStore.setState({ activeRoomId: 'r1' });
    useStore.getState().sendMessage('', []);
    useStore.getState().sendMessage('   ');
    expect(useStore.getState().outbox).toEqual([]);
    useStore.getState().sendMessage('', [ref('c')]);
    expect(useStore.getState().outbox.map((e) => [e.text, e.attachments])).toEqual([['', [ref('c')]]]);
  });

  it('reads a picture-only entry back after a reload, and drops one with a bad ref', async () => {
    localStorage.setItem('pocketrocket.outbox.v1', JSON.stringify([
      { clientId: 'ok', roomId: 'r1', text: '', status: 'sent', createdAt: 1, attachments: [ref('d')] },
      { clientId: 'bad', roomId: 'r1', text: '', status: 'sending', createdAt: 2, attachments: ['../../x'] },
      { clientId: 'empty', roomId: 'r1', text: '', status: 'sending', createdAt: 3 },
    ]));
    const { useStore } = await boot();
    expect(useStore.getState().outbox.map((e) => [e.clientId, e.status])).toEqual([['ok', 'sending']]);
  });
});
