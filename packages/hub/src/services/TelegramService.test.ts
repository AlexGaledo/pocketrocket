import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../db/db.js';
import { DevicesRepo } from '../db/devices.js';
import { events } from '../events.js';
import { fakeFetch, type FakeCall } from '../integrations/fakeFetch.js';
import { IntegrationError, type Fetch } from '../integrations/http.js';
import { clearSecrets, redact } from '../providers/redact.js';
import { IntegrationVault } from './IntegrationVault.js';
import { PushService } from './PushService.js';
import { CONFLICT_MESSAGE, LINK_TTL_MS, LOCK_MS, MAX_WRONG_CODES, TELEGRAM_TEXT, TelegramService } from './TelegramService.js';

const TOKEN = '123456789:AAF3kq9ZtPz0b1Yw8LmN4rVuHcDeXsGj7Ta';
const BOT = 'https://api.telegram.org/bot' + TOKEN + '/';
const CODE = 'K7Q2M9XD4A';
const OWNER = 4242;
const HUB = 'https://myhub.tail1234.ts.net/';
const T0 = 1_800_000_000_000;

let dir: string;
let clock: number;
let db: Db;
let vault: IntegrationVault;
let f: ReturnType<typeof fakeFetch>;
let updates: unknown[];

function method(c: FakeCall) { return c.url.pathname.split('/').pop(); }
function callsTo(m: string) { return f.calls.filter((c) => method(c) === m); }
const user = (over: Record<string, unknown> = {}) => ({ id: OWNER, is_bot: false, first_name: 'Ada', last_name: 'L', username: 'ada_l_private', ...over });
/** One incoming message update. `date` defaults to "now" on the fake clock. */
function msg(id: number, text: string, over: { chat?: Record<string, unknown>; from?: Record<string, unknown>; date?: number } = {}) {
  return {
    update_id: id,
    message: { message_id: id, date: over.date ?? Math.floor(clock / 1000), text, chat: { id: OWNER, type: 'private', ...over.chat }, from: user(over.from) },
  };
}

function build(opts: { fetch?: Fetch; hubUrl?: () => string | null } = {}) {
  return new TelegramService({
    db, vault, fetch: opts.fetch ?? f.fetch, now: () => clock, sleep: () => new Promise((r) => setTimeout(r, 5)), makeCode: () => CODE,
    hubUrl: opts.hubUrl ?? (() => HUB),
  });
}

