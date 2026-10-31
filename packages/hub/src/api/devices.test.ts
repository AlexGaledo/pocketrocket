import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, verify } from 'node:crypto';
import WebSocket from 'ws';
import { createHub, type Hub } from '../hub.js';
import { events } from '../events.js';
import { deviceMayAccess } from './guard.js';
import { DeviceService, hashDeviceToken, normalizeCode, PAIRING_TTL_MS } from '../services/DeviceService.js';
import { DevicesRepo } from '../db/devices.js';
import { Db } from '../db/db.js';
import { PushService, pushPayload } from '../services/PushService.js';
import { encryptPayload, isPushEndpoint, vapidAuthorization, vapidFromJwk } from '../services/WebPush.js';

const TOKEN = 'p9-hub-token';
const VAPID_JWK = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
const pushed: { url: string; headers: Record<string, string>; body: Buffer }[] = [];

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN,
    push: (devices, repos) => new PushService({
      devices, repos, subject: 'mailto:test@example.com', vapid: () => vapidFromJwk(VAPID_JWK),
      fetch: async (url, init) => { pushed.push({ url, headers: init.headers, body: init.body }); return { status: 201 }; },
    }),
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
});

function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port, ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function pair(name = 'Test phone'): Promise<{ token: string; id: string }> {
  const minted = await req('POST', '/api/devices/pairing', { token: TOKEN, body: {} });
  expect(minted.status).toBe(200);
  const r = await req('POST', '/api/devices/pair', { body: { code: minted.json.code, name } });
  expect(r.status).toBe(200);
  return { token: r.json.token, id: r.json.device.id };
}

function openWs(token: string): Promise<{ ws: WebSocket; messages: any[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(token));
    const messages: any[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('error', reject);
  });
}

describe('pairing (P9.1)', () => {
  it('mints a code only for the hub token, and the code never carries the hub token', async () => {
    const r = await req('POST', '/api/devices/pairing', { token: TOKEN, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.json.expiresAt - Date.now()).toBeLessThanOrEqual(PAIRING_TTL_MS);
    expect(JSON.stringify(r.json)).not.toContain(TOKEN);
    expect((await req('POST', '/api/devices/pairing', { body: {} })).status).toBe(401);
  });

  it('redeems a code once for a device token whose hash alone is stored', async () => {
    const minted = await req('POST', '/api/devices/pairing', { token: TOKEN, body: {} });
    const code = minted.json.code as string;
    // Typed with a dash and lower case, as a human might.
    const r = await req('POST', '/api/devices/pair', { body: { code: code.slice(0, 4).toLowerCase() + '-' + code.slice(4), name: 'Pixel' } });
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^prd_[A-Za-z0-9_-]{43}$/);
    expect(r.json.device.name).toBe('Pixel');
    // Second use of the same code is refused.
    expect((await req('POST', '/api/devices/pair', { body: { code, name: 'again' } })).status).toBe(403);
    // Only the hash is in the database.
    const row = hub.repos.db.get<{ token_hash: string }>('SELECT token_hash FROM devices WHERE id = ?', r.json.device.id)!;
    expect(row.token_hash).toBe(hashDeviceToken(r.json.token));
    expect(JSON.stringify(hub.repos.db.all('SELECT * FROM devices'))).not.toContain(r.json.token);
    // The listing never carries a hash or a token.
    const list = await req('GET', '/api/devices', { token: TOKEN });
    expect(JSON.stringify(list.json)).not.toContain(row.token_hash);
    expect(list.json.devices.some((d: { id: string }) => d.id === r.json.device.id)).toBe(true);
  });

  it('refuses a wrong code with 403 (not 401) and an expired one', () => {
    let t = 1_000_000;
    const svc = new DeviceService(new DevicesRepo(new Db(':memory:')), () => t);
    const { code } = svc.mintPairingCode();
    expect(() => svc.redeem('ZZZZZZZZ', 'x')).toThrow(/wrong or has expired/);
    t += PAIRING_TTL_MS + 1;
    expect(() => svc.redeem(code, 'x')).toThrow(/wrong or has expired/);
    expect(svc.pendingCodes()).toBe(0);
    expect(normalizeCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeCode('ABCDEFG0')).toBeNull();
  });

  it('a device token authenticates /api and the websocket', async () => {
    const d = await pair();
    expect((await req('GET', '/api/bots', { token: d.token })).status).toBe(200);
    const { ws } = await openWs(d.token);
    ws.close();
    expect((await req('GET', '/api/bots', { token: d.token + 'x' })).status).toBe(401);
  });
});

