import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { TelegramState } from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import { TelegramRepo } from '../db/telegramRepo.js';
import { events } from '../events.js';
import { IntegrationError, type Fetch } from '../integrations/http.js';
import { TELEGRAM_TOKEN_RE, TelegramClient, type TelegramUpdate } from '../integrations/telegram.js';
import { addSecret, logError } from '../providers/redact.js';
import type { IntegrationVault } from './IntegrationVault.js';
import type { PushKind } from './PushService.js';

/** A link code lives this long and works once. */
export const LINK_TTL_MS = 10 * 60 * 1000;
/** Wrong codes from private chats before linking locks. */
export const MAX_WRONG_CODES = 5;
export const LOCK_MS = 15 * 60 * 1000;
/** How long Telegram may hold one getUpdates open while a link is waiting. */
const POLL_WAIT_SEC = 10;
const POLL_GAP_MS = 500;
const POLL_FAILS_MAX = 3;
const VAULT_KEY = 'telegram';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const CONFLICT_MESSAGE = 'Another PocketRocket or a webhook uses this bot. Use a separate bot for this hub.';

/**
 * The whole of what Telegram is ever sent. One fixed line per kind: no bot, room, tool or message text, no
 * cost. Exported so tests can pin the bytes.
 */
export const TELEGRAM_TEXT: Record<PushKind | 'linked', string> = {
  approval: 'A bot needs your approval.',
  routine: 'A routine finished.',
  test: 'Test from PocketRocket. Notifications to this chat work.',
  linked: 'PocketRocket is linked to this chat.',
};

export interface TelegramServiceOptions {
  db: Db;
  vault: IntegrationVault;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where the owner opens the hub from a phone (their Tailscale name), or null when none is set up. */
  hubUrl?: () => string | null;
  /** Tests: a fixed link code. */
  makeCode?: () => string;
}

interface Pending { code: string; issuedAt: number; expiresAt: number }

/**
 * Telegram notifications (spec 03 Phase A). Outbound only: `sendMessage` for content-free notices, plus one short
 * `getUpdates` poll that runs only while a link code is waiting. No standing poll, no webhook, no inbound turns.
 *
 * The owner is whoever sends `/start <code>` from a private chat; what is stored is that sender's numeric id.
 * The token is in the vault; everything that can reach a log goes through `redact` (see `integrations/telegram.ts`).
 */
export class TelegramService {
  private repo: TelegramRepo;
  private client: TelegramClient;
  private fetch: Fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private pending: Pending | null = null;
  private wrong = 0;
  private lockedUntil = 0;
  private offset: number | undefined;
  private abort: AbortController | null = null;
  private error: string | null = null;

  constructor(private opts: TelegramServiceOptions) {
    this.repo = new TelegramRepo(opts.db);
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.client = new TelegramClient({ fetch: this.fetch, token: () => this.token() });
    // Register the stored token with the redactor right away, not only when the vault is first read for a call.
    addSecret(this.token());
  }

  private changed() {
    events.emitEvent({ type: 'integrations.changed' });
  }

  /** The stored token. An unreadable vault reads as "not set up" so Settings still opens. */
  private token(): string | null {
    try { return this.opts.vault.get(VAULT_KEY)?.token ?? null; } catch { return null; }
  }

  state(): TelegramState {
    const row = this.repo.get();
    const t = this.now();
    if (this.pending && this.pending.expiresAt <= t) this.pending = null;
    const configured = !!this.token() && !!row.botUsername;
    const linked = configured && !!row.chatId;
    return {
      configured,
      botUsername: configured ? row.botUsername : null,
      linked,
      linkedName: linked ? row.linkedName : null,
      notify: linked && row.notify,
      pendingCode: this.pending && configured
        ? { code: this.pending.code, deepLink: 'https://t.me/' + row.botUsername + '?start=' + this.pending.code, expiresAt: this.pending.expiresAt }
        : null,
      error: this.lockedUntil > t ? this.lockMessage() : this.error,
    };
  }

  private lockMessage(): string {
    const min = Math.max(1, Math.ceil((this.lockedUntil - this.now()) / 60_000));
    return 'Linking is locked after too many wrong codes. Try again in ' + min + ' minute' + (min === 1 ? '' : 's') + '.';
  }

