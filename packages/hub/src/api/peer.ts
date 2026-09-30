import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { bearerToken, tokenMatches } from './guard.js';
import { PeerError, type PeerHost } from '../services/PeerService.js';

export const PEER_PREFIX = '/api/peer/';

const Body = {
  list: z.object({ path: z.string().optional() }),
  read: z.object({ path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).optional() }),
  run: z.object({ command: z.string(), cwd: z.string().optional() }),
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * `/api/peer/*`, authenticated by the peer token alone: the hub token is neither needed nor accepted here, so
 * a linked hub never holds a credential that opens the rest of the API. Returns whether the token was good,
 * for the caller's rate limiter. 404 when no peer is configured, so an unlinked hub does not advertise the API.
 */
export async function handlePeer(req: IncomingMessage, res: ServerResponse, url: URL, body: unknown, host: PeerHost): Promise<boolean> {
  if (!host.enabled) {
    send(res, 404, { error: 'Not found' });
    return true;
  }
  if (!tokenMatches(bearerToken(req), host.acceptToken!)) {
    send(res, 401, { error: 'Missing or invalid peer token' });
    return false;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    send(res, 405, { error: 'POST only' });
    return true;
  }
  const op = url.pathname.slice(PEER_PREFIX.length);
  try {
    if (op === 'info') send(res, 200, host.info());
    else if (op === 'list') send(res, 200, host.listDir(Body.list.parse(body ?? {}).path ?? '.'));
    else if (op === 'read') {
      const a = Body.read.parse(body ?? {});
      send(res, 200, host.readFile(a.path, a.offset, a.limit));
    } else if (op === 'run') {
      const a = Body.run.parse(body ?? {});
      send(res, 200, await host.run(a.command, a.cwd));
    } else send(res, 404, { error: 'Unknown peer operation ' + op });
  } catch (e) {
    if (e instanceof PeerError) send(res, e.status, { error: e.message });
    else if (e instanceof z.ZodError) send(res, 400, { error: 'Invalid arguments: ' + e.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ') });
    else send(res, 500, { error: 'Peer operation failed' });
  }
  return true;
}
