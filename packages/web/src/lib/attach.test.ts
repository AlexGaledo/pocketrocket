import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACH_EDGE, fitWithin, refusalFor, reencodeImage } from './attach';
import { ImageRefused } from './media';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 1, 2]);
const fileOf = (bytes: Uint8Array, type: string, name = 'a') => ({ type, name, slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }) }) as unknown as File;

/** A canvas that records what it was asked for and hands back blobs of a chosen size/type. */
function mockCanvas(blobs: Array<{ type: string; size: number } | null>) {
  const canvas = { width: 0, height: 0, drawn: [] as number[][], tries: [] as Array<[string, number | undefined]> } as any;
  canvas.getContext = () => ({ drawImage: (_b: unknown, x: number, y: number, w: number, h: number) => canvas.drawn.push([x, y, w, h]) });
  let i = 0;
  canvas.toBlob = (cb: (b: Blob | null) => void, type: string, q?: number) => {
    canvas.tries.push([type, q]);
    const b = blobs[Math.min(i++, blobs.length - 1)];
    cb(b ? ({ type: b.type, size: b.size } as Blob) : null);
  };
  vi.stubGlobal('document', { createElement: () => canvas });
  return canvas;
}
const bitmap = (width: number, height: number) => vi.stubGlobal('createImageBitmap', async () => ({ width, height, close: () => undefined }));
afterEach(() => vi.unstubAllGlobals());

describe('fitWithin', () => {
  it('leaves a picture that fits alone and scales a big one to the edge', () => {
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(4096, 2048)).toEqual({ width: MAX_ATTACH_EDGE, height: 1024 });
    expect(fitWithin(1000, 8000)).toEqual({ width: 256, height: 2048 });
  });
});

describe('reencodeImage', () => {
  it('redraws through a canvas at the capped size, keeping PNG as PNG', async () => {
    const c = mockCanvas([{ type: 'image/png', size: 1000 }]);
    bitmap(4096, 1024);
    const out = await reencodeImage(fileOf(PNG, 'image/png'));
    expect(out.type).toBe('image/png');
    expect([c.width, c.height]).toEqual([2048, 512]);
    expect(c.drawn).toEqual([[0, 0, 2048, 512]]);
    expect(c.tries[0][0]).toBe('image/png');
  });

  it('does not enlarge a tiny picture, but still re-encodes it', async () => {
    const c = mockCanvas([{ type: 'image/png', size: 10 }]);
    bitmap(16, 16);
    await reencodeImage(fileOf(PNG, 'image/png'));
    expect([c.width, c.height]).toEqual([16, 16]);
    expect(c.drawn).toHaveLength(1);
  });

  it('falls back to JPEG when the result is over the hub cap', async () => {
    const c = mockCanvas([{ type: 'image/png', size: 11 * 1024 * 1024 }, { type: 'image/jpeg', size: 1000 }]);
    bitmap(100, 100);
    const out = await reencodeImage(fileOf(PNG, 'image/png'));
    expect(out.type).toBe('image/jpeg');
    expect(c.tries.map((t: [string, number?]) => t[0])).toEqual(['image/png', 'image/jpeg']);
  });

  it('refuses a GIF by its bytes even when it claims to be a PNG', async () => {
    mockCanvas([{ type: 'image/png', size: 1 }]);
    bitmap(10, 10);
    await expect(reencodeImage(fileOf(GIF, 'image/png', 'x.png'))).rejects.toBeInstanceOf(ImageRefused);
  });

  it('says plainly why a GIF or PDF is refused', () => {
    expect(refusalFor({ type: 'image/gif', name: 'a.gif' })).toMatch(/GIF/);
    expect(refusalFor({ type: 'application/pdf', name: 'a.pdf' })).toMatch(/PDF/);
    expect(refusalFor({ type: 'text/plain', name: 'a.txt' })).toMatch(/PNG, JPEG and WebP/);
  });

  it('reports a picture it cannot decode', async () => {
    mockCanvas([{ type: 'image/png', size: 1 }]);
    vi.stubGlobal('createImageBitmap', async () => { throw new Error('bad'); });
    await expect(reencodeImage(fileOf(PNG, 'image/png'))).rejects.toThrow(/read that picture/);
  });
});
