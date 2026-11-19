import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { ScreenOpenError, createScreenOpener, webUrlOrNull } from './screenOpen.js';

function setup(o: { enabled?: boolean; browserBots?: string[]; members?: string[]; allBots?: string[]; live?: string[]; wake?: 'ok' | 'fail'; status?: number } = {}) {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: o.status ?? 200 }));
  const wakeFocused = vi.fn(async (botId: string) => (o.wake === 'fail'
    ? { ok: false as const, reason: 'Not enough memory' }
    : { ok: true as const, endpoint: { cdpUrl: 'http://127.0.0.1:94' + botId.length } }));
  const live = new Set(o.live ?? []);
  const computers = { enabled: o.enabled ?? true, wakeFocused, legacyEndpoint: () => ({ cdpUrl: 'http://127.0.0.1:9222' }), status: (id: string) => ({ state: live.has(id) ? 'live' : 'asleep' }) };
  const members = o.members ?? ['a', 'bb'];
  const repos = {
    getRoom: (id: string) => (id === 'r1' ? { memberIds: members } : undefined),
    listBots: () => (o.allBots ?? members).map((id) => ({ id })),
  };
  const browser = new Set(o.browserBots ?? ['bb']);
  const opener = createScreenOpener({ repos: repos as never, computers: computers as never, usesComputer: (id) => browser.has(id), fetchFn: fetchFn as never });
  return { opener, fetchFn, wakeFocused };
}

describe('webUrlOrNull', () => {
  it('takes http and https only', () => {
    expect(webUrlOrNull(' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,x', 'nope']) expect(webUrlOrNull(bad)).toBeNull();
  });
});

describe('screen opener', () => {
  it("opens a web link in the room's bot that has a browser, waking it", async () => {
    const { opener, fetchFn, wakeFocused } = setup();
    await expect(opener.open({ url: 'https://example.com/x y' }, { roomId: 'r1' })).resolves.toEqual({ botId: 'bb' });
    expect(wakeFocused).toHaveBeenCalledWith('bb');
    expect(fetchFn.mock.calls[0][0]).toBe('http://127.0.0.1:942/json/new?' + encodeURIComponent('https://example.com/x%20y'));
    expect(fetchFn.mock.calls[0][1]?.method).toBe('PUT');
  });

  it('prefers the named bot, but only one in the room with a browser', async () => {
    const both = setup({ browserBots: ['a', 'bb'] });
    await expect(both.opener.open({ url: 'https://e.com' }, { roomId: 'r1', botId: 'bb' })).resolves.toEqual({ botId: 'bb' });
    const outsider = setup({ browserBots: ['zz', 'bb'] });
    await expect(outsider.opener.open({ url: 'https://e.com' }, { roomId: 'r1', botId: 'zz' })).resolves.toEqual({ botId: 'bb' });
  });

  it("falls back to any bot with a browser, an awake one first, when nobody in the chat has one", async () => {
    const asleep = setup({ members: ['a'], browserBots: ['x', 'y'], allBots: ['a', 'x', 'y'] });
    await expect(asleep.opener.open({ url: 'https://e.com' }, { roomId: 'r1' })).resolves.toEqual({ botId: 'x' });
    const awake = setup({ members: ['a'], browserBots: ['x', 'y'], allBots: ['a', 'x', 'y'], live: ['y'] });
    await expect(awake.opener.open({ url: 'https://e.com' }, { roomId: 'r1' })).resolves.toEqual({ botId: 'y' });
  });

  it('opens a room file as file://', async () => {
    const { opener, fetchFn } = setup();
    const file = process.platform === 'win32' ? 'C:\\data\\rooms\\r1\\report.html' : '/data/rooms/r1/report.html';
    await opener.open({ file }, { roomId: 'r1' });
    expect(fetchFn.mock.calls[0][0]).toContain(encodeURIComponent(pathToFileURL(file).href));
  });

  it('uses the shared screen without per-bot computers', async () => {
    const { opener, fetchFn, wakeFocused } = setup({ enabled: false });
    await expect(opener.open({ url: 'https://e.com' }, { roomId: 'r1' })).resolves.toEqual({ botId: null });
    expect(wakeFocused).not.toHaveBeenCalled();
    expect(String(fetchFn.mock.calls[0][0])).toMatch(/^http:\/\/127\.0\.0\.1:9222\/json\/new\?/);
  });

  it('says why it could not open', async () => {
    const reject = (p: Promise<unknown>, status: number) => expect(p).rejects.toSatisfy((e) => e instanceof ScreenOpenError && e.status === status);
    await reject(setup().opener.open({ url: 'javascript:alert(1)' }, { roomId: 'r1' }), 400);
    await reject(setup({ browserBots: [] }).opener.open({ url: 'https://e.com' }, { roomId: 'r1' }), 409);
    await reject(setup({ wake: 'fail' }).opener.open({ url: 'https://e.com' }, { roomId: 'r1' }), 409);
    await reject(setup({ status: 500 }).opener.open({ url: 'https://e.com' }, { roomId: 'r1' }), 502);
  });
});
