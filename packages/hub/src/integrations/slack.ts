import { ApiClient, type PollResult } from './base.js';
import { apiRequest, IntegrationError, type ApiResponse, type RequestOpts } from './http.js';

const API = 'https://slack.com/api/';
/** Slack answers 200 with `ok: false`; these errors mean the token itself is bad. */
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

export interface SlackChannel { id: string; name: string; isPrivate: boolean; isMember: boolean; topic: string; members: number }
export interface SlackMessage { ts: string; user: string; text: string; threadTs: string | null; replies: number }

type SlackOk = { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } };

export class SlackClient extends ApiClient {
  /** Slack's envelope: turn `ok: false` into an IntegrationError (auth ones flagged so the connection is marked). */
  private async slack<T extends SlackOk>(method: string, opts: RequestOpts = {}): Promise<T> {
    const r = await this.call<T>(API + method, opts);
    return check(method, r);
  }

  async authTest(): Promise<{ team: string; user: string; botId: string | null; url: string }> {
    const d = await this.slack<SlackOk & { team: string; user: string; bot_id?: string; url: string }>('auth.test', { method: 'POST' });
    return { team: d.team, user: d.user, botId: d.bot_id ?? null, url: d.url };
  }

  async listChannels(o: { limit?: number; includePrivate?: boolean } = {}): Promise<SlackChannel[]> {
    const out: SlackChannel[] = [];
    let cursor: string | undefined;
    const want = Math.min(o.limit ?? 200, 1000);
    do {
      const d = await this.slack<SlackOk & { channels: Array<{ id: string; name: string; is_private: boolean; is_member: boolean; topic?: { value: string }; num_members?: number }> }>(
        'conversations.list', { query: { types: o.includePrivate === false ? 'public_channel' : 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor } },
      );
      for (const c of d.channels) out.push({ id: c.id, name: c.name, isPrivate: c.is_private, isMember: c.is_member, topic: c.topic?.value ?? '', members: c.num_members ?? 0 });
      cursor = d.response_metadata?.next_cursor || undefined;
    } while (cursor && out.length < want);
    return out.slice(0, want);
  }

  /** A channel id (`C…`, `G…`, `D…`) as-is, or a `#name` looked up in the channel list. */
  async resolveChannel(ref: string): Promise<string> {
    const r = ref.trim();
    if (/^[CGD][A-Z0-9]{6,}$/.test(r)) return r;
    const name = r.replace(/^#/, '').toLowerCase();
    const hit = (await this.listChannels({ limit: 1000 })).find((c) => c.name.toLowerCase() === name);
    if (!hit) throw new IntegrationError('No Slack channel named "' + ref + '" that this token can see', 404);
    return hit.id;
  }

  async history(channel: string, o: { limit?: number; oldest?: string; latest?: string } = {}): Promise<SlackMessage[]> {
    const id = await this.resolveChannel(channel);
    const d = await this.slack<SlackOk & { messages: Array<{ ts: string; user?: string; bot_id?: string; text: string; thread_ts?: string; reply_count?: number }> }>(
      'conversations.history', { query: { channel: id, limit: Math.min(o.limit ?? 30, 200), oldest: o.oldest, latest: o.latest } },
    );
    return d.messages.map((m) => ({ ts: m.ts, user: m.user ?? m.bot_id ?? '', text: m.text, threadTs: m.thread_ts ?? null, replies: m.reply_count ?? 0 }));
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<{ channel: string; ts: string }> {
    const id = await this.resolveChannel(channel);
    const d = await this.slack<SlackOk & { channel: string; ts: string }>('chat.postMessage', { method: 'POST', json: { channel: id, text, thread_ts: threadTs } });
    return { channel: d.channel, ts: d.ts };
  }

  /**
   * Poll API (P5), fallback only: messages newer than `cursor` (a Slack ts) in one channel, oldest first.
   * Non-Marketplace apps get about 1 request/minute on conversations.history, so real-time triggers should
   * use Socket Mode (`openSocketModeUrl`) and keep this for catch-up after a reconnect.
   */
  async pollChannel(channel: string, o: { cursor?: string | null } = {}): Promise<PollResult<SlackMessage>> {
    const msgs = await this.history(channel, { limit: 100, oldest: o.cursor ?? undefined });
    const fresh = msgs.filter((m) => !o.cursor || m.ts !== o.cursor).reverse();
    return { items: fresh, cursor: fresh.length ? fresh[fresh.length - 1].ts : (o.cursor ?? null), notModified: fresh.length === 0, resync: false };
  }

  /**
   * Socket Mode (P5): a one-time `wss://` URL for an outbound WebSocket. Needs the `xapp-` app-level token
   * with `connections:write`; the bot token cannot open it.
   */
  async openSocketModeUrl(): Promise<string> {
    const app = await this.deps.appToken?.();
    if (!app) throw new IntegrationError('Socket Mode needs the Slack app-level token (xapp-…); add it in Settings → Integrations', 400);
    const r = await apiRequest<SlackOk & { url: string }>(this.deps.fetch, API + 'apps.connections.open', { method: 'POST', headers: { authorization: 'Bearer ' + app } });
    return check('apps.connections.open', r).url;
  }
}

function check<T extends SlackOk>(method: string, r: ApiResponse<T>): T {
  if (r.data && r.data.ok) return r.data;
  const e = r.data?.error ?? 'unknown_error';
  throw new IntegrationError('Slack ' + method + ' failed: ' + e, r.status === 200 ? (AUTH_ERRORS.has(e) ? 401 : 400) : r.status, AUTH_ERRORS.has(e));
}
