import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BotInputSchema, MAX_MEDIA_BYTES, RoomInputSchema, SettingsPatchSchema, isMediaRef, mediaHash } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { MEDIA_GRACE_MS, MediaRejected, MediaStore, referencedMedia, sniffImageType } from '../services/MediaStore.js';
import { deviceMayAccess } from './guard.js';

const TOKEN = 'media-hub-token';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

let hub: Hub;
let port: number;
let dir: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-media-'));
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, mediaDir: dir });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

function req(method: string, url: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; json: any; bytes: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port, ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let json: unknown = null;
        try { json = JSON.parse(bytes.toString()); } catch { /* binary */ }
        resolve({ status: res.statusCode ?? 0, json, bytes, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const upload = (bytes: Buffer, token = TOKEN) => req('POST', '/api/media', { token, body: { data: bytes.toString('base64') } });
const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

async function pair(): Promise<string> {
  const minted = await req('POST', '/api/devices/pairing', { token: TOKEN, body: {} });
  const r = await req('POST', '/api/devices/pair', { body: { code: minted.json.code, name: 'Phone' } });
  expect(r.status).toBe(200);
  return r.json.token;
}

describe('upload', () => {
  it.each([['PNG', PNG, 'image/png'], ['JPEG', JPEG, 'image/jpeg'], ['WebP', WEBP, 'image/webp']])('takes a %s, named by its hash', async (_n, bytes, type) => {
    const r = await upload(bytes);
    expect(r.status).toBe(200);
    expect(isMediaRef(r.json.ref)).toBe(true);
    expect(files()).toContain(mediaHash(r.json.ref));
    const got = await req('GET', '/api/media/' + mediaHash(r.json.ref), { token: TOKEN });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe(type);
    expect(got.bytes.equals(bytes)).toBe(true);
  });

  it('the same bytes land on the same file', async () => {
    const before = files().length;
    const a = await upload(PNG);
    const b = await upload(PNG);
    expect(a.json.ref).toBe(b.json.ref);
    expect(files().length).toBe(before);
  });

  it('refuses wrong magic bytes, whatever the name or type claims', async () => {
    const before = files();
    const bad = Buffer.from('this is not an image, whatever it says it is');
    const r = await req('POST', '/api/media', { token: TOKEN, body: { data: bad.toString('base64'), type: 'image/png', name: 'x.png' } });
    expect(r.status).toBe(415);
    expect(files()).toEqual(before);
  });

  it('refuses SVG', async () => {
    const before = files();
    expect((await upload(SVG)).status).toBe(415);
    expect(sniffImageType(SVG)).toBeNull();
    expect(files()).toEqual(before);
  });

  it('refuses a file cut off inside its magic', async () => {
    expect((await upload(PNG.subarray(0, 8))).status).toBe(415);
    expect((await upload(Buffer.from('RIFF'))).status).toBe(415);
  });

  it('refuses a picture past the cap, and a body past readBody\'s cap', async () => {
    const before = files();
    const over = Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES - PNG.length + 1, 7)]);
    expect((await upload(over)).status).toBe(413);
    expect((await req('POST', '/api/media', { token: TOKEN, raw: JSON.stringify({ data: 'A'.repeat(1024 * 1024 + 8) }) })).status).toBe(413);
    expect(files()).toEqual(before);
    const fits = Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES - PNG.length, 7)]);
    expect((await upload(fits)).status).toBe(200);
  });

  it('refuses a body that is not base64', async () => {
    expect((await req('POST', '/api/media', { token: TOKEN, body: { data: '../../etc/passwd' } })).status).toBe(400);
    expect((await req('POST', '/api/media', { token: TOKEN, body: {} })).status).toBe(400);
  });

  it('keeps the JSON-only rule: a form post is refused before the handler', async () => {
    const r = await req('POST', '/api/media', { token: TOKEN, raw: 'data=x', headers: { 'content-type': 'multipart/form-data' } });
    expect(r.status).toBe(415);
  });

  it('refuses no token, a device, and a bot\'s turn bearer', async () => {
    const before = files();
    expect((await req('POST', '/api/media', { body: { data: PNG.toString('base64') } })).status).toBe(401);
    const device = await pair();
    const asDevice = await upload(PNG, device);
    expect(asDevice.status).toBe(403);
    expect(deviceMayAccess('POST', '/api/media')).toBe(false);
    const turnBearer = hub.turns.registerTurn([]);
    expect((await upload(PNG, turnBearer)).status).toBe(401);
    hub.turns.unregister(turnBearer);
    expect(files()).toEqual(before);
  });
});

