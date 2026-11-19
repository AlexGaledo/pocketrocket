/**
 * Settings › Notifications › Telegram. The hub keeps the bot token; these types are what /api/telegram answers
 * (never the token). `TelegramController` holds the card's state and runs its actions against an injected api,
 * so the behaviour (busy, errors, the code running out) is testable without a DOM.
 */
export interface TelegramState {
  configured: boolean;
  botUsername: string | null;
  linked: boolean;
  linkedName: string | null;
  notify: boolean;
  pendingCode: { code: string; deepLink: string; expiresAt: number } | null;
  error: string | null;
}

export interface TelegramApi {
  get: () => Promise<TelegramState>;
  setToken: (token: string) => Promise<TelegramState>;
  removeToken: () => Promise<TelegramState>;
  link: () => Promise<TelegramState>;
  unlink: () => Promise<TelegramState>;
  setNotify: (notify: boolean) => Promise<TelegramState>;
  test: () => Promise<{ ok: true }>;
}

/** A link code is shown for ten minutes. */
export const LINK_CODE_MINUTES = 10;

/** Only a Telegram address is ever opened from the card; anything else the hub sent is dropped. */
export function safeDeepLink(link: string | undefined | null): string | null {
  return typeof link === 'string' && /^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}(\?start=[A-Za-z0-9_-]{1,64})?$/.test(link) ? link : null;
}

/** `Dana Reyes` → `D•••`: enough to recognise your own chat, not to copy it down. */
export function maskChatName(name: string): string {
  const first = Array.from(name.trim())[0];
  return (first ?? '') + '•••';
}

/** The code as a screen reader should read it: one character at a time. */
export const spokenCode = (code: string) => code.split('').join(' ');

export interface TelegramView {
  state: TelegramState | null;
  busy: boolean;
  /** An action's failure (Telegram's own words for a bad token). Shown under the card. */
  error: string | null;
  /** A short confirmation, e.g. "Test sent". */
  notice: string | null;
}

export class TelegramController {
  view: TelegramView = { state: null, busy: false, error: null, notice: null };
  constructor(private api: TelegramApi, private onChange: () => void) {}

  private set(patch: Partial<TelegramView>) {
    this.view = { ...this.view, ...patch };
    this.onChange();
  }

  /** Quiet refresh (first load, polling while a code is pending, a WS nudge): errors only show on first load. */
  async load(quiet = false) {
    try {
      this.set({ state: await this.api.get(), ...(quiet ? {} : { error: null }) });
    } catch (e) {
      if (!quiet || !this.view.state) this.set({ error: (e as Error).message || "Couldn't load Telegram settings." });
    }
  }

  private async run(fn: () => Promise<TelegramState | { ok: true }>, notice: string | null = null) {
    if (this.view.busy) return;
    this.set({ busy: true, error: null, notice: null });
    try {
      const r = await fn();
      this.set({ busy: false, notice, ...('ok' in r ? {} : { state: r }) });
    } catch (e) {
      this.set({ busy: false, error: (e as Error).message || 'Something went wrong. Try again.' });
    }
  }

  /** An empty token removes the bot (and its link). */
  saveToken = (token: string) => this.run(() => (token.trim() ? this.api.setToken(token.trim()) : this.api.removeToken()));
  startLink = () => this.run(() => this.api.link());
  unlink = () => this.run(() => this.api.unlink());
  setNotify = (on: boolean) => this.run(() => this.api.setNotify(on));
  sendTest = () => this.run(() => this.api.test(), 'Test sent. Check Telegram.');
  clearError = () => this.set({ error: null });
  /** The code ran out locally: forget it and ask the hub. */
  codeExpired = () => {
    const s = this.view.state;
    if (s?.pendingCode) this.set({ state: { ...s, pendingCode: null } });
    return this.load(true);
  };
}
