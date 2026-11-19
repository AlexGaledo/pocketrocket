import { describe, expect, it } from 'vitest';
import type { Bot, ProviderAuth, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import type { AgentProvider } from '../providers/types.js';
import { unattendedRefusal } from '../providers/unattended.js';
import { RoomRouter } from './RoomRouter.js';

/**
 * M7 (P2-3), spec 01 §4.6 and 05 §01 #1: Gemini on a Google login runs only turns a person is behind. Routines,
 * triggers and workflow steps are refused with a note, unless `agy` itself reports API-key auth. A bug here is a
 * terms breach, so the negatives matter most.
 */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function deps(id: ProviderId, auth: ProviderAuth, opts: { throws?: boolean } = {}) {
  const forced: boolean[] = [];
  return {
    forced,
    forBot: () => ({ id, label: id === 'gemini' ? 'Gemini' : 'Claude' }) as AgentProvider,
    check: async (_: ProviderId, force?: boolean): Promise<ProviderCheck> => {
      forced.push(!!force);
      if (opts.throws) throw new Error('agy hung');
      return { ok: true, auth };
    },
  };
}
const bot = { name: 'Gem', provider: 'gemini' } as Bot;

describe('unattendedRefusal', () => {
  it('refuses Gemini on a Google login, and on an unknown auth', async () => {
    expect(await unattendedRefusal(deps('gemini', 'subscription'), bot)).toMatch(/Gem did not run: Gemini on a Google sign-in/);
    expect(await unattendedRefusal(deps('gemini', 'unknown'), bot)).toMatch(/did not run/);
    expect(await unattendedRefusal(deps('gemini', 'none'), bot)).toMatch(/did not run/);
  });
  it('lets Gemini run when agy reports API-key auth, checking afresh rather than from the cache', async () => {
    const d = deps('gemini', 'apiKey');
    expect(await unattendedRefusal(d, bot)).toBeNull();
    expect(d.forced).toEqual([true]);
  });
  it('never applies to Claude', async () => {
    const d = deps('claude', 'subscription');
    expect(await unattendedRefusal(d, { ...bot, provider: 'claude' })).toBeNull();
    expect(d.forced).toEqual([]);
  });
});

function setup(refusal: ((b: Bot) => Promise<string | null>) | undefined) {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const reqs: TurnRequest[] = [];
  let block = false;
  const open: (() => void)[] = [];
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      if (block) await new Promise<void>((r) => open.push(r));
      return { ok: true, turnId: 't' + reqs.length, finalText: '', costUsd: 0 };
    },
    steer: () => ({ status: 'queued', reason: 'provider' }),
  } as unknown as BotRunner;
  router.unattendedRefusal = refusal;
  const b = repos.createBot({ name: 'Gem', handle: 'gem', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [b.id], coordinatorBotId: null });
  const notes = () => repos.listMessages(room.id, { limit: 100 }).filter((m) => m.kind === 'system').map((m) => m.text);
  return { repos, router, reqs, bot: b, room, notes, block: (v: boolean) => (block = v), open };
}
const refuseAll = async (b: Bot) => b.name + ' did not run: test refusal';

describe('RoomRouter guard', () => {
  it('a routine on a refusing provider posts the note and does not run; its run settles as an error', async () => {
    const s = setup(refuseAll);
    const done: TurnResult[] = [];
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' }, (r) => done.push(r));
    await until(() => done.length === 1);
    expect(s.reqs).toHaveLength(0);
    expect(done[0]).toMatchObject({ ok: false, error: 'unattended turn refused' });
    expect(s.notes()).toContain('Gem did not run: test refusal');
    expect(s.repos.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM lane_journal')[0].n).toBe(0);
  });

  it('a routine runs (strict) when the provider allows it, as with a reported API key', async () => {
    const s = setup(async () => null);
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' });
    await until(() => s.reqs.length === 1);
    expect(s.reqs[0].strictApprovals).toBe(true);
  });

  it('a person-started message runs on the same refusing provider, and the guard is not even asked', async () => {
    let asked = 0;
    const s = setup(async (b) => (asked++, refuseAll(b)));
    s.router.onUserMessage(s.room.id, 'hello');
    await until(() => s.reqs.length === 1);
    expect(asked).toBe(0);
    expect(s.notes()).toEqual([]);
  });

  it('Run now (manual) counts as attended', async () => {
    const s = setup(refuseAll);
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n', manual: true } as never);
    await until(() => s.reqs.length === 1);
    expect(s.notes()).toEqual([]);
  });

  it('in a batch, the routine is dropped and the person still gets an answer', async () => {
    const s = setup(refuseAll);
    s.block(true);
    s.router.onUserMessage(s.room.id, 'first');
    await until(() => s.reqs.length === 1);
    // While the first turn runs, a routine and a person's message queue in the same lane.
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' });
    s.router.onUserMessage(s.room.id, 'second', undefined, undefined, 'queue');
    await tick();
    s.block(false);
    s.open.shift()!();
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).toContain('second');
    expect(s.notes()).toContain('Gem did not run: test refusal');
  });

  it('a guard that throws refuses (fails closed)', async () => {
    const s = setup(async () => {
      throw new Error('agy hung');
    });
    const done: TurnResult[] = [];
    s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' }, (r) => done.push(r));
    await until(() => done.length === 1);
    expect(s.reqs).toHaveLength(0);
    expect(s.notes().some((n) => /could not check how its provider is signed in/.test(n))).toBe(true);
  });

  it('isAttended: a card press (M8 hook) makes an item attended whatever its thread', () => {
    const s = setup(refuseAll);
    const routine = s.router.fireRoutine(s.room, s.bot, '[Routine "n"] go', { routineId: 'r1', runId: 'run1', name: 'n' });
    expect(s.router.isAttended(routine.id)).toBe(false);
    expect(s.router.isAttended(routine.id, { attended: true })).toBe(true);
    expect(s.router.isAttended('no-such-cause')).toBe(false);
  });
});