describe('serving', () => {
  it('sends nosniff, a fixed type, and never lets a shared cache keep it', async () => {
    const { json } = await upload(PNG);
    const r = await req('GET', '/api/media/' + mediaHash(json.ref), { token: TOKEN });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('private, no-cache');
    expect(r.headers['content-security-policy']).toContain('sandbox');
  });

  it('is not public: no token and a bad token get 401, and a cookie or a query ticket buys nothing', async () => {
    const { json } = await upload(PNG);
    const url = '/api/media/' + mediaHash(json.ref);
    expect((await req('GET', url)).status).toBe(401);
    expect((await req('GET', url, { token: 'wrong' })).status).toBe(401);
    expect((await req('GET', url, { headers: { cookie: 'pr_screen=x' } })).status).toBe(401);
    expect((await req('GET', url + '?ticket=x')).status).toBe(401);
  });

  it('a paired device may view, and stops the moment it is revoked', async () => {
    const { json } = await upload(PNG);
    const url = '/api/media/' + mediaHash(json.ref);
    const device = await pair();
    expect((await req('GET', url, { token: device })).status).toBe(200);
    const list = await req('GET', '/api/devices', { token: TOKEN });
    for (const d of list.json.devices) await req('DELETE', '/api/devices/' + d.id, { token: TOKEN });
    expect((await req('GET', url, { token: device })).status).toBe(401);
  });

  it('revalidation needs the token too, and answers 304 for an unchanged picture', async () => {
    const { json } = await upload(PNG);
    const hash = mediaHash(json.ref);
    const url = '/api/media/' + hash;
    const etag = '"' + hash + '"';
    const r = await req('GET', url, { token: TOKEN, headers: { 'if-none-match': etag } });
    expect(r.status).toBe(304);
    expect(r.bytes.length).toBe(0);
    expect((await req('GET', url, { headers: { 'if-none-match': etag } })).status).toBe(401);
  });

  it('no client path reaches the filesystem', async () => {
    const secret = path.join(path.dirname(dir), 'pr-media-secret-' + path.basename(dir));
    fs.writeFileSync(secret, PNG);
    try {
      for (const u of ['/api/media/..%2F' + path.basename(secret), '/api/media/' + 'A'.repeat(64), '/api/media/' + 'a'.repeat(63), '/api/media/' + 'a'.repeat(64) + '.png']) {
        expect((await req('GET', u, { token: TOKEN })).status).toBe(404);
      }
      expect((await req('GET', '/api/media/' + 'a'.repeat(64), { token: TOKEN })).status).toBe(404);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });
});

describe('a stored avatar is an icon key or an uploaded reference', () => {
  const REF = 'img:' + 'a'.repeat(64);
  const base = { name: 'A', handle: 'aa' };
  it('schemas keep both, and turn emoji and other strings into automatic', () => {
    expect(BotInputSchema.parse({ ...base, avatar: REF }).avatar).toBe(REF);
    expect(BotInputSchema.parse({ ...base, avatar: 'shield' }).avatar).toBe('shield');
    for (const v of ['🤖', 'img:abc', 'img:' + 'G'.repeat(64), '../x.png', 'javascript:alert(1)', 'https://x.test/a.png']) {
      expect(BotInputSchema.parse({ ...base, avatar: v }).avatar).toBe('');
      expect(RoomInputSchema.parse({ kind: 'group', name: 'g', memberIds: ['x'], avatar: v }).avatar).toBe('');
    }
    expect(SettingsPatchSchema.safeParse({ userAvatar: REF }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ userAvatar: '' }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ userAvatar: 'shield' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ userAvatar: '🙂' }).success).toBe(false);
  });

  it('REST stores a reference only once the file exists', async () => {
    const missing = 'img:' + 'b'.repeat(64);
    const { json } = await upload(JPEG);
    expect((await req('POST', '/api/bots', { token: TOKEN, body: { ...base, handle: 'gone', avatar: missing } })).status).toBe(400);
    const bot = await req('POST', '/api/bots', { token: TOKEN, body: { ...base, handle: 'pic', description: 'x', avatar: json.ref } });
    expect(bot.status).toBe(200);
    expect(bot.json.avatar).toBe(json.ref);
    expect((await req('PATCH', '/api/bots/' + bot.json.id, { token: TOKEN, body: { avatar: missing } })).status).toBe(400);
    expect((await req('PUT', '/api/settings', { token: TOKEN, body: { userAvatar: missing } })).status).toBe(400);
    const set = await req('PUT', '/api/settings', { token: TOKEN, body: { userAvatar: json.ref } });
    expect(set.json.userAvatar).toBe(json.ref);
    expect((await req('PUT', '/api/settings', { token: TOKEN, body: { userAvatar: '' } })).json.userAvatar).toBe('');
    await req('DELETE', '/api/bots/' + bot.json.id, { token: TOKEN });
  });

  it('a paired device cannot set any avatar', async () => {
    const device = await pair();
    const { json } = await upload(PNG);
    expect((await req('PUT', '/api/settings', { token: device, body: { userAvatar: json.ref } })).status).toBe(403);
    expect((await req('POST', '/api/bots', { token: device, body: { ...base, handle: 'nope', avatar: json.ref } })).status).toBe(403);
    expect((await req('PATCH', '/api/rooms/x', { token: device, body: { avatar: json.ref } })).status).toBe(403);
  });
});

