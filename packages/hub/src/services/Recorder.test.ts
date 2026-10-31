import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ComputerControl, ControlStatus } from '@pocketrocket/shared';
import { Recorder, RecorderError, scrubUrl, type RecorderDeps } from './Recorder.js';
import { PAGE_SCRIPT, RECORDER_BINDING, RECORDER_WORLD, isSecretField } from './recorderPage.js';
import type { ComputerEndpoint } from './ComputerManager.js';
import { events } from '../events.js';

/** P6 (6.1): the recorder, against a fake Chromium DevTools endpoint and a fake scrot/xdotool. */

const PASSWORD = 'hunter2-PASSWORD-VALUE';
const CARD = '4111 1111 1111 1111';
const OTP = '913482';

// ---- a fake CDP browser: one page target, scripted replies, events pushed on demand ----
interface FakeCdp {
  url: string;
  methods: { method: string; params: Record<string, unknown>; sessionId?: string }[];
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void;
  page(ev: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function fakeCdp(): Promise<FakeCdp> {
  const server = http.createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/fake', webSocketDebuggerUrl: 'ws://localhost:' + port + '/devtools/browser/fake' }));
  });
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  const methods: FakeCdp['methods'] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
      methods.push({ method: m.method, params: m.params, sessionId: m.sessionId });
      const result =
        m.method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'T1', type: 'page' }, { targetId: 'W1', type: 'service_worker' }] }
        : m.method === 'Target.attachToTarget' ? { sessionId: 'S-' + m.params.targetId }
        : m.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'F1', url: 'https://shop.example/login?session=abc123&lang=en' }, childFrames: [{ frame: { id: 'F2', parentId: 'F1' } }] } }
        : m.method === 'Page.createIsolatedWorld' ? { executionContextId: 7 }
        : {};
      ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => {
    for (const s of sockets) s.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  };
  return {
    url: 'http://127.0.0.1:' + port,
    methods,
    emit,
    page: (ev) => emit('Runtime.bindingCalled', { name: RECORDER_BINDING, payload: JSON.stringify(ev), executionContextId: 7 }, 'S-T1'),
    close: () => new Promise((r) => { for (const s of sockets) s.terminate(); wss.close(); server.close(() => r()); }),
  };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---- fakes for the hub side ----
function fakeControl() {
  const state = new Map<string, ControlStatus>();
  const calls: { botId: string; control: ComputerControl; holder?: string | null; note?: string }[] = [];
  return {
    calls,
    get: (botId: string): ControlStatus => state.get(botId) ?? { botId, control: 'agent', holder: null, since: 0, takeover: null },
    set(botId: string, control: ComputerControl, o: { holder?: string | null; note?: string } = {}): ControlStatus {
      calls.push({ botId, control, ...o });
      const s = { botId, control, holder: control === 'agent' ? null : o.holder ?? null, since: Date.now(), takeover: null };
      state.set(botId, s);
      events.emitEvent({ type: 'computer.control', status: s });
      return s;
    },
  };
}

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

let cdp: FakeCdp;
let screen = '';
let released = 0;
let root: string;
beforeEach(async () => {
  cdp = await fakeCdp();
  screen = 'blank';
  released = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-rec-'));
  tmps.push(root);
});
afterEach(async () => { await cdp.close(); });

function recorder(extra: Partial<RecorderDeps> = {}) {
  const control = fakeControl();
  const endpoint: ComputerEndpoint = {
    perBot: true, botId: 'bot1', slot: 1, display: ':201', xauthority: '/x/.Xauthority', home: '/x', filesDir: '/x/files',
    cdpUrl: cdp.url, screenUrl: 'http://127.0.0.1:6201', vncPort: 5801,
  };
  const execs: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const rec = new Recorder({
    computers: { enabled: true, acquire: async () => ({ ok: true, endpoint, release: () => { released++; } }) },
    control,
    available: () => ({ ok: true }),
    dir: (botId) => path.join(root, botId, 'recordings'),
    // scrot "photographs" whatever the fake screen shows right now.
    exec: async (cmd, args, env) => {
      execs.push({ cmd, args, env });
      if (cmd === 'scrot') fs.writeFileSync(args[args.length - 1], 'PNG:' + screen);
      if (cmd === 'xdotool') return 'Terminal - bash';
      return '';
    },
    windowPollMs: 0,
    caps: { frameIntervalMs: 0 },
    ...extra,
  });
  return { rec, control, execs };
}

