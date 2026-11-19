import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TelegramActions } from './TelegramCard';
import { maskChatName, safeDeepLink, spokenCode, TelegramController, type TelegramApi, type TelegramState, type TelegramView as View } from '../../lib/telegram';

let TelegramView: typeof import('./TelegramCard').TelegramView;
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  ({ TelegramView } = await import('./TelegramCard'));
}, 60000);

const S = (o: Partial<TelegramState> = {}): TelegramState => ({
  configured: false, botUsername: null, linked: false, linkedName: null, notify: false, pendingCode: null, error: null, ...o,
});
const noop = () => undefined;
const actions: TelegramActions = { onSaveToken: async () => undefined, onLink: noop, onUnlink: noop, onNotify: noop, onTest: noop };
const render = (state: TelegramState | null, o: Partial<View> = {}, now = 0) =>
  renderToStaticMarkup(<TelegramView view={{ state, busy: false, error: null, notice: null, ...o }} actions={actions} now={now} />);

const CODE = { code: 'K7M2QX', deepLink: 'https://t.me/pocket_test_bot?start=K7M2QX', expiresAt: 600_000 };

describe('TelegramView', () => {
  it('asks for the token first and offers nothing else yet', () => {
    const html = render(S());
    expect(html).toContain('Check and save');
    expect(html).toContain('@BotFather');
    expect(html).not.toContain('Link Telegram');
    expect(html).not.toContain('Notify me here');
  });

  it('shows @yourbot after a checked token, with the cloud warning and the link step', () => {
    const html = render(S({ configured: true, botUsername: 'pocket_test_bot' }));
    expect(html).toContain('@pocket_test_bot');
    expect(html).toContain('Telegram is a cloud service');
    expect(html).toContain('Link Telegram');
    expect(html).toContain('Paste to replace saved key');
  });

  it('shows the link code per character, the ten-minute note, the deep link and a QR code', () => {
    const html = render(S({ configured: true, botUsername: 'b', pendingCode: CODE }), {}, 0);
    expect(html).toContain('aria-label="Link code K 7 M 2 Q X"');
    expect(html).toContain('Valid 10 minutes');
    expect(html).toContain('10:00 left');
    expect(html).toContain('Open in Telegram');
    expect(html).toContain('href="https://t.me/pocket_test_bot?start=K7M2QX"');
    expect(html).toContain('aria-label="Telegram link QR code"');
  });

  it('drops a deep link that is not a Telegram address', () => {
    const html = render(S({ configured: true, pendingCode: { ...CODE, deepLink: 'https://evil.example/?start=K7M2QX' } }));
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('Open in Telegram');
    expect(html).not.toContain('Telegram link QR code');
  });

  it('puts the cloud warning before the switch, and the switch names the warning', () => {
    const html = render(S({ configured: true, botUsername: 'b', linked: true, linkedName: 'Dana Reyes' }));
    expect(html.indexOf('Telegram is a cloud service')).toBeGreaterThan(-1);
    expect(html.indexOf('Telegram is a cloud service')).toBeLessThan(html.indexOf('role="switch"'));
    expect(html).toMatch(/role="switch"[^>]*aria-describedby/);
    expect(html).toContain('Send a test');
    expect(html).toContain('Unlink');
  });

  it('hides the chat name behind Private', () => {
    const html = render(S({ configured: true, linked: true, linkedName: 'Dana Reyes' }));
    expect(html).toContain('Linked to');
    expect(html).toContain('D•••');
    expect(html).not.toContain('Dana Reyes');
  });

  it('always carries the one-hub note and the BotFather revoke pointer', () => {
    const html = render(S());
    expect(html).toContain('One hub per bot token');
    expect(html).toContain('/revoke');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('shows errors and disables the actions while busy', () => {
    const html = render(S({ configured: true, linked: true, linkedName: 'D' }), { busy: true, error: 'Unauthorized' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Unauthorized');
    expect(html).toMatch(/role="switch"[^>]*disabled/);
  });

  it('says it is loading, or why it could not load', () => {
    expect(render(null)).toContain('Loading');
    expect(render(null, { error: 'Not found' })).toContain('Not found');
  });
});

describe('helpers', () => {
  it('accepts only t.me links', () => {
    expect(safeDeepLink('https://t.me/abc_bot?start=XY12')).not.toBeNull();
    expect(safeDeepLink('http://t.me/abc_bot')).toBeNull();
    expect(safeDeepLink('https://t.me.evil.com/abc_bot')).toBeNull();
    expect(safeDeepLink('javascript:alert(1)')).toBeNull();
    expect(safeDeepLink(undefined)).toBeNull();
  });
  it('masks and spells', () => {
    expect(maskChatName('Dana')).toBe('D•••');
    expect(maskChatName('')).toBe('•••');
    expect(spokenCode('AB12')).toBe('A B 1 2');
  });
});

function fakeApi(over: Partial<TelegramApi> = {}) {
  const api: TelegramApi = {
    get: vi.fn(async () => S()),
    setToken: vi.fn(async () => S({ configured: true, botUsername: 'pocket_test_bot' })),
    removeToken: vi.fn(async () => S()),
    link: vi.fn(async () => S({ configured: true, pendingCode: CODE })),
    unlink: vi.fn(async () => S({ configured: true })),
    setNotify: vi.fn(async (n: boolean) => S({ configured: true, linked: true, linkedName: 'D', notify: n })),
    test: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
  return api;
}

describe('TelegramController', () => {
  it('loads, saves a trimmed token, and removes on an empty one', async () => {
    const api = fakeApi();
    const c = new TelegramController(api, noop);
    await c.load();
    expect(c.view.state?.configured).toBe(false);
    await c.saveToken('  123:abc \n');
    expect(api.setToken).toHaveBeenCalledWith('123:abc');
    expect(c.view.state?.botUsername).toBe('pocket_test_bot');
    await c.saveToken('');
    expect(api.removeToken).toHaveBeenCalled();
    expect(c.view.state?.configured).toBe(false);
  });

  it("keeps Telegram's own words for a bad token and the previous state", async () => {
    const api = fakeApi({ setToken: vi.fn(async () => { throw new Error('Unauthorized'); }) });
    const c = new TelegramController(api, noop);
    await c.load();
    await c.saveToken('bad');
    expect(c.view.error).toBe('Unauthorized');
    expect(c.view.busy).toBe(false);
    expect(c.view.state?.configured).toBe(false);
    c.clearError();
    expect(c.view.error).toBeNull();
  });

  it('shows the 429 lock text and ignores a second action while busy', async () => {
    let release: () => void = noop;
    const api = fakeApi({ link: vi.fn(() => new Promise<TelegramState>((res) => { release = () => res(S({ configured: true, pendingCode: CODE })); })) });
    const c = new TelegramController(api, noop);
    const first = c.startLink();
    void c.startLink();
    expect(api.link).toHaveBeenCalledTimes(1);
    expect(c.view.busy).toBe(true);
    release();
    await first;
    expect(c.view.state?.pendingCode?.code).toBe('K7M2QX');

    const locked = new TelegramController(fakeApi({ link: vi.fn(async () => { throw new Error('Too many wrong codes. Try again later.'); }) }), noop);
    await locked.startLink();
    expect(locked.view.error).toContain('Too many wrong codes');
  });

  it('sends the notify switch and the test, with a confirmation', async () => {
    const api = fakeApi();
    const c = new TelegramController(api, noop);
    await c.setNotify(true);
    expect(api.setNotify).toHaveBeenCalledWith(true);
    expect(c.view.state?.notify).toBe(true);
    await c.sendTest();
    expect(api.test).toHaveBeenCalled();
    expect(c.view.notice).toContain('Test sent');
    expect(c.view.state?.notify).toBe(true);
  });

  it('forgets a code that ran out and asks the hub', async () => {
    const api = fakeApi({ get: vi.fn(async () => S({ configured: true })) });
    const c = new TelegramController(api, noop);
    await c.startLink();
    expect(c.view.state?.pendingCode).not.toBeNull();
    await c.codeExpired();
    expect(c.view.state?.pendingCode).toBeNull();
    expect(api.get).toHaveBeenCalled();
  });

  it('a quiet refresh does not replace the screen with an error', async () => {
    const api = fakeApi({ get: vi.fn(async () => S({ configured: true })) });
    const c = new TelegramController(api, noop);
    await c.load();
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    await c.load(true);
    expect(c.view.error).toBeNull();
    expect(c.view.state?.configured).toBe(true);
  });
});
