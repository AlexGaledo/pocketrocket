import {
  TRIGGER_SOURCE_PROVIDER, TRIGGER_SOURCES,
  type IntegrationProvider, type Trigger, type TriggerEvent, type TriggerFire, type TriggerInput, type TriggerPayload,
  type TriggerSource, type TriggersState, type TriggerTestInput,
} from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import { TriggerRepo, type CursorRow, type InboxRow } from '../db/triggerRepo.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { fieldValue } from '../rooms/untrusted.js';
import type { IntegrationService } from './IntegrationService.js';
import { IntegrationError } from '../integrations/http.js';
import { repoPath } from '../integrations/github.js';
import { SlackSocketMode, type SlackEventCallback, type SocketFactory } from './SlackSocketMode.js';
import { events } from '../events.js';

/** Default seconds between polls per source (docs/specs/integrations-client-api.md). A provider's own minimum wins. */
export const POLL_INTERVAL_SEC: Record<Exclude<TriggerSource, 'slack'>, number> = {
  'github.notifications': 60, 'github.repo': 60, gmail: 60, calendar: 120, drive: 300, clickup: 60, teams: 60,
};
/** Longest a failing stream waits between tries. */
export const MAX_BACKOFF_SEC = 30 * 60;
/** How often the scheduler looks for due streams. */
const TICK_MS = 5_000;
/** Handled inbox rows are kept this long for dedupe, then pruned. */
const INBOX_KEEP_MS = 14 * 24 * 3_600_000;
/** Most new Gmail messages read per poll (each is one API call). */
const GMAIL_READS_PER_POLL = 20;

/** One poll stream: a source plus what selects it (a repo, a calendar, a workspace). Triggers share streams. */
interface Stream {
  key: string;
  source: Exclude<TriggerSource, 'slack'>;
  provider: IntegrationProvider;
  /** repo for github.repo, calendar id, ClickUp workspace id ('' = the first one). */
  param: string;
}
type Found = { dedupe: string; event: TriggerEvent };
type PollOutcome = { found: Found[]; cursor: string | null; etag: string | null; intervalSec?: number; note?: string };

export interface TriggerServiceOptions {
  db: Db;
  repos: Repos;
  integrations: IntegrationService;
  router: RoomRouter;
  now?: () => number;
  /** Slack Socket Mode transport; tests pass a fake socket. */
  socket?: SocketFactory;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

const ev = (source: TriggerSource, e: Partial<TriggerEvent> & { id: string }): TriggerEvent => ({
  source, title: '', text: '', from: '', url: '', at: '', ...e, fields: Object.fromEntries(Object.entries(e.fields ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])),
});

/**
 * P5 event triggers (spec §2.3). Outbound only: pollers on the P4 clients with persisted cursors, plus a Slack
 * Socket Mode client. There is no inbound port.
 *
 * Pipeline: a poll (or a Slack envelope) normalises each item to a TriggerEvent and stores it once in
 * `events_inbox` (UNIQUE dedupe key) → the matcher runs it against the enabled triggers of that stream →
 * each match goes through the trigger's grant, hourly rate limit and daily budget → `router.fireTrigger()`.
 *
 * Only streams with at least one enabled trigger whose bot holds a grant for a connected (not expired)
 * provider are polled. A first poll only seeds the cursor, so turning a trigger on never fires on history.
 */
export class TriggerService {
  readonly repo: TriggerRepo;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastPrune = 0;
  private offEvents: (() => void) | null = null;
  private slack: SlackSocketMode;
  private workspaces = new Map<string, string>();
  private teamsMe: string | null | undefined;

