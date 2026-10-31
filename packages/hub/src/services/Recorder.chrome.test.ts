import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComputerControl, ControlStatus } from '@pocketrocket/shared';
import { Recorder } from './Recorder.js';
import { connectCdp, type CdpConnection } from './cdpClient.js';
import { HUB_DIR } from '../config.js';

/**
 * P6 (6.1) against a real Chromium: the redaction fixture page, typed into over CDP Input events while the
 * recorder listens as a second client. Skipped when no Chrome/Chromium is installed (set CHROME_PATH to force one).
 * scrot is faked (no X display here); everything on the browser side is real.
 */

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p): p is string => !!p);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));

const PASSWORD = 'hunter2-PASSWORD-VALUE';
const CARD = '4111111111111111';
const OTP = '913482';
const FIXTURE = pathToFileURL(path.join(HUB_DIR, 'test-fixtures', 'teach', 'checkout.html')).toString();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!CHROME)('Recorder against a real Chromium', () => {
  let proc: ChildProcess;
  let profile: string;
  let root: string;
  let cdpUrl = '';

  beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-chrome-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-rec-real-'));
    proc = spawn(CHROME!, [
      '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
      '--no-default-browser-check', '--disable-gpu', '--allow-file-access-from-files', 'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    for (let i = 0; i < 20 && !cdpUrl; i++) {
      const port = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n')[0].trim() : '';
      if (port) cdpUrl = 'http://127.0.0.1:' + port;
      else await sleep(100);
    }
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await sleep(500);
    for (const d of [profile, root]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still holds a lock */ }
    }
  });

  it('records the checkout with no password, card number or code in the trace or a kept frame', async () => {
    expect(cdpUrl).not.toBe('');
    const state = new Map<string, ControlStatus>();
    const control = {
      get: (b: string) => state.get(b) ?? { botId: b, control: 'agent' as ComputerControl, holder: null, since: 0, takeover: null },
      set: (b: string, c: ComputerControl, o: { holder?: string | null } = {}) => {
        const s = { botId: b, control: c, holder: o.holder ?? null, since: Date.now(), takeover: null };
        state.set(b, s);
        return s;
      },
    };
    let screen = 'blank';
    const rec = new Recorder({
      computers: {
        enabled: true,
        acquire: async () => ({
          ok: true, release: () => undefined,
          endpoint: { perBot: true, botId: 'b', slot: 1, display: ':201', xauthority: '', home: '', filesDir: null, cdpUrl, screenUrl: '', vncPort: null },
        }),
      },
      control, available: () => ({ ok: true }), dir: () => root, windowPollMs: 0, caps: { frameIntervalMs: 0 },
      exec: async (cmd, args) => { if (cmd === 'scrot') fs.writeFileSync(args[args.length - 1], 'PNG:' + screen); return ''; },
    });
    await rec.start('b', { title: 'Pay for the order' });

    // The "user": another CDP client driving the same page with real input events.
    const ver = (await (await fetch(cdpUrl + '/json/version')).json()) as { webSocketDebuggerUrl: string };
    const user: CdpConnection = await connectCdp(ver.webSocketDebuggerUrl);
    const { targetInfos } = (await user.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string }[] };
    const page = targetInfos.find((t) => t.type === 'page')!;
    const { sessionId } = (await user.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })) as { sessionId: string };
    const send = (m: string, p: Record<string, unknown> = {}) => user.send(m, p, sessionId);
    await send('Page.enable');
    await send('Page.navigate', { url: FIXTURE });
    await sleep(800);
    const click = async (sel: string) => {
      const { result } = (await send('Runtime.evaluate', {
        expression: 'JSON.stringify((() => { const r = document.querySelector(' + JSON.stringify(sel) + ').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())',
        returnByValue: true,
      })) as { result: { value: string } };
      const { x, y } = JSON.parse(result.value) as { x: number; y: number };
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(150);
    };
    const typeText = async (text: string) => { await send('Input.insertText', { text }); await sleep(100); };

    screen = 'login form';
    await click('#email');
    await typeText('me@example.com');
    screen = 'password dots';
    await click('#password');
    await typeText(PASSWORD);
    screen = 'card ' + CARD;
    await click('#cardnumber');
    await typeText(CARD);
    await click('#otp');
    await typeText(OTP);
    await click('#pay');
    await sleep(400);
    user.close();
    const info = (await rec.stop('b'))!;

    const dir = path.join(root, info.id);
    const raw = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8');
    for (const s of [PASSWORD, CARD, OTP]) expect(raw).not.toContain(s);
    const trace = rec.readTrace('b', info.id);
    expect(trace.some((e) => e.t === 'nav' && String(e.url).endsWith('checkout.html'))).toBe(true);
    expect(trace.some((e) => e.t === 'type' && e.value === 'me@example.com')).toBe(true);
    expect(trace.filter((e) => e.t === 'type' && e.value === '«secret»')).toHaveLength(3);
    const pay = trace.find((e) => e.t === 'click' && (e.target as { text?: string })?.text === 'Pay now');
    expect(pay?.target).toMatchObject({ selector: '[data-testid="pay-button"]', role: 'button' });
    // Only the first click (into the email field, nothing secret anywhere yet) kept its screenshot.
    const frames = fs.readdirSync(path.join(dir, 'frames'));
    expect(frames.map((f) => fs.readFileSync(path.join(dir, 'frames', f), 'utf8'))).toEqual(['PNG:login form']);
    expect(info.framesDropped).toBeGreaterThanOrEqual(4);
  }, 30_000);
});