  // ---------------------------------------------------------------- token
  /** Checks the token with `getMe` (a bad one gives Telegram's own words), then saves it. */
  async setToken(raw: string): Promise<TelegramState> {
    const token = String(raw ?? '').trim();
    if (!TELEGRAM_TOKEN_RE.test(token)) throw new IntegrationError('That does not look like a Telegram bot token (12345678:AA...). Copy it from @BotFather.', 400);
    addSecret(token);
    let me;
    try {
      me = await new TelegramClient({ fetch: this.fetch, token: () => token }).getMe();
    } catch (e) {
      // Telegram answers an unknown token with 401 (or 404 for a malformed one): to the owner both are "that token is wrong".
      if (e instanceof IntegrationError && (e.status === 401 || e.status === 404)) throw new IntegrationError(e.message, 400);
      throw e;
    }
    if (!me.username) throw new IntegrationError('Telegram returned no username for this bot', 502);
    const row = this.repo.get();
    // A different bot cannot inherit the old link: that chat never talked to it.
    if (row.botId && row.botId !== String(me.id)) this.dropLink();
    this.opts.vault.set(VAULT_KEY, { token });
    this.repo.setBot(String(me.id), me.username);
    this.error = null;
    this.changed();
    return this.state();
  }

  removeToken(): TelegramState {
    this.stopPolling();
    this.pending = null;
    this.wrong = 0;
    this.lockedUntil = 0;
    this.error = null;
    this.opts.vault.delete(VAULT_KEY);
    this.repo.clearAll();
    this.changed();
    return this.state();
  }

  // ---------------------------------------------------------------- link
  /** Issues a code and starts the short poll. 429 while locked; 409 when a webhook or another hub holds the bot. */
  async link(): Promise<TelegramState> {
    const t = this.now();
    if (!this.state().configured) throw new IntegrationError('Add a bot token first', 400);
    if (this.repo.get().chatId) throw new IntegrationError('Already linked. Unlink first to link another account.', 400);
    if (this.lockedUntil > t) throw new IntegrationError(this.lockMessage(), 429);
    if (this.lockedUntil) { this.lockedUntil = 0; this.wrong = 0; }
    this.stopPolling();
    this.error = null;
    this.pending = { code: this.makeCode(), issuedAt: t, expiresAt: t + LINK_TTL_MS };
    this.abort = new AbortController();
    const ac = this.abort;
    try {
      // One immediate pass, so a webhook or a second hub shows up as an error here and not as a code that never works.
      await this.pollOnce(0);
    } catch (e) {
      this.pending = null;
      this.stopPolling();
      if (e instanceof IntegrationError && e.status === 409) {
        this.error = CONFLICT_MESSAGE;
        this.changed();
        throw new IntegrationError(CONFLICT_MESSAGE, 409);
      }
      throw e;
    }
    if (this.pending && !ac.signal.aborted) void this.loop(ac);
    this.changed();
    return this.state();
  }

  unlink(): TelegramState {
    this.error = null;
    this.dropLink();
    this.changed();
    return this.state();
  }

  private dropLink() {
    this.stopPolling();
    this.pending = null;
    this.repo.clearLink();
  }

  setNotify(on: boolean): TelegramState {
    if (!this.state().linked) throw new IntegrationError('Link your Telegram first', 400);
    this.repo.setNotify(on);
    this.changed();
    return this.state();
  }

  private makeCode(): string {
    if (this.opts.makeCode) return this.opts.makeCode();
    return Array.from(randomBytes(10), (b) => BASE32[b % 32]).join('');
  }

  private stopPolling() {
    this.abort?.abort();
    this.abort = null;
  }

  /** Hub shutdown: aborts an in-flight poll and does not wait for it. */
  stop(): void {
    this.stopPolling();
    this.pending = null;
  }

