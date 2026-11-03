import type { IncomingMessage, ServerResponse } from 'node:http';
import { MediaUploadSchema } from '@pocketrocket/shared';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import { MediaRejected, type MediaStore } from '../services/MediaStore.js';

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

/**
 * `POST /api/media` and `GET /api/media/:hash`, behind the same token check as the rest of `/api`.
 *
 * Reading takes the Bearer token, so the web client fetches a picture and shows it as a blob URL. There is no cookie and
 * no ticket: `<img>` never gets a URL that works by itself, the hub token stays out of URLs, and revoking a device
 * stops its next fetch. A cookie would also be shared by every hub on 127.0.0.1 (cookies ignore the port), and each
 * refused `<img>` would feed the auth limiter.
 *
 * Uploading is for the hub token only: a paired device is refused here and by DEVICE_ALLOW, and a bot's per-turn
 * MCP bearer is not a hub token, so the token check answers it with 401.
 */
export function createMediaApi({ media }: { media: MediaStore }) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (method === 'POST' && /^\/api\/media\/?$/.test(pathname)) {
      if (principalOf(req)?.kind !== 'hub') return send(res, 403, { error: 'Only the desktop app can do this' });
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Image too large' });
      let body: unknown;
      try { body = JSON.parse(buf.toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const parsed = MediaUploadSchema.safeParse(body);
      if (!parsed.success) {
        const tooBig = parsed.error.issues.some((i) => i.code === 'too_big');
        return send(res, tooBig ? 413 : 400, { error: tooBig ? 'Image too large' : 'Invalid image data' });
      }
      try {
        return send(res, 200, { ref: media.put(Buffer.from(parsed.data.data, 'base64')) });
      } catch (e) {
        if (e instanceof MediaRejected) return send(res, e.status, { error: e.message });
        throw e;
      }
    }
    const m = /^\/api\/media\/([0-9a-f]{64})$/.exec(pathname);
    if (method !== 'GET' || !m) return false;
    const found = media.read(m[1]);
    if (!found) return send(res, 404, { error: 'Not found' });
    const headers = {
      // Authenticated: each use revalidates, so a revoked device gets a 401 and an unchanged picture a 304.
      'cache-control': 'private, no-cache',
      etag: '"' + m[1] + '"',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    };
    if (req.headers['if-none-match'] === headers.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(200, { ...headers, 'content-type': found.type, 'content-length': found.bytes.length });
    res.end(found.bytes);
    return true;
  };
}