describe('Recorder: start and stop', () => {
  it('forces user control (holder recorder), acquires the computer, attaches a second CDP client, and hands back with a note', async () => {
    const { rec, control } = recorder();
    const st = await rec.start('bot1', { title: 'Export the monthly report' });
    expect(control.calls[0]).toMatchObject({ botId: 'bot1', control: 'user', holder: 'recorder' });
    expect(st.active?.state).toBe('recording');
    // The script and its binding live in an isolated world, on the page and on frames already loaded.
    const sent = cdp.methods.map((m) => m.method);
    expect(sent).toContain('Target.setDiscoverTargets');
    const binding = cdp.methods.find((m) => m.method === 'Runtime.addBinding')!;
    expect(binding).toMatchObject({ sessionId: 'S-T1', params: { name: RECORDER_BINDING, executionContextName: RECORDER_WORLD } });
    expect(cdp.methods.find((m) => m.method === 'Page.addScriptToEvaluateOnNewDocument')?.params).toMatchObject({ worldName: RECORDER_WORLD });
    expect(cdp.methods.filter((m) => m.method === 'Page.createIsolatedWorld')).toHaveLength(2);
    expect(cdp.methods.some((m) => m.method === 'Target.attachToTarget' && m.params.targetId === 'W1')).toBe(false);
    await expect(rec.start('bot1')).rejects.toThrow(/Already recording/);

    const done = await rec.stop('bot1');
    expect(done?.state).toBe('stopped');
    expect(released).toBe(1);
    const last = control.calls[control.calls.length - 1];
    expect(last.control).toBe('agent');
    expect(last.note).toMatch(/showed you a task.*Export the monthly report/);
    expect(rec.status('bot1').active).toBeNull();
    // The initial URL is in the trace with its session id scrubbed.
    const trace = rec.readTrace('bot1', done!.id);
    expect(trace[0].t).toBe('start');
    expect(trace.find((e) => e.t === 'nav')?.url).toBe('https://shop.example/login?session=%C2%ABsecret%C2%BB&lang=en');
    expect(rec.list('bot1').map((r) => r.id)).toEqual([done!.id]);
  });

  it('is not available without per-bot computers, and says so', async () => {
    const rec = new Recorder({
      computers: { enabled: false, acquire: async () => { throw new Error('must not acquire'); } },
      control: fakeControl(),
    });
    const st = rec.status('bot1');
    expect(st.available).toBe(false);
    expect(st.reason).toMatch(/server hub|per-bot computers/);
    await expect(rec.start('bot1')).rejects.toBeInstanceOf(RecorderError);
  });

  it('gives control back when the computer cannot start', async () => {
    const control = fakeControl();
    const rec = new Recorder({
      computers: { enabled: true, acquire: async () => ({ ok: false, reason: 'Every computer slot (9) is taken.', release: () => { released++; } }) },
      control, available: () => ({ ok: true }), dir: () => path.join(root, 'r'),
    });
    await expect(rec.start('bot1')).rejects.toThrow(/slot/);
    expect(control.get('bot1').control).toBe('agent');
    expect(released).toBe(1);
  });

  it('ends the recording when the user hands back from the Screen tab', async () => {
    const { rec, control } = recorder();
    rec.listen();
    try {
      await rec.start('bot1');
      control.set('bot1', 'agent', { note: 'all yours' });
      await tick();
      expect(rec.status('bot1').active).toBeNull();
      // Exactly the user's hand-back: the recorder does not add a second one.
      expect(control.calls.filter((c) => c.control === 'agent')).toHaveLength(1);
    } finally {
      await rec.shutdown();
    }
  });

  it('records the active window for non-browser apps, and keeps going when the browser is not reachable', async () => {
    const { rec } = recorder({ windowPollMs: 10, fetchJson: async () => { throw new Error('connect ECONNREFUSED'); } });
    await rec.start('bot1');
    await tick(60);
    const info = await rec.stop('bot1');
    expect(info?.error).toMatch(/Browser not recorded/);
    const windows = rec.readTrace('bot1', info!.id).filter((e) => e.t === 'window');
    expect(windows).toEqual([expect.objectContaining({ title: 'Terminal - bash' })]);
  });
});

