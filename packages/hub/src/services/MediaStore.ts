import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_MEDIA_BYTES, isMediaRef, mediaHash } from '@pocketrocket/shared';

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

/** A refused upload; `status` is what the API answers. */
export class MediaRejected extends Error {
  constructor(message: string, readonly status: 413 | 415) {
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
  put(bytes: Buffer): string {
    if (bytes.length > MAX_MEDIA_BYTES) throw new MediaRejected('Image too large', 413);
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

  has(hash: string): boolean {
    const file = this.file(hash);
    return !!file && fs.existsSync(file);
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
}

/** Every picture still in use: bots, group chats and the owner. */
export function referencedMedia(repos: { listBots(): { avatar: string }[]; listRooms(): { avatar?: string }[] }, settings: { userAvatar: string }): Set<string> {
  const all = [...repos.listBots().map((b) => b.avatar), ...repos.listRooms().map((r) => r.avatar), settings.userAvatar];
  return new Set(all.filter(isMediaRef).map(mediaHash));
}