describe('cleanup', () => {
  function store() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-media-gc-'));
    let t = Date.now();
    const s = new MediaStore(d, () => t);
    return { d, s, advance: (ms: number) => { t += ms; }, age: (name: string) => fs.utimesSync(path.join(d, name), new Date(t - MEDIA_GRACE_MS - 1000), new Date(t - MEDIA_GRACE_MS - 1000)) };
  }

  it('removes what nothing refers to once past the grace period, and only that', () => {
    const { d, s, age } = store();
    const kept = mediaHash(s.put(PNG));
    const orphan = mediaHash(s.put(JPEG));
    const fresh = mediaHash(s.put(WEBP));
    age(kept); age(orphan);
    expect(s.sweep(new Set([kept]))).toBe(1);
    expect(fs.readdirSync(d).sort()).toEqual([kept, fresh].sort());
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('uploading the same bytes again restarts the grace period', () => {
    const { d, s, age } = store();
    const h = mediaHash(s.put(PNG));
    age(h);
    s.put(PNG);
    expect(s.sweep(new Set())).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('collects leftovers from a crash, and does not mind a missing folder', () => {
    const { d, s } = store();
    const tmp = path.join(d, 'a'.repeat(64) + '.tmp');
    fs.writeFileSync(tmp, 'x');
    fs.utimesSync(tmp, new Date(0), new Date(0));
    expect(s.sweep(new Set())).toBe(1);
    fs.rmSync(d, { recursive: true, force: true });
    expect(s.sweep(new Set())).toBe(0);
  });

  it('counts bots, groups and the owner as references; a deleted bot or group stops counting', async () => {
    const a = await upload(Buffer.concat([PNG, Buffer.from('bot')]));
    const b = await upload(Buffer.concat([PNG, Buffer.from('room')]));
    const c = await upload(Buffer.concat([PNG, Buffer.from('me')]));
    const bot = (await req('POST', '/api/bots', { token: TOKEN, body: { name: 'G', handle: 'gcbot', description: 'x', avatar: a.json.ref } })).json;
    const room = (await req('POST', '/api/rooms', { token: TOKEN, body: { kind: 'group', name: 'g', memberIds: [bot.id], avatar: b.json.ref } })).json;
    await req('PUT', '/api/settings', { token: TOKEN, body: { userAvatar: c.json.ref } });
    const refs = () => referencedMedia(hub.repos, hub.settings.get());
    for (const x of [a, b, c]) expect(refs().has(mediaHash(x.json.ref))).toBe(true);
    await req('DELETE', '/api/rooms/' + room.id, { token: TOKEN });
    await req('DELETE', '/api/bots/' + bot.id, { token: TOKEN });
    await req('PUT', '/api/settings', { token: TOKEN, body: { userAvatar: '' } });
    for (const x of [a, b, c]) expect(refs().has(mediaHash(x.json.ref))).toBe(false);
  });

  it('a hub sweeps its folder when it starts', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-media-start-'));
    const h = mediaHash(new MediaStore(d).put(PNG));
    fs.utimesSync(path.join(d, h), new Date(0), new Date(0));
    const started = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, mediaDir: d });
    await started.listen();
    await started.shutdown();
    expect(fs.existsSync(path.join(d, h))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('put rejects with a typed error', () => {
    const { d, s } = store();
    expect(() => s.put(SVG)).toThrow(MediaRejected);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