describe('Recorder: redaction at capture time', () => {
  const field = (o: Record<string, string>) => ({ tag: 'input', selector: '#' + (o.id ?? 'x'), role: 'textbox', label: o.label ?? '', ...o });
  const email = field({ id: 'email', type: 'email', name: 'email', label: 'Email', autocomplete: 'username' });
  const pwd = field({ id: 'pwd', type: 'password', name: 'pwd', label: 'Password' });
  const card = field({ id: 'card', type: 'text', name: 'cardnumber', label: 'Card number', autocomplete: 'cc-number' });
  const otp = field({ id: 'code', type: 'text', name: 'code', label: 'Code', autocomplete: 'one-time-code' });
  const pay = { tag: 'button', selector: '#pay', role: 'button', label: '', text: 'Pay now' };

  it('never writes a password, card number or one-time code into the trace or a kept frame, even when the page sends them', async () => {
    const { rec } = recorder();
    await rec.start('bot1');
    // 1. Click into the email field and type: kept, with the value.
    screen = 'login page';
    cdp.page({ t: 'focus', el: email });
    cdp.page({ t: 'click', el: email, x: 10, y: 10, visibleSecret: false });
    await tick();
    cdp.page({ t: 'type', el: email, value: 'me@example.com' });
    cdp.page({ t: 'blur', secret: false, visibleSecret: false });
    // 2. The password field. A lying (or buggy) page sends the real value; the hub redacts it anyway.
    cdp.page({ t: 'focus', el: { ...pwd, secret: false } });
    screen = 'password: ' + PASSWORD;
    cdp.page({ t: 'click', el: { ...pwd, secret: false }, x: 10, y: 40, visibleSecret: false });
    await tick();
    cdp.page({ t: 'type', el: { ...pwd, secret: false }, value: PASSWORD });
    cdp.page({ t: 'key', key: 'Tab', el: pwd });
    cdp.page({ t: 'blur', secret: true, visibleSecret: false });
    // 3. A card number (visible text once typed) and a one-time code.
    cdp.page({ t: 'focus', el: card });
    screen = 'card: ' + CARD;
    cdp.page({ t: 'click', el: card, x: 10, y: 70, visibleSecret: false });
    await tick();
    cdp.page({ t: 'type', el: card, value: CARD });
    cdp.page({ t: 'blur', secret: true, visibleSecret: true });
    cdp.page({ t: 'focus', el: otp });
    cdp.page({ t: 'change', el: otp, value: OTP });
    cdp.page({ t: 'blur', secret: true, visibleSecret: true });
    // 4. "Pay" while the card number is still on screen: that frame is dropped too.
    cdp.page({ t: 'click', el: pay, x: 10, y: 100, visibleSecret: true });
    await tick();
    // 5. A new page: nothing secret on screen any more, so frames are kept again.
    cdp.emit('Page.frameNavigated', { frame: { id: 'F1', url: 'https://shop.example/done' } }, 'S-T1');
    screen = 'thank you';
    cdp.page({ t: 'click', el: { tag: 'a', role: 'link', text: 'Continue', selector: '#continue' }, x: 1, y: 1, visibleSecret: false });
    await tick();
    const info = (await rec.stop('bot1'))!;

    const dir = path.join(root, 'bot1', 'recordings', info.id);
    const traceRaw = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8');
    for (const secret of [PASSWORD, CARD, CARD.replace(/ /g, ''), OTP]) expect(traceRaw).not.toContain(secret);
    expect(traceRaw).toContain('me@example.com');
    const trace = rec.readTrace('bot1', info.id);
    expect(trace.filter((e) => (e.t === 'type' || e.t === 'change') && e.value === '«secret»')).toHaveLength(3);
    expect(trace.some((e) => e.t === 'key' && e.key === 'Tab')).toBe(true);

    const frames = fs.readdirSync(path.join(dir, 'frames'));
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      const png = fs.readFileSync(path.join(dir, 'frames', f), 'utf8');
      expect(png).not.toContain(PASSWORD);
      expect(png).not.toContain(CARD);
    }
    expect(frames.map((f) => fs.readFileSync(path.join(dir, 'frames', f), 'utf8'))).toEqual(['PNG:login page', 'PNG:thank you']);
    expect(info.frames).toBe(2);
    expect(info.framesDropped).toBe(3);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(JSON.stringify(meta)).not.toContain(PASSWORD);
  });

  it('runs scrot on the bot\'s own display with its X cookie', async () => {
    const { rec, execs } = recorder();
    await rec.start('bot1');
    cdp.page({ t: 'click', el: { tag: 'button', text: 'Go' }, x: 0, y: 0 });
    await tick();
    await rec.stop('bot1');
    const scrot = execs.find((e) => e.cmd === 'scrot')!;
    expect(scrot.env).toEqual({ DISPLAY: ':201', XAUTHORITY: '/x/.Xauthority' });
    expect(scrot.args[scrot.args.length - 1]).toMatch(/frames[\\/]00001\.png$/);
  });

  it('drops a screenshot when a secret field takes focus while it is being taken', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { rec } = recorder({
      exec: async (cmd, args) => {
        if (cmd === 'scrot') { await gate; fs.writeFileSync(args[args.length - 1], 'PNG:' + PASSWORD); }
        return '';
      },
    });
    await rec.start('bot1');
    cdp.page({ t: 'click', el: { tag: 'button', text: 'Show login' }, x: 0, y: 0 });
    await tick();
    cdp.page({ t: 'focus', el: { tag: 'input', type: 'password', id: 'p' } });
    await tick();
    release();
    await tick();
    const info = (await rec.stop('bot1'))!;
    expect(info.frames).toBe(0);
    expect(info.framesDropped).toBe(1);
    expect(fs.readdirSync(path.join(root, 'bot1', 'recordings', info.id, 'frames'))).toEqual([]);
  });

  it('logs downloads and navigations with credential-looking query values scrubbed', async () => {
    const { rec } = recorder();
    await rec.start('bot1');
    cdp.emit('Page.downloadWillBegin', { url: 'https://files.example/r.csv?token=s3cr3t-tok', suggestedFilename: 'report.csv' }, 'S-T1');
    cdp.emit('Page.downloadProgress', { state: 'completed' }, 'S-T1');
    cdp.emit('Page.frameNavigated', { frame: { id: 'F9', parentId: 'F1', url: 'https://ads.example' } }, 'S-T1');
    await tick();
    const info = (await rec.stop('bot1'))!;
    const trace = rec.readTrace('bot1', info.id);
    expect(trace.filter((e) => e.t === 'download')).toEqual([
      expect.objectContaining({ file: 'report.csv', url: 'https://files.example/r.csv?token=%C2%ABsecret%C2%BB' }),
      expect.objectContaining({ state: 'completed' }),
    ]);
    // Sub-frame navigations are not steps.
    expect(trace.filter((e) => e.t === 'nav')).toHaveLength(1);
    expect(scrubUrl('https://u:p@x.example/a?code=1&q=shoes')).toBe('https://x.example/a?code=%C2%ABsecret%C2%BB&q=shoes');
  });
});

