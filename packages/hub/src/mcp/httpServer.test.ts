import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHub, type Hub } from '../hub.js';
import { hubTool } from '../agent/botTools.js';

let hub: Hub;
let base: string;
let token: string;
const calls: unknown[] = [];

beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null });
  const p = await hub.listen();
  base = 'http://127.0.0.1:' + p;
  token = hub.turns.registerTurn([
    hubTool('echo', 'Echo back the text.', { text: z.string() }, async (a) => {
      calls.push(a);
      return { content: [{ type: 'text', text: 'echo: ' + a.text }] };
    }),
    hubTool('boom', 'Always fails.', {}, async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true })),
  ]);
});
afterAll(async () => {
  await hub.shutdown();
});

/** Minimal Streamable-HTTP MCP client: one JSON-RPC request per POST (the endpoint is stateless). */
async function rpc(method: string, params: unknown, bearer = token) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + bearer,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const text = await res.text();
  // enableJsonResponse gives plain JSON; fall back to parsing an SSE frame just in case.
  const payload = res.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5))
    : text ? JSON.parse(text) : null;
  return { status: res.status, body: payload as { result?: Record<string, unknown>; error?: { message: string } } | null };
}

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'pocketrocket-test', version: '1.0.0' },
};

describe('HTTP MCP endpoint', () => {
  it('initializes', async () => {
    const r = await rpc('initialize', INIT);
    expect(r.status).toBe(200);
    expect((r.body!.result as { serverInfo: { name: string } }).serverInfo.name).toBe('pocketrocket');
  });

  it('lists the tools of the turn the token belongs to', async () => {
    await rpc('initialize', INIT);
    const r = await rpc('tools/list', {});
    const names = (r.body!.result!.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(['echo', 'boom']);
  });

  it('calls a tool and returns its output', async () => {
    await rpc('initialize', INIT);
    const r = await rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(r.body!.result!.content).toEqual([{ type: 'text', text: 'echo: hi' }]);
    expect(calls.at(-1)).toEqual({ text: 'hi' });
  });

  it('rejects an unknown or expired turn token', async () => {
    const r = await rpc('tools/list', {}, 'not-a-token');
    expect(r.status).toBe(401);

    const gone = hub.turns.registerTurn([]);
    hub.turns.unregister(gone);
    expect((await rpc('tools/list', {}, gone)).status).toBe(401);
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
