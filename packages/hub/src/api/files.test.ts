import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MAX_FILE_LIST_ENTRIES, folderUploadSkip, type FileListing, type ServerEvent } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { deviceMayAccess } from './guard.js';
import { listFolder, windowsNameProblem } from './files.js';
import { events } from '../events.js';
import { listAudit } from '../services/AuditLog.js';

const TOKEN = 'files-test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-files-'));
const projectsDir = path.join(tmp, 'projects');
const roomsDir = path.join(tmp, 'rooms');
const botsDir = path.join(tmp, 'bots');
const outside = path.join(tmp, 'outside');

let hub: Hub;
let port: number;
beforeAll(async () => {
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir, roomsDir,
    dmFilesDir: (botId) => path.join(botsDir, botId, 'files'),
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json', ...opts.headers };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  return new Promise<{ status: number; json: any; raw: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json: unknown = null;
        try { json = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

let n = 0;
function groupRoom() {
  const bot = hub.repos.createBot({ name: 'b' + n, handle: 'files-bot-' + n++, title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
  return { bot, room: hub.repos.createRoom({ kind: 'group', name: 'G', memberIds: [bot.id], coordinatorBotId: null }) };
}
const base = (roomId: string) => '/api/rooms/' + roomId + '/files';
const upload = (roomId: string, name: string, text: string, dir = '', overwrite?: boolean) =>
  request('POST', base(roomId) + '/upload', { body: { path: dir, name, dataBase64: Buffer.from(text).toString('base64'), overwrite } });

describe('/api/rooms/:id/files', () => {
  it('is for the owner: no token is 401, and a paired phone can reach none of it', async () => {
    const { room } = groupRoom();
    expect((await request('GET', base(room.id), { token: null })).status).toBe(401);
    for (const [m, p] of [
      ['GET', base(room.id)], ['GET', base(room.id) + '/raw'], ['POST', base(room.id) + '/upload'],
      ['POST', base(room.id) + '/folder'], ['PATCH', base(room.id)], ['DELETE', base(room.id)],
    ] as const) expect(deviceMayAccess(m, p)).toBe(false);
  });

  it('404s an unknown room, and makes a group room its own folder the first time', async () => {
    expect((await request('GET', base('nope'))).status).toBe(404);
    const { room } = groupRoom();
    expect(fs.existsSync(path.join(roomsDir, room.id))).toBe(false);
    const r = await request('GET', base(room.id));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ roomId: room.id, folder: 'room', projectSlug: null, path: '', entries: [], truncated: false });
    expect(fs.statSync(path.join(roomsDir, room.id)).isDirectory()).toBe(true);
  });

  it('uses the project folder for a project room and the bot\'s files/ folder for a direct chat', async () => {
    const made = await request('POST', '/api/projects', { body: { name: 'Files Proj' } });
    expect(made.status).toBe(200);
    const { room } = groupRoom();
    hub.repos.db.run('UPDATE projects SET room_id=? WHERE slug=?', room.id, 'files-proj');
    const proj = await request('GET', base(room.id));
    expect(proj.json).toMatchObject({ folder: 'project', projectSlug: 'files-proj' });
    expect(proj.json.entries.map((e: { name: string }) => e.name)).toContain('current.md');

    const { bot } = groupRoom();
    const dm = hub.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    expect((await request('GET', base(dm.id))).json.folder).toBe('dm');
    await upload(dm.id, 'note.txt', 'hi');
    expect(fs.readFileSync(path.join(botsDir, bot.id, 'files', 'note.txt'), 'utf8')).toBe('hi');
  });

  it('lists folders first, then files in natural order, and hides .git', async () => {
    const { room } = groupRoom();
    const dir = path.join(roomsDir, room.id);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'zeta'));
    fs.mkdirSync(path.join(dir, 'Alpha'));
    for (const f of ['file10.txt', 'file2.txt', 'B.md']) fs.writeFileSync(path.join(dir, f), 'x');
    const r = await request('GET', base(room.id));
    const list = r.json as FileListing;
    expect(list.entries.map((e) => e.name)).toEqual(['Alpha', 'zeta', 'B.md', 'file2.txt', 'file10.txt']);
    expect(list.entries[0]).toMatchObject({ kind: 'dir', size: 0, ext: '' });
    expect(list.entries[2]).toMatchObject({ kind: 'file', size: 1, ext: 'md' });
    expect(typeof list.entries[2].mtime).toBe('number');
  });

  it('caps a listing and says so, keeping folders first', () => {
    const dir = path.join(tmp, 'capped');
    fs.mkdirSync(path.join(dir, 'zz-folder'), { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'f' + i), '');
    const full = listFolder(dir, dir, '', 'r', 'room', null);
    expect(MAX_FILE_LIST_ENTRIES).toBe(2000);
    expect(full.truncated).toBe(false);
    const capped = listFolder(dir, dir, '', 'r', 'room', null, 3);
    expect(capped.entries.map((e) => e.name)).toEqual(['zz-folder', 'f0', 'f1']);
    expect(capped.truncated).toBe(true);
  });

  it('round-trips an upload, with headers that keep a preview from running anything', async () => {
    const { room } = groupRoom();
    const seen: ServerEvent[] = [];
    const off = events.onEvent((e) => { if (e.type === 'files.changed') seen.push(e); });
    await request('POST', base(room.id) + '/folder', { body: { name: 'docs' } });
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const up = await request('POST', base(room.id) + '/upload', { body: { path: 'docs', name: 'blob.bin', dataBase64: bytes.toString('base64') } });
    off();
    expect(up.status).toBe(200);
    expect(up.json).toEqual({ ok: true, path: 'docs/blob.bin' });
    expect(seen).toContainEqual({ type: 'files.changed', roomId: room.id, path: 'docs' });

    const raw = await request('GET', base(room.id) + '/raw?path=docs/blob.bin');
    expect(raw.status).toBe(200);
    expect(raw.raw.equals(bytes)).toBe(true);
    expect(raw.headers['content-type']).toBe('application/octet-stream');
    expect(raw.headers['x-content-type-options']).toBe('nosniff');
    expect(raw.headers['content-security-policy']).toContain('sandbox');
    expect(raw.headers['content-disposition']).toMatch(/^inline;/);
    const again = await request('GET', base(room.id) + '/raw?path=docs/blob.bin', { headers: { 'if-none-match': String(raw.headers.etag) } });
    expect(again.status).toBe(304);
    const dl = await request('GET', base(room.id) + '/raw?path=docs/blob.bin&download=1');
    expect(dl.headers['content-disposition']).toMatch(/^attachment;.*blob\.bin/);

    await upload(room.id, 'page.html', '<script>alert(1)</script>');
    expect((await request('GET', base(room.id) + '/raw?path=page.html')).headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(listAudit(hub.repos.db).some((a) => a.action === 'files.uploaded' && a.target === room.id)).toBe(true);
  });

  it('refuses to overwrite unless asked, and refuses bad names', async () => {
    const { room } = groupRoom();
    expect((await upload(room.id, 'a.txt', 'one')).status).toBe(200);
    expect((await upload(room.id, 'a.txt', 'two')).status).toBe(409);
    expect((await upload(room.id, 'a.txt', 'two', '', true)).status).toBe(200);
    expect((await request('GET', base(room.id) + '/raw?path=a.txt')).raw.toString()).toBe('two');
    for (const name of ['..', '.', 'a/b', 'a\\b', 'nul\u0000x', '', ' lead', 'trail.']) {
      expect((await upload(room.id, name, 'x')).status).toBe(400);
    }
    expect((await request('POST', base(room.id) + '/upload', { body: { name: 'x', dataBase64: '***' } })).status).toBe(400);
  });

  it('makes folders, and renames and moves files', async () => {
    const { room } = groupRoom();
    expect((await request('POST', base(room.id) + '/folder', { body: { name: 'one' } })).status).toBe(200);
    expect((await request('POST', base(room.id) + '/folder', { body: { name: 'one' } })).status).toBe(409);
    expect((await request('POST', base(room.id) + '/folder', { body: { path: 'one', name: 'two' } })).json.path).toBe('one/two');
    await upload(room.id, 'a.txt', 'hello');
    expect((await request('PATCH', base(room.id), { body: { from: 'a.txt', to: 'b.txt' } })).json).toEqual({ ok: true, path: 'b.txt' });
    expect((await request('PATCH', base(room.id), { body: { from: 'b.txt', to: 'one/two/b.txt' } })).status).toBe(200);
    expect((await request('GET', base(room.id) + '/raw?path=one/two/b.txt')).raw.toString()).toBe('hello');
    await upload(room.id, 'c.txt', 'c');
    expect((await request('PATCH', base(room.id), { body: { from: 'c.txt', to: 'one/two/b.txt' } })).status).toBe(409);
    expect((await request('PATCH', base(room.id), { body: { from: 'one', to: 'one/two/inside' } })).status).toBe(400);
    expect((await request('PATCH', base(room.id), { body: { from: 'missing', to: 'x' } })).status).toBe(404);
    expect((await request('PATCH', base(room.id), { body: { from: 'c.txt', to: 'nofolder/c.txt' } })).status).toBe(404);
    // A change of case only.
    expect((await request('PATCH', base(room.id), { body: { from: 'c.txt', to: 'C.txt' } })).status).toBe(200);
    expect((await request('GET', base(room.id))).json.entries.map((e: { name: string }) => e.name)).toContain('C.txt');
  });

  it('deletes files, and folders with something in them only when told to', async () => {
    const { room } = groupRoom();
    await request('POST', base(room.id) + '/folder', { body: { name: 'full' } });
    await upload(room.id, 'x.txt', 'x', 'full');
    await request('POST', base(room.id) + '/folder', { body: { name: 'empty' } });
    expect((await request('DELETE', base(room.id) + '?path=full')).status).toBe(409);
    expect((await request('DELETE', base(room.id) + '?path=empty')).status).toBe(200);
    expect((await request('DELETE', base(room.id) + '?path=full/x.txt')).status).toBe(200);
    await upload(room.id, 'y.txt', 'y', 'full');
    expect((await request('DELETE', base(room.id) + '?path=full&recursive=true')).status).toBe(200);
    expect(fs.existsSync(path.join(roomsDir, room.id, 'full'))).toBe(false);
    expect((await request('DELETE', base(room.id) + '?path=gone')).status).toBe(404);
  });

  it('never lets the room\'s folder itself be renamed or deleted', async () => {
    const { room } = groupRoom();
    await upload(room.id, 'keep.txt', 'k');
    for (const p of ['', '.', './', '/']) {
      expect((await request('DELETE', base(room.id) + '?path=' + encodeURIComponent(p) + '&recursive=true')).status).toBe(400);
    }
    expect((await request('PATCH', base(room.id), { body: { from: '.', to: 'moved' } })).status).toBe(400);
    expect(fs.existsSync(path.join(roomsDir, room.id, 'keep.txt'))).toBe(true);
  });

  it('refuses paths that climb out, absolute paths, and another room\'s folder', async () => {
    const { room } = groupRoom();
    const other = groupRoom().room;
    await upload(other.id, 'theirs.txt', 'theirs');
    const abs = path.join(outside, 'secret.txt');
    for (const p of ['../' + other.id + '/theirs.txt', '..\\' + other.id + '\\theirs.txt', 'a/../../x', abs, abs.replaceAll('\\', '/'), '/etc/passwd', 'C:/Windows/win.ini']) {
      const q = encodeURIComponent(p);
      expect((await request('GET', base(room.id) + '/raw?path=' + q)).status).toBe(400);
      expect((await request('GET', base(room.id) + '?path=' + q)).status).toBe(400);
      expect((await request('DELETE', base(room.id) + '?path=' + q)).status).toBe(400);
      expect((await request('POST', base(room.id) + '/upload', { body: { path: p, name: 'x.txt', dataBase64: '' } })).status).toBe(400);
      expect((await request('PATCH', base(room.id), { body: { from: p, to: 'stolen.txt' } })).status).toBe(400);
    }
    expect(fs.existsSync(path.join(roomsDir, other.id, 'theirs.txt'))).toBe(true);
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true);
  });

  it('places an absolute server path from a bot\'s link inside the folder, and nothing outside it', async () => {
    const { room } = groupRoom();
    await upload(room.id, 'report.html', '<p>hi</p>');
    const where = (p: string) => request('GET', base(room.id) + '/where?path=' + encodeURIComponent(p));
    const inside = await where(path.join(roomsDir, room.id, 'report.html'));
    expect(inside.status).toBe(200);
    expect(inside.json).toEqual({ path: 'report.html', kind: 'file' });
    expect((await where(path.join(roomsDir, room.id))).json).toEqual({ path: '', kind: 'dir' });
    expect((await where(path.join(roomsDir, room.id, 'gone.html'))).status).toBe(404);
    expect((await where(path.join(outside, 'secret.txt'))).status).toBe(404);
    expect((await where(path.join(roomsDir, room.id, '..', 'x'))).status).toBe(404);
    expect((await where('report.html')).status).toBe(400);
  });

  it('opens a file in the server browser only when it is a file in the folder and a bot here has a browser', async () => {
    const { room } = groupRoom();
    await upload(room.id, 'page.html', '<p>hi</p>');
    const browse = (p: string) => request('POST', base(room.id) + '/browse', { body: { path: p } });
    expect((await browse('../x.html')).status).toBe(400);
    expect((await browse('missing.html')).status).toBe(404);
    expect((await browse('')).status).toBe(400);
    // The room's only bot has no Browser: refused, or (without per-bot computers) no screen running here.
    expect([409, 503]).toContain((await browse('page.html')).status);
  });

  it('refuses a link inside the folder that leads out of it, for reading and writing', async () => {
    const { room } = groupRoom();
    const dir = path.join(roomsDir, room.id);
    fs.mkdirSync(dir, { recursive: true });
    // A junction needs no admin rights on Windows; elsewhere it is a plain directory symlink.
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction');
    expect((await request('GET', base(room.id) + '?path=escape')).status).toBe(400);
    expect((await request('GET', base(room.id) + '/raw?path=escape/secret.txt')).status).toBe(400);
    expect((await upload(room.id, 'planted.txt', 'x', 'escape')).status).toBe(400);
    expect((await request('DELETE', base(room.id) + '?path=escape/secret.txt')).status).toBe(400);
    expect((await request('PATCH', base(room.id), { body: { from: 'escape/secret.txt', to: 'got.txt' } })).status).toBe(400);
    expect((await request('GET', base(room.id))).json.entries.map((e: { name: string }) => e.name)).not.toContain('escape');
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true);
  });

  describe('folder uploads (parents)', () => {
    const nested = (roomId: string, dir: string, name: string, text: string, extra: Record<string, unknown> = {}) =>
      request('POST', base(roomId) + '/upload', { body: { path: dir, name, dataBase64: Buffer.from(text).toString('base64'), parents: true, ...extra } });

    it('makes the missing folders on the way, and tells each new folder\'s parent', async () => {
      const { room } = groupRoom();
      const seen: string[] = [];
      const off = events.onEvent((e) => { if (e.type === 'files.changed' && e.roomId === room.id) seen.push(e.path); });
      const r = await nested(room.id, 'proj/src/lib', 'a.ts', 'export {}');
      off();
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true, path: 'proj/src/lib/a.ts' });
      expect(fs.readFileSync(path.join(roomsDir, room.id, 'proj', 'src', 'lib', 'a.ts'), 'utf8')).toBe('export {}');
      expect(new Set(seen)).toEqual(new Set(['', 'proj', 'proj/src', 'proj/src/lib']));
      // Again into folders that are there now, and with the same name: 409 unless overwrite.
      expect((await nested(room.id, 'proj/src', 'b.ts', 'b')).status).toBe(200);
      expect((await nested(room.id, 'proj/src/lib', 'a.ts', 'again')).status).toBe(409);
      expect((await nested(room.id, 'proj/src/lib', 'a.ts', 'again', { overwrite: true })).status).toBe(200);
      expect(fs.readFileSync(path.join(roomsDir, room.id, 'proj', 'src', 'lib', 'a.ts'), 'utf8')).toBe('again');
      // Without parents a missing folder is still a 404.
      expect((await upload(room.id, 'c.ts', 'c', 'proj/missing')).status).toBe(404);
    });

    it('makes empty folders like mkdir -p, and a folder already there is fine', async () => {
      const { room } = groupRoom();
      const mk = (p: string, name: string) => request('POST', base(room.id) + '/folder', { body: { path: p, name, parents: true } });
      expect((await mk('a/b', 'empty')).json).toEqual({ ok: true, path: 'a/b/empty' });
      expect(fs.statSync(path.join(roomsDir, room.id, 'a', 'b', 'empty')).isDirectory()).toBe(true);
      expect((await mk('a/b', 'empty')).status).toBe(200);
      expect((await request('POST', base(room.id) + '/folder', { body: { path: 'a/b', name: 'empty' } })).status).toBe(409);
      await upload(room.id, 'file.txt', 'x', 'a');
      expect((await mk('a', 'file.txt')).status).toBe(409);
      expect((await mk('a/file.txt', 'under')).status).toBe(409);
      expect((await nested(room.id, 'a/file.txt/deeper', 'x.txt', 'x')).status).toBe(409);
    });

    it('refuses every way out of the folder, and bad folder names, making nothing', async () => {
      const { room } = groupRoom();
      const dir = path.join(roomsDir, room.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction');
      const abs = path.join(outside, 'deep');
      const bad = [
        '..', '../x', 'a/../../x', 'a/..', '..\\x', 'a\\..\\..\\x', // climbing out, either separator
        abs, abs.replaceAll('\\', '/'), '/etc/x', '\\\\server\\share\\x', '//server/share/x', // absolute and UNC
        'C:/x', 'C:x', 'c:\\x', // drive letters
        'a\u0000b/x', 'ok/nul\u0000/x', // NUL
        'escape/x', 'escape/a/b', // through a link that leads out
        'ok/ lead', 'ok/trail.', 'ok/trail ', 'a/' + 'x'.repeat(256) + '/y', 'ok/tab\there', // names a file couldn't have
      ];
      for (const p of bad) {
        expect((await nested(room.id, p, 'x.txt', 'x')).status, 'upload into ' + JSON.stringify(p)).toBe(400);
        expect((await request('POST', base(room.id) + '/folder', { body: { path: p, name: 'x', parents: true } })).status, 'folder in ' + JSON.stringify(p)).toBe(400);
      }
      for (const name of ['..', '.', 'a/b', 'a\\b', 'nul\u0000x', '', ' lead', 'trail.']) {
        expect((await request('POST', base(room.id) + '/folder', { body: { path: 'ok', name, parents: true } })).status).toBe(400);
      }
      expect(fs.readdirSync(dir).sort()).toEqual(['escape']);
      expect(fs.readdirSync(outside).sort()).toEqual(['secret.txt']);
    });

    it('refuses names Windows would take for a device or a data stream', async () => {
      for (const n of ['nul', 'NUL.txt', 'con', 'com1', 'lpt9.log', 'aux', 'prn.md', 'conin$', 'a:b', 'a.txt:stream', 'a?b', 'a*b', 'a|b', 'a"b', 'a<b', 'a>b']) {
        expect(windowsNameProblem(n), n).not.toBeNull();
      }
      for (const n of ['null', 'console.txt', 'com', 'com10', 'notes.md', '.env.example', 'a b', 'é.txt']) {
        expect(windowsNameProblem(n), n).toBeNull();
      }
      if (process.platform !== 'win32') return;
      const { room } = groupRoom();
      expect((await nested(room.id, 'ok/nul', 'x.txt', 'x')).status).toBe(400);
      expect((await nested(room.id, 'ok/a:b', 'x.txt', 'x')).status).toBe(400);
      expect((await upload(room.id, 'a.txt:stream', 'x')).status).toBe(400);
      expect((await request('POST', base(room.id) + '/folder', { body: { name: 'com1' } })).status).toBe(400);
    });

    it('sorts out junk and likely secrets for the app', () => {
      for (const d of ['.git', 'node_modules', 'Node_Modules']) expect(folderUploadSkip(d, true)).toBe('junk');
      for (const d of ['src', '.github', 'keys', '.env']) expect(folderUploadSkip(d, true)).toBeNull();
      for (const f of ['.DS_Store', 'Thumbs.db', 'thumbs.db']) expect(folderUploadSkip(f, false)).toBe('junk');
      for (const f of ['.env', '.env.local', '.ENV.production', '.envrc', 'server.pem', 'api.key', 'AuthKey_X.p8', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'service-account.json', 'service-account-prod.json']) {
        expect(folderUploadSkip(f, false), f).toBe('secret');
      }
      for (const f of ['.env.example', '.env.sample', '.env.template', 'README.md', 'keys.ts', 'monkey.txt', 'service-account.md', 'my.keynote', 'index.ts']) {
        expect(folderUploadSkip(f, false), f).toBeNull();
      }
    });
  });

  it('caps an upload at 25 MB', async () => {
    const { room } = groupRoom();
    const big = Buffer.alloc(25 * 1024 * 1024 + 10).toString('base64');
    const r = await request('POST', base(room.id) + '/upload', { body: { name: 'big.bin', dataBase64: big } });
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(roomsDir, room.id, 'big.bin'))).toBe(false);
  });
});