  constructor(private o: TriggerServiceOptions) {
    this.repo = new TriggerRepo(o.db);
    this.now = o.now ?? Date.now;
    this.slack = new SlackSocketMode({
      openUrl: () => o.integrations.run('slack', (c) => c.openSocketModeUrl()),
      onEvent: (p) => this.onSlackEvent(p),
      onStatus: (s) => this.slackStatus(s.error),
      socket: o.socket,
      setTimer: o.setTimer,
    });
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    // Fires left running by the previous process lost their callback; close them so the history is honest.
    for (const f of this.repo.runningFires()) this.repo.finishFire(f.id, 'error', null, 'The hub restarted during this turn.', this.now());
    // Events stored but never matched (the hub stopped in between) are matched now.
    for (const row of this.repo.pendingEvents()) this.process(row);
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    this.offEvents ??= events.onEvent((e) => {
      if (e.type === 'integrations.changed' || e.type === 'bots.changed') this.syncSlack();
    });
    this.syncSlack();
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offEvents?.();
    this.offEvents = null;
    this.slack.stop();
  }

  // ---------------------------------------------------------------- CRUD (REST is the only caller)
  list(): Trigger[] {
    return this.repo.list();
  }
  create(i: TriggerInput): Trigger {
    this.validate(i);
    const t = this.repo.create(i, this.now());
    this.changed();
    return t;
  }
  update(id: string, p: Partial<TriggerInput>): Trigger | undefined {
    const cur = this.repo.get(id);
    if (!cur) return undefined;
    this.validate({ ...cur, ...p });
    const t = this.repo.update(id, p, this.now());
    this.changed();
    return t;
  }
  delete(id: string) {
    this.repo.delete(id);
    this.changed();
  }
  private validate(i: Pick<TriggerInput, 'source' | 'filter' | 'botId' | 'roomId'>) {
    if (!this.o.repos.getBot(i.botId)) throw new IntegrationError('Unknown bot', 400);
    if (!this.o.repos.getRoom(i.roomId)) throw new IntegrationError('Unknown room', 400);
    if (i.source === 'github.repo') repoPath(i.filter?.repo ?? '');
  }
  private changed() {
    this.syncSlack();
    events.emitEvent({ type: 'triggers.changed' });
  }

  state(): TriggersState {
    const available = TRIGGER_SOURCES.filter((s) => {
      const info = this.o.integrations.repo.byProvider(TRIGGER_SOURCE_PROVIDER[s]);
      return !!info && info.status !== 'expired';
    });
    const triggers = this.repo.list();
    const t = this.now();
    const stats: TriggersState['stats'] = {};
    for (const tr of triggers) stats[tr.id] = { firesLastHour: this.repo.firesLastHour(tr.id, t), spentLastDayUsd: this.repo.spentLastDay(tr.id, t) };
    const keys = this.streams().map((s) => s.key);
    if (this.slackWanted()) keys.push('slack');
    return { triggers, available, polls: this.repo.pollStatus(keys), stats };
  }

  // ---------------------------------------------------------------- streams
  /** The stream a trigger listens on, or null when its source is not polled (Slack) or its filter is unusable. */
  keyFor(t: Pick<Trigger, 'source' | 'filter'>): string | null {
    switch (t.source) {
      case 'github.repo': {
        try { return 'github.repo:' + repoPath(t.filter.repo ?? ''); } catch { return null; }
      }
      case 'calendar': return 'calendar:' + (t.filter.calendar?.trim() || 'primary');
      case 'clickup': return 'clickup:' + (t.filter.workspace?.trim() ?? '');
      case 'slack': return 'slack';
      default: return t.source;
    }
  }

  /** Whether this trigger's bot may hear from its source: the provider is connected and the bot is granted. */
  private live(t: Trigger): boolean {
    if (!t.enabled) return false;
    const info = this.o.integrations.repo.byProvider(TRIGGER_SOURCE_PROVIDER[t.source]);
    return !!info && info.status !== 'expired' && info.botIds.includes(t.botId);
  }

  /** Streams to poll right now (Slack excluded: it pushes). */
  streams(): Stream[] {
    const out = new Map<string, Stream>();
    for (const t of this.repo.list()) {
      if (t.source === 'slack' || !this.live(t)) continue;
      const key = this.keyFor(t);
      if (!key || out.has(key)) continue;
      out.set(key, { key, source: t.source, provider: TRIGGER_SOURCE_PROVIDER[t.source], param: key.includes(':') ? key.slice(key.indexOf(':') + 1) : '' });
    }
    return [...out.values()];
  }