beforeEach(() => {
  clearSecrets();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tg-'));
  vault = new IntegrationVault({ file: path.join(dir, 'v.json'), keyFile: path.join(dir, 'v.key') });
  db = new Db(':memory:');
  clock = T0;
  updates = [];
  f = fakeFetch();
  f.on('POST', BOT + 'getMe', () => ({ json: { ok: true, result: { id: 987654321, is_bot: true, first_name: 'Rocket', username: 'rocket_notify_bot' } } }));
  f.on('POST', BOT + 'getUpdates', () => { const r = updates; updates = []; return { json: { ok: true, result: r } }; });
  f.on('POST', BOT + 'sendMessage', () => ({ json: { ok: true, result: { message_id: 1 } } }));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function configured() {
  const svc = build();
  await svc.setToken(TOKEN);
  return svc;
}
async function linked(svc?: TelegramService) {
  const s = svc ?? (await configured());
  await s.link();
  updates = [msg(10, '/start ' + CODE)];
  await s.pollOnce(0);
  expect(s.state().linked).toBe(true);
  return s;
}

describe('token (A1)', () => {
  it('a valid token shows @botname, calls getMe through the bot URL and stores the token in the vault only', async () => {
    const svc = build();
    const s = await svc.setToken('  ' + TOKEN + ' ');
    expect(s).toMatchObject({ configured: true, botUsername: 'rocket_notify_bot', linked: false, notify: false, pendingCode: null, error: null });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(callsTo('getMe')).toHaveLength(1);
    expect(vault.get('telegram')).toEqual({ token: TOKEN });
    expect(JSON.stringify(db.all('SELECT * FROM telegram_link'))).not.toContain(TOKEN);
  });

  it('a bad token is a 400 with Telegram\'s words, and nothing is stored', async () => {
    f.on('POST', BOT + 'getMe', () => ({ status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } }));
    const err = await build().setToken(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Unauthorized');
    expect(err.message).not.toContain(TOKEN);
    expect(vault.get('telegram')).toBeNull();
    // Not even shaped like a token: refused without a request.
    f.calls.length = 0;
    const junk = await build().setToken('../../etc/passwd').catch((e) => e);
    expect(junk.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('redacts the token from a thrown error, from state.error and from the log', async () => {
    const boom: Fetch = async (url) => { throw new Error('connect ECONNRESET ' + String(url)); };
    const leaky = build({ fetch: f.fetch });
    await leaky.setToken(TOKEN);
    await linked(leaky);

    const svc = new TelegramService({ db, vault, fetch: boom, now: () => clock, hubUrl: () => null });
    const err = await svc.sendTest().catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err.message).toContain('Could not reach api.telegram.org');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('123456789');

    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    svc.setNotify(true);
    await svc.notify('approval');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(TOKEN);
    expect(svc.state().error).toMatch(/^Could not send to Telegram/);
    expect(JSON.stringify(svc.state())).not.toContain(TOKEN);
  });

  it('the redactor knows the token by its shape alone, including inside a URL path, and by the stored value', () => {
    clearSecrets();
    expect(redact('GET /bot' + TOKEN + '/getMe failed')).toBe('GET /bot[redacted]/getMe failed');
    expect(redact('timestamp 1700000000 and 1700000000:short')).toBe('timestamp 1700000000 and 1700000000:short');
    // A saved token is registered on load, before any request is made.
    clearSecrets();
    const odd = '55555555:' + 'x'.repeat(10) + '#odd';
    vault.set('telegram', { token: odd });
    clearSecrets();
    const fresh = new IntegrationVault({ file: path.join(dir, 'v.json'), keyFile: path.join(dir, 'v.key') });
    new TelegramService({ db, vault: fresh });
    expect(redact('error at ' + odd)).toBe('error at [redacted]');
  });

  it('removing the token forgets the link too', async () => {
    const svc = await linked();
    expect(svc.removeToken()).toMatchObject({ configured: false, linked: false, botUsername: null });
    expect(vault.get('telegram')).toBeNull();
    expect(db.all('SELECT * FROM telegram_link')).toHaveLength(0);
  });

  it('a different bot does not inherit the old link', async () => {
    const svc = await linked();
    f.on('POST', 'https://api.telegram.org/bot222222222:' + 'B'.repeat(35) + '/getMe', () => ({ json: { ok: true, result: { id: 111, username: 'other_bot' } } }));
    const s = await svc.setToken('222222222:' + 'B'.repeat(35));
    expect(s).toMatchObject({ configured: true, botUsername: 'other_bot', linked: false });
  });
});

describe('link flow (A2)', () => {
  it('issues a base32 code of at least 8 characters, valid 10 minutes, with a t.me deep link', async () => {
    const svc = new TelegramService({ db, vault, fetch: f.fetch, now: () => clock, sleep: () => new Promise((r) => setTimeout(r, 5)) });
    await svc.setToken(TOKEN);
    const s = await svc.link();
    expect(s.pendingCode!.code).toMatch(/^[A-Z2-7]{10}$/);
    expect(s.pendingCode!.deepLink).toBe('https://t.me/rocket_notify_bot?start=' + s.pendingCode!.code);
    expect(s.pendingCode!.expiresAt).toBe(T0 + LINK_TTL_MS);
    // Codes differ between issues.
    const again = await svc.link();
    expect(again.pendingCode!.code).not.toBe(s.pendingCode!.code);
    svc.stop();
  });

  it('links only the sender of the right code, stores the numeric id and tells them so', async () => {
    const svc = await configured();
    await svc.link();
    updates = [msg(10, '/start ' + CODE)];
    await svc.pollOnce(0);
    const s = svc.state();
    expect(s).toMatchObject({ linked: true, linkedName: 'Ada L', notify: false, pendingCode: null, error: null });
    expect(db.get('SELECT chat_id, linked_name FROM telegram_link')).toEqual({ chat_id: String(OWNER), linked_name: 'Ada L' });
    expect(JSON.stringify(db.all('SELECT * FROM telegram_link'))).not.toContain('ada_l_private');
    const sent = callsTo('sendMessage').at(-1)!;
    expect(JSON.parse(sent.body)).toMatchObject({ chat_id: OWNER, text: TELEGRAM_TEXT.linked + '\n\n' + HUB });
  });

  it('acknowledges updates with offset = last + 1, including the ones it ignores', async () => {
    const svc = await configured();
    await svc.link();
    updates = [msg(20, 'hello', { chat: { id: 7, type: 'group' } }), msg(21, 'hi')];
    await svc.pollOnce(0);
    updates = [];
    await svc.pollOnce(0);
    const polls = callsTo('getUpdates').map((c) => JSON.parse(c.body));
    expect(polls.at(-1).offset).toBe(22);
    expect(polls[0]).toMatchObject({ timeout: 0, allowed_updates: ['message'] });
    svc.stop();
  });

  it('a code works once', async () => {
    const svc = await linked();
    svc.unlink();
    await svc.link();
    updates = [msg(11, '/start ' + CODE, { date: Math.floor((T0 - 5000) / 1000) })];
    await svc.pollOnce(0);
    expect(svc.state().linked).toBe(false);
    svc.stop();
  });

  it('ignores a group, a bot, a forwarded sender, an old update, a late one and a wrong code', async () => {
    const svc = await configured();
    await svc.link();
    const before = Math.floor(clock / 1000) - 5;
    updates = [
      msg(30, '/start ' + CODE, { chat: { id: -100, type: 'supergroup' } }),
      msg(31, '/start ' + CODE, { from: { is_bot: true } }),
      msg(32, '/start ' + CODE, { from: { id: 999 } }), // from.id !== chat.id
      msg(33, '/start ' + CODE, { date: before }),
      msg(34, '/start WRONGCODE9'),
      msg(35, 'just chatting'),
    ];
    await svc.pollOnce(0);
    expect(svc.state().linked).toBe(false);
    expect(svc.state().pendingCode).not.toBeNull();
    // Expired: the right code after ten minutes does nothing, and the code is gone.
    clock += LINK_TTL_MS + 1000;
    updates = [msg(36, '/start ' + CODE)];
    await svc.pollOnce(0).catch(() => {});
    expect(svc.state().linked).toBe(false);
    expect(svc.state().pendingCode).toBeNull();
    svc.stop();
  });

  it('also takes the code typed on its own, in lower case', async () => {
    const svc = await configured();
    await svc.link();
    updates = [msg(40, CODE.toLowerCase())];
    await svc.pollOnce(0);
    expect(svc.state().linked).toBe(true);
  });

  it('locks after five wrong codes: 429, a message, and a fresh start after the lock', async () => {
    const svc = await configured();
    await svc.link();
    updates = Array.from({ length: MAX_WRONG_CODES }, (_, i) => msg(50 + i, '/start GUESS' + i + 'AAAA'));
    await svc.pollOnce(0);
    expect(svc.state().pendingCode).toBeNull();
    expect(svc.state().error).toMatch(/locked/i);
    const err = await svc.link().catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err.status).toBe(429);
    clock += LOCK_MS + 1000;
    const s = await svc.link();
    expect(s.pendingCode).not.toBeNull();
    expect(s.error).toBeNull();
    svc.stop();
  });

  it('a webhook or another hub (409) is reported at once and never deleted', async () => {
    const svc = await configured();
    f.on('POST', BOT + 'getUpdates', () => ({ status: 409, json: { ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' } }));
    const err = await svc.link().catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err.status).toBe(409);
    expect(err.message).toBe(CONFLICT_MESSAGE);
    expect(svc.state().pendingCode).toBeNull();
    expect(svc.state().error).toBe(CONFLICT_MESSAGE);
    expect(f.calls.some((c) => /webhook/i.test(method(c) ?? ''))).toBe(false);
  });

  it('linking needs a token, and is refused while already linked', async () => {
    expect((await build().link().catch((e) => e)).status).toBe(400);
    const svc = await linked();
    expect((await svc.link().catch((e) => e)).status).toBe(400);
  });

  it('shutdown aborts the poll in flight and does not wait for it', async () => {
    let calls = 0;
    let hung: AbortSignal | undefined;
    const fetchFn: Fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/getMe')) return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'rocket_notify_bot' } }));
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ ok: true, result: [] }));
      hung = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const svc = build({ fetch: fetchFn });
    await svc.setToken(TOKEN);
    await svc.link();
    await vi.waitFor(() => expect(hung).toBeDefined());
    expect(hung!.aborted).toBe(false);
    const t = Date.now();
    svc.stop();
    expect(Date.now() - t).toBeLessThan(50);
    expect(hung!.aborted).toBe(true);
    expect(svc.state().pendingCode).toBeNull();
    // The loop ended quietly: no error is surfaced for an abort the hub asked for.
    expect(svc.state().error).toBeNull();
  });

  it('unlink forgets the chat and turns notifications off', async () => {
    const svc = await linked();
    svc.setNotify(true);
    expect(svc.unlink()).toMatchObject({ linked: false, notify: false, linkedName: null });
    expect(() => svc.setNotify(true)).toThrow(/Link/);
  });
});

describe('Telegram as a notification sink (A3)', () => {
  const sub = { id: 'ps1', deviceId: null, endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'a', auth: 'b', now: 1 };

  async function setup() {
    const tg = await linked();
    tg.setNotify(true);
    f.calls.length = 0;
    let now = T0;
    const webSent: string[] = [];
    const devices = new DevicesRepo(new Db(':memory:'));
    const push = new PushService({
      devices, repos: {} as never, subject: 'mailto:x@y.z', vapid: () => { throw new Error('no key'); }, now: () => now,
      fetch: async (url) => { webSent.push(url); return { status: 201 }; },
    });
    push.setTelegram(tg);
    return { tg, push, devices, webSent, advance: (ms: number) => { now += ms; clock += ms; } };
  }
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it('a Telegram-only owner (no Web Push subscription) is notified, with these exact bytes', async () => {
    const { push } = await setup();
    push.notify('approval');
    await flush();
    const sends = callsTo('sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe('POST');
    expect(sends[0].url.href).toBe(BOT + 'sendMessage');
    expect(sends[0].headers['content-type']).toBe('application/json; charset=utf-8');
    expect(sends[0].body).toBe('{"chat_id":4242,"text":"A bot needs your approval.\\n\\nhttps://myhub.tail1234.ts.net/","link_preview_options":{"is_disabled":true}}');
  });

  it('says only the fixed line, whatever the event carried', async () => {
    const { push } = await setup();
    push.start();
    try {
      events.emitEvent({
        type: 'approval.request', roomId: 'room-payroll', botId: 'bot-hr', messageId: 'm1',
        approval: { id: 'a1', toolName: 'Bash', toolInput: { command: 'rm -rf /srv/payroll' }, reason: 'delete payroll', status: 'pending' } as never,
      });
      await flush();
    } finally {
      push.stop();
    }
    const body = JSON.parse(callsTo('sendMessage')[0].body);
    expect(body.text).toBe(TELEGRAM_TEXT.approval + '\n\n' + HUB);
    for (const word of ['payroll', 'Bash', 'bot-hr', 'room', 'rm']) expect(body.text).not.toContain(word);
    expect(Object.keys(body).sort()).toEqual(['chat_id', 'link_preview_options', 'text']);
  });

  it('each kind has its own fixed line', async () => {
    const { push } = await setup();
    push.notify('approval');
    push.notify('routine');
    await flush();
    expect(callsTo('sendMessage').map((c) => JSON.parse(c.body).text)).toEqual([
      TELEGRAM_TEXT.approval + '\n\n' + HUB,
      TELEGRAM_TEXT.routine + '\n\n' + HUB,
    ]);
  });

  it('coalesces on its own 30 s stamp, separate from Web Push', async () => {
    const { push, devices, webSent, advance } = await setup();
    push.notify('approval');
    advance(10_000);
    push.notify('approval');
    await flush();
    expect(callsTo('sendMessage')).toHaveLength(1);
    // A phone subscribing now is not held back by Telegram's stamp: it has none yet, so it gets this one.
    devices.upsertSubscription(sub);
    push.notify('approval');
    await flush();
    expect(callsTo('sendMessage')).toHaveLength(1);
    expect(webSent).toHaveLength(0); // no VAPID key in this test: the web sink tried and failed, it did not throw
    advance(21_000);
    push.notify('approval');
    await flush();
    expect(callsTo('sendMessage')).toHaveLength(2);
  });

  it('sends nothing until the owner turns notifications on, or after they turn them off', async () => {
    const { tg, push, advance } = await setup();
    tg.setNotify(false);
    push.notify('approval');
    await flush();
    expect(callsTo('sendMessage')).toHaveLength(0);
    tg.setNotify(true);
    advance(1000);
    push.notify('approval');
    await flush();
    expect(callsTo('sendMessage')).toHaveLength(1);
  });

  it('a Telegram outage does not throw into the approval path and shows as an error', async () => {
    const { tg, push } = await setup();
    f.on('POST', BOT + 'sendMessage', () => ({ status: 403, json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => push.notify('approval')).not.toThrow();
    await flush();
    expect(tg.state().error).toContain('bot was blocked by the user');
  });

  it('the test message goes out even with notifications off, and needs a link', async () => {
    const svc = await configured();
    expect((await svc.sendTest().catch((e) => e)).status).toBe(400);
    await linked(svc);
    f.calls.length = 0;
    await svc.sendTest();
    expect(JSON.parse(callsTo('sendMessage')[0].body).text).toBe(TELEGRAM_TEXT.test + '\n\n' + HUB);
  });

  it('leaves the link out of the text when the hub has no phone address', async () => {
    const svc = build({ hubUrl: () => null });
    await svc.setToken(TOKEN);
    await linked(svc);
    f.calls.length = 0;
    await svc.sendTest();
    expect(JSON.parse(callsTo('sendMessage')[0].body).text).toBe(TELEGRAM_TEXT.test);
  });
});
