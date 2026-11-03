import type { DatabaseSync } from 'node:sqlite';
import { isBotIconKey } from '@pocketrocket/shared';
import { nanoid } from 'nanoid';

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
