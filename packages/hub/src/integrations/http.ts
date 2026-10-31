import { redact } from '../providers/redact.js';

/** `fetch`, injectable so tests answer with recorded fixtures and never reach the network. */
export type Fetch = typeof fetch;

/**
 * A provider call that failed. `auth` means the provider refused the credential (401, Slack `invalid_auth`,
 * an OAuth `invalid_grant`): the connection needs a refresh or the user must reconnect. `message` is the
 * provider's own words, redacted and capped, never the request (which carries the token).
 */
export class IntegrationError extends Error {
  constructor(message: string, readonly status: number, readonly auth = false) {
    super(redact(message).slice(0, 400));
    this.name = 'IntegrationError';
  }
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  /** 304 to a conditional request (ETag / If-Modified-Since): nothing changed, `data` is null. */
  notModified: boolean;
}

export interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  /** Sent as application/json. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Conditional GET. */
  etag?: string | null;
  ifModifiedSince?: string | null;
  /** Answer as text, not JSON (Drive file content, Gmail raw). */
  text?: boolean;
  /** Status codes the caller handles itself instead of an exception (e.g. 404/410 = cursor expired). */
  allow?: number[];
  timeoutMs?: number;
}

export function withQuery(url: string, query?: RequestOpts['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

/** One HTTPS call. Throws IntegrationError on anything but 2xx, 304 or a status listed in `allow`. */
export async function apiRequest<T = unknown>(fetchFn: Fetch, url: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'PocketRocket-Crew', ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] = 'application/json; charset=utf-8';
  } else if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.ifModifiedSince) headers['if-modified-since'] = opts.ifModifiedSince;
  let res: Response;
  try {
    res = await fetchFn(withQuery(url, opts.query), {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new IntegrationError('Could not reach ' + new URL(url).host + ': ' + String((e as Error).message ?? e), 0);
  }
  if (res.status === 304) return { status: 304, data: null as T, headers: res.headers, notModified: true };
  const raw = await res.text();
  let data: unknown = raw;
  if (!opts.text) {
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  }
  if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, data: data as T, headers: res.headers, notModified: false };
  throw new IntegrationError(describeError(new URL(url).host, res.status, data), res.status, res.status === 401);
}

function describeError(host: string, status: number, data: unknown): string {
  let detail = '';
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const e = d.error;
    detail = String(
      d.error_description ?? d.message ?? (e && typeof e === 'object' ? (e as Record<string, unknown>).message : e) ?? d.err ?? '',
    );
  } else if (typeof data === 'string') {
    detail = data.slice(0, 200);
  }
  return host + ' answered HTTP ' + status + (detail ? ': ' + detail : '');
}
