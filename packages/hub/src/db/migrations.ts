import type { DatabaseSync } from 'node:sqlite';
import { isBotIconKey } from '@pocketrocket/shared';
import { nanoid } from 'nanoid';
import { MIGRATION_BACKFILL_ROWS, backfillMessagesFts } from './historyIndex.js';

/**
 * Versioned schema migrations. See the header of `db.ts` for how phases add theirs.
 *
 * A migration runs once per database, in version order, inside a transaction together with the
 * `schema_version` row that records it. "Applied" is tracked per version, not as a high-water mark,
 * so blocks merged out of order (P3's 30s before P1's 10s) still run on a database that already has
 * the later ones.
 */
export interface Migration {
  /** Unique, inside the phase's reserved block (P0 1–9, P1 10–19, … P9 90–99). */
  version: number;
  /** Short description, stored in `schema_version.name`. */
  name: string;
  /** Additive only: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN, backfills. Never drop or rename. */
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [];

/**
 * Registers one phase's migrations. `block` is the phase's reserved version range (inclusive), e.g.
 * `[10, 19]` for P1; every version must fall inside it and be unused.
 */
export function registerMigrations(block: readonly [number, number], list: readonly Migration[]): void {
  const [lo, hi] = block;
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version < lo || m.version > hi) {
      throw new Error(`migration ${m.version} (${m.name}) is outside its block ${lo}-${hi}`);
    }
    if (MIGRATIONS.some((x) => x.version === m.version)) throw new Error(`migration version ${m.version} is registered twice`);
    MIGRATIONS.push(m);
  }
  MIGRATIONS.sort((a, b) => a.version - b.version);
}

/** True when `table` has a column named `column`. */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * `ALTER TABLE <table> ADD COLUMN <column> <ddl>` unless the column already exists (a fresh database
 * gets it from SCHEMA_SQL, an old one from this).
 */
export function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
}

// ---------------------------------------------------------------------------------------------------
// P0 (1–9): the ad-hoc column checks that predate the runner. SCHEMA_SQL already creates these
// columns on a fresh database, so on one they are recorded without changing anything.
registerMigrations([1, 9], [
  { version: 1, name: 'sessions.provider', up: (db) => addColumnIfMissing(db, 'sessions', 'provider', 'TEXT') },
  { version: 2, name: 'bots.auto_memory', up: (db) => addColumnIfMissing(db, 'bots', 'auto_memory', 'INTEGER NOT NULL DEFAULT 1') },
  { version: 3, name: 'bots.auto_memory_every', up: (db) => addColumnIfMissing(db, 'bots', 'auto_memory_every', 'INTEGER NOT NULL DEFAULT 10') },
]);

// Later phases: append one clearly separated block per phase below, e.g.
//   // P1 (10–19): per-bot computers
//   registerMigrations([10, 19], [{ version: 10, name: 'computers table', up: (db) => db.exec('CREATE TABLE IF NOT EXISTS computers (...)') }]);
// or keep the list in its own file (importing only `type Migration` from here) and register it here.

// ---------------------------------------------------------------------------------------------------
// P1 (10–19): per-bot computers (services/ComputerManager.ts, db/computers.ts).
registerMigrations([10, 19], [
  {
    version: 10,
    name: 'computers table',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS computers (' +
          'bot_id TEXT PRIMARY KEY, slot INTEGER UNIQUE NOT NULL, state TEXT NOT NULL DEFAULT \'asleep\', ' +
          'last_used_at INTEGER, disk_bytes INTEGER NOT NULL DEFAULT 0, quota_bytes INTEGER NOT NULL, ' +
          'keep_awake INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
      ),
  },
]);

