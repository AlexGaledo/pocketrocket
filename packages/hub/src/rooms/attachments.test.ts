import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, ClientEventSchema } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { MediaStore, referencedMedia } from '../services/MediaStore.js';
import { attachWs } from '../api/ws.js';
import { imageNote, materializeImages } from '../agent/attachments.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import type { SettingsStore } from '../services/SettingsStore.js';
import { RoomRouter } from './RoomRouter.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-att-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const settle = () => new Promise((r) => setTimeout(r, 50));

function fakeSocket(): any {
  return Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, sent: [] as any[], send(d: string) { this.sent.push(JSON.parse(d)); }, ping() {}, terminate() {}, close() {} });
}
function setup() {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const bot = repos.createBot({ name: 'ann', handle: 'ann', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
  const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [bot.id], coordinatorBotId: null });
  const reqs: TurnRequest[] = [];
  router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
  const media = new MediaStore(tmp());
  return { repos, router, room, reqs, media };
}
function wire(withMedia = true) {
  const s = setup();
  const wss = attachWs({} as never, { ...(withMedia ? { media: s.media } : {}), repos: s.repos, router: s.router, broker: {} as PermissionBroker, settings: { get: () => ({}) } as unknown as SettingsStore });
  const ws = fakeSocket();
  wss.clients.add(ws as never);
  wss.emit('connection', ws);
  const send = (e: unknown) => ws.emit('message', JSON.stringify(e));
  const userMsgs = () => s.repos.listMessages(s.room.id, { limit: 50 }).filter((m) => m.authorType === 'user');
  const errorOf = () => ws.sent.find((e: any) => e.type === 'error');
  return { ...s, wss, ws, send, userMsgs, errorOf };
}

describe('message.send with attachments (U2a)', () => {
  it('stores the refs on the message and the turn gets them', async () => {
    const { media, send, userMsgs, room, reqs, wss } = wire();
    const a = media.put(PNG, MAX_ATTACHMENT_BYTES);
    const b = media.put(JPEG, MAX_ATTACHMENT_BYTES);
    send({ type: 'message.send', roomId: room.id, text: 'look', attachments: [a, b, a], clientMsgId: 'x1' });
    await settle();
    expect(userMsgs()[0].attachments).toEqual([a, b]);
    expect(reqs[0].images).toEqual([a, b]);
    expect(reqs[0].injected).toContain('[2 pictures attached]');
    wss.close();
  });

  it('allows a picture with no text', () => {
    const { media, send, userMsgs, room, wss } = wire();
    send({ type: 'message.send', roomId: room.id, text: '', attachments: [media.put(PNG)] });
    expect(userMsgs()).toHaveLength(1);
    wss.close();
  });

  it('still refuses an empty message', () => {
    expect(ClientEventSchema.safeParse({ type: 'message.send', roomId: 'r', text: '  ' }).success).toBe(false);
  });

  it('refuses the whole send for an unknown ref, naming the client id', () => {
    const { media, send, userMsgs, room, errorOf, wss } = wire();
    const good = media.put(PNG);
    send({ type: 'message.send', roomId: room.id, text: 'a', attachments: [good, 'img:' + 'a'.repeat(64)], clientMsgId: 'bad1' });
    expect(userMsgs()).toHaveLength(0);
    expect(errorOf()).toMatchObject({ context: 'bad1' });
    wss.close();
  });

  it('refuses a string that is not a media ref', () => {
    const { send, userMsgs, room, errorOf, wss } = wire();
    send({ type: 'message.send', roomId: room.id, text: 'a', attachments: ['../../etc/passwd'], clientMsgId: 'bad2' });
    expect(userMsgs()).toHaveLength(0);
    expect(errorOf()).toMatchObject({ context: 'bad2' });
    wss.close();
  });

  it('refuses a stored file that is no longer an allowed image', () => {
    const { media, send, userMsgs, room, errorOf, wss } = wire();
    const ref = media.put(PNG);
    fs.writeFileSync(path.join((media as any).dir, ref.slice(4)), 'GIF89a not an allowed type');
    send({ type: 'message.send', roomId: room.id, text: 'a', attachments: [ref], clientMsgId: 'bad3' });
    expect(userMsgs()).toHaveLength(0);
    expect(errorOf()).toMatchObject({ context: 'bad3' });
    wss.close();
  });

  it('refuses more than the cap', () => {
    const { media, send, userMsgs, room, errorOf, wss } = wire();
    const refs = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => media.put(Buffer.concat([PNG, Buffer.from([i])])));
    send({ type: 'message.send', roomId: room.id, text: 'a', attachments: refs, clientMsgId: 'bad4' });
    expect(userMsgs()).toHaveLength(0);
    expect(errorOf()).toMatchObject({ context: 'bad4' });
    wss.close();
  });

  it('a replay with the same clientMsgId posts and runs once', async () => {
    const { media, send, userMsgs, room, reqs, wss } = wire();
    const ref = media.put(PNG);
    for (let i = 0; i < 3; i++) send({ type: 'message.send', roomId: room.id, text: 'a', attachments: [ref], clientMsgId: 'same' });
    await settle();
    expect(userMsgs()).toHaveLength(1);
    expect(reqs).toHaveLength(1);
    wss.close();
  });

  it('works in a group room too', async () => {
    const { media, repos, router, reqs } = setup();
    const b1 = repos.createBot({ name: 'b1', handle: 'bb1', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
    const b2 = repos.createBot({ name: 'b2', handle: 'bb2', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [b1.id, b2.id], coordinatorBotId: b1.id });
    const ref = media.put(PNG);
    router.onUserMessage(room.id, 'hi', 'g1', [ref]);
    await settle();
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs[0].images).toEqual([ref]);
  });

  it('a hub without a media store refuses pictures', () => {
    const { send, room, errorOf, userMsgs, wss } = wire(false);
    send({ type: 'message.send', roomId: room.id, text: 'a', attachments: ['img:' + 'b'.repeat(64)], clientMsgId: 'n' });
    expect(errorOf()).toMatchObject({ context: 'n' });
    expect(userMsgs()).toHaveLength(0);
    wss.close();
  });
});

