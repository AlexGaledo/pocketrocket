import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_IMAGE_BYTES, MAX_FILE_BYTES, MAX_MEDIA_BYTES, MAX_VIDEO_BYTES, fileHash, isFileRef, isMediaRef, mediaHash, type StoredFileMeta } from '@pocketrocket/shared';

export type MediaType = 'image/png' | 'image/jpeg' | 'image/webp';

/** A file nothing refers to is kept this long: the owner may be mid-way through a dialog that will refer to it. */
export const MEDIA_GRACE_MS = 24 * 60 * 60 * 1000;
export const MEDIA_SWEEP_MS = 6 * 60 * 60 * 1000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HASH_RE = /^[0-9a-f]{64}$/;

/** The type these bytes really are, by magic number, or null. Nothing a client declares is ever consulted. */
export function sniffImageType(b: Buffer): MediaType | null {
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(PNG)) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The video type these bytes really are, by magic number, or null. */
export function sniffVideoType(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b.toString('latin1', 4, 8) === 'ftyp') return b.toString('latin1', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 11) === 'AVI') return 'video/x-msvideo';
  return null;
}

/** A file name fit to show and to name a copy by: no folders, no control characters, at most 120 characters. */
export function cleanFileName(raw: string | undefined): string {
  let n = (raw ?? '').split(/[\\/]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').trim();
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || 'file';
}

/** A declared MIME type kept only when it looks like one; it is shown, never trusted. */
const cleanType = (t: string | undefined): string => (t && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(t) && t.length <= 100 ? t.toLowerCase() : 'application/octet-stream');

/** A refused upload; `status` is what the API answers. */
export class MediaRejected extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) {
    super(message);
  }
}

/**
 * Uploaded pictures, one file per distinct content, named by its SHA-256 and nothing else. No client string reaches
 * a path: the only thing that gets from a request to the filesystem is a hash matched against HASH_RE.
 */
export class MediaStore {
  constructor(private dir: string, private now: () => number = Date.now) {}

  private file(hash: string): string | null {
    return HASH_RE.test(hash) ? path.join(this.dir, hash) : null;
  }

  /** Validates and stores. The same bytes again land on the same file, and count as fresh for the sweep. */
  put(bytes: Buffer, maxBytes: number = MAX_MEDIA_BYTES): string {
    if (bytes.length > maxBytes) throw new MediaRejected('Image too large', 413);
    if (!sniffImageType(bytes)) throw new MediaRejected('Use a PNG, JPEG or WebP image', 415);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = this.file(hash)!;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      const t = new Date(this.now());
      fs.utimesSync(file, t, t);
    } else {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return 'img:' + hash;
  }

  /**
   * Why a message may not carry these pictures, or null. Every ref must be well formed, stored by this hub and still
   * an allowed image (the type is read from the bytes again). One bad ref refuses them all.
   */
  checkAttachments(refs: readonly string[]): string | null {
    if (refs.length > MAX_ATTACHMENTS) return 'At most ' + MAX_ATTACHMENTS + ' attachments per message';
    for (const ref of refs) {
      if (isFileRef(ref)) {
        if (!this.fileMeta(fileHash(ref))) return 'A file is missing. Attach it again.';
        continue;
      }
      if (!isMediaRef(ref)) return 'Not a picture this hub stored';
      const found = this.read(mediaHash(ref));
      if (!found) return 'A picture is missing or not allowed. Attach it again.';
      if (found.bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) return 'A picture is too large. Use one under ' + Math.floor(MAX_ATTACHMENT_IMAGE_BYTES / 1024 / 1024 * 10) / 10 + ' MB.';
    }
    return null;
  }

  has(hash: string): boolean {
    const file = this.file(hash);
    return !!file && fs.existsSync(file);
  }

  // ---------- files and videos on chat messages: `<dir>/files/<hash>` plus `<hash>.json` ----------

  private filesDir(): string {
    return path.join(this.dir, 'files');
  }

  private filePaths(hash: string): { data: string; meta: string } | null {
    return HASH_RE.test(hash) ? { data: path.join(this.filesDir(), hash), meta: path.join(this.filesDir(), hash + '.json') } : null;
  }