  // ---------------------------------------------------------------- polling
  /** Polls every stream that is due. Public so tests drive it with a fake clock. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const t = this.now();
      for (const s of this.streams()) {
        const cur = this.repo.cursor(s.key);
        if (cur?.nextPollAt && cur.nextPollAt > t) continue;
        await this.pollStream(s, cur);
      }
      if (t - this.lastPrune > 3_600_000) {
        this.lastPrune = t;
        this.repo.pruneInbox(t - INBOX_KEEP_MS);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async pollStream(s: Stream, cur: CursorRow | undefined) {
    const base: CursorRow = cur ?? { key: s.key, source: s.source, cursor: null, etag: null, lastPolledAt: null, nextPollAt: null, failures: 0, lastError: null };
    const t0 = this.now();
    let out: PollOutcome;
    try {
      out = await this.poll(s, base);
    } catch (e) {
      const failures = base.failures + 1;
      const wait = Math.min(POLL_INTERVAL_SEC[s.source] * 2 ** failures, MAX_BACKOFF_SEC);
      const msg = e instanceof Error ? e.message : String(e);
      const hadError = base.lastError;
      this.repo.saveCursor({ ...base, lastPolledAt: t0, nextPollAt: t0 + wait * 1000, failures, lastError: msg });
      if (hadError !== msg) events.emitEvent({ type: 'triggers.changed' });
      return;
    }
    const interval = Math.max(POLL_INTERVAL_SEC[s.source], out.intervalSec ?? 0);
    const hadError = !!base.lastError;
    // Cursor first, then the events: the inbox dedupes, so a crash in between re-polls nothing twice.
    this.repo.saveCursor({ ...base, cursor: out.cursor, etag: out.etag, lastPolledAt: t0, nextPollAt: t0 + interval * 1000, failures: 0, lastError: out.note ?? null });
    for (const f of out.found) this.ingest(s.key, f);
    if (hadError || out.note) events.emitEvent({ type: 'triggers.changed' });
  }

  /** One provider call (or a seed). `cur.cursor === null` means "never polled": seed, report nothing. */
  private async poll(s: Stream, cur: CursorRow): Promise<PollOutcome> {
    const I = this.o.integrations;
    switch (s.source) {
      case 'github.notifications': {
        const r = await I.run('github', (c) => c.pollNotifications({ cursor: cur.cursor }));
        const seeding = cur.cursor === null;
        const found = seeding ? [] : r.items.map((n) => ({
          dedupe: 'gh.n:' + n.id + ':' + n.updatedAt,
          event: ev(s.source, {
            id: n.id, title: n.title, text: n.type + ' in ' + n.repo + ': ' + n.title + ' (' + n.reason + ')', url: n.subjectUrl ?? '', at: n.updatedAt,
            fields: { repo: n.repo, reason: n.reason, type: n.type, title: n.title },
          }),
        }));
        // GitHub sends no Last-Modified on an empty first page; keep a non-null cursor so seeding ends.
        return { found, cursor: r.cursor ?? cur.cursor ?? new Date(this.now()).toUTCString(), etag: null, intervalSec: r.pollIntervalSec };
      }
      case 'github.repo': {
        const r = await I.run('github', (c) => c.pollRepoEvents(s.param, { etag: cur.etag }));
        if (r.notModified) return { found: [], cursor: cur.cursor ?? '0', etag: cur.etag, intervalSec: r.pollIntervalSec };
        const last = cur.cursor;
        const newer = last === null ? [] : r.items.filter((e) => idGreater(e.id, last));
        const top = r.items.reduce((m, e) => (idGreater(e.id, m) ? e.id : m), last ?? '0');
        return { found: newer.map((e) => ({ dedupe: 'gh.e:' + e.id, event: repoEvent(s.param, e) })), cursor: top, etag: r.etag ?? null, intervalSec: r.pollIntervalSec };
      }
      case 'gmail': {
        if (cur.cursor === null) return { found: [], cursor: await I.run('google', (c) => c.seedGmailHistory()), etag: null };
        const r = await I.run('google', (c) => c.pollGmail({ cursor: cur.cursor! }));
        if (r.resync) {
          const fresh = await I.run('google', (c) => c.seedGmailHistory());
          return { found: [], cursor: fresh, etag: null, note: 'Gmail history expired; mail received in the gap was skipped.' };
        }
        const found: Found[] = [];
        // Mail the account sent itself (a bot's reply, a draft) must not trigger a turn.
        for (const m of r.items.filter((x) => !x.labels.includes('SENT') && !x.labels.includes('DRAFT')).slice(0, GMAIL_READS_PER_POLL)) {
          const full = await I.run('google', (c) => c.gmailRead(m.id));
          found.push({
            dedupe: 'gmail:' + m.id,
            event: ev(s.source, {
              id: m.id, title: full.subject, text: full.body || full.snippet, from: full.from, at: full.date,
              url: 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(m.threadId),
              fields: { from: full.from, to: full.to, subject: full.subject, labels: (full.labels.length ? full.labels : m.labels).join(','), threadId: m.threadId },
            }),
          });
        }
        return { found, cursor: r.cursor, etag: null };
      }
      case 'calendar': {
        const calendarId = s.param || 'primary';
        if (cur.cursor === null) return { found: [], cursor: (await I.run('google', (c) => c.pollCalendar({ calendarId }))).cursor, etag: null };
        const r = await I.run('google', (c) => c.pollCalendar({ cursor: cur.cursor, calendarId }));
        if (r.resync) {
          const fresh = await I.run('google', (c) => c.pollCalendar({ calendarId }));
          return { found: [], cursor: fresh.cursor, etag: null, note: 'Calendar sync token expired; changes in the gap were skipped.' };
        }
        return {
          found: r.items.map((e) => ({
            dedupe: 'cal:' + calendarId + ':' + e.id + ':' + e.status + ':' + e.start,
            event: ev(s.source, {
              id: e.id, title: e.summary, from: e.organizer, url: e.url, at: e.start,
              text: [e.summary, e.start + (e.end ? ' – ' + e.end : ''), e.location, e.attendees.length ? 'Attendees: ' + e.attendees.join(', ') : ''].filter(Boolean).join('\n'),
              fields: { calendar: calendarId, title: e.summary, status: e.status, organizer: e.organizer, location: e.location, start: e.start, end: e.end, attendees: e.attendees.join(',') },
            }),
          })),
          cursor: r.cursor, etag: null,
        };
      }
      case 'drive': {
        if (cur.cursor === null) return { found: [], cursor: await I.run('google', (c) => c.seedDriveChanges()), etag: null };
        const r = await I.run('google', (c) => c.pollDrive({ cursor: cur.cursor! }));
        return {
          found: r.items.map((f) => ({
            dedupe: 'drive:' + f.fileId + ':' + f.time,
            event: ev(s.source, {
              id: f.fileId, title: f.name, text: (f.removed ? 'Removed: ' : 'Changed: ') + f.name, at: f.time,
              url: 'https://drive.google.com/file/d/' + encodeURIComponent(f.fileId), fields: { title: f.name, removed: String(f.removed), fileId: f.fileId },
            }),
          })),
          cursor: r.cursor, etag: null,
        };
      }
      case 'clickup': {
        const workspaceId = await this.workspace(s.param);
        if (cur.cursor === null) return { found: [], cursor: String(this.now()), etag: null };
        const r = await I.run('clickup', (c) => c.pollTasks({ workspaceId, cursor: cur.cursor }));
        return {
          found: r.items.map((t) => ({
            dedupe: 'clickup:' + t.id + ':' + t.dateUpdated,
            event: ev(s.source, {
              id: t.id, title: t.name, url: t.url, at: t.dateUpdated,
              text: t.name + '\nStatus: ' + t.status + '\nList: ' + t.list + (t.assignees.length ? '\nAssignees: ' + t.assignees.join(', ') : ''),
              fields: { workspace: workspaceId, list: t.list, listId: t.listId, status: t.status, assignees: t.assignees.join(','), title: t.name },
            }),
          })),
          cursor: r.cursor, etag: null,
        };
      }
      case 'teams': {
        if (cur.cursor === null) return { found: [], cursor: (await I.run('teams', (c) => c.pollChats({}))).cursor ?? new Date(this.now()).toISOString(), etag: null };
        const r = await I.run('teams', (c) => c.pollChats({ cursor: cur.cursor }));
        const me = await this.teamsSelf();
        return {
          // A message the signed-in account wrote (a bot's reply) must not trigger a turn.
          found: r.items.filter((c) => !me || c.lastFrom !== me).map((c) => ({
            dedupe: 'teams:' + c.id + ':' + c.lastAt,
            event: ev(s.source, {
              id: c.id, title: c.topic || 'Chat with ' + c.lastFrom, text: c.lastMessage, from: c.lastFrom, url: c.url, at: c.lastAt ?? '',
              fields: { chat: c.topic, from: c.lastFrom, text: c.lastMessage, type: c.type },
            }),
          })),
          cursor: r.cursor, etag: null,
        };
      }
    }
  }

