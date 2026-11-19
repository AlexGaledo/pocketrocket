import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MAX_FILE_BYTES, isFileRef } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { MEDIA_GRACE_MS, MediaRejected, MediaStore, cleanFileName, referencedMedia, sniffVideoType } from '../services/MediaStore.js';
import { attachWs } from '../api/ws.js';
import { createMediaApi } from '../api/media.js';
import { copyNameFor, fileNote, materializeFiles } from '../agent/attachments.js';
import { checkContentType, setPrincipal } from '../api/guard.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import type { SettingsStore } from '../services/SettingsStore.js';
import { RoomRouter, formatMessage } from './RoomRouter.js';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-file-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const settle = () => new Promise((r) => setTimeout(r, 50));
async function* chunks(...bufs: Buffer[]) { for (const b of bufs) yield b; }

describe('MediaStore files', () => {
  it('stores a file by hash with a cleaned name, and reads it back', async () => {
    const media = new MediaStore(tmp());
    const meta = await media.putFile(chunks(Buffer.from('hello '), Buffer.from('world')), { name: '../../etc/notes.txt', declaredType: 'text/plain' });
    expect(isFileRef(meta.ref)).toBe(true);
    expect(meta).toMatchObject({ name: 'notes.txt', type: 'text/plain', size: 11, kind: 'file' });
    const hash = meta.ref.slice(5);
    const found = media.readFile(hash)!;
    expect(fs.readFileSync(found.path, 'utf8')).toBe('hello world');
    expect(media.fileMeta(hash)).toEqual(meta);
  });

  it('a video is a video only when its bytes say so', async () => {
    const media = new MediaStore(tmp());
    expect((await media.putFile(chunks(MP4), { name: 'clip.mp4', declaredType: 'video/mp4' })).kind).toBe('video');
    const fake = await media.putFile(chunks(Buffer.from('not a video at all')), { name: 'x.mp4', declaredType: 'video/mp4' });
    expect(fake).toMatchObject({ kind: 'file', type: 'application/octet-stream' });
  });

  it('refuses a file over 25 MB unless it is a real video, and leaves nothing behind', async () => {
    const dir = tmp();
    const media = new MediaStore(dir);
    const big = Buffer.alloc(MAX_FILE_BYTES + 1);
    await expect(media.putFile(chunks(big), { name: 'a.bin' })).rejects.toBeInstanceOf(MediaRejected);
    // Declared a video to get the bigger cap, but the bytes are not one.
    await expect(media.putFile(chunks(big), { name: 'a.mp4', declaredType: 'video/mp4' })).rejects.toThrow(/25 MB/);
    expect(fs.readdirSync(path.join(dir, 'files'))).toEqual([]);
    const video = await media.putFile(chunks(MP4, big), { name: 'long.mp4', declaredType: 'video/mp4' });
    expect(video.kind).toBe('video');
  });

  it('refuses an empty file', async () => {
    await expect(new MediaStore(tmp()).putFile(chunks(), { name: 'e.txt' })).rejects.toThrow(/empty/);
  });

  it('sweeps unreferenced files after the grace period, keeping referenced ones', async () => {
    let now = Date.now();
    const media = new MediaStore(tmp(), () => now);
    const kept = await media.putFile(chunks(Buffer.from('keep')), { name: 'k.txt' });
    const gone = await media.putFile(chunks(Buffer.from('drop')), { name: 'd.txt' });
    const old = new Date(Date.now() - MEDIA_GRACE_MS - 1000);
    for (const m of [kept, gone]) for (const f of [m.ref.slice(5), m.ref.slice(5) + '.json']) fs.utimesSync(path.join((media as any).dir, 'files', f), old, old);
    const referenced = referencedMedia({ listBots: () => [], listRooms: () => [], attachmentRefs: () => [kept.ref] }, { userAvatar: '' });
    media.sweep(referenced);
    media.sweep(referenced);
    expect(media.fileMeta(kept.ref.slice(5))).not.toBeNull();
    expect(media.fileMeta(gone.ref.slice(5))).toBeNull();
    expect(fs.readdirSync(path.join((media as any).dir, 'files')).sort()).toEqual([kept.ref.slice(5), kept.ref.slice(5) + '.json'].sort());
  });
});

describe('helpers', () => {
  it('cleans names', () => {
    expect(cleanFileName('C:\\Users\\x\\report<1>.pdf')).toBe('report1.pdf');
    expect(cleanFileName('...')).toBe('file');
    expect(cleanFileName('a'.repeat(300) + '.pdf').length).toBe(120);
  });
  it('sniffs video', () => {
    expect(sniffVideoType(MP4)).toBe('video/mp4');
    expect(sniffVideoType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]))).toBe('video/webm');
    expect(sniffVideoType(Buffer.from('plain text here!'))).toBeNull();
  });
  it('copy names keep the extension and lose anything path-like', () => {
    expect(copyNameFor('a'.repeat(64), '../my report.pdf')).toBe('aaaaaaaaaaaa-my_report.pdf');
  });
  it('the content-type guard lets raw bytes through to /api/files only', () => {
    const req = (p: string) => ({ method: 'POST', headers: { 'content-type': 'application/octet-stream' } }) as never;
    expect(checkContentType(req('x'), new URL('http://h/api/files')).ok).toBe(true);
    expect(checkContentType(req('x'), new URL('http://h/api/bots')).ok).toBe(false);
  });
});

