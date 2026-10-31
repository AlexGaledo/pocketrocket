import { nanoid } from 'nanoid';
import type { SkillReflectionConfig, SkillVersion, SkillVersionOrigin, SkillVersionStatus } from '@pocketrocket/shared';
import { REFLECTION_DAILY_CAP, REFLECTION_EVERY } from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

/**
 * P6 storage for skill versions and the reflection opt-in.
 *
 * A candidate version is a row of `skills` with `parent_id` = the pool skill it revises. Its `name` is
 * `<skill>@v<n>`: unique like every skill name, and never a valid pool name (`@` fails SKILL_NAME_RE), so it can
 * neither collide with nor be materialized as a real skill. `review_status` is pending / approved / rejected.
 */
export class SkillVersionsRepo {
  constructor(private db: Db, private now: () => number = Date.now) {}

  private toVersion(r: Row): SkillVersion {
    return {
      id: r.id as string,
      skillId: r.parent_id as string,
      version: (r.version as number) ?? 1,
      status: r.review_status as SkillVersionStatus,
      origin: ((r.origin as string) ?? 'bot') as SkillVersionOrigin,
      note: (r.note as string) ?? '',
      createdByBot: (r.created_by_bot as string) ?? null,
      createdAt: (r.created_at as number) ?? 0,
      decidedAt: (r.decided_at as number) ?? null,
    };
  }

  /** Newest first. */
  list(skillId: string): SkillVersion[] {
    return this.db.all('SELECT * FROM skills WHERE parent_id=? ORDER BY version DESC', skillId).map((r) => this.toVersion(r));
  }
  get(id: string): (SkillVersion & { path: string }) | undefined {
    const r = this.db.get('SELECT * FROM skills WHERE id=? AND parent_id IS NOT NULL', id);
    return r && { ...this.toVersion(r), path: r.path as string };
  }
  pendingCount(skillId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM skills WHERE parent_id=? AND review_status='pending'", skillId)?.n ?? 0;
  }
  /** The next version number: one past the live version and every candidate. */
  nextVersion(skillId: string): number {
    const r = this.db.get<{ v: number | null }>('SELECT MAX(version) v FROM skills WHERE id=? OR parent_id=?', skillId, skillId);
    return (r?.v ?? 1) + 1;
  }
  insert(v: { skillId: string; skillName: string; version: number; path: string; description: string; origin: SkillVersionOrigin; note: string; createdByBot: string | null }): SkillVersion {
    const id = nanoid(10);
    this.db.run(
      'INSERT INTO skills (id,name,description,path,source,review_status,created_by_bot,version,parent_id,origin,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, v.skillName + '@v' + v.version, v.description, v.path, 'bot', 'pending', v.createdByBot, v.version, v.skillId, v.origin, v.note, this.now(),
    );
    return this.get(id)!;
  }
  decide(id: string, status: 'approved' | 'rejected') {
    this.db.run('UPDATE skills SET review_status=?, decided_at=? WHERE id=?', status, this.now(), id);
  }
  /** The live skill now runs `version` (after an approval). */
  setLive(skillId: string, version: number, description: string) {
    this.db.run("UPDATE skills SET version=?, description=?, review_status='approved' WHERE id=?", version, description, skillId);
  }
  deleteAll(skillId: string) {
    this.db.run('DELETE FROM skills WHERE parent_id=?', skillId);
  }

  // ---- reflection opt-in (6.3) ----
  reflection(botId: string): SkillReflectionConfig {
    const r = this.db.get('SELECT * FROM skill_reflection WHERE bot_id=?', botId);
    return {
      botId,
      enabled: !!r?.enabled,
      every: (r?.every as number) ?? REFLECTION_EVERY.default,
      dailyCapUsd: (r?.daily_cap_usd as number) ?? REFLECTION_DAILY_CAP.default,
    };
  }
  setReflection(botId: string, patch: Partial<Omit<SkillReflectionConfig, 'botId'>>): SkillReflectionConfig {
    const cur = { ...this.reflection(botId), ...patch };
    this.db.run(
      'INSERT INTO skill_reflection (bot_id,enabled,every,daily_cap_usd) VALUES (?,?,?,?) ' +
        'ON CONFLICT(bot_id) DO UPDATE SET enabled=excluded.enabled, every=excluded.every, daily_cap_usd=excluded.daily_cap_usd',
      botId, cur.enabled ? 1 : 0, cur.every, cur.dailyCapUsd,
    );
    return this.reflection(botId);
  }
  /** Counts one more run of a skill by a bot; returns the new count. */
  bumpRuns(botId: string, skillId: string): number {
    this.db.run(
      'INSERT INTO skill_reflection_runs (bot_id,skill_id,runs_since) VALUES (?,?,1) ' +
        'ON CONFLICT(bot_id,skill_id) DO UPDATE SET runs_since=runs_since+1',
      botId, skillId,
    );
    return this.db.get<{ n: number }>('SELECT runs_since n FROM skill_reflection_runs WHERE bot_id=? AND skill_id=?', botId, skillId)?.n ?? 0;
  }
  resetRuns(botId: string, skillId: string) {
    this.db.run('UPDATE skill_reflection_runs SET runs_since=0 WHERE bot_id=? AND skill_id=?', botId, skillId);
  }
  /** What this bot's reflection passes spent since `since` (epoch ms). */
  reflectionSpend(botId: string, since: number): number {
    return this.db.get<{ c: number }>("SELECT COALESCE(SUM(cost_usd),0) c FROM usage WHERE bot_id=? AND cause_kind='reflection' AND created_at>=?", botId, since)?.c ?? 0;
  }
  prune(botIds: string[]) {
    const keep = new Set(botIds);
    for (const r of this.db.all<{ bot_id: string }>('SELECT bot_id FROM skill_reflection UNION SELECT bot_id FROM skill_reflection_runs')) {
      if (keep.has(r.bot_id)) continue;
      this.db.run('DELETE FROM skill_reflection WHERE bot_id=?', r.bot_id);
      this.db.run('DELETE FROM skill_reflection_runs WHERE bot_id=?', r.bot_id);
    }
  }
}