  private async workspace(param: string): Promise<string> {
    if (param) return param;
    const hit = this.workspaces.get('');
    if (hit) return hit;
    const first = (await this.o.integrations.run('clickup', (c) => c.workspaces()))[0]?.id;
    if (!first) throw new IntegrationError('This ClickUp token sees no workspace', 404);
    this.workspaces.set('', first);
    return first;
  }
  private async teamsSelf(): Promise<string | null> {
    if (this.teamsMe !== undefined) return this.teamsMe;
    try {
      this.teamsMe = (await this.o.integrations.run('teams', (c) => c.whoami())).name || null;
    } catch {
      return null;
    }
    return this.teamsMe;
  }

  // ---------------------------------------------------------------- Slack Socket Mode
  private slackWanted(): boolean {
    return this.repo.list().some((t) => t.source === 'slack' && this.live(t));
  }
  /** Runs the socket while some enabled Slack trigger's bot may hear from Slack; stops it otherwise. */
  syncSlack() {
    const want = this.slackWanted();
    if (want && !this.slack.active) this.slack.start();
    else if (!want && this.slack.active) this.slack.stop();
  }
  private slackStatus(error: string | null) {
    const t = this.now();
    const cur = this.repo.cursor('slack');
    this.repo.saveCursor({
      key: 'slack', source: 'slack', cursor: null, etag: null, lastPolledAt: t, nextPollAt: null,
      failures: error ? (cur?.failures ?? 0) + 1 : 0, lastError: error,
    });
    if ((cur?.lastError ?? null) !== error) events.emitEvent({ type: 'triggers.changed' });
  }
  /** One `events_api` payload. Public for tests that feed envelopes without a socket. */
  onSlackEvent(p: SlackEventCallback) {
    const e = p.event;
    if (!e || (e.type !== 'message' && e.type !== 'app_mention')) return;
    // Bot posts (ours included) and edits/joins/deletes are not new messages from a person.
    if (e.bot_id || e.subtype) return;
    const id = p.event_id ?? (e.channel ?? '') + ':' + (e.ts ?? '');
    this.ingest('slack', {
      dedupe: 'slack:' + id,
      event: ev('slack', {
        id, title: 'Slack ' + (e.type === 'app_mention' ? 'mention' : 'message') + ' in ' + (e.channel ?? ''), text: e.text ?? '', from: e.user ?? '',
        at: e.ts ? new Date(Number(e.ts) * 1000).toISOString() : '',
        fields: { channel: e.channel ?? '', from: e.user ?? '', text: e.text ?? '', type: e.type, thread: e.thread_ts ?? '', team: p.team_id ?? '' },
      }),
    });
  }

