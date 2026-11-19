import { nanoid } from 'nanoid';
import { PROVIDER_IDS, type FailoverCard, type ProviderId } from '@pocketrocket/shared';
import type { Db } from './db.js';

/*
 * M8 (P3-1) data access: failover cards (migration 313). Kept out of `repos.ts`, like db/approvalStore.ts.
 */

/** A card as the hub keeps it: the public card plus what Continue needs to queue the turn again. */
export interface FailoverRecord extends FailoverCard {
  causeId: string;
  hop: number;
  /** The limited turn's read window: the session's cursor before it (`fromSeq`) and the seq it read up to (`toSeq`). */
  fromSeq: number;
  toSeq: number;
  /** What the limited turn had left to spend; null = no dollar cap. */
  budgetUsd: number | null;
  answeredAt: number | null;
}

interface Raw {
  id: string; bot_id: string; room_id: string; cause_id: string; hop: number; provider: string; model: string | null;
  limit_window: string | null; backup_provider: string; backup_model: string; resets_at: number | null; expires_at: number;
  from_seq: number; to_seq: number; budget_usd: number | null; status: string; created_at: number; answered_at: number | null;
}

const providerId = (s: string): ProviderId => ((PROVIDER_IDS as readonly string[]).includes(s) ? (s as ProviderId) : 'claude');
const STATUSES: FailoverCard['status'][] = ['pending', 'continued', 'waited', 'expired'];

const toRecord = (r: Raw): FailoverRecord => ({
  id: r.id, botId: r.bot_id, roomId: r.room_id, causeId: r.cause_id, hop: r.hop,
  provider: providerId(r.provider), ...(r.model ? { model: r.model } : {}), ...(r.limit_window ? { window: r.limit_window } : {}),
  backup: { provider: providerId(r.backup_provider), model: r.backup_model },
  ...(r.resets_at != null ? { resetsAt: r.resets_at } : {}), expiresAt: r.expires_at,
  fromSeq: r.from_seq, toSeq: r.to_seq, budgetUsd: r.budget_usd,
  status: STATUSES.includes(r.status as FailoverCard['status']) ? (r.status as FailoverCard['status']) : 'expired',
  createdAt: r.created_at, answeredAt: r.answered_at,
});

/** The public shape (GET /api/failover, the WS event): no cause, seqs or budget. */
export function publicCard(r: FailoverRecord): FailoverCard {
  const { causeId: _c, hop: _h, fromSeq: _f, toSeq: _t, budgetUsd: _b, answeredAt: _a, ...card } = r;
  return card;
}

export class FailoverRepo {
  constructor(readonly db: Db) {}

  insert(c: Omit<FailoverRecord, 'id' | 'status' | 'answeredAt'>): FailoverRecord {
    const id = nanoid(10);
    this.db.run(
      `INSERT INTO failover_cards (id, bot_id, room_id, cause_id, hop, provider, model, limit_window, backup_provider, backup_model,
        resets_at, expires_at, from_seq, to_seq, budget_usd, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
      id, c.botId, c.roomId, c.causeId, c.hop, c.provider, c.model ?? null, c.window ?? null, c.backup.provider, c.backup.model,
      c.resetsAt ?? null, c.expiresAt, c.fromSeq, c.toSeq, c.budgetUsd, c.createdAt,
    );
    return this.get(id)!;
  }

  /** A later limit in the same chat while the card is still open: it now continues that turn (the window keeps its start). */
  refresh(id: string, c: Pick<FailoverRecord, 'causeId' | 'hop' | 'toSeq' | 'budgetUsd' | 'expiresAt'> & { resetsAt?: number }) {
    this.db.run(
      "UPDATE failover_cards SET cause_id=?, hop=?, to_seq=?, budget_usd=?, expires_at=?, resets_at=? WHERE id=? AND status='pending'",
      c.causeId, c.hop, c.toSeq, c.budgetUsd, c.expiresAt, c.resetsAt ?? null, id,
    );
  }

  get(id: string): FailoverRecord | undefined {
    const r = this.db.get<Raw>('SELECT * FROM failover_cards WHERE id=?', id);
    return r ? toRecord(r) : undefined;
  }

  pendingFor(botId: string, roomId: string): FailoverRecord | undefined {
    const r = this.db.get<Raw>("SELECT * FROM failover_cards WHERE bot_id=? AND room_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1", botId, roomId);
    return r ? toRecord(r) : undefined;
  }

  listPending(): FailoverRecord[] {
    return this.db.all<Raw>("SELECT * FROM failover_cards WHERE status='pending' ORDER BY created_at").map(toRecord);
  }

  /** Continued cards still in force at `now`: their bots run attended turns on the backup. */
  listActive(now: number): FailoverRecord[] {
    return this.db.all<Raw>("SELECT * FROM failover_cards WHERE status='continued' AND expires_at > ? ORDER BY created_at", now).map(toRecord);
  }

  /** Moves a pending card to its answer. False when it was no longer pending (answered twice, or expired meanwhile). */
  settle(id: string, status: Exclude<FailoverCard['status'], 'pending'>, at: number): boolean {
    const before = this.get(id);
    if (before?.status !== 'pending') return false;
    this.db.run("UPDATE failover_cards SET status=?, answered_at=? WHERE id=? AND status='pending'", status, at, id);
    return true;
  }

  /** A deleted bot or room takes its cards with it. */
  pruneOrphans(liveBotIds: string[], liveRoomIds: string[]) {
    const bots = new Set(liveBotIds);
    const rooms = new Set(liveRoomIds);
    for (const r of this.db.all<{ id: string; bot_id: string; room_id: string }>('SELECT id, bot_id, room_id FROM failover_cards')) {
      if (!bots.has(r.bot_id) || !rooms.has(r.room_id)) this.db.run('DELETE FROM failover_cards WHERE id=?', r.id);
    }
  }
}