describe('revocation (P9.1)', () => {
  it('refuses a revoked device at once and closes its open socket', async () => {
    const d = await pair('Revoke me');
    const sock = await openWs(d.token);
    expect((await req('DELETE', '/api/devices/' + d.id, { token: TOKEN })).status).toBe(200);
    // The very next request is refused…
    expect((await req('GET', '/api/bots', { token: d.token })).status).toBe(401);
    // …and the socket it already had open was hung up.
    expect(await sock.closed).toBe(4001);
    await expect(openWs(d.token)).rejects.toBeTruthy();
    const list = await req('GET', '/api/devices', { token: TOKEN });
    expect(list.json.devices.find((x: { id: string }) => x.id === d.id).revoked).toBe(true);
  });

  it('revoking a device also kills the Screen sessions it minted', async () => {
    const d = await pair('Screen phone');
    const t = await req('POST', '/api/screen/ticket', { token: d.token, body: {} });
    expect(t.status).toBe(200);
    const ticket = new URL(t.json.url, 'http://x').searchParams.get('ticket')!;
    await req('DELETE', '/api/devices/' + d.id, { token: TOKEN });
    // The ticket is gone: redeeming it is a failed auth now.
    const redeemed = await req('GET', '/screen/session?ticket=' + encodeURIComponent(ticket));
    expect(redeemed.status).toBe(401);
  });
});

describe('capability split (P9.1)', () => {
  let phone: { token: string; id: string };
  beforeAll(async () => { phone = await pair('Split'); });

  it('lets a device follow the fleet, chat, run automations and open a Screen', async () => {
    for (const p of ['/api/bots', '/api/rooms', '/api/routines', '/api/settings', '/api/usage', '/api/skills', '/api/push']) {
      expect((await req('GET', p, { token: phone.token })).status, p).toBe(200);
    }
    expect((await req('POST', '/api/screen/ticket', { token: phone.token, body: {} })).status).toBe(200);
  });

  it('refuses secrets, integrations, settings writes, account, fleet changes and debug with 403', async () => {
    const denied: [string, string, unknown?][] = [
      ['GET', '/api/secrets'],
      ['PUT', '/api/secrets', { anthropic: 'x' }],
      ['PUT', '/api/settings', { approvals: 'bypass' }],
      ['GET', '/api/integrations'],
      ['PUT', '/api/integrations/apps/github', { clientId: 'x', clientSecret: 'y' }],
      ['POST', '/api/integrations/token/github', { token: 'x' }],
      ['POST', '/oauth/start/github', {}],
      ['POST', '/api/account/sign-out', {}],
      ['GET', '/api/debug/last-init'],
      ['POST', '/api/bots', { name: 'x', handle: 'xx' }],
      ['DELETE', '/api/bots/whatever'],
      ['PUT', '/api/bots/whatever/memory', { text: '' }],
      ['POST', '/api/skills/import-git', { url: 'https://example.com/x.git' }],
      ['POST', '/api/providers/claude/check', {}],
      ['POST', '/api/workspace/open', {}],
      ['POST', '/api/devices/pairing', {}],
      ['PATCH', '/api/devices/' + 'x', { name: 'y' }],
    ];
    for (const [m, p, body] of denied) {
      const r = await req(m, p, { token: phone.token, body });
      expect(r.status, m + ' ' + p).toBe(403);
    }
    // Settings stayed as they were.
    expect((await req('GET', '/api/settings', { token: TOKEN })).json.approvals).not.toBe('bypass');
  });

  it('a device sees only itself and may unpair only itself', async () => {
    const other = await pair('Other');
    const mine = await req('GET', '/api/devices', { token: phone.token });
    expect(mine.json.current).toBe(phone.id);
    expect(mine.json.devices.map((d: { id: string }) => d.id)).toEqual([phone.id]);
    expect((await req('DELETE', '/api/devices/' + other.id, { token: phone.token })).status).toBe(403);
    expect((await req('GET', '/api/bots', { token: other.token })).status).toBe(200);
  });

  it('refuses "always allow" from a device over the socket', async () => {
    const { ws, messages } = await openWs(phone.token);
    ws.send(JSON.stringify({ type: 'approval.decide', approvalId: 'nope', decision: 'always' }));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    expect(messages.some((m) => m.type === 'error' && /desktop app/.test(m.message))).toBe(true);
  });

  it('the allowlist is closed by default for unknown routes', () => {
    expect(deviceMayAccess('GET', '/api/some-new-phase-route')).toBe(false);
    expect(deviceMayAccess('POST', '/api/routines/x/run')).toBe(true);
    expect(deviceMayAccess('GET', '/api/triggers')).toBe(true);
    expect(deviceMayAccess('POST', '/api/triggers/x/test')).toBe(true);
    expect(deviceMayAccess('GET', '/assets/app.js')).toBe(true);
    expect(deviceMayAccess('POST', '/oauth/start/github')).toBe(false);
    expect(deviceMayAccess('GET', '/oauth/start/github')).toBe(false);
  });
});

