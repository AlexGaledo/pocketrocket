import { describe, expect, it } from 'vitest';
import type { Bot, FailoverState, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { FailoverRepo } from '../db/failoverRepo.js';
import { DEFAULT_HOLD_MS } from './ProviderHealth.js';
import { FailoverError, FailoverService, type ContinueTurn, type LimitedTurn } from './Failover.js';

/** M8 (spec 01 §4.7, P3-1): the failover card on its own, with a fake clock and stub providers. */

const T0 = Date.UTC(2026, 10, 19, 10, 0);
const RESET = T0 + 4 * 3600_000; // 14:00 UTC

function setup(o: { held?: (id: ProviderId, model?: string) => boolean; enabled?: ProviderId[] } = {}) {
  const repos = new Repos(new Db(':memory:'));
  let now = T0;
  const notes: { roomId: string; text: string; causeId: string | null }[] = [];
  const continued: Parameters<ContinueTurn>[0][] = [];
  const changes: FailoverState[] = [];
  const enabled = o.enabled ?? ['claude', 'gemini'];
  const svc = new FailoverService({
    repo: new FailoverRepo(repos.db), repos,
    label: (id) => ({ claude: 'Claude', gemini: 'Gemini' } as Record<string, string>)[id] ?? id,
    enabled: (id) => enabled.includes(id),
    isHeld: o.held ?? (() => false),
    note: (roomId, text, causeId) => notes.push({ roomId, text, causeId }),
    continueTurn: (c) => (continued.push(c), true),
    onChange: (s) => changes.push(s),
    now: () => now,
    timeZone: 'UTC',
  });
  const bot = repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 1 });
  repos.updateBot(bot.id, { backup: { provider: 'gemini', model: 'gemini-3-pro' } });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const limited = (over: Partial<LimitedTurn> = {}) =>
    svc.limited({
      bot: repos.getBot(bot.id)!, roomId: room.id, causeId: 'cause1', hop: 0, limit: { kind: 'usage', window: 'five_hour', resetsAt: RESET },
      provider: 'claude', model: 'claude-sonnet-5', stopped: false, onBackup: false, fromSeq: 3, toSeq: 5, budgetLeftUsd: 0.7, ...over,
    });
  return { repos, svc, bot: bot as Bot, room, notes, continued, changes, limited, tick: (ms: number) => (now += ms), setNow: (t: number) => (now = t) };
}

describe('raising the card', () => {
  it('a usage limit on a bot with a backup raises one pending card that expires at the reset', () => {
    const s = setup();
    const card = s.limited()!;
    expect(card).toMatchObject({ status: 'pending', provider: 'claude', window: 'five_hour', backup: { provider: 'gemini', model: 'gemini-3-pro' }, resetsAt: RESET, expiresAt: RESET });
    expect(s.svc.state().cards).toHaveLength(1);
    // The public card carries no cause, seqs or budget.
    expect(Object.keys(s.svc.state().cards[0])).not.toContain('causeId');
    expect(s.changes.at(-1)!.cards).toHaveLength(1);
  });

  it('no reset time: the card expires after the default hold', () => {
    const s = setup();
    expect(s.limited({ limit: { kind: 'usage' } })!.expiresAt).toBe(T0 + DEFAULT_HOLD_MS);
  });

  it('never on a sign-in problem, an overload or an outage, nor after a Stop', () => {
    const s = setup();
    expect(s.limited({ limit: { kind: 'auth' } })).toBeNull();
    expect(s.limited({ limit: { kind: 'overloaded' } })).toBeNull();
    expect(s.limited({ limit: { kind: 'down' } })).toBeNull();
    expect(s.limited({ stopped: true })).toBeNull();
    expect(s.svc.state().cards).toEqual([]);
  });

  it('no loops: a limit on a turn that already ran on the backup raises nothing', () => {
    const s = setup();
    expect(s.limited({ onBackup: true, provider: 'gemini', model: 'gemini-3-pro' })).toBeNull();
  });

  it('no card without a backup, or with one that cannot run (disabled, held, the same model), or with nothing left to spend', () => {
    const s = setup();
    s.repos.updateBot(s.bot.id, { backup: null });
    expect(s.limited()).toBeNull();
    s.repos.updateBot(s.bot.id, { backup: { provider: 'claude', model: 'claude-sonnet-5' } });
    expect(s.limited()).toBeNull();
    s.repos.updateBot(s.bot.id, { backup: { provider: 'gemini', model: 'gemini-3-pro' } });
    expect(s.limited({ budgetLeftUsd: 0 })).toBeNull();
    expect(setup({ enabled: ['claude'] }).limited()).toBeNull();
    expect(setup({ held: (id) => id === 'gemini' }).limited()).toBeNull();
    expect(s.svc.state().cards).toEqual([]);
  });

  it('a later limit in the same chat moves the open card on; its window keeps its start', () => {
    const s = setup();
    const a = s.limited()!;
    const b = s.limited({ causeId: 'cause2', toSeq: 9, budgetLeftUsd: 0.4 })!;
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ causeId: 'cause2', fromSeq: 3, toSeq: 9, budgetUsd: 0.4 });
    expect(s.svc.state().cards).toHaveLength(1);
  });
});

