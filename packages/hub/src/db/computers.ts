import type { ComputerState } from '@pocketrocket/shared';
import type { Db } from './db.js';

/** One row of the `computers` table (migration 10). */
export interface ComputerRow {
  botId: string;
  slot: number;
  state: ComputerState;
  lastUsedAt: number | null;
  diskBytes: number;
  quotaBytes: number;
  keepAwake: boolean;
  createdAt: number;
}

interface Raw {
  bot_id: string; slot: number; state: string; last_used_at: number | null; disk_bytes: number; quota_bytes: number;
  keep_awake: number; created_at: number;
}
const toRow = (r: Raw): ComputerRow => ({
  botId: r.bot_id, slot: r.slot, state: (['asleep', 'starting', 'live'].includes(r.state) ? r.state : 'asleep') as ComputerState,
  lastUsedAt: r.last_used_at, diskBytes: r.disk_bytes, quotaBytes: r.quota_bytes, keepAwake: !!r.keep_awake, createdAt: r.created_at,
});

/**
 * Data access for per-bot computers. Kept out of `repos.ts` so this phase's table lives in one file of its own
 * (parallel phases append to repos.ts); it follows the same pattern and goes through the same `Db`.
 */
export class ComputersRepo {
  constructor(readonly db: Db) {}

  get(botId: string): ComputerRow | undefined {
    const r = this.db.get<Raw>('SELECT * FROM computers WHERE bot_id=?', botId);
    return r ? toRow(r) : undefined;
  }
  list(): ComputerRow[] {
    return this.db.all<Raw>('SELECT * FROM computers ORDER BY slot').map(toRow);
  }
  /**
   * The bot's row, creating it on the lowest free slot in [1, maxSlot] when it has none. Returns null when
   * every slot is taken. Runs in one transaction so two bots can never be handed the same slot.
   */
  allocate(botId: string, maxSlot: number, quotaBytes: number, now: number): ComputerRow | null {
    return this.db.tx(() => {
      const cur = this.get(botId);
      if (cur) return cur;
      const used = new Set(this.db.all<{ slot: number }>('SELECT slot FROM computers').map((r) => r.slot));
      let slot = 0;
      for (let n = 1; n <= maxSlot; n++) if (!used.has(n)) { slot = n; break; }
      if (!slot) return null;
      this.db.run(
        'INSERT INTO computers (bot_id, slot, state, last_used_at, disk_bytes, quota_bytes, keep_awake, created_at) VALUES (?,?,?,?,?,?,?,?)',
        botId, slot, 'asleep', null, 0, quotaBytes, 0, now,
      );
      return this.get(botId)!;
    });
  }
  setState(botId: string, state: ComputerState) {
    this.db.run('UPDATE computers SET state=? WHERE bot_id=?', state, botId);
  }
  touch(botId: string, at: number) {
    this.db.run('UPDATE computers SET last_used_at=? WHERE bot_id=?', at, botId);
  }
  setKeepAwake(botId: string, on: boolean) {
    this.db.run('UPDATE computers SET keep_awake=? WHERE bot_id=?', on ? 1 : 0, botId);
  }
  setDisk(botId: string, bytes: number) {
    this.db.run('UPDATE computers SET disk_bytes=? WHERE bot_id=?', Math.max(0, Math.round(bytes)), botId);
  }
  remove(botId: string) {
    this.db.run('DELETE FROM computers WHERE bot_id=?', botId);
  }
}
