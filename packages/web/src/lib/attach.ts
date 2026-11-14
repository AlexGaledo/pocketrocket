import { MAX_ATTACHMENTS, MAX_ATTACHMENT_IMAGE_BYTES } from '@pocketrocket/shared';
import { api } from './api';
import { IMAGE_TYPES, ImageRefused, cachePreview, sniffImage } from './media';

/** Longest side a picture keeps before upload. Bigger ones are scaled down. */
export const MAX_ATTACH_EDGE = 2048;
export { MAX_ATTACHMENTS };

/** The new size for a picture: unchanged when it already fits, otherwise scaled so its longest side is `max`. */
export function fitWithin(width: number, height: number, max = MAX_ATTACH_EDGE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The words for a file that is not a PNG, JPEG or WebP. */
export function refusalFor(file: { type: string; name: string }): string {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  if (t === 'image/gif' || n.endsWith('.gif')) return 'GIFs are not supported yet. Use a PNG, JPEG or WebP picture.';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'PDFs are not supported yet. Use a PNG, JPEG or WebP picture.';
  return 'Only PNG, JPEG and WebP pictures can be attached.';
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Re-draws the picture through a canvas, which drops every piece of metadata (EXIF location, camera, thumbnails)
 * and scales it to {@link MAX_ATTACH_EDGE}. The type is checked from the file's own bytes, not its name or declared
 * type. PNG stays PNG (transparency), the others keep their format; if the result is still over the hub's per-picture cap
 * ({@link MAX_ATTACHMENT_IMAGE_BYTES}) it is written as JPEG at lower quality, then at half size.
 */
export async function reencodeImage(file: File): Promise<Blob> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const type = sniffImage(head);
  if (!type) throw new ImageRefused(refusalFor(file));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageRefused("Couldn't read that picture.");
  }
  const size = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close?.();
    throw new ImageRefused("Couldn't read that picture.");
  }
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  // Each step is smaller than the last, and the last also halves the picture, so a huge one still ends up under the
  // per-picture cap the hub enforces (MAX_ATTACHMENT_IMAGE_BYTES).
  const tries: [string, number | undefined, number][] = [
    [type, type === 'image/png' ? undefined : 0.92, 1], ['image/jpeg', 0.85, 1], ['image/jpeg', 0.6, 1], ['image/jpeg', 0.6, 0.5],
  ];
  let scaled = canvas;
  for (const [t, q, f] of tries) {
    if (f !== 1 && scaled === canvas) {
      scaled = document.createElement('canvas');
      scaled.width = Math.max(1, Math.round(canvas.width * f));
      scaled.height = Math.max(1, Math.round(canvas.height * f));
      scaled.getContext('2d')?.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    }
    const blob = await encode(f === 1 ? canvas : scaled, t, q);
    if (blob && (IMAGE_TYPES as readonly string[]).includes(blob.type) && blob.size <= MAX_ATTACHMENT_IMAGE_BYTES) return blob;
  }
  throw new ImageRefused('That picture is too large.');
}

/** Uploads an already re-encoded picture and returns its reference. */
export async function uploadAttachment(blob: Blob): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new ImageRefused("Couldn't read that picture."));
    reader.readAsDataURL(blob);
  });
  const { ref } = await api.media.uploadAttachment(data);
  cachePreview(ref, blob);
  return ref;
}
