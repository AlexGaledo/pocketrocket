import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationProvider, TriggerInput } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from './UsageTracker.js';
import { IntegrationVault } from './IntegrationVault.js';
import { IntegrationService } from './IntegrationService.js';
import { RoomRouter } from '../rooms/RoomRouter.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { fakeFetch } from '../integrations/fakeFetch.js';
import { TriggerService, matches } from './TriggerService.js';
import type { SocketLike } from './SlackSocketMode.js';
import * as F from './__fixtures__/triggerFixtures.js';

const GH = 'https://api.github.com';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const CU = 'https://api.clickup.com/api/v2';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) { super(); }
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; this.emit('close'); }
  push(obj: unknown) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

/** A hub slice: db, repos, integrations over a fake fetch, a router over a recording runner, a fake clock. */
function setup(o: { db?: Db; dir?: string } = {}) {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pr-trig-'));
  if (!o.dir) dirs.push(dir);
  const db = o.db ?? new Db(':memory:');
  const repos = new Repos(db);
  const usage = new UsageTracker(repos);
  const f = fakeFetch();
  const clock = { t: Date.parse('2026-11-01T09:00:00Z') };
  const integrations = new IntegrationService({
    db, fetch: f.fetch, now: () => clock.t,
    vault: new IntegrationVault({ file: path.join(dir, 'i.json'), keyFile: path.join(dir, 'vault.key') }),
  });
  const router = new RoomRouter(repos, usage);
  const reqs: TurnRequest[] = [];
  let cost = 0;
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      if (cost) usage.record(req.bot.id, req.room.id, 't' + reqs.length, req.causeId, { costUsd: cost, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: null, durationMs: 1 });
      return { ok: true, turnId: 't' + reqs.length, finalText: '', costUsd: cost };
    },
  } as unknown as BotRunner;
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const svc = new TriggerService({
    db, repos, integrations, router, now: () => clock.t,
    socket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
  });
  const bot = repos.getBot('scout') ?? repos.listBots().find((b) => b.handle === 'scout') ?? repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.listRooms()[0] ?? repos.createRoom({ kind: 'dm', name: 'Scout', memberIds: [bot.id], coordinatorBotId: null });
  /** Connects a provider as if signed in (no network), optionally granting the bot. */
  const connect = (p: IntegrationProvider, grant = true, extra: Record<string, string> = {}) => {
    const info = integrations.repo.upsert({ provider: p, method: 'oauth', accountLabel: p + '-acct', scopes: [] });
    integrations.vault.set('conn:' + info.id, { accessToken: 'tok-' + p, ...extra });
    if (grant) integrations.setGrants(info.id, [bot.id]);
    return info;
  };
  const trigger = (i: Partial<TriggerInput> & Pick<TriggerInput, 'source'>) =>
    svc.create({ name: 'T', enabled: true, filter: {}, botId: bot.id, roomId: room.id, prompt: 'Look at {{event.title}}', maxPerHour: 6, budgetUsd: 2, ...i });
  const advance = (sec: number) => { clock.t += sec * 1000; };
  return { db, dir, repos, usage, f, clock, advance, integrations, router, reqs, svc, bot, room, connect, trigger, sockets, timers, setCost: (c: number) => { cost = c; } };
}

describe('filter matching', () => {
  const e = { source: 'github.repo' as const, id: '1', title: 'Crash on startup', text: '', from: 'octocat', url: '', at: '', fields: { repo: 'acme/app', labels: 'bug,p1', type: 'IssuesEvent', action: 'opened' } };
  it('needs every filter field to contain one of its comma-separated values, ignoring case', () => {
    expect(matches({ source: 'github.repo', filter: {} }, e)).toBe(true);
    expect(matches({ source: 'github.repo', filter: { labels: 'BUG' } }, e)).toBe(true);
    expect(matches({ source: 'github.repo', filter: { labels: 'docs, p1' } }, e)).toBe(true);
    expect(matches({ source: 'github.repo', filter: { labels: 'docs' } }, e)).toBe(false);
    expect(matches({ source: 'github.repo', filter: { action: 'opened', from: 'octo' } }, e)).toBe(true);
    expect(matches({ source: 'github.repo', filter: { action: 'closed' } }, e)).toBe(false);
    expect(matches({ source: 'github.repo', filter: { title: 'crash' } }, e)).toBe(true);
  });
});