describe('Recorder: caps', () => {
  it('stops writing events at maxEvents and says so once', async () => {
    const { rec } = recorder({ caps: { maxEvents: 5, frameIntervalMs: 0, maxFrames: 1000 } });
    await rec.start('bot1');
    for (let i = 0; i < 12; i++) cdp.page({ t: 'key', key: 'Enter', el: null });
    await tick();
    const info = (await rec.stop('bot1'))!;
    expect(info.events).toBe(5);
    expect(info.capped).toContain('events');
    const trace = rec.readTrace('bot1', info.id);
    expect(trace.filter((e) => e.t === 'cap')).toHaveLength(1);
    expect(trace[trace.length - 1].t).toBe('stop');
  });

  it('keeps at most maxFrames screenshots', async () => {
    const { rec } = recorder({ caps: { maxFrames: 2, frameIntervalMs: 0 } });
    await rec.start('bot1');
    for (let i = 0; i < 5; i++) { cdp.page({ t: 'click', el: { tag: 'button', text: 'b' + i }, x: 0, y: 0 }); await tick(15); }
    const info = (await rec.stop('bot1'))!;
    expect(info.frames).toBe(2);
    expect(info.capped).toContain('frames');
    expect(fs.readdirSync(path.join(root, 'bot1', 'recordings', info.id, 'frames'))).toHaveLength(2);
  });

  it('stops at maxBytes (trace plus frames)', async () => {
    const { rec } = recorder({ caps: { maxBytes: 600, frameIntervalMs: 0 } });
    await rec.start('bot1');
    for (let i = 0; i < 30; i++) cdp.page({ t: 'type', el: { tag: 'input', type: 'text', id: 'q' }, value: 'x'.repeat(60) });
    await tick();
    const info = (await rec.stop('bot1'))!;
    expect(info.capped).toContain('bytes');
    expect(info.events).toBeLessThan(30);
    const size = fs.statSync(path.join(root, 'bot1', 'recordings', info.id, 'trace.jsonl')).size;
    expect(size).toBeLessThan(600 + 300); // the cap and stop lines always fit
  });

  it('ends a recording that runs past maxDurationMs', async () => {
    const { rec, control } = recorder({ caps: { maxDurationMs: 30, frameIntervalMs: 0 } });
    await rec.start('bot1');
    await tick(80);
    expect(rec.status('bot1').active).toBeNull();
    const [info] = rec.list('bot1');
    expect(info.capped).toContain('duration');
    expect(control.get('bot1').control).toBe('agent');
  });

  it('ignores oversized binding payloads', async () => {
    const { rec } = recorder();
    await rec.start('bot1');
    cdp.emit('Runtime.bindingCalled', { name: RECORDER_BINDING, payload: JSON.stringify({ t: 'type', el: {}, value: 'y'.repeat(20_000) }) }, 'S-T1');
    cdp.emit('Runtime.bindingCalled', { name: 'somethingElse', payload: JSON.stringify({ t: 'key', key: 'Enter' }) }, 'S-T1');
    await tick();
    const info = (await rec.stop('bot1'))!;
    expect(info.events).toBe(1); // the initial navigation only
  });
});