describe('a turn gets the files', () => {
  it('copies each file into the bot folder and names it in the note', async () => {
    const media = new MediaStore(tmp());
    const root = tmp();
    const doc = await media.putFile(chunks(Buffer.from('%PDF-1.7 fake')), { name: 'plan.pdf', declaredType: 'application/pdf' });
    const vid = await media.putFile(chunks(MP4), { name: 'demo.mp4', declaredType: 'video/mp4' });
    const files = materializeFiles(media, root, 'bot1', ['img:' + 'f'.repeat(64), doc.ref, vid.ref]);
    expect(files.map((f) => f.name)).toEqual(['plan.pdf', 'demo.mp4']);
    expect(fs.readFileSync(files[0].path, 'utf8')).toBe('%PDF-1.7 fake');
    expect(path.dirname(files[0].path)).toBe(path.join(root, 'bot1'));
    // Same file again reuses the copy.
    expect(materializeFiles(media, root, 'bot1', [doc.ref])[0].path).toBe(files[0].path);
    const withFf = fileNote(files, true);
    expect(withFf).toContain(files[0].path);
    expect(withFf).toContain('ffmpeg');
    expect(withFf).toContain('untrusted data');
    expect(fileNote(files, false)).toContain('ffmpeg is not installed');
    expect(fileNote([files[0]], true)).not.toContain('ffmpeg');
  });

  it('refuses a link planted at the copy name', async () => {
    const media = new MediaStore(tmp());
    const root = tmp();
    const doc = await media.putFile(chunks(Buffer.from('secret-free')), { name: 'a.txt' });
    fs.mkdirSync(path.join(root, 'bot1'));
    const target = path.join(tmp(), 'elsewhere.txt');
    fs.writeFileSync(target, 'x');
    try {
      fs.symlinkSync(target, path.join(root, 'bot1', copyNameFor(doc.ref.slice(5), 'a.txt')));
    } catch {
      return; // no symlink rights (Windows without developer mode): nothing to test
    }
    expect(materializeFiles(media, root, 'bot1', [doc.ref])).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});

function wired() {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const bot = repos.createBot({ name: 'ann', handle: 'ann', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
  const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [bot.id], coordinatorBotId: null });
  const reqs: TurnRequest[] = [];
  router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
  const media = new MediaStore(tmp());
  const wss = attachWs({} as never, { media, repos, router, broker: {} as PermissionBroker, settings: { get: () => ({}) } as unknown as SettingsStore });
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, sent: [] as any[], send(d: string) { this.sent.push(JSON.parse(d)); }, ping() {}, terminate() {}, close() {} });
  wss.emit('connection', ws);
  return { repos, room, reqs, media, ws, send: (e: unknown) => ws.emit('message', JSON.stringify(e)) };
}

describe('message.send with files', () => {
  it('accepts a file ref, and the transcript line counts it', async () => {
    const s = wired();
    const doc = await s.media.putFile(chunks(Buffer.from('notes')), { name: 'n.txt' });
    s.send({ type: 'message.send', roomId: s.room.id, text: 'see attached', attachments: [doc.ref] });
    await settle();
    const msg = s.repos.listMessages(s.room.id).find((m) => m.authorType === 'user')!;
    expect(msg.attachments).toEqual([doc.ref]);
    expect(formatMessage(s.repos, msg)).toContain('[1 file attached]');
    expect(s.reqs[0]?.images).toEqual([doc.ref]);
  });

  it('refuses an unknown file ref', () => {
    const s = wired();
    s.send({ type: 'message.send', roomId: s.room.id, text: 'x', clientMsgId: 'c1', attachments: ['file:' + 'a'.repeat(64)] });
    expect(s.ws.sent.at(-1)).toMatchObject({ type: 'error', context: 'c1' });
  });
});

describe('/api/files', () => {
  async function serve(principal: 'hub' | 'device' = 'hub') {
    const media = new MediaStore(tmp());
    const api = createMediaApi({ media });
    const server = http.createServer(async (req, res) => {
      setPrincipal(req, { kind: principal } as never);
      if (!(await api(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    return { media, base, close: () => new Promise((r) => server.close(r)) };
  }

  it('uploads raw bytes, then serves the meta and a download', async () => {
    const s = await serve();
    try {
      const r = await fetch(s.base + '/api/files', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('My notes.md'), 'x-file-type': 'text/markdown' }, body: '# hi' });
      expect(r.status).toBe(200);
      const meta = await r.json();
      expect(meta).toMatchObject({ name: 'My notes.md', size: 4, kind: 'file' });
      const hash = meta.ref.slice(5);
      expect(await (await fetch(s.base + '/api/files/' + hash + '/meta')).json()).toEqual(meta);
      const dl = await fetch(s.base + '/api/files/' + hash);
      expect(dl.headers.get('content-type')).toBe('application/octet-stream');
      expect(dl.headers.get('content-disposition')).toContain('attachment');
      expect(await dl.text()).toBe('# hi');
      expect((await fetch(s.base + '/api/files/' + 'b'.repeat(64))).status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