  /**
   * Streams an upload to disk while hashing it. `declaredType` and `name` come from the client and are only shown: the
   * video allowance ({@link MAX_VIDEO_BYTES}) applies only when the bytes are a video, everything else stops at
   * {@link MAX_FILE_BYTES}. Nothing the client sent reaches a path; the stored name is the hash.
   */
  async putFile(body: AsyncIterable<Buffer | string>, o: { name?: string; declaredType?: string }): Promise<StoredFileMeta> {
    const declared = cleanType(o.declaredType);
    const cap = declared.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
    const dir = this.filesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, 'upload-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.tmp');
    const fd = fs.openSync(tmp, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const c of body) {
        const buf = typeof c === 'string' ? Buffer.from(c) : c;
        size += buf.length;
        if (size > cap) throw new MediaRejected(cap === MAX_VIDEO_BYTES ? 'Videos can be up to 200 MB.' : 'Files can be up to 25 MB.', 413);
        if (head.length < 16) head = Buffer.concat([head, buf.subarray(0, 16)]);
        hash.update(buf);
        fs.writeSync(fd, buf);
      }
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.closeSync(fd);
    if (!size) {
      fs.rmSync(tmp, { force: true });
      throw new MediaRejected('That file is empty.', 400);
    }
    const video = sniffVideoType(head);
    if (!video && size > MAX_FILE_BYTES) {
      fs.rmSync(tmp, { force: true });
      throw new MediaRejected('Files can be up to 25 MB. Only real videos may be larger.', 413);
    }
    const h = hash.digest('hex');
    const paths = this.filePaths(h)!;
    const type = video ?? (declared.startsWith('video/') ? 'application/octet-stream' : declared);
    const meta: StoredFileMeta = { ref: 'file:' + h, name: cleanFileName(o.name), type, size, kind: video ? 'video' : 'file' };
    if (fs.existsSync(paths.data)) {
      fs.rmSync(tmp, { force: true });
      const t = new Date(this.now());
      try { fs.utimesSync(paths.data, t, t); } catch { /* the sweep may take it a little earlier */ }
    } else {
      fs.renameSync(tmp, paths.data);
    }
    fs.writeFileSync(paths.meta, JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  /** What is known about a stored file, or null when it is gone. */
  fileMeta(hash: string): StoredFileMeta | null {
    const p = this.filePaths(hash);
    if (!p) return null;
    try {
      const st = fs.lstatSync(p.data);
      if (!st.isFile()) return null;
      const m = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as Partial<StoredFileMeta>;
      return { ref: 'file:' + hash, name: cleanFileName(m.name), type: cleanType(m.type), size: st.size, kind: m.kind === 'video' ? 'video' : 'file' };
    } catch {
      return null;
    }
  }

  /** The stored file's path on disk and its meta, for streaming it out or copying it for a bot. */
  readFile(hash: string): { path: string; meta: StoredFileMeta } | null {
    const meta = this.fileMeta(hash);
    return meta ? { path: this.filePaths(hash)!.data, meta } : null;
  }

  /** The bytes and their type. The type is read from the bytes again, so a file changed on disk cannot serve as anything else. */
  read(hash: string): { bytes: Buffer; type: MediaType } | null {
    const file = this.file(hash);
    if (!file) return null;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return null;
    }
    const type = sniffImageType(bytes);
    return type ? { bytes, type } : null;
  }

  /** Removes every file nothing refers to, once it is past the grace period. Returns how many went. */
  sweep(referenced: ReadonlySet<string>): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0; // no folder yet: nothing has been uploaded
    }
    let removed = 0;
    for (const name of names) {
      if (name === 'files') {
        removed += this.sweepFiles(referenced);
        continue;
      }
      if (referenced.has(name)) continue;
      const file = path.join(this.dir, name);
      try {
        if (this.now() - fs.statSync(file).mtimeMs < MEDIA_GRACE_MS) continue;
        fs.rmSync(file, { force: true });
        removed++;
      } catch { /* gone already, or locked: the next sweep gets it */ }
    }
    return removed;
  }

  /** {@link sweep} for `files/`: data and meta go together; half-written uploads go after the grace period too. */
  private sweepFiles(referenced: ReadonlySet<string>): number {
    const dir = this.filesDir();
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const hash = name.replace(/\.json$/, '');
      if (HASH_RE.test(hash) && referenced.has(hash)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || this.now() - st.mtimeMs < MEDIA_GRACE_MS) continue;
        // The meta goes with its data, never before it.
        if (name.endsWith('.json') && fs.existsSync(path.join(dir, hash))) continue;
        fs.rmSync(file, { force: true });
        removed++;
      } catch { /* gone already: the next sweep tidies the rest */ }
    }
    return removed;
  }
}

/** Every picture still in use: bots, group chats, the owner and chat messages. */
export function referencedMedia(repos: { listBots(): { avatar: string }[]; listRooms(): { avatar?: string }[]; attachmentRefs?(): string[] }, settings: { userAvatar: string }): Set<string> {
  const all = [...repos.listBots().map((b) => b.avatar), ...repos.listRooms().map((r) => r.avatar), settings.userAvatar, ...(repos.attachmentRefs?.() ?? [])];
  return new Set([...all.filter(isMediaRef).map(mediaHash), ...all.filter(isFileRef).map(fileHash)]);
}