// P2 (20–29): take over, hand back, approvals while away (db/approvalStore.ts).
registerMigrations([20, 29], [
  // A routine/trigger turn that stopped waiting on a card ("parked") keeps what it needs to resume: the
  // thread it belongs to, its hop, its routine run, and when it parked (a parked card expires after 24 h).
  {
    version: 20,
    name: 'approvals parking columns',
    up: (db) => {
      addColumnIfMissing(db, 'approvals', 'parked_at', 'INTEGER');
      addColumnIfMissing(db, 'approvals', 'cause_id', 'TEXT');
      addColumnIfMissing(db, 'approvals', 'hop', 'INTEGER');
      addColumnIfMissing(db, 'approvals', 'run_id', 'TEXT');
      addColumnIfMissing(db, 'approvals', 'message_id', 'TEXT');
    },
  },
  // Approval rules. `scope` 'always' rows are the user's persisted rules (Settings › Bots › Approvals);
  // 'session' rows are "Allow for this session" answers and are dropped at every hub start. Only REST and the
  // approval card write here; no bot tool or MCP route reaches it.
  {
    version: 21,
    name: 'approval_policies table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS approval_policies (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, tool TEXT NOT NULL, pattern TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('allow','deny')), scope TEXT NOT NULL DEFAULT 'always' CHECK(scope IN ('always','session')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_policies_bot ON approval_policies(bot_id, tool);
    `),
  },
]);

// P3 (30–39): routines v2 and proactive follow-up.
registerMigrations([30, 39], [
  // One-shot routines: epoch ms the routine fires at once; NULL for a cron routine.
  { version: 30, name: 'routines.once_at', up: (db) => addColumnIfMissing(db, 'routines', 'once_at', 'INTEGER') },
  // Lane items queued or running, so a hub restart can resume them (services/FollowUp.ts). A row lives from
  // enqueue until its turn settles; `attempts` counts restarts it was resumed across, so a turn that kills
  // the hub is resumed once, not forever.
  {
    version: 31,
    name: 'lane_journal table',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS lane_journal (' +
          'id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, cause_id TEXT NOT NULL, hop INTEGER NOT NULL, ' +
          'trigger_seq INTEGER NOT NULL, run_id TEXT, note TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
      ),
  },
]);

// P4 (40–49): integrations. Credentials are NOT here: they live encrypted in the IntegrationVault
// (data/integrations.json + data/vault.key), keyed by `integrations.id`. These rows hold only what the UI
// may see. `bot_integrations` is the per-bot grant (decision Q7): no row, no tools.
registerMigrations([40, 49], [
  {
    version: 40,
    name: 'integrations + bot_integrations',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS integrations (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL UNIQUE, method TEXT NOT NULL CHECK(method IN ('oauth','token')),
        account_label TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'connected',
        last_error TEXT, warnings TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_checked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS bot_integrations (
        bot_id TEXT NOT NULL, integration_id TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, integration_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_integrations_integration ON bot_integrations(integration_id);
    `),
  },
]);

// P5 (50–59): event triggers (services/TriggerService.ts, db/triggerRepo.ts). Events arrive by outbound polling
// and Slack Socket Mode only (decision Q5). Cursors and the inbox are persisted so a restart neither replays
// nor loses events; `events_inbox.dedupe_key` is what makes a re-polled event a no-op.
registerMigrations([50, 59], [
  {
    version: 50,
    name: 'triggers table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
        filter_json TEXT NOT NULL DEFAULT '{}', bot_id TEXT NOT NULL, room_id TEXT NOT NULL, prompt TEXT NOT NULL,
        max_per_hour INTEGER NOT NULL DEFAULT 6, budget_usd REAL NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_fired_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_triggers_source ON triggers(source, enabled);
    `),
  },
  {
    version: 51,
    name: 'events_inbox table',
    // status: new (stored, not yet matched) → matched | ignored. A row left `new` by a crash is matched on start.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS events_inbox (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, poll_key TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', seen_at INTEGER NOT NULL, processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_inbox_status ON events_inbox(status, seen_at);
    `),
  },
  {
    version: 52,
    name: 'trigger_fires table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_fires (
        id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, event_id TEXT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        note TEXT, message_id TEXT, cost_usd REAL, test INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_fires_trigger ON trigger_fires(trigger_id, started_at);
    `),
  },
  {
    version: 53,
    name: 'trigger_cursors table',
    // One row per poll stream ('gmail', 'github.repo:owner/name', 'calendar:primary', ...): the provider cursor,
    // its ETag, and the schedule/backoff state.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_cursors (
        key TEXT PRIMARY KEY, source TEXT NOT NULL, cursor TEXT, etag TEXT, last_polled_at INTEGER, next_poll_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `),
  },
]);

// P7 (70–79): knowledge repo sync status, voice proposals from AutoMemory.
registerMigrations([70, 79], [
  {
    version: 70,
    name: 'knowledge_sync table',
    up: (db) => db.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_sync (id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL DEFAULT '', " +
      "mode TEXT NOT NULL DEFAULT 'off', last_synced_at INTEGER, head TEXT, last_error TEXT)",
    ),
  },
  {
    version: 71,
    name: 'voice_proposals table',
    up: (db) => db.exec(
      'CREATE TABLE IF NOT EXISTS voice_proposals (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_voice_proposals_bot ON voice_proposals(bot_id, created_at)',
    ),
  },
]);