  // ---------------------------------------------------------------- matching and firing
  private ingest(pollKey: string, f: Found) {
    const row = this.repo.addEvent(pollKey, f.dedupe, f.event, this.now());
    if (row) this.process(row);
  }

  /** Matches one stored event against the enabled triggers of its stream and fires each match. */
  private process(row: InboxRow) {
    let hit = false;
    for (const t of this.repo.list()) {
      if (!t.enabled || this.keyFor(t) !== row.pollKey || !matches(t, row.event)) continue;
      hit = true;
      this.fire(t, row.event, { eventId: row.id });
    }
    this.repo.markEvent(row.id, hit ? 'matched' : 'ignored', this.now());
  }

  /**
   * Fires one trigger for one event: access, hourly rate and daily budget first (each a `skipped` fire with a
   * reason), then `router.fireTrigger`. The turn is strict (approvals on even under bypass) because its cause
   * is a system message; nothing here can relax that.
   */
  fire(t: Trigger, event: TriggerEvent, o: { eventId: string | null; test?: boolean }): TriggerFire {
    const now = this.now();
    const skip = (note: string) => {
      const f = this.repo.addFire({ triggerId: t.id, eventId: o.eventId, title: event.title, status: 'skipped', note, test: o.test }, now);
      events.emitEvent({ type: 'trigger.fired', triggerId: t.id, fireId: f.id, status: f.status });
      return f;
    };
    const bot = this.o.repos.getBot(t.botId);
    const room = this.o.repos.getRoom(t.roomId);
    if (!bot || !room) return skip('The bot or room no longer exists.');
    if (!o.test) {
      const info = this.o.integrations.repo.byProvider(TRIGGER_SOURCE_PROVIDER[t.source]);
      if (!info || !info.botIds.includes(bot.id)) return skip('@' + bot.handle + ' has no access to this connection.');
    }
    const fired = this.repo.firesLastHour(t.id, now);
    if (fired >= t.maxPerHour) return skip('Rate limit: ' + t.maxPerHour + ' per hour.');
    const spent = this.repo.spentLastDay(t.id, now);
    if (spent >= t.budgetUsd) return skip('Daily budget reached ($' + spent.toFixed(2) + ' of $' + t.budgetUsd.toFixed(2) + ').');

    const fire = this.repo.addFire({ triggerId: t.id, eventId: o.eventId, title: event.title, status: 'running', test: o.test }, now);
    const payload: TriggerPayload = { triggerId: t.id, fireId: fire.id, name: t.name, source: t.source, eventId: o.eventId };
    let messageId = '';
    const msg = this.o.router.fireTrigger(room, bot, {
      name: t.name, prompt: t.prompt, event, payload, budgetUsd: t.budgetUsd - spent,
      onDone: (res) => {
        const cost = messageId ? this.o.repos.usageTotals({ causeId: messageId }).costUsd : res.costUsd;
        this.repo.finishFire(fire.id, res.ok ? 'success' : 'error', cost, res.ok ? null : res.error ?? null, this.now());
        events.emitEvent({ type: 'trigger.fired', triggerId: t.id, fireId: fire.id, status: res.ok ? 'success' : 'error' });
      },
    });
    messageId = msg.id;
    this.repo.setFireMessage(fire.id, msg.id);
    this.repo.touchFired(t.id, now);
    events.emitEvent({ type: 'trigger.fired', triggerId: t.id, fireId: fire.id, status: 'running' });
    return this.repo.getFire(fire.id)!;
  }