describe('versioned text, history and decisions (bridge P1)', () => {
  it('writes with a matching base, refuses a stale one with the current text, and keeps history', async () => {
    const { room } = groupRoom();
    const created = await request('POST', base(room.id) + '/text', { body: { path: 'notes/current.md', text: 'v1', base: null } });
    expect(created.status).toBe(200);
    const read = await request('GET', base(room.id) + '/text?path=notes/current.md');
    expect(read.json).toMatchObject({ path: 'notes/current.md', text: 'v1', rev: { rev: 1, author: { kind: 'owner' } } });

    expect((await request('POST', base(room.id) + '/text', { body: { path: 'notes/current.md', text: 'v2', base: read.json.hash } })).status).toBe(200);
    const stale = await request('POST', base(room.id) + '/text', { body: { path: 'notes/current.md', text: 'v2b', base: read.json.hash } });
    expect(stale.status).toBe(409);
    expect(stale.json.current.text).toBe('v2');

    const hist = await request('GET', base(room.id) + '/history?path=notes/current.md');
    expect(hist.json.revisions.map((r: { rev: number }) => r.rev)).toEqual([2, 1]);
    expect((await request('POST', base(room.id) + '/text', { body: { path: 'x.md', text: 'x', base: 'nope' } })).status).toBe(400);
  });

  it('appends decisions and refuses decisions.md as plain text', async () => {
    const { room } = groupRoom();
    const d1 = await request('POST', base(room.id) + '/decision', { body: { title: 'Ship v0.3.0', text: 'Release is green.' } });
    expect(d1.json).toMatchObject({ ok: true, id: 'D-0001' });
    const d2 = await request('POST', base(room.id) + '/decision', { body: { title: 'Then v0.4.0', text: 'Workflows next.', supersedes: ['D-0001'] } });
    expect(d2.json.id).toBe('D-0002');
    const asText = await request('POST', base(room.id) + '/text', { body: { path: 'decisions.md', text: 'wiped', base: null } });
    expect(asText.status).toBe(409);
    const file = fs.readFileSync(path.join(roomsDir, room.id, 'decisions.md'), 'utf8');
    expect(file).toContain('## D-0001 · Ship v0.3.0');
    expect(file).toContain('## D-0002 · Then v0.4.0');
  });

  it('records an owner upload in the file history', async () => {
    const { room } = groupRoom();
    await request('POST', base(room.id) + '/upload', { body: { path: '', name: 'brief.md', dataBase64: Buffer.from('hello').toString('base64') } });
    const hist = await request('GET', base(room.id) + '/history?path=brief.md');
    expect(hist.json.revisions).toHaveLength(1);
    expect(hist.json.revisions[0]).toMatchObject({ tool: 'upload', author: { kind: 'owner' } });
  });
});