describe('attachments stay stored', () => {
  it('the media sweep keeps pictures that a message refers to', () => {
    const { repos, router, room, media } = setup();
    const ref = media.put(PNG);
    const orphan = media.put(JPEG);
    router.onUserMessage(room.id, 'x', 'k', [ref]);
    const kept = referencedMedia(repos, { userAvatar: '' });
    expect(kept.has(ref.slice(4))).toBe(true);
    expect(kept.has(orphan.slice(4))).toBe(false);
  });
});

describe('model input', () => {
  const BOT = 'bot-1';
  it('saves pictures under the hub-owned folder by hash and names them in the input note', () => {
    const { media } = setup();
    const root = tmp();
    const ref = media.put(PNG);
    const images = materializeImages(media, root, BOT, [ref, 'img:' + 'c'.repeat(64), '../x']);
    expect(images).toHaveLength(1);
    expect(images[0].path).toBe(path.join(fs.realpathSync(root), BOT, ref.slice(4) + '.png'));
    expect(fs.readFileSync(images[0].path)).toEqual(PNG);
    expect(images[0].mediaType).toBe('image/png');
    const note = imageNote(images);
    expect(note).toContain(images[0].path);
    expect(note).toContain('untrusted data');
    expect(note).not.toContain(PNG.toString('base64'));
    expect(imageNote([])).toBe('');
  });

  it('refuses a bot id that is not a plain id', () => {
    const { media } = setup();
    expect(materializeImages(media, tmp(), '../escape', [media.put(PNG)])).toEqual([]);
  });

  it('refuses a folder that is a link, and writes nothing through it', () => {
    const { media } = setup();
    const root = tmp();
    const target = tmp();
    fs.symlinkSync(target, path.join(root, BOT), 'junction');
    expect(materializeImages(media, root, BOT, [media.put(PNG)])).toEqual([]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('checks the folder again before every file: a swap after the first write stops the second', () => {
    const { media } = setup();
    const root = tmp();
    const target = tmp();
    const a = media.put(PNG);
    const b = media.put(JPEG);
    const dir = path.join(root, BOT);
    const images = materializeImages(media, root, BOT, [a, b], (n) => {
      if (n !== 0) return;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.symlinkSync(target, dir, 'junction');
    });
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe('image/png');
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('refuses a link planted at the file name, and a plain file of the wrong size', () => {
    const { media } = setup();
    const root = tmp();
    const outside = path.join(tmp(), 'victim.txt');
    fs.writeFileSync(outside, 'keep');
    const ref = media.put(PNG);
    fs.mkdirSync(path.join(root, BOT));
    const name = path.join(root, BOT, ref.slice(4) + '.png');
    try { fs.symlinkSync(outside, name, 'file'); } catch { fs.writeFileSync(name, 'x'); }
    expect(materializeImages(media, root, BOT, [ref])).toEqual([]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('reuses a file it already saved', () => {
    const { media } = setup();
    const root = tmp();
    const ref = media.put(PNG);
    expect(materializeImages(media, root, BOT, [ref])).toHaveLength(1);
    expect(materializeImages(media, root, BOT, [ref])).toHaveLength(1);
  });

  it('does nothing without a store or refs', () => {
    expect(materializeImages(undefined, tmp(), BOT, ['img:' + 'a'.repeat(64)])).toEqual([]);
    expect(materializeImages(new MediaStore(tmp()), tmp(), BOT, undefined)).toEqual([]);
  });
});