describe('GitHub repo events poller', () => {
  it('seeds on the first poll, fires only newer events, sends the ETag back, and dedupes', async () => {
    const h = setup();
    h.connect('github');
    let page = F.GH_REPO_EVENTS_SEED as unknown[];
    let etag = '"e1"';
    h.f.on('GET', GH + '/repos/acme/app/events', (c) => (c.headers['if-none-match'] === etag ? { status: 304 } : { json: page, headers: { etag, 'x-poll-interval': '90' } }));
    const t = h.trigger({ source: 'github.repo', filter: { repo: 'acme/app' } });

    await h.svc.tick();
    expect(h.reqs).toHaveLength(0); // seeded, not fired on history
    const cur = h.svc.repo.cursor('github.repo:acme/app')!;
    expect(cur).toMatchObject({ cursor: '40000000001', etag: '"e1"', failures: 0 });
    // X-Poll-Interval (90 s) beats the default 60 s.
    expect(cur.nextPollAt! - cur.lastPolledAt!).toBe(90_000);

    await h.svc.tick(); // not due
    expect(h.f.calls).toHaveLength(1);

    h.advance(90);
    await h.svc.tick(); // 304: nothing changed
    expect(h.f.calls[1].headers['if-none-match']).toBe('"e1"');
    expect(h.reqs).toHaveLength(0);

    page = F.GH_REPO_EVENTS_NEW;
    etag = '"e2"';
    h.advance(90);
    await h.svc.tick();
    // Two events, two fires; queued together in the bot's lane they may share one turn.
    await until(() => h.svc.repo.listFires(t.id).length === 2 && h.svc.repo.listFires(t.id).every((f) => f.status === 'success'));
    const turns = h.reqs.length;
    expect(h.svc.repo.cursor('github.repo:acme/app')!.cursor).toBe('40000000003');
    const msgs = h.repos.listMessages(h.room.id, { limit: 10 }).filter((m) => m.kind === 'trigger');
    expect(msgs).toHaveLength(2);
    expect(h.reqs.every((r) => r.causeKind === 'trigger' && r.strictApprovals)).toBe(true);

    // The same events again (a cursor reset, a provider replay) are dropped by the inbox.
    h.svc.repo.saveCursor({ ...h.svc.repo.cursor('github.repo:acme/app')!, cursor: '40000000001', etag: null, nextPollAt: null });
    await h.svc.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reqs).toHaveLength(turns);
    expect(h.svc.repo.listFires(t.id)).toHaveLength(2);
  });

  it('fires only triggers whose filter matches', async () => {
    const h = setup();
    h.connect('github');
    h.f.on('GET', GH + '/repos/acme/app/events', () => ({ json: F.GH_REPO_EVENTS_NEW, headers: { etag: '"x"' } }));
    const bug = h.trigger({ source: 'github.repo', name: 'Bugs', filter: { repo: 'acme/app', type: 'IssuesEvent', labels: 'bug' } });
    h.trigger({ source: 'github.repo', name: 'Docs', filter: { repo: 'acme/app', labels: 'docs' } });
    h.svc.repo.saveCursor({ key: 'github.repo:acme/app', source: 'github.repo', cursor: '40000000001', etag: null, lastPolledAt: null, nextPollAt: null, failures: 0, lastError: null });
    await h.svc.tick();
    await until(() => h.reqs.length === 1);
    expect(h.svc.repo.listFires(bug.id).map((f) => f.title)).toEqual(['Crash on startup']);
    expect(h.reqs[0].injected).toContain('[Trigger "Bugs"] Look at "Crash on startup"');
  });
});

