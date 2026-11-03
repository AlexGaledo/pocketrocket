import { useEffect, useState } from 'react';
import { MAX_MEDIA_BYTES, isMediaRef, mediaHash } from '@pocketrocket/shared';
import { api } from './api';
import { getToken, reportAuthFailure } from './auth';

/**
 * Uploaded pictures. `<img>` cannot send the Bearer token and the token must stay out of URLs, so a picture is fetched
 * with the token, like any other API call, and shown through a blob URL that only this tab can use.
 */

/** What the file picker offers, and all the hub accepts. Never SVG: it can carry script. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_SIDE = 512;

const urls = new Map<string, string>();
const loading = new Map<string, Promise<void>>();
const waiting = new Set<() => void>();
/** The token the hub last refused. Every refusal feeds its auth limiter, so nothing more is asked with that token. */
let refused: string | null | undefined;
/** One at a time, for the same reason: a stale token costs one failed request, not one per picture on screen. */
let queue: Promise<unknown> = Promise.resolve();

function load(hash: string): Promise<void> {
  const inFlight = loading.get(hash);
  if (inFlight) return inFlight;
  const job = queue.then(async () => {
    const token = getToken();
    if (token === refused) return;
    const r = await fetch('/api/media/' + hash, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    if (r.status === 401) {
      refused = token;
      reportAuthFailure();
      return;
    }
    if (r.ok) urls.set(hash, URL.createObjectURL(await r.blob()));
  }).catch(() => { /* offline: the icon stays, and the next mount tries again */ }).finally(() => {
    loading.delete(hash);
    for (const fn of waiting) fn();
  });
  loading.set(hash, job);
  queue = job;
  return job;
}

/** A blob URL for an avatar that is a picture; null for an icon key, '' and while it loads. */
export function useMediaUrl(avatar: string | undefined): string | null {
  const hash = isMediaRef(avatar) ? mediaHash(avatar) : null;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!hash || urls.has(hash)) return;
    const done = () => rerender((n) => n + 1);
    waiting.add(done);
    void load(hash);
    return () => { waiting.delete(done); };
  }, [hash]);
  return hash ? urls.get(hash) ?? null : null;
}

/** A refused image, with the words to show. */
export class ImageRefused extends Error {}

/** The same check the hub makes, so a wrong file is refused before anything is uploaded. */
export function sniffImage(b: Uint8Array): (typeof IMAGE_TYPES)[number] | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Down to 512 px at most, re-encoded, which also drops EXIF such as a photo's location. A browser that cannot write
 * WebP hands back a PNG, which is still one of the three; JPEG is the way down when a detailed picture is too big.
 */
async function shrink(file: File): Promise<Blob> {
  const type = (IMAGE_TYPES as readonly string[]).includes(file.type) ? sniffImage(new Uint8Array(await file.slice(0, 12).arrayBuffer())) : null;
  if (!type) throw new ImageRefused('Use a PNG, JPEG or WebP image.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageRefused("Couldn't read that image.");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const [t, q] of [['image/webp', 0.85], ['image/jpeg', 0.85], ['image/jpeg', 0.6]] as const) {
    const blob = await encode(canvas, t, q);
    if (blob && (IMAGE_TYPES as readonly string[]).includes(blob.type) && blob.size <= MAX_MEDIA_BYTES) return blob;
  }
  throw new ImageRefused('Image too large.');
}

/** Checks, shrinks and uploads a file. Returns the reference to store; refuses with words to show. */
export async function uploadImage(file: File): Promise<string> {
  const blob = await shrink(file);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new ImageRefused("Couldn't read that image."));
    reader.readAsDataURL(blob);
  });
  const { ref } = await api.media.upload(data);
  // Already in hand, so the preview needs no second trip.
  const hash = mediaHash(ref);
  if (!urls.has(hash)) urls.set(hash, URL.createObjectURL(blob));
  return ref;
}
