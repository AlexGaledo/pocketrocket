import { describe, expect, it } from 'vitest';
import type { Bot, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { FailoverRepo } from '../db/failoverRepo.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { FailoverService } from '../services/Failover.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';

/**
 * M8 (spec 01 §4.7, P3-1) through RoomRouter with a stub runner and a fake clock: the limited turn ends at once, the
 * card waits outside any lane or slot, Continue queues one strict, attended turn on the backup, and the backup stays in
 * force for attended turns until the reset.
 */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 19, 10, 0);
const RESET = T0 + 4 * 3600_000;
const LIMITED = (provider: ProviderId = 'claude'): Partial<TurnResult> => ({
  ok: false, error: 'usage limit reached', costUsd: 0.3, provider, model: provider === 'claude' ? 'claude-sonnet-5' : 'gemini-3.1-pro',
  limit: { kind: 'usage', window: 'five_hour', resetsAt: RESET },
});

function setup(o: { backup?: boolean } = {}) {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  let now = T0;
  const reqs: TurnRequest[] = [];
  const script: Partial<TurnResult>[] = [];
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      return { ok: true, turnId: 't' + reqs.length, finalText: '', costUsd: 0.01, provider: req.providerOverride?.provider ?? 'claude', ...(script.shift() ?? {}) };
    },
    steer: () => ({ status: 'queued', reason: 'provider' }),
  } as unknown as BotRunner;
  const failover = new FailoverService({
    repo: new FailoverRepo(repos.db), repos, label: (id) => (id === 'claude' ? 'Claude' : 'Gemini'), enabled: () => true, isHeld: () => false,
    note: (roomId, text, causeId, hop) => router.systemNote(repos.getRoom(roomId)!, text, causeId, hop),
    continueTurn: (c) => router.continueOnBackup(c),
    now: () => now, timeZone: 'UTC',
  });
  router.failover = failover;
  const bot = repos.createBot({ name: 'Ada', handle: 'ada', title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 1 });
  if (o.backup !== false) repos.updateBot(bot.id, { backup: { provider: 'gemini', model: 'gemini-3.1-pro' } });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const lanes = () => repos.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM lane_journal')[0].n;
  return { repos, router, failover, reqs, script, bot: bot as Bot, room, lanes, setNow: (t: number) => (now = t) };
}

describe('the failover card through the router', () => {
  it('a limit ends the turn and raises a card; nothing waits in the lane meanwhile', async () => {
    const s = setup();
    s.script.push(LIMITED());
    s.router.onUserMessage(s.room.id, 'write the report');
    await until(() => s.failover.state().cards.length === 1);
    await tick();
    expect(s.reqs).toHaveLength(1);
    expect(s.lanes()).toBe(0);
    expect(s.router.pendingLaneCount()).toBe(0);
    const card = s.failover.state().cards[0];
    expect(card).toMatchObject({ botId: s.bot.id, roomId: s.room.id, provider: 'claude', expiresAt: RESET });
    // The lane is free: another message runs at once (on Claude still: nothing was pressed).
    s.router.onUserMessage(s.room.id, 'never mind');
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].providerOverride).toBeUndefined();
  });

  it('Continue: one strict, attended turn on the backup, same thread, shown the unanswered message, within what was left', async () => {
    const s = setup();
    s.script.push(LIMITED());
    const ask = s.router.onUserMessage(s.room.id, 'write the report');
    await until(() => s.failover.state().cards.length === 1);
    const first = s.reqs[0];
    s.failover.decide(s.failover.state().cards[0].id, { decision: 'continue' });
    await until(() => s.reqs.length === 2);
    const r = s.reqs[1];
    expect(r.providerOverride).toEqual({ provider: 'gemini', model: 'gemini-3.1-pro' });
    expect(r.strictApprovals).toBe(true);
    expect(r.causeId).toBe(first.causeId);
    expect(r.causeKind).toBe('user');
    expect(r.injected).toContain('write the report');
    // Budget never raised: the limited turn had $1 and spent $0.30.
    expect(r.causeBudgetUsd).toBeCloseTo(0.7, 5);
    void ask;
  });

  it('no loops: a limit on the backup turn raises no second card', async () => {
    const s = setup();
    s.script.push(LIMITED(), LIMITED('gemini'));
    s.router.onUserMessage(s.room.id, 'go');
    await until(() => s.failover.state().cards.length === 1);
    s.failover.decide(s.failover.state().cards[0].id, { decision: 'continue' });
    await until(() => s.reqs.length === 2);
    await tick();
    expect(s.failover.state().cards).toEqual([]);
    expect(s.reqs).toHaveLength(2);
  });

  it('after a press, attended turns of that bot use the backup until the reset; then its own provider again', async () => {
    const s = setup();
    s.script.push(LIMITED());
    s.router.onUserMessage(s.room.id, 'go');
    await until(() => s.failover.state().cards.length === 1);
    s.failover.decide(s.failover.state().cards[0].id, { decision: 'continue' });
    await until(() => s.reqs.length === 2);
    s.router.onUserMessage(s.room.id, 'and the summary');
    await until(() => s.reqs.length === 3);
    expect(s.reqs[2].providerOverride).toEqual({ provider: 'gemini', model: 'gemini-3.1-pro' });
    expect(s.reqs[2].strictApprovals).toBe(true);
    // A routine in that window is unattended: it stays on Claude.
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' });
    await until(() => s.reqs.length === 4);
    expect(s.reqs[3].providerOverride).toBeUndefined();
    s.setNow(RESET);
    s.router.onUserMessage(s.room.id, 'later');
    await until(() => s.reqs.length === 5);
    expect(s.reqs[4].providerOverride).toBeUndefined();
  });

  it("a routine's card left unanswered never switches: it expires into a note", async () => {
    const s = setup();
    s.script.push(LIMITED());
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' });
    await until(() => s.failover.state().cards.length === 1);
    s.setNow(RESET);
    s.failover.sweep();
    await tick();
    expect(s.reqs).toHaveLength(1);
    expect(s.failover.state().cards).toEqual([]);
    const notes = s.repos.listMessages(s.room.id, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text);
    expect(notes).toContain('Not continued on Gemini. Claude reset at 14:00; send Ada a message to pick it up.');
  });

  it('a routine card pressed runs the routine on the backup, attended and strict', async () => {
    const s = setup();
    s.script.push(LIMITED());
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' });
    await until(() => s.failover.state().cards.length === 1);
    let attendedAsked = false;
    s.router.unattendedRefusal = async () => ((attendedAsked = true), 'refused');
    s.failover.decide(s.failover.state().cards[0].id, { decision: 'continue' });
    await until(() => s.reqs.length === 2);
    expect(attendedAsked).toBe(false);
    expect(s.reqs[1]).toMatchObject({ providerOverride: { provider: 'gemini' }, strictApprovals: true, causeKind: 'routine' });
  });

  it('never on a Stop, nor on a sign-in failure; and no card without a backup', async () => {
    const s = setup();
    s.script.push({ ...LIMITED(), stopped: true }, { ...LIMITED(), limit: { kind: 'auth' } });
    s.router.onUserMessage(s.room.id, 'one');
    await until(() => s.reqs.length === 1);
    s.router.onUserMessage(s.room.id, 'two');
    await until(() => s.reqs.length === 2);
    await tick();
    expect(s.failover.state().cards).toEqual([]);

    const n = setup({ backup: false });
    n.script.push(LIMITED());
    n.router.onUserMessage(n.room.id, 'go');
    await until(() => n.reqs.length === 1);
    await tick();
    expect(n.failover.state().cards).toEqual([]);
  });
});
