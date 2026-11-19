import { apiRequest, IntegrationError, type Fetch } from './http.js';
import { addSecret } from '../providers/redact.js';

/** What a Telegram bot token looks like: `<bot id>:<secret>`. Checked before it is put into a URL path. */
export const TELEGRAM_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;

export interface TelegramMe { id: number; username: string; firstName: string }
export interface TelegramUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id?: number; date?: number; text?: string; chat?: { id: number; type: string }; from?: TelegramUser };
}

type Envelope<T> = { ok: boolean; result?: T; description?: string; error_code?: number };

export interface TelegramDeps {
  fetch: Fetch;
  /** The bot token, read per call so a replaced or removed token takes effect at once. */
  token(): string | null;
}

/**
 * The three Bot API calls Phase A needs. The token is part of the URL path (`/bot<token>/<method>`), so:
 * the URL is built here and nowhere else, it is never logged or put into a message, and every error that comes
 * out is an IntegrationError, whose message is redacted when it is made (`integrations/http.ts`).
 * `deleteWebhook` is deliberately absent: a webhook that someone else set up is theirs to remove.
 */
export class TelegramClient {
  constructor(private deps: TelegramDeps) {}

  private async call<T>(method: string, json: unknown, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const token = this.deps.token();
    if (!token) throw new IntegrationError('Telegram is not set up', 404);
    addSecret(token);
    const r = await apiRequest<Envelope<T>>(this.deps.fetch, 'https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', json, ...o });
    if (!r.data || typeof r.data !== 'object' || !r.data.ok) {
      const code = r.data?.error_code ?? r.status;
      throw new IntegrationError('Telegram ' + method + ' failed' + (r.data?.description ? ': ' + r.data.description : ''), code, code === 401);
    }
    return r.data.result as T;
  }

  async getMe(): Promise<TelegramMe> {
    const u = await this.call<{ id: number; username?: string; first_name?: string }>('getMe', {});
    return { id: u.id, username: u.username ?? '', firstName: u.first_name ?? '' };
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: typeof chatId === 'string' ? Number(chatId) : chatId, text, link_preview_options: { is_disabled: true } });
  }

  /** Messages only. `timeoutSec` is how long Telegram may hold the request open (0 = answer now). */
  async getUpdates(o: { offset?: number; timeoutSec: number; signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset: o.offset, timeout: o.timeoutSec, limit: 20, allowed_updates: ['message'] },
      { signal: o.signal, timeoutMs: o.timeoutSec * 1000 + 8000 },
    );
  }
}