// P8 (80–89): model router and usage. Which model ran each turn, why the router picked it, and what kind of
// cause started it, on the usage row (for the Usage tab) and on the bot's messages (for the chat chip).
registerMigrations([80, 89], [
  { version: 80, name: 'usage.model', up: (db) => addColumnIfMissing(db, 'usage', 'model', 'TEXT') },
  { version: 81, name: 'usage.route_reason', up: (db) => addColumnIfMissing(db, 'usage', 'route_reason', 'TEXT') },
  {
    version: 82,
    name: 'usage.cause_kind',
    up: (db) => {
      addColumnIfMissing(db, 'usage', 'cause_kind', 'TEXT');
      // Best-effort backfill so old spend shows up in the breakdown: memory passes have `mem-` turn ids, bot
      // hops wrote messages with hop > 0, routines and user messages are told apart by the cause message.
      db.exec(`UPDATE usage SET cause_kind = CASE
        WHEN turn_id LIKE 'mem-%' THEN 'memory'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.turn_id = usage.turn_id AND m.hop > 0) THEN 'bot'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = usage.cause_id AND m.kind = 'routine') THEN 'routine'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = usage.cause_id AND m.author_type = 'user') THEN 'user'
      END WHERE cause_kind IS NULL`);
      // And the model, from the provider's own per-model report: the one that cost the most.
      db.exec(`UPDATE usage SET model = (
        SELECT j.key FROM json_each(usage.model_usage) j
        ORDER BY COALESCE(json_extract(j.value, '$.costUSD'), json_extract(j.value, '$.costUsd'), 0) DESC LIMIT 1
      ) WHERE model IS NULL AND model_usage IS NOT NULL AND json_valid(model_usage) AND json_type(model_usage) = 'object'`);
    },
  },
  { version: 83, name: 'messages.model', up: (db) => addColumnIfMissing(db, 'messages', 'model', 'TEXT') },
  { version: 84, name: 'messages.model_reason', up: (db) => addColumnIfMissing(db, 'messages', 'model_reason', 'TEXT') },
]);

// P9 (90–99): paired devices (phones) and their Web Push subscriptions. A device row holds only the SHA-256 of
// its token; the token itself is shown to the phone once and never stored. Revoking keeps the row (so the list
// can say so) and drops its push subscriptions.
registerMigrations([90, 99], [
  {
    version: 90,
    name: 'devices table',
    up: (db) => db.exec(
      'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, ' +
      'created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0)',
    ),
  },
  {
    version: 91,
    name: 'push_subscriptions table',
    up: (db) => db.exec(
      'CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, device_id TEXT, endpoint TEXT NOT NULL UNIQUE, ' +
      'p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device ON push_subscriptions(device_id)',
    ),
  },
]);

// ---------------------------------------------------------------------------------------------------
// P6 (60–69): teach by demonstration and skill refinement (services/Recorder.ts, SkillDistiller.ts,
// SkillReflection.ts, SkillService versions). A candidate version is a row in `skills` with `parent_id` set to
// the pool skill it revises; `listSkills` leaves those rows out, so nothing else sees them.
registerMigrations([60, 69], [
  { version: 60, name: 'skills.version', up: (db) => addColumnIfMissing(db, 'skills', 'version', 'INTEGER NOT NULL DEFAULT 1') },
  { version: 61, name: 'skills.parent_id', up: (db) => addColumnIfMissing(db, 'skills', 'parent_id', 'TEXT') },
  {
    version: 62,
    name: 'skills version metadata',
    up: (db) => {
      addColumnIfMissing(db, 'skills', 'origin', 'TEXT');
      addColumnIfMissing(db, 'skills', 'note', 'TEXT');
      addColumnIfMissing(db, 'skills', 'created_at', 'INTEGER');
      addColumnIfMissing(db, 'skills', 'decided_at', 'INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS idx_skills_parent ON skills(parent_id)');
    },
  },
  {
    version: 63,
    name: 'skill reflection',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS skill_reflection (' +
          'bot_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, every INTEGER NOT NULL DEFAULT 5, ' +
          'daily_cap_usd REAL NOT NULL DEFAULT 0.25);' +
          'CREATE TABLE IF NOT EXISTS skill_reflection_runs (' +
          'bot_id TEXT NOT NULL, skill_id TEXT NOT NULL, runs_since INTEGER NOT NULL DEFAULT 0, ' +
          'PRIMARY KEY (bot_id, skill_id))',
      ),
  },
]);