  /** "Test fire" from the builder: a sample event straight to this trigger, skipping the filter and the poll. */
  testFire(id: string, input: TriggerTestInput = {}): TriggerFire | undefined {
    const t = this.repo.get(id);
    if (!t) return undefined;
    const s = input.event ?? {};
    const sample = SAMPLE[t.source];
    const event = ev(t.source, {
      id: s.id ?? 'test-' + this.now(), title: s.title ?? sample.title, text: s.text ?? sample.text, from: s.from ?? sample.from,
      url: s.url ?? '', at: new Date(this.now()).toISOString(), fields: { ...sample.fields, ...t.filter, ...s.fields },
    });
    return this.fire(t, event, { eventId: null, test: true });
  }
}

const SAMPLE: Record<TriggerSource, { title: string; text: string; from: string; fields: Record<string, string> }> = {
  'github.notifications': { title: 'Review requested: Fix flaky test', text: 'PullRequest: Fix flaky test (review_requested)', from: '', fields: { reason: 'review_requested', type: 'PullRequest' } },
  'github.repo': { title: 'Crash on startup', text: 'The app crashes when the config file is empty.', from: 'octocat', fields: { type: 'IssuesEvent', action: 'opened', labels: 'bug' } },
  gmail: { title: 'Invoice for October', text: 'Hi, please find the invoice attached.', from: 'billing@example.com', fields: { subject: 'Invoice for October', labels: 'INBOX' } },
  calendar: { title: 'Interview: backend engineer', text: 'Interview: backend engineer\n10:00 – 11:00', from: 'recruiting@example.com', fields: { status: 'confirmed' } },
  drive: { title: 'Q4 report', text: 'Changed: Q4 report', from: '', fields: { removed: 'false' } },
  slack: { title: 'Slack message in C0123ABCD', text: 'Can someone look at the failed deploy?', from: 'U0123ABCD', fields: { type: 'message' } },
  clickup: { title: 'Ship the onboarding flow', text: 'Ship the onboarding flow\nStatus: in review', from: '', fields: { status: 'in review' } },
  teams: { title: 'Design sync', text: 'Can we move the review to Thursday?', from: 'Jordan', fields: { chat: 'Design sync' } },
};

