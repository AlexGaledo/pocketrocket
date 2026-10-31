import type { Fetch } from './http.js';

/** One recorded call to the fake. */
export interface FakeCall { method: string; url: URL; headers: Record<string, string>; body: string }
type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
type Route = { method: string; match: (u: URL) => boolean; reply: (c: FakeCall) => Reply | Promise<Reply> };

/**
 * Test-only `fetch` (P4): routes by method + URL to canned answers and records every call, so the
 * integration tests never touch the network. Unrouted calls answer 599 and are recorded too.
 */
export function fakeFetch() {
  const routes: Route[] = [];
  const calls: FakeCall[] = [];
  const fn: Fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: FakeCall = { method: init?.method ?? 'GET', url, headers, body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    const r = routes.find((x) => x.method === call.method && x.match(url));
    if (!r) return new Response('{"error":"unrouted in test"}', { status: 599 });
    const a = await r.reply(call);
    const status = a.status ?? 200;
    const body = status === 304 ? null : a.text ?? JSON.stringify(a.json ?? {});
    return new Response(body, { status, headers: a.headers });
  };
  return {
    fetch: fn,
    calls,
    on(method: string, prefix: string, reply: Route['reply']) {
      routes.unshift({ method, match: (u) => (u.origin + u.pathname).startsWith(prefix), reply });
      return this;
    },
  };
}