// ---------------------------------------------------------------------------------------------------
// [100, 109]: past the P0-P9 blocks. Bot avatars become line icon keys.
/** Emoji with an obvious icon, without variation selectors: our presets and common picks. The rest derive from the id. */
const LEGACY_AVATARS: Record<string, string> = {
  '🧭': 'compass', '🔎': 'search', '🛠': 'wrench', '✍': 'pen', '🙂': 'smile', '🤖': '',
  '🔍': 'search', '🚀': 'rocket', '💻': 'terminal', '🧑‍💻': 'terminal', '⚙': 'wrench', '🎨': 'palette',
};
/** Seeded before they had icons, with `''`. By handle alone, so a seeded bot the owner renamed still gets its icon. */
const SEEDED_ICONS: Record<string, string> = { 'pocketrocket-support': 'shield', 'data-engineer': 'database' };
registerMigrations([100, 109], [
  {
    version: 100,
    name: 'bots.avatar to icon keys',
    // Custom emoji and short text are replaced too: the owner chose that over keeping a legacy column.
    up: (db) => {
      const rows = db.prepare('SELECT id, handle, avatar FROM bots').all() as { id: string; handle: string; avatar: string | null }[];
      const set = db.prepare('UPDATE bots SET avatar=? WHERE id=?');
      for (const r of rows) {
        const was = (r.avatar ?? '').replace(/\uFE0F/g, '').trim();
        const known = isBotIconKey(was) ? was : Object.hasOwn(LEGACY_AVATARS, was) ? LEGACY_AVATARS[was] : '';
        const key = known || (Object.hasOwn(SEEDED_ICONS, r.handle) ? SEEDED_ICONS[r.handle] : '');
        if (key !== r.avatar) set.run(key, r.id);
      }
    },
  },
  { version: 101, name: 'rooms.chat_model', up: (db) => addColumnIfMissing(db, 'rooms', 'chat_model', 'TEXT') },
  // bots.avatar needs no change: it is plain TEXT, and only BotInputSchema ever held it to 8 characters.
  { version: 102, name: 'rooms.avatar', up: (db) => addColumnIfMissing(db, 'rooms', 'avatar', "TEXT NOT NULL DEFAULT ''") },
]);

// ---------------------------------------------------------------------------------------------------
// [110, 119]: bot training pilot (services/Training.ts). `heading_added`: this approved rule owns the "## Lessons"
// heading it created, so undoing the last lesson can take the heading away too.
registerMigrations([110, 119], [
  {
    version: 110,
    name: 'bot training',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS training_config (' +
          'bot_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER);' +
          'CREATE TABLE IF NOT EXISTS training_proposals (' +
          'id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, ' +
          "status TEXT NOT NULL CHECK(status IN ('pending','blocked','approved','rejected','undone')), " +
          "rule TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', evidence_summary TEXT NOT NULL DEFAULT '', " +
          "verifier_note TEXT NOT NULL DEFAULT '', description_before TEXT, heading_added INTEGER NOT NULL DEFAULT 0, " +
          'created_at INTEGER NOT NULL, decided_at INTEGER, undone_at INTEGER);' +
          'CREATE INDEX IF NOT EXISTS idx_training_proposals_bot ON training_proposals(bot_id, status)',
      ),
  },
  {
    version: 111,
    name: 'training window, unjudged proposals, who answered an approval',
    up: (db) => {
      // Evidence only counts from when training was last switched on. Bots already on start from now.
      addColumnIfMissing(db, 'training_config', 'window_start', 'INTEGER');
      db.prepare('UPDATE training_config SET window_start=? WHERE enabled=1 AND window_start IS NULL').run(Date.now());
      // retry: blocked only because the verifier never judged it, so it may be proposed again.
      addColumnIfMissing(db, 'training_proposals', 'retry', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'approvals', 'decided_by', 'TEXT');
    },
  },
  {
    version: 112,
    name: 'users: a stable id for the owner, separate from the display name',
    up: (db) => {
      db.exec(
        'CREATE TABLE IF NOT EXISTS users (' +
          "id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', " +
          "role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), " +
          "previous_names TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)",
      );
      const stored = db.prepare("SELECT value FROM settings WHERE key='userName'").get() as { value?: string } | undefined;
      let name = '';
      try { name = stored?.value ? String(JSON.parse(stored.value)) : ''; } catch { /* left empty; the hub fills it in at start */ }
      const id = nanoid(10);
      db.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?,?,'owner',?)").run(id, name, Date.now());
      // Every human message so far came from the one login this hub has ever had.
      db.prepare("UPDATE messages SET author_id=? WHERE author_type='user' AND author_id IS NULL").run(id);
    },
  },
  {
    version: 113,
    name: 'sign-in: owner password, browser sessions, audit log',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS user_credentials (' +
          'user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, updated_at INTEGER NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS user_sessions (' +
          'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_agent TEXT, ip TEXT, ' +
          'created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);' +
          'CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);' +
          'CREATE TABLE IF NOT EXISTS audit_log (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, ' +
          'action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT)',
      ),
  },
]);

// ---------------------------------------------------------------------------------------------------
registerMigrations([120, 129], [
  { version: 120, name: 'messages.attachments', up: (db) => addColumnIfMissing(db, 'messages', 'attachments', 'TEXT') },
]);

// ---------------------------------------------------------------------------------------------------
registerMigrations([130, 139], [
  {
    version: 130,
    name: 'project folders, their search index, connector queue and secret',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, room_id TEXT, template_version INTEGER, created_at INTEGER NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS project_members (slug TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY (slug, bot_id));' +
          'CREATE INDEX IF NOT EXISTS idx_project_members_bot ON project_members(bot_id);' +
          'CREATE TABLE IF NOT EXISTS project_files (slug TEXT NOT NULL, path TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, status TEXT, updated TEXT, review_by TEXT, PRIMARY KEY (slug, path));' +
          "CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(slug UNINDEXED, path UNINDEXED, text, tokenize='porter unicode61');" +
          'CREATE TABLE IF NOT EXISTS project_search_misses (at INTEGER NOT NULL, projects TEXT NOT NULL, query TEXT NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS context_queue (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS context_connector (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)',
      ),
  },
]);

