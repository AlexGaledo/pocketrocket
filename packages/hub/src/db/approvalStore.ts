import { nanoid } from 'nanoid';
import type { ApprovalPolicy } from '@pocketrocket/shared';
import type { Db } from './db.js';

/*
 * P2 data access (migrations 20-21): parked approvals and approval rules. Kept out of `repos.ts`, like
 * db/computers.ts, so this phase's tables live in a file of their own.
 */

/** An approval card a routine/trigger turn stopped waiting on (`approvals.parked_at` set, still pending). */
export interface ParkedApproval {
  id: string;
  botId: string;
  roomId: string;
  toolName: string;
  toolInput: unknown;
  reason: string;
  causeId: string;
  hop: number;
  runId: string | null;
  messageId: string | null;
  parkedAt: number;
}

export type PolicyScope = 'always' | 'session';
export interface StoredPolicy extends ApprovalPolicy {
  scope: PolicyScope;
}

interface ParkedRaw {
  id: string; bot_id: string; room_id: string; tool_name: string; tool_input: string | null; reason: string | null;
  cause_id: string | null; hop: number | null; run_id: string | null; message_id: string | null; parked_at: number;
}
interface PolicyRaw { id: string; bot_id: string; tool: string; pattern: string; decision: string; scope: string; created_at: number }

const toParked = (r: ParkedRaw): ParkedApproval => {
  let input: unknown = null;
  try { input = r.tool_input ? JSON.parse(r.tool_input) : null; } catch { /* keep null */ }
  return {
    id: r.id, botId: r.bot_id, roomId: r.room_id, toolName: r.tool_name, toolInput: input, reason: r.reason ?? '',
    causeId: r.cause_id ?? r.id, hop: r.hop ?? 0, runId: r.run_id, messageId: r.message_id, parkedAt: r.parked_at,
  };
};
const toPolicy = (r: PolicyRaw): StoredPolicy => ({
  id: r.id, botId: r.bot_id, tool: r.tool, pattern: r.pattern, decision: r.decision === 'deny' ? 'deny' : 'allow',
  scope: r.scope === 'session' ? 'session' : 'always', createdAt: r.created_at,
});

export class ApprovalStore {
  constructor(readonly db: Db, private now: () => number = Date.now) {}

  // ---------- parked approvals ----------
  park(id: string, p: { causeId: string; hop: number; runId: string | null; messageId: string }) {
    this.db.run(
      "UPDATE approvals SET parked_at=?, cause_id=?, hop=?, run_id=?, message_id=? WHERE id=? AND status='pending'",
      this.now(), p.causeId, p.hop, p.runId, p.messageId, id,
    );
  }
  getParked(id: string): ParkedApproval | undefined {
    const r = this.db.get<ParkedRaw>("SELECT * FROM approvals WHERE id=? AND status='pending' AND parked_at IS NOT NULL", id);
    return r ? toParked(r) : undefined;
  }
  listParked(): ParkedApproval[] {
    return this.db.all<ParkedRaw>("SELECT * FROM approvals WHERE status='pending' AND parked_at IS NOT NULL ORDER BY parked_at").map(toParked);
  }
  /** Routine runs a parked card still holds open (FollowUp must not close them at startup). */
  parkedRunIds(): string[] {
    return this.listParked().map((p) => p.runId).filter((r): r is string => !!r);
  }

  // ---------- approval rules ----------
  listPolicies(botId?: string, scope: PolicyScope | 'all' = 'always'): StoredPolicy[] {
    const where: string[] = [];
    const args: string[] = [];
    if (botId) { where.push('bot_id=?'); args.push(botId); }
    if (scope !== 'all') { where.push('scope=?'); args.push(scope); }
    return this.db
      .all<PolicyRaw>('SELECT * FROM approval_policies' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at, id', ...args)
      .map(toPolicy);
  }
  getPolicy(id: string): StoredPolicy | undefined {
    const r = this.db.get<PolicyRaw>('SELECT * FROM approval_policies WHERE id=?', id);
    return r ? toPolicy(r) : undefined;
  }
  /** Adds a rule; an identical one (same bot, tool, pattern, decision, scope) is returned instead of duplicated. */
  addPolicy(p: { botId: string; tool: string; pattern: string; decision: 'allow' | 'deny'; scope: PolicyScope }): StoredPolicy {
    const same = this.db.get<PolicyRaw>(
      'SELECT * FROM approval_policies WHERE bot_id=? AND tool=? AND pattern=? AND decision=? AND scope=?',
      p.botId, p.tool, p.pattern, p.decision, p.scope,
    );
    if (same) return toPolicy(same);
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO approval_policies (id, bot_id, tool, pattern, decision, scope, created_at) VALUES (?,?,?,?,?,?,?)',
      id, p.botId, p.tool, p.pattern, p.decision, p.scope, this.now(),
    );
    return this.getPolicy(id)!;
  }
  removePolicy(id: string): boolean {
    const had = !!this.getPolicy(id);
    this.db.run('DELETE FROM approval_policies WHERE id=?', id);
    return had;
  }
  /** Hub start: "Allow for this session" answers belong to the previous process. */
  clearSessionPolicies() {
    this.db.run("DELETE FROM approval_policies WHERE scope='session'");
  }
  /** Rules of bots that no longer exist. */
  prunePolicies(liveBotIds: string[]) {
    const keep = new Set(liveBotIds);
    for (const p of this.listPolicies(undefined, 'all')) if (!keep.has(p.botId)) this.removePolicy(p.id);
  }
}

/** `*` matches anything, a trailing `*` is a prefix match, anything else must be equal. */
export function patternMatches(pattern: string, subject: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return subject.startsWith(pattern.slice(0, -1));
  return pattern === subject;
}

/** An approvals row as the "make this a rule" route needs it, with the danger flag its card showed. */
export interface ApprovalRecord {
  id: string;
  botId: string;
  toolName: string;
  toolInput: unknown;
  status: string;
  danger: boolean;
}

export function getApprovalRecord(db: Db, id: string): ApprovalRecord | undefined {
  const r = db.get<{ id: string; bot_id: string; tool_name: string; tool_input: string | null; status: string }>(
    'SELECT id, bot_id, tool_name, tool_input, status FROM approvals WHERE id=?', id,
  );
  if (!r) return undefined;
  let input: unknown = null;
  try { input = r.tool_input ? JSON.parse(r.tool_input) : null; } catch { /* keep null */ }
  const card = db.get<{ danger: number | null }>(
    "SELECT json_extract(payload, '$.danger') AS danger FROM messages WHERE kind='approval' AND json_extract(payload, '$.approvalId')=?", id,
  );
  return { id: r.id, botId: r.bot_id, toolName: r.tool_name, toolInput: input, status: r.status, danger: !!card?.danger };
}