/** Numeric GitHub event ids compared without losing precision. */
function idGreater(a: string, b: string): boolean {
  try { return BigInt(a) > BigInt(b); } catch { return a > b; }
}

type RepoEv = { id: string; type: string; actor: string; createdAt: string; payload: unknown };
type Obj = Record<string, unknown>;
function repoEvent(repo: string, e: RepoEv): TriggerEvent {
  const p = (e.payload ?? {}) as Obj;
  const issue = (p.issue ?? p.pull_request) as Obj | undefined;
  const comment = p.comment as Obj | undefined;
  const labels = ((issue?.labels ?? []) as Array<{ name?: string } | string>).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
  const commits = (p.commits ?? []) as Array<{ message?: string }>;
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const title = str(issue?.title) || (e.type === 'PushEvent' ? 'Push to ' + str(p.ref).replace('refs/heads/', '') : e.type + ' by ' + e.actor);
  const text = str(comment?.body) || str(issue?.body) || commits.map((c) => '- ' + str(c.message)).join('\n') || title;
  return ev('github.repo', {
    id: e.id, title, text, from: e.actor, at: e.createdAt, url: str(comment?.html_url) || str(issue?.html_url) || 'https://github.com/' + repo,
    fields: {
      repo, type: e.type, action: str(p.action), labels: labels.join(','), number: str(issue?.number), from: e.actor,
      label: str((p.label as Obj | undefined)?.name), ref: str(p.ref),
    },
  });
}

/**
 * A trigger's filter against an event: every non-empty filter value must match its field. A value matches
 * when the field contains it, ignoring case; `a, b` means either. Poll selectors (the ClickUp workspace) are
 * not matched again.
 */
export function matches(t: Pick<Trigger, 'source' | 'filter'>, e: TriggerEvent): boolean {
  for (const [k, raw] of Object.entries(t.filter)) {
    const v = raw.trim();
    if (!v || (t.source === 'clickup' && k === 'workspace')) continue;
    const field = (k === 'labels' ? [e.fields.labels, e.fields.label].filter(Boolean).join(',') : fieldValue(e, k)).toLowerCase();
    const any = v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!any.some((x) => field.includes(x))) return false;
  }
  return true;
}