describe('what gets polled', () => {
  it('only polls providers that are connected and granted to an enabled trigger\'s bot', async () => {
    const h = setup();
    h.f.on('GET', GH + '/notifications', () => ({ json: [] }));
    const t = h.trigger({ source: 'github.notifications' });
    expect(h.svc.streams()).toEqual([]); // not connected
    const info = h.connect('github', false);
    expect(h.svc.streams()).toEqual([]); // connected, but the bot has no grant
    h.integrations.setGrants(info.id, [h.bot.id]);
    expect(h.svc.streams().map((s) => s.key)).toEqual(['github.notifications']);
    h.svc.update(t.id, { enabled: false });
    expect(h.svc.streams()).toEqual([]);
    h.svc.update(t.id, { enabled: true });
    h.integrations.repo.setStatus(info.id, 'expired', 'revoked');
    expect(h.svc.streams()).toEqual([]); // reconnect needed
    await h.svc.tick();
    expect(h.f.calls).toHaveLength(0);
    expect(h.svc.state().available).not.toContain('github.notifications');
  });

  it('backs off a failing stream and stops polling one whose credential was refused', async () => {
    const h = setup();
    h.connect('github');
    let status = 500;
    h.f.on('GET', GH + '/notifications', () => ({ status, json: { message: 'boom' } }));
    h.trigger({ source: 'github.notifications' });
    await h.svc.tick();
    let cur = h.svc.repo.cursor('github.notifications')!;
    expect(cur.failures).toBe(1);
    expect(cur.nextPollAt! - cur.lastPolledAt!).toBe(120_000); // 60 s × 2¹
    expect(cur.lastError).toContain('500');
    h.advance(60);
    await h.svc.tick();
    expect(h.f.calls).toHaveLength(1); // still backing off
    h.advance(60);
    await h.svc.tick();
    cur = h.svc.repo.cursor('github.notifications')!;
    expect(cur.failures).toBe(2);
    expect(cur.nextPollAt! - cur.lastPolledAt!).toBe(240_000);

    status = 401; // revoked: integrations.run marks the connection expired and the stream drops out
    h.advance(240);
    await h.svc.tick();
    expect(h.integrations.repo.byProvider('github')!.status).toBe('expired');
    h.advance(3600);
    const n = h.f.calls.length;
    await h.svc.tick();
    expect(h.f.calls.length).toBe(n);
  });
});

describe('GitHub notifications poller', () => {
  it('uses Last-Modified as the cursor and fires per new notification', async () => {
    const h = setup();
    h.connect('github');
    let page = F.GH_NOTIFICATIONS_SEED as unknown[];
    h.f.on('GET', GH + '/notifications', (c) => (c.headers['if-modified-since'] === 'Sun, 01 Nov 2026 09:00:00 GMT' && page === F.GH_NOTIFICATIONS_SEED
      ? { status: 304 }
      : { json: page, headers: { 'last-modified': page === F.GH_NOTIFICATIONS_SEED ? 'Sun, 01 Nov 2026 09:00:00 GMT' : 'Sun, 01 Nov 2026 09:12:00 GMT', 'x-poll-interval': '60' } }));
    h.trigger({ source: 'github.notifications', filter: { reason: 'review_requested' } });
    await h.svc.tick();
    expect(h.svc.repo.cursor('github.notifications')!.cursor).toBe('Sun, 01 Nov 2026 09:00:00 GMT');
    h.advance(60);
    await h.svc.tick();
    expect(h.f.calls[1].headers['if-modified-since']).toBe('Sun, 01 Nov 2026 09:00:00 GMT');
    page = F.GH_NOTIFICATIONS_NEW;
    h.advance(60);
    await h.svc.tick();
    await until(() => h.reqs.length === 1);
    expect(h.reqs[0].injected).toContain('Fix flaky test');
    expect(h.svc.repo.inboxCount()).toBe(2); // both stored, one matched
  });
});

