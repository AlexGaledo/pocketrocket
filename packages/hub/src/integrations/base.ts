import { apiRequest, IntegrationError, type ApiResponse, type Fetch, type RequestOpts } from './http.js';

/**
 * What a provider client needs. The client never holds a credential itself: it asks `token()` per call,
 * so a refresh, a reconnect or a disconnect takes effect on the very next request.
 */
export interface ClientDeps {
  fetch: Fetch;
  /** The access token / PAT. `refresh = true` after a 401: refresh if the connection can, else return the same value. */
  token(refresh?: boolean): Promise<string>;
  /** Slack only: the `xapp-` app-level token, or null when none is stored. */
  appToken?(): Promise<string | null>;
}

/**
 * The shape every poll-friendly method returns (P5 event triggers build their pollers on these).
 *
 * - `cursor`: hand it back on the next call. Its meaning is per method (a Gmail historyId, a Calendar
 *   syncToken, a Drive page token, a Slack ts, a GitHub Last-Modified date, a ClickUp ms timestamp).
 * - `etag`: for methods that support conditional GETs; pass it back as well.
 * - `notModified`: the provider answered 304 (free on GitHub); `items` is empty and the cursor unchanged.
 * - `resync`: the cursor expired (Gmail 404, Calendar 410, ...). Re-seed with the method's `seed*` call
 *   and treat anything in between as missed.
 * - `pollIntervalSec`: the provider's own minimum interval when it states one (GitHub `X-Poll-Interval`).
 */
export interface PollResult<T> {
  items: T[];
  cursor: string | null;
  etag?: string | null;
  notModified: boolean;
  resync: boolean;
  pollIntervalSec?: number;
}

export abstract class ApiClient {
  constructor(protected deps: ClientDeps) {}

  /** `Bearer <token>` for most providers; ClickUp wants the bare token. */
  protected authHeader(token: string): string {
    return 'Bearer ' + token;
  }

  /** One authenticated call. A 401 triggers one refresh-and-retry when the connection can refresh. */
  protected async call<T>(url: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
    const token = await this.deps.token(false);
    try {
      return await apiRequest<T>(this.deps.fetch, url, { ...opts, headers: { ...opts.headers, authorization: this.authHeader(token) } });
    } catch (e) {
      if (!(e instanceof IntegrationError) || !e.auth) throw e;
      let fresh: string;
      try {
        fresh = await this.deps.token(true);
      } catch {
        throw e;
      }
      if (fresh === token) throw e;
      return apiRequest<T>(this.deps.fetch, url, { ...opts, headers: { ...opts.headers, authorization: this.authHeader(fresh) } });
    }
  }
}

/** Cap long text the bots read (email bodies, file contents) so one tool call cannot flood a turn. */
export function clip(s: string, max = 20_000): string {
  return s.length > max ? s.slice(0, max) + '\n…[truncated, ' + (s.length - max) + ' more characters]' : s;
}