/** RFC 8291 decryption, the browser's side, so the test reads exactly what the push service carried. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(out[out.length - 1]).toBe(2);
  return out.subarray(0, out.length - 1);
}

describe('Web Push (P9.3)', () => {
  it('encrypts to the subscription key (RFC 8291 round trip)', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const body = encryptPayload(Buffer.from('hello'), { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
    expect(decrypt(body, ua, auth).toString()).toBe('hello');
  });

  it('signs a VAPID JWT for the push service origin', () => {
    const keys = vapidFromJwk(VAPID_JWK);
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:a@b.c', 1000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(JSON.parse(Buffer.from(m[2], 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'mailto:a@b.c' });
    const ok = verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: createPublicKey({ key: VAPID_JWK, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    expect(ok).toBe(true);
    expect(m[4]).toBe(keys.publicKey);
  });

  it('only accepts browser push service endpoints', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(isPushEndpoint('https://evil.example.com/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
  });

  it('pushes approval and test payloads that carry no message text', async () => {
    const phone = await pair('Push phone');
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/p9-test', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    expect((await req('POST', '/api/push/subscribe', { token: phone.token, body: { endpoint: 'https://10.0.0.1/hook', keys: sub.keys } })).status).toBe(400);
    expect((await req('POST', '/api/push/subscribe', { token: phone.token, body: sub })).status).toBe(200);
    expect((await req('GET', '/api/push', { token: phone.token })).json.subscriptions).toBe(1);
    // The desktop cannot be shadowed: another principal may not claim the same endpoint.
    expect((await req('POST', '/api/push/subscribe', { token: TOKEN, body: sub })).status).toBe(409);

    pushed.length = 0;
    const secret = 'Deploy the payroll export to prod with password hunter2';
    events.emitEvent({
      type: 'approval.request', roomId: 'r1', botId: 'b1', messageId: 'm1',
      approval: { id: 'a1', toolName: 'Bash', toolInput: { command: secret }, reason: secret, status: 'pending' } as never,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushed).toHaveLength(1);
    const plain = decrypt(pushed[0].body, ua, auth);
    expect(JSON.parse(plain.toString())).toEqual({ kind: 'approval' });
    expect(plain.toString()).not.toContain('hunter2');
    expect(pushed[0].body.toString('latin1')).not.toContain('payroll');
    expect(pushed[0].headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(pushed[0].headers['Content-Encoding']).toBe('aes128gcm');

    // A burst coalesces into one push.
    events.emitEvent({ type: 'approval.request', roomId: 'r1', botId: 'b1', messageId: 'm2', approval: { id: 'a2' } as never });
    await new Promise((r) => setTimeout(r, 20));
    expect(pushed).toHaveLength(1);

    pushed.length = 0;
    const t = await req('POST', '/api/push/test', { token: phone.token, body: {} });
    expect(t.json).toEqual({ sent: 1, failed: 0 });
    expect(decrypt(pushed[0].body, ua, auth).equals(pushPayload('test'))).toBe(true);

    // Revoking the device drops its subscription.
    await req('DELETE', '/api/devices/' + phone.id, { token: TOKEN });
    pushed.length = 0;
    expect(await hub.push.send('routine')).toEqual({ sent: 0, failed: 0 });
  });

  it('drops a subscription the push service says is gone', async () => {
    const db = new Db(':memory:');
    const devices = new DevicesRepo(db);
    const svc = new PushService({
      devices, repos: {} as never, subject: 'mailto:x@y.z', vapid: () => vapidFromJwk(VAPID_JWK),
      fetch: async () => ({ status: 410 }),
    });
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    svc.subscribe(null, { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
    expect(await svc.send('test')).toEqual({ sent: 0, failed: 1 });
    expect(devices.subscriptions()).toHaveLength(0);
  });
});

describe('routine push (P9.3)', () => {
  it('sends a content-free "routine" push when a routine turn ends, and nothing for a chat turn', async () => {
    const devices = new DevicesRepo(new Db(':memory:'));
    const sent: Buffer[] = [];
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const svc = new PushService({
      devices, subject: 'mailto:x@y.z', vapid: () => vapidFromJwk(VAPID_JWK),
      repos: { getMessage: (id: string) => ({ id, kind: id === 'routine-msg' ? 'routine' : 'text', text: 'Summarise the board meeting notes' }) } as never,
      fetch: async (_u, init) => { sent.push(init.body); return { status: 201 }; },
    });
    svc.subscribe(null, { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });
    svc.start();
    try {
      events.emitEvent({ type: 'turn.start', turnId: 't-chat', botId: 'b', roomId: 'r', causeId: 'chat-msg', hop: 0 });
      events.emitEvent({ type: 'turn.end', turnId: 't-chat', botId: 'b', roomId: 'r' });
      events.emitEvent({ type: 'turn.start', turnId: 't-rt', botId: 'b', roomId: 'r', causeId: 'routine-msg', hop: 0 });
      events.emitEvent({ type: 'turn.end', turnId: 't-rt', botId: 'b', roomId: 'r', messageId: 'm' });
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      svc.stop();
    }
    expect(sent).toHaveLength(1);
    const plain = decrypt(sent[0], ua, auth).toString();
    expect(JSON.parse(plain)).toEqual({ kind: 'routine' });
    expect(plain).not.toContain('board meeting');
  });
});