describe('answering the card', () => {
  it('Continue queues one turn on the backup, on the same thread, within what was left, and is then in force until the reset', () => {
    const s = setup();
    const card = s.limited()!;
    expect(s.svc.stickyFor(s.bot.id)).toBeNull();
    s.svc.decide(card.id, { decision: 'continue' });
    expect(s.continued).toEqual([{ botId: s.bot.id, roomId: s.room.id, causeId: 'cause1', hop: 0, backup: { provider: 'gemini', model: 'gemini-3-pro' }, fromSeq: 3, toSeq: 5, budgetUsd: 0.7 }]);
    expect(s.notes.at(-1)!.text).toBe('Ada continues on Gemini (gemini-3-pro), with approvals on. Until Claude resets at 14:00, what you send Ada runs there too.');
    expect(s.svc.state()).toEqual({ cards: [], active: [{ botId: s.bot.id, from: 'claude', backup: { provider: 'gemini', model: 'gemini-3-pro' }, until: RESET }] });
    expect(s.svc.stickyFor(s.bot.id)).toEqual({ provider: 'gemini', model: 'gemini-3-pro' });
    // Once per press: a second answer is refused and queues nothing.
    expect(() => s.svc.decide(card.id, { decision: 'continue' })).toThrow(FailoverError);
    expect(s.continued).toHaveLength(1);
    // The reset ends it; the sweep tells the clients the badge is gone.
    s.setNow(RESET);
    expect(s.svc.stickyFor(s.bot.id)).toBeNull();
    s.svc.sweep();
    expect(s.changes.at(-1)!.active).toEqual([]);
  });

  it('Continue stops applying when the owner removes or changes the backup', () => {
    const s = setup();
    s.svc.decide(s.limited()!.id, { decision: 'continue' });
    s.repos.updateBot(s.bot.id, { backup: { provider: 'gemini', model: 'gemini-3-flash' } });
    expect(s.svc.stickyFor(s.bot.id)).toBeNull();
  });

  it('Continue is refused when the backup changed since the card, or is held now; nothing is queued', () => {
    const s = setup();
    const card = s.limited()!;
    s.repos.updateBot(s.bot.id, { backup: { provider: 'gemini', model: 'gemini-3-flash' } });
    expect(() => s.svc.decide(card.id, { decision: 'continue' })).toThrow(/backup changed/);
    expect(s.svc.state().cards).toEqual([]);

    let held = false;
    const h = setup({ held: () => held });
    const c2 = h.limited()!;
    held = true;
    expect(() => h.svc.decide(c2.id, { decision: 'continue' })).toThrow(/at its own limit/);
    expect(h.continued).toEqual([]);
    expect(h.svc.state().cards).toHaveLength(1);
  });

  it('Wait closes the card with a note and switches nothing', () => {
    const s = setup();
    s.svc.decide(s.limited()!.id, { decision: 'wait' });
    expect(s.continued).toEqual([]);
    expect(s.svc.stickyFor(s.bot.id)).toBeNull();
    expect(s.notes.at(-1)!.text).toBe('Ada waits for Claude to reset at 14:00. Send a message after that to pick it up.');
    expect(s.svc.state()).toEqual({ cards: [], active: [] });
  });

  it('an unknown card is 404; a card past its reset is 409 and expires', () => {
    const s = setup();
    expect(() => s.svc.decide('nope', { decision: 'continue' })).toThrow(expect.objectContaining({ status: 404 }));
    const card = s.limited()!;
    s.setNow(RESET + 1);
    expect(() => s.svc.decide(card.id, { decision: 'continue' })).toThrow(expect.objectContaining({ status: 409, message: 'This card expired.' }));
    expect(s.continued).toEqual([]);
  });
});

describe('a card nobody answers', () => {
  it('expires at the reset with a quiet note, and never switches (a routine left alone stays on its provider)', () => {
    const s = setup();
    s.limited({ causeId: 'routine-cause' });
    s.tick(3600_000);
    s.svc.sweep();
    expect(s.svc.state().cards).toHaveLength(1);
    s.setNow(RESET);
    s.svc.sweep();
    expect(s.svc.state()).toEqual({ cards: [], active: [] });
    expect(s.notes).toEqual([{ roomId: s.room.id, causeId: 'routine-cause', text: 'Not continued on Gemini. Claude reset at 14:00; send Ada a message to pick it up.' }]);
    expect(s.continued).toEqual([]);
    expect(s.svc.stickyFor(s.bot.id)).toBeNull();
  });

  it('survives a restart (persisted): a new service still lists it and can answer it', () => {
    const s = setup();
    const card = s.limited()!;
    const again = new FailoverService({
      repo: new FailoverRepo(s.repos.db), repos: s.repos, label: (id) => id, enabled: () => true, isHeld: () => false,
      note: () => undefined, continueTurn: () => true, now: () => T0 + 60_000,
    });
    expect(again.state().cards.map((c) => c.id)).toEqual([card.id]);
    expect(again.decide(card.id, { decision: 'continue' }).status).toBe('continued');
  });

  it('a deleted bot takes its cards with it', () => {
    const s = setup();
    s.limited();
    s.repos.deleteBot(s.bot.id);
    s.svc.sweep();
    expect(s.svc.state().cards).toEqual([]);
  });
});
