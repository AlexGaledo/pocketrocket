import { nanoid } from 'nanoid';
import type { IntegrationInfo, IntegrationMethod, IntegrationProvider, IntegrationStatus } from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

/** The rows behind integrations (P4). Secrets never touch these tables; see IntegrationVault. */
export class IntegrationRepo {
  constructor(private db: Db) {}

  private rowTo(r: Row): IntegrationInfo {
    const id = r.id as string;
    return {
      id,
      provider: r.provider as IntegrationProvider,
      method: r.method as IntegrationMethod,
      accountLabel: (r.account_label as string) ?? '',
      scopes: JSON.parse((r.scopes as string) || '[]'),
      status: r.status as IntegrationStatus,
      lastError: (r.last_error as string) ?? null,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      lastCheckedAt: (r.last_checked_at as number) ?? null,
      botIds: this.grantedBots(id),
      warnings: JSON.parse((r.warnings as string) || '[]'),
    };
  }

  list(): IntegrationInfo[] {
    return this.db.all('SELECT * FROM integrations ORDER BY created_at').map((r) => this.rowTo(r));
  }
  get(id: string): IntegrationInfo | undefined {
    const r = this.db.get('SELECT * FROM integrations WHERE id=?', id);
    return r ? this.rowTo(r) : undefined;
  }
  byProvider(provider: IntegrationProvider): IntegrationInfo | undefined {
    const r = this.db.get('SELECT * FROM integrations WHERE provider=?', provider);
    return r ? this.rowTo(r) : undefined;
  }

  /**
   * One connection per provider: connecting again (another account, or the other method) replaces the
   * row in place, so its id and therefore the bots' grants survive a reconnect.
   */
  upsert(i: { provider: IntegrationProvider; method: IntegrationMethod; accountLabel: string; scopes: string[]; warnings?: string[] }): IntegrationInfo {
    const t = Date.now();
    const cur = this.byProvider(i.provider);
    if (cur) {
      this.db.run(
        "UPDATE integrations SET method=?, account_label=?, scopes=?, warnings=?, status='connected', last_error=NULL, updated_at=?, last_checked_at=? WHERE id=?",
        i.method, i.accountLabel, JSON.stringify(i.scopes), JSON.stringify(i.warnings ?? []), t, t, cur.id,
      );
      return this.get(cur.id)!;
    }
    const id = nanoid(10);
    this.db.run(
      "INSERT INTO integrations (id, provider, method, account_label, scopes, status, warnings, created_at, updated_at, last_checked_at) VALUES (?,?,?,?,?,'connected',?,?,?,?)",
      id, i.provider, i.method, i.accountLabel, JSON.stringify(i.scopes), JSON.stringify(i.warnings ?? []), t, t, t,
    );
    return this.get(id)!;
  }

  setStatus(id: string, status: IntegrationStatus, error: string | null, accountLabel?: string) {
    const t = Date.now();
    if (accountLabel !== undefined) {
      this.db.run('UPDATE integrations SET status=?, last_error=?, account_label=?, last_checked_at=?, updated_at=? WHERE id=?', status, error, accountLabel, t, t, id);
    } else {
      this.db.run('UPDATE integrations SET status=?, last_error=?, last_checked_at=?, updated_at=? WHERE id=?', status, error, t, t, id);
    }
  }

  delete(id: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM bot_integrations WHERE integration_id=?', id);
      this.db.run('DELETE FROM integrations WHERE id=?', id);
    });
  }

  // ---------- grants ----------
  grantedBots(integrationId: string): string[] {
    return this.db.all<{ bot_id: string }>('SELECT bot_id FROM bot_integrations WHERE integration_id=? ORDER BY created_at', integrationId).map((r) => r.bot_id);
  }
  /** Connections this bot may use. */
  forBot(botId: string): IntegrationInfo[] {
    return this.db
      .all('SELECT i.* FROM integrations i JOIN bot_integrations g ON g.integration_id = i.id WHERE g.bot_id=? ORDER BY i.created_at', botId)
      .map((r) => this.rowTo(r));
  }
  setGrants(integrationId: string, botIds: string[]) {
    const t = Date.now();
    this.db.tx(() => {
      this.db.run('DELETE FROM bot_integrations WHERE integration_id=?', integrationId);
      for (const b of new Set(botIds)) this.db.run('INSERT INTO bot_integrations (bot_id, integration_id, scopes, created_at) VALUES (?,?,?,?)', b, integrationId, '[]', t);
    });
  }
  /** Drop grants that point at bots which no longer exist. Returns how many went. */
  pruneGrants(liveBotIds: string[]): number {
    const live = new Set(liveBotIds);
    const rows = this.db.all<{ bot_id: string }>('SELECT DISTINCT bot_id FROM bot_integrations');
    let n = 0;
    for (const r of rows) {
      if (live.has(r.bot_id)) continue;
      n += Number(this.db.run('DELETE FROM bot_integrations WHERE bot_id=?', r.bot_id).changes);
    }
    return n;
  }
}