// ---------------------------------------------------------------------------------------------------
// Memory fixes: when auto-memory last wrote to a bot's memory.md (the Memory tab shows it).
registerMigrations([150, 159], [
  { version: 150, name: 'auto_memory.saved_at', up: (db) => addColumnIfMissing(db, 'auto_memory', 'saved_at', 'INTEGER') },
]);

// ---------------------------------------------------------------------------------------------------
// PC runner: Claude Code jobs a bot asks the owner's PC to run (services/PcRunner.ts). Only `queued` rows
// (the owner approved the card) are ever served to the PC.
registerMigrations([160, 169], [
  {
    version: 160,
    name: 'pc_jobs',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS pc_jobs (' +
          'id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, folder TEXT NOT NULL, prompt TEXT NOT NULL, ' +
          "status TEXT NOT NULL CHECK(status IN ('pending_approval','queued','claimed','running','done','failed','refused','expired','cancelled')), " +
          'result TEXT, cost_usd REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);' +
          'CREATE INDEX IF NOT EXISTS idx_pc_jobs_status ON pc_jobs(status, updated_at)',
      ),
  },
  {
    // Settings > PC runner shows when a job started and finished, and how long the PC says it ran.
    version: 161,
    name: 'pc_jobs.started_at, finished_at, duration_ms',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'started_at', 'INTEGER');
      addColumnIfMissing(db, 'pc_jobs', 'finished_at', 'INTEGER');
      addColumnIfMissing(db, 'pc_jobs', 'duration_ms', 'INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS idx_pc_jobs_created ON pc_jobs(created_at)');
    },
  },
  {
    // Bridge P4: the app can start a job itself (origin 'owner', no bot or room: stored as '', shown as null) and
    // @persona can resume a mirrored Claude Code session (mode 'resume': folder '' and the runner resolves it).
    // Additive: the NOT NULL bot_id / room_id / folder columns stay, so rows from before read as mode 'new', origin 'bot'.
    version: 162,
    name: 'pc_jobs.mode, session_id, origin, resolved_folder, new_session_id',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'mode', "TEXT NOT NULL DEFAULT 'new'");
      addColumnIfMissing(db, 'pc_jobs', 'session_id', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'origin', "TEXT NOT NULL DEFAULT 'bot'");
      addColumnIfMissing(db, 'pc_jobs', 'resolved_folder', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'new_session_id', 'TEXT');
    },
  },
  {
    // Bridge P5: a sync job (mode 'sync') carries which project repo to sync, what the PC reported (commit, branch,
    // pre-push scan) and what the hub imported from an uploaded bundle. All JSON, all NULL for older rows and other modes.
    version: 163,
    name: 'pc_jobs.sync_json, sync_result_json, sync_import_json',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'sync_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'sync_result_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'sync_import_json', 'TEXT');
    },
  },
]);

// ---------------------------------------------------------------------------------------------------
// Token efficiency (agent/BotRunner.ts, services/SessionRotation.ts). Per (bot, room) session:
//   cost_total         the SDK's cumulative total_cost_usd last reported for this session (it is cumulative across
//                      resumes), so a turn's own cost is the difference; NULL on rows from before this migration.
//   context_tokens     input size of the last top-level model call of the last turn; NULL = unknown, which makes a
//   context_at         resumed legacy session rotate once. context_at is when it was measured (idle check).
//   memory_snapshot    memory.md and identity as they were when the session started, so the system prompt stays
//   identity_snapshot  byte-identical (prompt-cache hits) across resumed turns.
//   summary            the hub's running summary of the room, written when a session rotates and replayed into the next.
registerMigrations([170, 179], [
  {
    version: 170,
    name: 'sessions: cost_total, context_tokens, context_at, memory/identity snapshot, summary',
    up: (db) => {
      addColumnIfMissing(db, 'sessions', 'cost_total', 'REAL');
      addColumnIfMissing(db, 'sessions', 'context_tokens', 'INTEGER');
      addColumnIfMissing(db, 'sessions', 'context_at', 'INTEGER');
      addColumnIfMissing(db, 'sessions', 'memory_snapshot', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'identity_snapshot', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'summary', 'TEXT');
    },
  },
]);