describe('Google pollers', () => {
  it('Gmail: seeds a historyId, reads new mail, skips mail the account sent, re-seeds on 404', async () => {
    const h = setup();
    h.connect('google');
    let history: { status?: number; json?: unknown } = { json: F.GMAIL_HISTORY };
    h.f.on('GET', GMAIL + '/profile', () => ({ json: F.GMAIL_PROFILE }));
    h.f.on('GET', GMAIL + '/history', () => history);
    h.f.on('GET', GMAIL + '/messages/m1', () => ({ json: F.GMAIL_MESSAGE_M1 }));
    h.trigger({ source: 'gmail', filter: { from: 'vendor.example' }, prompt: 'Mail from {{event.from}}: {{event.subject}}' });
    await h.svc.tick();
    expect(h.svc.repo.cursor('gmail')!.cursor).toBe('5000');
    h.advance(60);
    await h.svc.tick();
    await until(() => h.reqs.length === 1);
    expect(h.f.calls.some((c) => c.url.pathname.endsWith('/messages/m2'))).toBe(false);
    expect(h.svc.repo.cursor('gmail')!.cursor).toBe('5002');
    expect(h.reqs[0].injected).toContain('Mail from "Billing <billing@vendor.example>": "Invoice 2026-10"');
    expect(h.reqs[0].injected).toContain('the October invoice is attached');

    history = { status: 404, json: { error: { message: 'Requested entity was not found.' } } };
    h.advance(60);
    await h.svc.tick();
    const cur = h.svc.repo.cursor('gmail')!;
    expect(cur.cursor).toBe('5000'); // re-seeded from the profile
    expect(cur.lastError).toContain('skipped');
    expect(cur.failures).toBe(0);
  });

  it('Calendar: seeds a syncToken, fires on changes (including cancellations), re-seeds on 410', async () => {
    const h = setup();
    h.connect('google');
    let mode: 'seed' | 'changes' | 'gone' = 'seed';
    h.f.on('GET', CAL, (c) => {
      if (mode === 'gone') return c.url.searchParams.get('syncToken') ? { status: 410, json: {} } : { json: F.CAL_SEED };
      if (mode === 'seed') return { json: F.CAL_SEED };
      expect(c.url.searchParams.get('syncToken')).toBe('sync-1');
      return { json: F.CAL_CHANGES };
    });
    const t = h.trigger({ source: 'calendar', filter: { status: 'cancelled' } });
    await h.svc.tick();
    expect(h.svc.repo.cursor('calendar:primary')!.cursor).toBe('sync-1');
    mode = 'changes';
    h.advance(120);
    await h.svc.tick();
    await until(() => h.reqs.length === 1);
    expect(h.svc.repo.listFires(t.id)[0].title).toBe('Lunch');
    mode = 'gone';
    h.advance(120);
    await h.svc.tick();
    expect(h.svc.repo.cursor('calendar:primary')!).toMatchObject({ cursor: 'sync-1', failures: 0 });
  });

  it('Drive: seeds a page token and reports changes and removals', async () => {
    const h = setup();
    h.connect('google');
    h.f.on('GET', DRIVE + '/changes', () => ({ json: F.DRIVE_CHANGES }));
    h.f.on('GET', DRIVE + '/changes/startPageToken', () => ({ json: F.DRIVE_START }));
    h.trigger({ source: 'drive', filter: { removed: 'true' } });
    await h.svc.tick();
    h.advance(300);
    await h.svc.tick();
    await until(() => h.reqs.length === 1);
    expect(h.svc.repo.cursor('drive')!.cursor).toBe('102');
  });
});

describe('ClickUp and Teams pollers (5.4)', () => {
  it('ClickUp: resolves the first workspace, polls date_updated_gt from the stored cursor', async () => {
    const h = setup();
    h.connect('clickup');
    // fakeFetch tries the newest route first and matches by prefix: register the shorter path first.
    h.f.on('GET', CU + '/team', () => ({ json: F.CLICKUP_TEAMS }));
    h.f.on('GET', CU + '/team/9001/task', () => ({ json: F.CLICKUP_TASKS }));
    h.trigger({ source: 'clickup', filter: { status: 'review' } });
    await h.svc.tick();
    const seeded = h.svc.repo.cursor('clickup:')!.cursor!;
    expect(Number(seeded)).toBe(h.clock.t);
    h.advance(60);
    await h.svc.tick();
    await until(() => h.reqs.length === 1);
    const poll = h.f.calls.find((c) => c.url.pathname === '/api/v2/team/9001/task')!;
    expect(poll.url.searchParams.get('date_updated_gt')).toBe(seeded);
    expect(h.svc.repo.cursor('clickup:')!.cursor).toBe('1793523660000');
  });

  it('Teams: polls chats newer than the cursor and ignores what the signed-in account wrote', async () => {
    const h = setup();
    h.connect('teams');
    let chats: unknown = F.TEAMS_CHATS_SEED;
    h.f.on('GET', GRAPH + '/me', () => ({ json: F.TEAMS_ME }));
    h.f.on('GET', GRAPH + '/me/chats', () => ({ json: chats }));
    h.trigger({ source: 'teams' });
    await h.svc.tick();
    expect(h.svc.repo.cursor('teams')!.cursor).toBe('2026-11-01T08:00:00Z');
    chats = F.TEAMS_CHATS_NEW;
    h.advance(60);
    await h.svc.tick();
    await until(() => h.reqs.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reqs).toHaveLength(1);
    expect(h.reqs[0].injected).toContain('Can we move the review?');
  });
});

