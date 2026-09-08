import type { IncomingMessage } from 'node:http';

/** Hard cap on a request body (audit 2026-09-09, B15); anything bigger gets a 413. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Hard cap on a single websocket frame (same finding). */
export const MAX_WS_BYTES = 256 * 1024;

/**
 * Read a request body with a byte cap; returns null when the cap is passed so the caller can answer 413.
 * Before this, `for await (const c of req)` would happily accumulate a gigabyte in memory.
 *
 * Past the cap nothing more is buffered, but the rest is drained rather than dropped, so the client still
 * receives the 413 instead of a socket hang-up. A body absurdly over the cap (8x) is not worth draining on a
 * loopback hub, so that one does get the connection torn down.
 */
export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > limit) {
      over = true;
      if (size > limit * 8) {
        req.destroy();
        return null;
      }
      continue;
    }
    chunks.push(buf);
  }
  return over ? null : Buffer.concat(chunks);
}