  private async loop(ac: AbortController): Promise<void> {
    let fails = 0;
    while (!ac.signal.aborted && this.pending) {
      if (this.pending.expiresAt <= this.now()) {
        this.pending = null;
        this.changed();
        return;
      }
      try {
        await this.pollOnce(POLL_WAIT_SEC);
        fails = 0;
      } catch (e) {
        if (ac.signal.aborted) return;
        const status = e instanceof IntegrationError ? e.status : 0;
        fails++;
        if (status === 409 || status === 401 || fails >= POLL_FAILS_MAX) {
          this.pending = null;
          this.error = status === 409 ? CONFLICT_MESSAGE : status === 401 ? 'Telegram refused the bot token. Paste it again.' : 'Could not reach Telegram. Start linking again.';
          if (status !== 409 && status !== 401) logError('[telegram]', e);
          this.changed();
          return;
        }
      }
      if (ac.signal.aborted || !this.pending) return;
      await this.sleep(POLL_GAP_MS);
    }
  }

  /** One getUpdates call; acknowledges everything it saw and links on the first valid code. Exposed for tests. */
  async pollOnce(waitSec: number): Promise<void> {
    if (!this.pending) return;
    const updates = await this.client.getUpdates({ offset: this.offset, timeoutSec: waitSec, signal: this.abort?.signal });
    let linked = false;
    for (const u of updates) {
      if (typeof u.update_id === 'number') this.offset = Math.max(this.offset ?? 0, u.update_id + 1);
      if (!linked && this.pending && this.handle(u)) linked = true;
    }
    if (!linked) return;
    this.stopPolling();
    // Tell Telegram the linking update is done, so a later link does not see it again. Best effort.
    try { await this.client.getUpdates({ offset: this.offset, timeoutSec: 0 }); } catch { /* the date check covers a redelivery */ }
    this.error = null;
    this.changed();
    await this.sendSafe('linked');
  }

  /** True when this update carried the right code from the right kind of sender. */
  private handle(u: TelegramUpdate): boolean {
    const p = this.pending;
    const m = u.message;
    if (!p || !m || !m.chat || !m.from) return false;
    if (m.chat.type !== 'private' || m.from.is_bot !== false || m.from.id !== m.chat.id) return false;
    if (typeof m.date !== 'number' || m.date < Math.floor(p.issuedAt / 1000) || m.date * 1000 > p.expiresAt || this.now() > p.expiresAt) return false;
    const text = (m.text ?? '').trim();
    const candidate = /^\/start(?:@\w+)?\s+(\S{1,64})$/.exec(text)?.[1] ?? (/^[A-Za-z0-9]{8,32}$/.test(text) ? text : null);
    if (candidate === null) return false;
    const a = Buffer.from(candidate.toUpperCase());
    const b = Buffer.from(p.code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').slice(0, 64) || 'Telegram user';
      this.repo.setLink(String(m.from.id), name, this.now());
      this.pending = null;
      this.wrong = 0;
      return true;
    }
    if (++this.wrong >= MAX_WRONG_CODES) {
      this.pending = null;
      this.lockedUntil = this.now() + LOCK_MS;
      this.stopPolling();
      this.changed();
    }
    return false;
  }

  // ---------------------------------------------------------------- sending
  /** Linked, and the owner switched notifications on. */
  ready(): boolean {
    const s = this.state();
    return s.linked && s.notify;
  }

  private text(kind: PushKind | 'linked'): string {
    const url = this.opts.hubUrl?.() ?? null;
    return TELEGRAM_TEXT[kind] + (url ? '\n\n' + url : '');
  }

  /** The owner's "Send a test": throws what Telegram said when it fails. */
  async sendTest(): Promise<void> {
    const row = this.repo.get();
    if (!this.state().linked || !row.chatId) throw new IntegrationError('Link your Telegram first', 400);
    await this.client.sendMessage(row.chatId, this.text('test'));
    this.error = null;
    this.changed();
  }

  /** A hub event. Never throws: a Telegram outage must not break an approval card. */
  async notify(kind: PushKind): Promise<void> {
    if (!this.ready()) return;
    await this.sendSafe(kind);
  }

  private async sendSafe(kind: PushKind | 'linked'): Promise<void> {
    const chat = this.repo.get().chatId;
    if (!chat) return;
    try {
      await this.client.sendMessage(chat, this.text(kind));
      if (this.error) { this.error = null; this.changed(); }
    } catch (e) {
      logError('[telegram]', e);
      this.error = 'Could not send to Telegram: ' + (e instanceof IntegrationError ? e.message : 'unknown error');
      this.changed();
    }
  }
}