// ---------------------------------------------------------------------------------------------------
// Send journal (B5). A client numbers each message it sends; the hub keeps one message per (room, id) so a replay
// after a reconnect cannot post twice. NULL for every message that did not come with an id.
registerMigrations([180, 189], [
  {
    version: 180,
    name: 'messages.client_msg_id + unique (room_id, client_msg_id)',
    up: (db) => {
      addColumnIfMissing(db, 'messages', 'client_msg_id', 'TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg ON messages(room_id, client_msg_id) WHERE client_msg_id IS NOT NULL');
    },
  },
]);

// ---------------------------------------------------------------------------------------------------
// Tasks, history search and bot reports (G1, G2, G5).
//   200  tasks: a room's board. Local only.
//   201  messages_fts: full-text index over messages.text, kept in sync by triggers. Rows that existed before are
//        indexed in bounded batches: the first here, the rest by startHistoryBackfill after the hub is up.
//   202  bot_reports: report_blocked items and the send_feedback rate-limit log (feedback text lives in a file).
registerMigrations([200, 209], [
  {
    version: 200,
    name: 'tasks',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS tasks (' +
          "id TEXT PRIMARY KEY, room_id TEXT NOT NULL, bot_id TEXT, assignee_bot_id TEXT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', " +
          "status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done','blocked')), " +
          'due_at INTEGER, parent_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);' +
          'CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id, status, updated_at)',
      ),
  },
  {
    version: 201,
    name: 'messages_fts + triggers + bounded backfill',
    up: (db) => {
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='porter unicode61');" +
          'CREATE TABLE IF NOT EXISTS fts_backfill (name TEXT PRIMARY KEY, next_rowid INTEGER NOT NULL, upto INTEGER NOT NULL);' +
          'CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text); END;' +
          'CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; END;' +
          'CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text); END',
      );
      db.exec("INSERT OR IGNORE INTO fts_backfill (name, next_rowid, upto) SELECT 'messages', 0, COALESCE(MAX(rowid), 0) FROM messages");
      backfillMessagesFts(db, MIGRATION_BACKFILL_ROWS, true);
    },
  },
  {
    version: 202,
    name: 'bot_reports',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS bot_reports (' +
          "id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT, type TEXT NOT NULL CHECK(type IN ('blocked','feedback')), " +
          "kind TEXT, site TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed')), created_at INTEGER NOT NULL);" +
          'CREATE INDEX IF NOT EXISTS idx_bot_reports_bot ON bot_reports(bot_id, type, created_at)',
      ),
  },
]);

// 240  messages_fts only indexes the kinds searchHistory reads (text, handoff, routine, trigger), so tool/approval/form
//      cards and system rows no longer cost index space and trigger work. The update trigger fires only when the
//      text or kind changed. Rows of other kinds that 201 already indexed are removed. Migration 201 itself is
//      shipped on this branch and stays as it is.
const FTS_KINDS = "('text','handoff','routine','trigger')";
registerMigrations([240, 249], [
  {
    version: 240,
    name: 'messages_fts: index searchable kinds only',
    up: (db) => {
      db.exec(
        'DROP TRIGGER IF EXISTS messages_fts_ai; DROP TRIGGER IF EXISTS messages_fts_au;' +
          'CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.kind IN ' + FTS_KINDS + ' BEGIN INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text); END;' +
          'CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages WHEN old.text IS NOT new.text OR old.kind IS NOT new.kind ' +
          'BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; INSERT INTO messages_fts (rowid, text) SELECT new.rowid, new.text WHERE new.kind IN ' + FTS_KINDS + '; END',
      );
      db.exec('DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE kind NOT IN ' + FTS_KINDS + ')');
    },
  },
]);