describe('restart', () => {
  it('keeps cursors and the inbox across a restart, and matches events stored but never processed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-trig-r-'));
    dirs.push(dir);
    const file = path.join(dir, 'hub.db');
    const a = setup({ db: new Db(file), dir });
    a.connect('github');
    a.f.on('GET', GH + '/repos/acme/app/events', () => ({ json: F.GH_REPO_EVENTS_SEED, headers: { etag: '"e1"' } }));
    a.trigger({ source: 'github.repo', filter: { repo: 'acme/app' } });
    await a.svc.tick();
    // An event stored just before the hub died, never matched.
    a.svc.repo.addEvent('github.repo:acme/app', 'gh.e:999', { source: 'github.repo', id: '999', title: 'Left over', text: '', from: '', url: '', at: '', fields: { repo: 'acme/app' } });
    a.db.raw.close();

    const b = setup({ db: new Db(file), dir });
    b.f.on('GET', GH + '/repos/acme/app/events', (c) => (c.headers['if-none-match'] === '"e1"' ? { status: 304 } : { json: F.GH_REPO_EVENTS_NEW }));
    expect(b.svc.repo.cursor('github.repo:acme/app')!.cursor).toBe('40000000001');
    b.svc.start();
    await until(() => b.reqs.length === 1);
    expect(b.reqs[0].injected).toContain('Left over');
    b.advance(60);
    await b.svc.tick();
    expect(b.f.calls.at(-1)!.headers['if-none-match']).toBe('"e1"'); // the stored ETag, not a re-seed
    expect(b.svc.repo.pendingEvents()).toEqual([]);
    b.svc.stop();
    b.db.raw.close();
  });
});

describe('limits', () => {
  it('skips fires past the hourly rate limit, with a reason', async () => {
    const h = setup();
    h.connect('github');
    const t = h.trigger({ source: 'github.repo', filter: { repo: 'acme/app' }, maxPerHour: 1 });
    h.svc.testFire(t.id);
    h.svc.testFire(t.id);
    const fires = h.svc.repo.listFires(t.id);
    expect(fires.map((f) => f.status).sort()).toEqual(['running', 'skipped']);
    expect(fires.find((f) => f.status === 'skipped')!.note).toContain('Rate limit');
    h.advance(3601);
    expect(h.svc.testFire(t.id)!.status).toBe('running');
  });

  it('applies no daily budget when spend caps are off', async () => {
    const h = setup();
    h.connect('github');
    const t = h.trigger({ source: 'github.repo', filter: { repo: 'acme/app' }, budgetUsd: 1, maxPerHour: 60 });
    h.setCost(5);
    process.env.POCKETROCKET_NO_SPEND_CAPS = '1';
    try {
      h.svc.testFire(t.id);
      await until(() => h.reqs.length === 1);
      await until(() => h.svc.repo.listFires(t.id)[0].status === 'success');
      expect(h.svc.testFire(t.id)!.status).not.toBe('skipped');
      await until(() => h.reqs.length === 2);
      expect(h.svc.remainingBudget(t.id)).toBe(Infinity);
      expect(h.svc.remainingBudget('nope')).toBeUndefined();
    } finally {
      delete process.env.POCKETROCKET_NO_SPEND_CAPS;
    }
  });

  it('caps a turn at the trigger\'s remaining daily budget and skips once it is spent (hops included)', async () => {
    const h = setup();
    h.connect('github');
    const t = h.trigger({ source: 'github.repo', filter: { repo: 'acme/app' }, budgetUsd: 1, maxPerHour: 60 });
    h.setCost(0.7);
    h.svc.testFire(t.id);
    await until(() => h.reqs.length === 1);
    expect(h.reqs[0].causeBudgetUsd).toBe(1);
    await until(() => h.svc.repo.listFires(t.id)[0].status === 'success');
    expect(h.svc.repo.listFires(t.id)[0].costUsd).toBeCloseTo(0.7);
    h.svc.testFire(t.id);
    await until(() => h.reqs.length === 2);
    expect(h.reqs[1].causeBudgetUsd).toBeCloseTo(0.3);
    await until(() => h.svc.repo.listFires(t.id)[0].status === 'success');
    const third = h.svc.testFire(t.id)!;
    expect(third.status).toBe('skipped');
    expect(third.note).toContain('Daily budget');
    // The router reads this for resumed turns and hops on the trigger's thread.
    expect(h.svc.remainingBudget(t.id)).toBeCloseTo(1 - 1.4);
    expect(h.svc.remainingBudget('nope')).toBeUndefined();
    h.advance(24 * 3600 + 1);
    expect(h.svc.testFire(t.id)!.status).toBe('running');
  });

  it('a real event for a bot that lost its grant is skipped, not fired', () => {
    const h = setup();
    const info = h.connect('github');
    const t = h.trigger({ source: 'github.repo', filter: { repo: 'acme/app' } });
    h.integrations.setGrants(info.id, []);
    const f = h.svc.fire(t, { source: 'github.repo', id: '1', title: 'x', text: '', from: '', url: '', at: '', fields: {} }, { eventId: 'e' });
    expect(f.status).toBe('skipped');
    expect(f.note).toContain('no access');
    expect(h.reqs).toHaveLength(0);
  });
});

