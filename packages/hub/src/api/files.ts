import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FileFolderSchema, FileRenameSchema, FileUploadSchema, MAX_FILE_DOWNLOAD_BYTES, MAX_FILE_LIST_ENTRIES, MAX_FILE_UPLOAD_BYTES,
  type FileEntry, type FileListing,
} from '@pocketrocket/shared';
import { events } from '../events.js';
import { readBody, MAX_BODY_BYTES } from './body.js';
import { principalOf } from './guard.js';
import type { Repos } from '../db/repos.js';
import type { RoomFiles } from '../rooms/roomFiles.js';
import { isInside } from '../permissions/pathRules.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import { logError } from '../providers/redact.js';

/** Base64 of the biggest upload, plus room for the JSON around it. */
const UPLOAD_BODY_BYTES = Math.ceil(MAX_FILE_UPLOAD_BYTES / 3) * 4 + 64 * 1024;
const HIDDEN = new Set(['.git']);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  pdf: 'application/pdf', json: 'application/json', zip: 'application/zip',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
// Shown as plain text, never run: an .html file previews as its source.
const TEXT = new Set([
  'md', 'markdown', 'txt', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'env',
]);
function contentType(ext: string): string {
  if (TYPES[ext]) return TYPES[ext];
  if (TEXT.has(ext)) return ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const extOf = (name: string) => path.extname(name).slice(1).toLowerCase();

class FilesError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

/** A request path, '/' separated, back to its clean form ('' for the folder itself). */
function cleanRel(rel: string): string {
  return rel.replaceAll('\\', '/').split('/').filter((p) => p && p !== '.').join('/');
}

/**
 * The absolute path for `rel` inside `root`, or a 400. Absolute paths, drive letters, `..` and NUL are refused
 * before the disk is asked; then isInside checks the written path and its real path, so a symlink or junction
 * inside the folder that points outside it is refused for reading and writing alike.
 */
function resolveIn(root: string, rel: string): { abs: string; rel: string } {
  const raw = rel.replaceAll('\\', '/');
  if (raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new FilesError(400, 'Paths are relative to the room\'s folder');
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new FilesError(400, 'Paths may not go up a folder');
  const abs = path.join(root, ...parts);
  if (!isInside(abs, [root])) throw new FilesError(400, 'That path leads outside the room\'s folder');
  return { abs, rel: parts.join('/') };
}

function statOr404(abs: string): fs.Stats {
  try { return fs.statSync(abs); } catch { throw new FilesError(404, 'Not found'); }
}
const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/**
 * `/api/rooms/:id/files*`: the owner's view of a room's file folder (rooms/roomFiles.ts). Hub token only: a paired
 * phone is refused here and by DEVICE_ALLOW, and a bot's per-turn MCP bearer is not a hub token.
 *
 *   GET    /api/rooms/:id/files?path=                 list a folder
 *   GET    /api/rooms/:id/files/raw?path=&download=1  the file's bytes (50 MB cap)
 *   POST   /api/rooms/:id/files/upload                { path, name, dataBase64, overwrite? } (25 MB cap)
 *   POST   /api/rooms/:id/files/folder                { path, name }
 *   PATCH  /api/rooms/:id/files                       { from, to } rename or move
 *   DELETE /api/rooms/:id/files?path=&recursive=true  a folder with anything in it needs recursive
 */
export function createFilesApi(deps: { repos: Repos; roomFiles: RoomFiles }) {
  const { repos, roomFiles } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/api\/rooms\/([^/]+)\/files(?:\/(raw|upload|folder))?\/?$/.exec(url.pathname);
    if (!m) return false;
    if (principalOf(req)?.kind !== 'hub') return send(res, 403, { error: 'Only the desktop app can do this' });
    const method = req.method ?? 'GET';
    const action = m[2] ?? '';
    let roomId: string;
    try { roomId = decodeURIComponent(m[1]); } catch { return send(res, 404, { error: 'No room with that id' }); }

    try {
      const room = repos.getRoom(roomId);
      const folder = room ? roomFiles.folderOf(room) : null;
      if (!room || !folder) return send(res, 404, { error: 'No room with that id' });
      const root = roomFiles.ensure(folder);

      let body: unknown;
      if (method === 'POST' || method === 'PATCH') {
        const buf = await readBody(req, action === 'upload' ? UPLOAD_BODY_BYTES : MAX_BODY_BYTES);
        if (buf === null) return send(res, 413, { error: action === 'upload' ? 'File too large (max 25 MB)' : 'Request body too large (max 1 MB)' });
        try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      }
      const bad = (issues: { path: PropertyKey[]; message: string }[]) => send(res, 400, { error: issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
      const changed = (what: string, rel: string, folders: string[], detail?: string) => {
        const actor = actorOf(req);
        if (actor) recordAudit(repos.db, actor, 'files.' + what, roomId, detail ?? rel);
        for (const f of new Set(folders)) events.emitEvent({ type: 'files.changed', roomId, path: f });
      };

      if (action === '' && method === 'GET') {
        const { abs, rel } = resolveIn(root, url.searchParams.get('path') ?? '');
        if (!statOr404(abs).isDirectory()) throw new FilesError(400, 'Not a folder');
        return send(res, 200, listFolder(root, abs, rel, roomId, folder.kind, folder.projectSlug));
      }

      if (action === 'raw' && method === 'GET') {
        const { abs } = resolveIn(root, url.searchParams.get('path') ?? '');
        const st = statOr404(abs);
        if (!st.isFile()) throw new FilesError(400, 'Not a file');
        if (st.size > MAX_FILE_DOWNLOAD_BYTES) throw new FilesError(413, 'File too large to open here (max 50 MB)');
        const name = path.basename(abs);
        const headers = {
          'cache-control': 'private, no-cache',
          etag: '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
        };
        if (req.headers['if-none-match'] === headers.etag) {
          res.writeHead(304, headers);
          res.end();
          return true;
        }
        const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
        res.writeHead(200, {
          ...headers,
          'content-type': contentType(extOf(name)),
          'content-length': st.size,
          'content-disposition': (url.searchParams.get('download') === '1' ? 'attachment' : 'inline') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
        });
        await new Promise<void>((resolve) => {
          const stream = fs.createReadStream(abs);
          stream.on('error', (e) => { logError('[files api]', e); res.destroy(); resolve(); });
          stream.on('end', () => resolve());
          // A client that hangs up mid-download: stop reading and let the request finish.
          res.on('close', () => { stream.destroy(); resolve(); });
          stream.pipe(res);
        });
        return true;
      }

      if (action === 'upload' && method === 'POST') {
        const p = FileUploadSchema.safeParse(body);
        if (!p.success) {
          if (p.error.issues.some((i) => i.code === 'too_big')) return send(res, 413, { error: 'File too large (max 25 MB)' });
          return bad(p.error.issues);
        }
        const dir = resolveIn(root, p.data.path);
        if (!statOr404(dir.abs).isDirectory()) throw new FilesError(400, 'Not a folder');
        const bytes = Buffer.from(p.data.dataBase64, 'base64');
        if (bytes.length > MAX_FILE_UPLOAD_BYTES) return send(res, 413, { error: 'File too large (max 25 MB)' });
        const target = resolveIn(root, cleanRel(dir.rel + '/' + p.data.name));
        const existing = lstatOrNull(target.abs);
        if (existing && (!p.data.overwrite || !existing.isFile())) throw new FilesError(409, 'There is already something called ' + p.data.name + ' here');
        fs.writeFileSync(target.abs, bytes, { flag: p.data.overwrite ? 'w' : 'wx' });
        changed('uploaded', target.rel, [dir.rel], target.rel + ' (' + bytes.length + ' bytes)');
        return send(res, 200, { ok: true, path: target.rel });
      }

      if (action === 'folder' && method === 'POST') {
        const p = FileFolderSchema.safeParse(body);
        if (!p.success) return bad(p.error.issues);
        const dir = resolveIn(root, p.data.path);
        if (!statOr404(dir.abs).isDirectory()) throw new FilesError(400, 'Not a folder');
        const target = resolveIn(root, cleanRel(dir.rel + '/' + p.data.name));
        if (lstatOrNull(target.abs)) throw new FilesError(409, 'There is already something called ' + p.data.name + ' here');
        fs.mkdirSync(target.abs);
        changed('folder_created', target.rel, [dir.rel]);
        return send(res, 200, { ok: true, path: target.rel });
      }

      if (action === '' && method === 'PATCH') {
        const p = FileRenameSchema.safeParse(body);
        if (!p.success) return bad(p.error.issues);
        const from = resolveIn(root, p.data.from);
        const to = resolveIn(root, p.data.to);
        if (!from.rel || !to.rel) throw new FilesError(400, 'The room\'s folder itself cannot be renamed or moved');
        statOr404(from.abs);
        const fromKey = from.rel.toLowerCase();
        const toKey = to.rel.toLowerCase();
        if (toKey.startsWith(fromKey + '/')) throw new FilesError(400, 'A folder cannot move into itself');
        // On Windows and macOS a change of case only (a.md to A.md) finds the same entry, which is not a clash.
        const there = lstatOrNull(to.abs);
        const src = fs.lstatSync(from.abs);
        if (there && !(there.ino === src.ino && there.dev === src.dev)) throw new FilesError(409, 'There is already something at ' + to.rel);
        const parent = statOr404(path.dirname(to.abs));
        if (!parent.isDirectory()) throw new FilesError(400, 'Not a folder: ' + parentOf(to.rel));
        fs.renameSync(from.abs, to.abs);
        changed('renamed', to.rel, [parentOf(from.rel), parentOf(to.rel)], from.rel + ' -> ' + to.rel);
        return send(res, 200, { ok: true, path: to.rel });
      }

      if (action === '' && method === 'DELETE') {
        const { abs, rel } = resolveIn(root, url.searchParams.get('path') ?? '');
        if (!rel) throw new FilesError(400, 'The room\'s folder itself cannot be deleted');
        const st = statOr404(abs);
        if (st.isDirectory()) {
          if (fs.readdirSync(abs).length && url.searchParams.get('recursive') !== 'true') throw new FilesError(409, 'The folder is not empty');
          fs.rmSync(abs, { recursive: true });
        } else fs.rmSync(abs);
        changed('deleted', rel, [parentOf(rel)]);
        return send(res, 200, { ok: true, path: rel });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof FilesError) return send(res, e.status, { error: e.message });
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') return send(res, 409, { error: 'There is already something with that name' });
      if (code === 'ENOENT') return send(res, 404, { error: 'Not found' });
      if (code === 'EINVAL' || code === 'ENAMETOOLONG') return send(res, 400, { error: 'That name is not allowed here' });
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return send(res, 409, { error: 'The file is in use or protected' });
      logError('[files api]', e);
      if (!res.headersSent) return send(res, 500, { error: 'Internal error' });
      return true;
    }
  };
}

function lstatOrNull(abs: string): fs.Stats | null {
  try { return fs.lstatSync(abs); } catch { return null; }
}

/** Folders first, then files, by name. Sorting needs only the names; the stats are read for the entries kept. */
export function listFolder(
  root: string, abs: string, rel: string, roomId: string, kind: FileListing['folder'], projectSlug: string | null, cap = MAX_FILE_LIST_ENTRIES,
): FileListing {
  const dirents = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => !HIDDEN.has(d.name));
  const isDir = (d: fs.Dirent) => d.isDirectory() || (d.isSymbolicLink() && statOrNull(path.join(abs, d.name))?.isDirectory() === true);
  const keyed = dirents.map((d) => ({ d, dir: isDir(d) }));
  keyed.sort((a, b) => (a.dir === b.dir ? collator.compare(a.d.name, b.d.name) : a.dir ? -1 : 1));
  const entries: FileEntry[] = [];
  for (const { d, dir } of keyed.slice(0, cap)) {
    const full = path.join(abs, d.name);
    // A link that leads out of the folder is left out: the panel could not open it anyway.
    if (d.isSymbolicLink() && !isInside(full, [root])) continue;
    const st = statOrNull(full);
    if (!st) continue;
    entries.push({ name: d.name, kind: dir ? 'dir' : 'file', size: dir ? 0 : st.size, mtime: Math.floor(st.mtimeMs), ext: dir ? '' : extOf(d.name) });
  }
  return { roomId, folder: kind, projectSlug, path: rel, entries, truncated: keyed.length > cap };
}

function statOrNull(abs: string): fs.Stats | null {
  try { return fs.statSync(abs); } catch { return null; }
}