// Machines (B4). One row per machine the owner set a policy for (never | ask | always); no row means 'ask'.
// A table rather than a settings field: machines are keyed by id and there will be more than the two that
// exist today. Approval rules also gain an optional machine scope and an expiry (NULL = any machine / never).
registerMigrations([190, 199], [
  {
    version: 190,
    name: 'machine_policies table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS machine_policies (
        machine TEXT PRIMARY KEY,
        policy TEXT NOT NULL CHECK(policy IN ('never','ask','always')),
        updated_at INTEGER NOT NULL
      );
    `),
  },
  {
    version: 191,
    name: 'approval_policies.machine + expires_at',
    up: (db) => {
      addColumnIfMissing(db, 'approval_policies', 'machine', 'TEXT');
      addColumnIfMissing(db, 'approval_policies', 'expires_at', 'INTEGER');
    },
  },
]);

// Credential vault (G4). Name, origin and username of each saved login; the secret is in the encrypted vault file
// (data/credentials.json, key in vault.key), keyed by `credentials.id`, never in this table.
registerMigrations([210, 219], [
  {
    version: 210,
    name: 'credentials',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS credentials (' +
          "id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', " +
          'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER);' +
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_name ON credentials(name COLLATE NOCASE)',
      ),
  },
]);

// 250-259  Steering and queue controls (spec 02 Phase 1-2). A person's message pushed into a running turn gets a
//          `lane_journal` row of its own (status 'steered'), so a hub that dies before the bot answers it re-queues it
//          once after restart even when the turn's own item has used its one resume. Once a turn consumed it the row
//          stays as 'consumed' (with the message id) until the lane's read cursor passes it: the cursor stays at the
//          turn's start, so the next turn would otherwise be shown the steer again (RoomRouter `unreadForLane`).
registerMigrations([250, 259], [
  {
    version: 250,
    name: 'lane_journal.status + message_id (steering)',
    up: (db) => {
      addColumnIfMissing(db, 'lane_journal', 'status', "TEXT NOT NULL DEFAULT 'queued'");
      addColumnIfMissing(db, 'lane_journal', 'message_id', 'TEXT');
    },
  },
  // Queue controls (Phase 2). A cancelled or edited queued message keeps that state across restarts. A lane row the
  // owner cancelled stays as status 'cancelled' (like a consumed steer) until the lane's cursor passes it, so that
  // bot is never shown the message even while another bot still holds it. A paused queue is a row in `lane_pauses`.
  {
    version: 251,
    name: 'messages.cancelled_at + edited_at, lane_pauses (queue controls)',
    up: (db) => {
      addColumnIfMissing(db, 'messages', 'cancelled_at', 'INTEGER');
      addColumnIfMissing(db, 'messages', 'edited_at', 'INTEGER');
      db.exec(
        'CREATE TABLE IF NOT EXISTS lane_pauses (bot_id TEXT NOT NULL, room_id TEXT NOT NULL, paused_at INTEGER NOT NULL, PRIMARY KEY (bot_id, room_id))',
      );
    },
  },
]);

// Claude Code bridge P1 (docs/specs/claude-code-bridge.md 6.1, 6.3): who changed each shared file, and from where.
// One row per revision of a file in a room, project or direct-chat folder. `hash` null = deleted. Small text files
// keep their content for diffs. `services/FileRevisions.ts` writes it.
registerMigrations([260, 269], [
  {
    version: 260,
    name: 'file_revisions (provenance of shared files)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS file_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_kind TEXT NOT NULL,
        root_key TEXT NOT NULL,
        path TEXT NOT NULL,
        rev INTEGER NOT NULL,
        hash TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        content TEXT,
        author_kind TEXT NOT NULL,
        author_id TEXT,
        author_label TEXT NOT NULL DEFAULT '',
        machine TEXT NOT NULL,
        session_id TEXT,
        room_id TEXT,
        sources TEXT,
        tool TEXT,
        created_at INTEGER NOT NULL
      )`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS file_revisions_path_rev ON file_revisions (root_kind, root_key, path, rev)');
    },
  },
]);

// Claude Code bridge P3 (docs/specs/claude-code-bridge.md 3.1): the PC session mirror. `pc_sessions` is one row per
// Claude Code transcript on the owner's PC (a subagent transcript is a child row, `parent_id`); `offset` is how many
// bytes of the source file the hub has consumed, so the runner resumes where it stopped. `pc_session_entries` holds
// the compact, redacted entries. Only the owner's app reads these tables (services/PcSessions.ts); no bot tool does.
registerMigrations([270, 279], [
  {
    version: 270,
    name: 'pc_sessions + pc_session_entries (PC session mirror)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pc_sessions (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        machine TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        cwd TEXT,
        repo_json TEXT,
        title TEXT,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0,
        entry_count INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS pc_sessions_last ON pc_sessions (last_at)');
      db.exec('CREATE INDEX IF NOT EXISTS pc_sessions_parent ON pc_sessions (parent_id)');
      db.exec(`CREATE TABLE IF NOT EXISTS pc_session_entries (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        uuid TEXT NOT NULL,
        parent_uuid TEXT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        tool TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        is_sidechain INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        PRIMARY KEY (session_id, seq)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS pc_session_entries_seq ON pc_session_entries (session_id, seq)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS pc_session_entries_uuid ON pc_session_entries (session_id, uuid)');
    },
  },
  {
    version: 271,
    name: 'pc_session_tombstones (a deleted mirrored session is not mirrored again)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pc_session_tombstones (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL,
        by_owner INTEGER NOT NULL DEFAULT 0
      )`);
    },
  },
]);