describe('Slack Socket Mode', () => {
  it('opens a socket only when a granted Slack trigger exists, acks every envelope at once, fires on messages', async () => {
    const h = setup();
    let urls = 0;
    h.f.on('POST', 'https://slack.com/api/apps.connections.open', (c) => {
      expect(c.headers.authorization).toBe('Bearer xapp-1-test');
      return { json: { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=' + ++urls } };
    });
    h.connect('slack', true, { appToken: 'xapp-1-test' });
    h.svc.start();
    expect(h.sockets).toHaveLength(0); // no Slack trigger yet
    h.trigger({ source: 'slack', filter: { channel: 'C0123ABCD' } });
    await until(() => h.sockets.length === 1);
    const s = h.sockets[0];
    expect(s.url).toContain('ticket=1');
    s.push(F.SLACK_HELLO);
    s.push(F.slackEnvelope(1, { type: 'message', channel: 'C0123ABCD', user: 'U1', text: 'deploy failed', ts: '1793523600.000100' }));
    // The ack went out synchronously with the envelope, before any turn ran.
    expect(s.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
    s.push(F.slackEnvelope(2, { type: 'message', channel: 'C999', user: 'U1', text: 'other channel', ts: '1793523601.000100' }));
    s.push(F.slackEnvelope(3, { type: 'message', channel: 'C0123ABCD', bot_id: 'B1', text: 'our own post', ts: '1793523602.000100' }));
    s.push(F.slackEnvelope(1, { type: 'message', channel: 'C0123ABCD', user: 'U1', text: 'deploy failed', ts: '1793523600.000100' })); // Slack retry
    expect(s.sent).toHaveLength(4);
    await until(() => h.reqs.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reqs).toHaveLength(1);
    expect(h.reqs[0].injected).toContain('deploy failed');
    expect(h.svc.repo.cursor('slack')).toMatchObject({ lastError: null, failures: 0 });

    // Slack rotates the connection: a fresh URL at once.
    s.push(F.SLACK_DISCONNECT);
    await until(() => h.sockets.length === 2);
    expect(h.sockets[1].url).toContain('ticket=2');
    // A dropped socket reconnects after a backoff timer.
    h.sockets[1].emit('close');
    expect(h.timers.at(-1)!.ms).toBe(1000);
    h.timers.at(-1)!.fn();
    await until(() => h.sockets.length === 3);
    h.svc.stop();
    expect(h.sockets[2].closed).toBe(true);
  });

  it('records why it cannot connect (no app token) and does not spin', async () => {
    const h = setup();
    h.connect('slack');
    h.trigger({ source: 'slack' });
    h.svc.start();
    await until(() => !!h.svc.repo.cursor('slack')?.lastError);
    expect(h.svc.repo.cursor('slack')!.lastError).toContain('xapp');
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
    h.svc.stop();
  });
});