describe('the page script', () => {
  /** A tiny DOM: just enough elements and listeners to run PAGE_SCRIPT in a vm. */
  class El {
    nodeType = 1;
    parentElement: El | null = null;
    children: El[] = [];
    value = '';
    checked = false;
    isContentEditable = false;
    innerText = '';
    textContent = '';
    constructor(public tagName: string, public attrs: Record<string, string> = {}) {}
    get id() { return this.attrs.id ?? ''; }
    getAttribute(a: string) { return this.attrs[a] ?? null; }
    closest() { return null; }
  }
  function run() {
    const handlers: Record<string, ((e: unknown) => void)[]> = {};
    const fields: El[] = [];
    const body = new El('BODY');
    const sent: Record<string, unknown>[] = [];
    const document = {
      body,
      addEventListener: (t: string, fn: (e: unknown) => void) => { (handlers[t] ??= []).push(fn); },
      querySelectorAll: () => fields,
      querySelector: () => null,
      getElementById: () => null,
    };
    const window: Record<string, unknown> = { [RECORDER_BINDING]: (p: string) => sent.push(JSON.parse(p)) };
    vm.runInNewContext(PAGE_SCRIPT, { window, document });
    vm.runInNewContext(PAGE_SCRIPT, { window, document }); // idempotent: one set of listeners
    const add = (tag: string, attrs: Record<string, string>) => { const el = new El(tag, attrs); el.parentElement = body; body.children.push(el); fields.push(el); return el; };
    const fire = (t: string, e: Record<string, unknown>) => { for (const h of handlers[t] ?? []) h({ clientX: 0, clientY: 0, ctrlKey: false, altKey: false, metaKey: false, ...e }); };
    const typeInto = (el: El, v: string) => { fire('focusin', { target: el }); el.value = v; fire('focusout', { target: el }); };
    return { add, fire, typeInto, sent, handlers };
  }

  it('sends «secret» for password, autocomplete password / cc-* and one-time-code fields, and the value otherwise', () => {
    const p = run();
    expect(p.handlers.click).toHaveLength(1);
    const email = p.add('INPUT', { id: 'email', type: 'email', name: 'email' });
    const pwd = p.add('INPUT', { id: 'pwd', type: 'password' });
    const newPwd = p.add('INPUT', { id: 'np', type: 'text', autocomplete: 'new-password' });
    const card = p.add('INPUT', { id: 'cc', type: 'text', autocomplete: 'billing cc-number' });
    const cvc = p.add('INPUT', { id: 'cvc', type: 'text', autocomplete: 'cc-csc' });
    const code = p.add('INPUT', { id: 'otp', type: 'text', autocomplete: 'one-time-code' });
    p.typeInto(email, 'me@example.com');
    p.typeInto(pwd, PASSWORD);
    p.typeInto(newPwd, PASSWORD + '2');
    p.typeInto(card, CARD);
    p.typeInto(cvc, '123');
    p.typeInto(code, OTP);
    const all = JSON.stringify(p.sent);
    for (const s of [PASSWORD, CARD, OTP, '"123"']) expect(all).not.toContain(s);
    const typed = p.sent.filter((e) => e.t === 'type');
    expect(typed.map((e) => e.value)).toEqual(['me@example.com', '«secret»', '«secret»', '«secret»', '«secret»', '«secret»']);
    expect(typed.slice(1).every((e) => (e.el as { secret: boolean }).secret)).toBe(true);
    // A visible secret (the card number) is reported, so the hub drops frames while it is on screen.
    expect(p.sent.filter((e) => e.t === 'blur').pop()).toMatchObject({ visibleSecret: true });
  });

  it('flushes a typed value on Enter and reports special keys, never plain characters', () => {
    const p = run();
    const q = p.add('INPUT', { id: 'search', type: 'search', 'aria-label': 'Search' });
    p.fire('focusin', { target: q });
    q.value = 'blue shoes';
    p.fire('keydown', { target: q, key: 'b' });
    p.fire('keydown', { target: q, key: 'Enter' });
    p.fire('keydown', { target: q, key: 'k', ctrlKey: true });
    const kinds = p.sent.map((e) => e.t + ':' + (e.value ?? e.key ?? ''));
    expect(kinds).toEqual(['focus:', 'type:blue shoes', 'key:Enter', 'key:Ctrl+K']);
    expect((p.sent[1].el as { selector: string; label: string })).toMatchObject({ selector: '#search', label: 'Search', role: 'textbox' });
  });

  it('agrees with the hub on what a secret field is', () => {
    expect(isSecretField({ tag: 'input', type: 'password' })).toBe(true);
    expect(isSecretField({ tag: 'input', autocomplete: 'current-password' })).toBe(true);
    expect(isSecretField({ tag: 'input', autocomplete: 'cc-exp' })).toBe(true);
    expect(isSecretField({ tag: 'input', autocomplete: 'one-time-code' })).toBe(true);
    expect(isSecretField({ tag: 'input', name: 'cvv' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'email', autocomplete: 'email', name: 'email' })).toBe(false);
    expect(isSecretField({ tag: 'button', type: 'password' })).toBe(false);
    expect(isSecretField({ tag: 'button', secret: true })).toBe(true);
  });
});

describe('Recorder: finished recordings', () => {
  it('lists a recording the hub went down in as interrupted (and usable), and deletes on request', () => {
    const { rec } = recorder();
    const id = '2026-10-31T23-00-00-000Z';
    const dir = path.join(root, 'bot1', 'recordings', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, botId: 'bot1', title: 't', startedAt: 5, endedAt: null, state: 'recording', events: 3, frames: 0, framesDropped: 0, bytes: 10, capped: [], skillId: null }));
    fs.mkdirSync(path.join(root, 'bot1', 'recordings', 'not-a-recording'));
    expect(rec.list('bot1')).toEqual([expect.objectContaining({ id, state: 'stopped', endedAt: 5, error: expect.stringMatching(/Interrupted/) })]);
    expect(rec.get('bot1', '../../etc')).toBeNull();
    rec.setSkill('bot1', id, 'sk1');
    expect(rec.get('bot1', id)?.skillId).toBe('sk1');
    expect(rec.remove('bot1', id)).toBe(true);
    expect(rec.list('bot1')).toEqual([]);
  });
});