// Claude Code bridge P6 (docs/specs/claude-code-bridge.md 3.4): a PC session moved to the VPS and pulled back.
// `pc_session_moves` is one row per session that ever moved: where it is now (`state`), the repos that travelled (JSON:
// project, repo, vps folder, remote, branch, base commit, worktree), the PC toplevel the paths were rewritten from, the
// worktree the VPS turns run in and how many bytes of its jsonl the mirror has already read. A job row carries the move or
// pull it is (JSON, NULL for the other modes), and a mirrored entry the hub itself fed from the VPS says so in `machine`.
registerMigrations([280, 289], [
  {
    version: 280,
    name: 'pc_session_moves (a PC session moved to the VPS)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pc_session_moves (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        project TEXT,
        room_id TEXT,
        repos_json TEXT NOT NULL DEFAULT '[]',
        pc_root TEXT,
        vps_cwd TEXT,
        worktree TEXT,
        feed_offset INTEGER NOT NULL DEFAULT 0,
        moved_at INTEGER NOT NULL,
        pulled_at INTEGER,
        move_job_id TEXT,
        pull_job_id TEXT,
        turns INTEGER NOT NULL DEFAULT 0
      )`);
    },
  },
  {
    version: 281,
    name: 'pc_jobs.move_json, move_result_json, pull_json, pull_result_json',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'move_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'move_result_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'pull_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'pull_result_json', 'TEXT');
    },
  },
  { version: 282, name: 'pc_session_entries.machine', up: (db) => addColumnIfMissing(db, 'pc_session_entries', 'machine', 'TEXT') },
]);

// Workflows v1 (docs/specs/openbot-gaps/02-steering-workflows.md, Phase 3). 290 generalises the routine run id that a lane
// journal row and a parked approval carry into an owner ref (`routine:<runId>`, `workflow:<runId>:<nodeId>`), so the
// turn's `onDone` can be rebuilt after a restart or a parked approval whoever started it. `run_id` stays (older hubs read
// it) and is still written for routine refs. 291-292: the workflow definitions and their runs. A run keeps a snapshot of
// the graph and budget it started with, so editing the workflow never changes a run in flight.
registerMigrations([290, 299], [
  {
    version: 290,
    name: 'lane_journal.owner_ref + approvals.owner_ref (backfilled from run_id)',
    up: (db) => {
      addColumnIfMissing(db, 'lane_journal', 'owner_ref', 'TEXT');
      addColumnIfMissing(db, 'approvals', 'owner_ref', 'TEXT');
      db.exec("UPDATE lane_journal SET owner_ref='routine:'||run_id WHERE owner_ref IS NULL AND run_id IS NOT NULL");
      db.exec("UPDATE approvals SET owner_ref='routine:'||run_id WHERE owner_ref IS NULL AND run_id IS NOT NULL");
    },
  },
  {
    version: 291,
    name: 'workflows table',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        room_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('routine','trigger','manual')),
        routine_id TEXT,
        trigger_id TEXT,
        graph_json TEXT NOT NULL,
        budget_usd REAL NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_routine ON workflows(routine_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows(trigger_id)');
    },
  },
  {
    version: 292,
    name: 'workflow_runs table',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        cause_id TEXT,
        node_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','waiting','success','error','cancelled')),
        steps_json TEXT NOT NULL DEFAULT '[]',
        graph_json TEXT NOT NULL,
        budget_usd REAL NOT NULL DEFAULT 2,
        cost_usd REAL NOT NULL DEFAULT 0,
        manual INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        expires_at INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id, started_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)');
    },
  },
  // The room the run's thread lives in, fixed when it starts (the workflow may be moved to another chat meanwhile).
  { version: 293, name: 'workflow_runs.room_id', up: (db) => addColumnIfMissing(db, 'workflow_runs', 'room_id', 'TEXT') },
]);

// 300-309  Telegram notifications (spec 03 Phase A). One row (id 1): which bot is set up and which private chat is
//          linked. The token itself is in the encrypted vault (`telegram` entry), never here. The link stores the
//          numeric Telegram user id only; `linked_name` is a display label for Settings and is not an identity.
registerMigrations([300, 309], [
  {
    version: 300,
    name: 'telegram_link',
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS telegram_link (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bot_id TEXT,
        bot_username TEXT,
        chat_id TEXT,
        linked_name TEXT,
        notify INTEGER NOT NULL DEFAULT 0,
        linked_at INTEGER
      )`),
  },
]);

// 310-319  Gap 1 Phase 1: provider per bot (docs/specs/openbot-gaps/01-providers-failover.md P1-1). The spec planned
//          270-279, but the PC session mirror took 270-271 first, so this block moved here (docs/specs/decisions.md).
//          `bots.provider` NULL = follow settings.provider; `bots.backup` is JSON {provider, model} or NULL;
//          `usage.provider` is the provider that ran the turn (NULL on rows from before it existed).
registerMigrations([310, 319], [
  { version: 310, name: 'bots.provider', up: (db) => addColumnIfMissing(db, 'bots', 'provider', 'TEXT') },
  { version: 311, name: 'bots.backup', up: (db) => addColumnIfMissing(db, 'bots', 'backup', 'TEXT') },
  { version: 312, name: 'usage.provider', up: (db) => addColumnIfMissing(db, 'usage', 'provider', 'TEXT') },
]);
