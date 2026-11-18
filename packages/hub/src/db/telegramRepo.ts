import type { Db } from './db.js';

/** The one Telegram link (migration 300). No secret in here: the token lives in the vault. */
export interface TelegramLinkRow {
  botId: string | null;
  botUsername: string | null;
  /** Numeric Telegram user id (== private chat id), as a string. Never a username. */
  chatId: string | null;
  linkedName: string | null;
  notify: boolean;
  linkedAt: number | null;
}

export class TelegramRepo {
  constructor(private db: Db) {}

  get(): TelegramLinkRow {
    const r = this.db.get('SELECT * FROM telegram_link WHERE id=1');
    return {
      botId: (r?.bot_id as string) ?? null,
      botUsername: (r?.bot_username as string) ?? null,
      chatId: (r?.chat_id as string) ?? null,
      linkedName: (r?.linked_name as string) ?? null,
      notify: !!r?.notify,
      linkedAt: (r?.linked_at as number) ?? null,
    };
  }

  setBot(botId: string, botUsername: string): void {
    this.db.run(
      'INSERT INTO telegram_link (id, bot_id, bot_username) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id, bot_username=excluded.bot_username',
      botId, botUsername,
    );
  }

  setLink(chatId: string, name: string, at: number): void {
    this.db.run('UPDATE telegram_link SET chat_id=?, linked_name=?, linked_at=?, notify=0 WHERE id=1', chatId, name, at);
  }

  clearLink(): void {
    this.db.run('UPDATE telegram_link SET chat_id=NULL, linked_name=NULL, linked_at=NULL, notify=0 WHERE id=1');
  }

  setNotify(on: boolean): void {
    this.db.run('UPDATE telegram_link SET notify=? WHERE id=1', on ? 1 : 0);
  }

  clearAll(): void {
    this.db.run('DELETE FROM telegram_link WHERE id=1');
  }
}
