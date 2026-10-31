import { describe, expect, it } from 'vitest';
import type { TriggerEvent, TriggerPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';

/**
 * Hardening pass (P5 known limit): a trigger turn resumed after a restart or a parked approval, and any later
 * item on the trigger's thread, is capped by what is left of the trigger's daily budget, not only by the
 * thread cost cap. The budget is looked up from the cause message's TriggerPayload.
 */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

function setup(left: number | undefined) {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const seen: TurnRequest[] = [];
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      seen.push(req);
      return { ok: true, turnId: 't' + seen.length, finalText: '', costUsd: 0 } as TurnResult;
    },
  } as unknown as BotRunner;
  const asked: string[] = [];
  router.triggerBudget = (id) => {
    asked.push(id);
    return left;
  };
  const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const event: TriggerEvent = { source: 'github.repo', id: 'e1', title: 'Issue', from: 'x', url: '', at: '', text: 'hi', fields: {} };
  const payload: TriggerPayload = { triggerId: 'trg1', fireId: 'f1', name: 'Issues', source: 'github.repo', eventId: null };
  return { repos, router, seen, asked, bot, room, event, payload };
}

describe('trigger budget on resumed turns', () => {
  it('caps a turn resumed after a parked approval at the trigger budget left', async () => {
    const h = setup(0.4);
    // The fresh fire carries its own budget (TriggerService passes budget - spent).
    const msg = h.router.fireTrigger(h.room, h.bot, { name: 'Issues', prompt: 'p', event: h.event, payload: h.payload, budgetUsd: 1 });
    await until(() => h.seen.length === 1);
    expect(h.seen[0].causeBudgetUsd).toBeCloseTo(0.4);
    // The resumed turn has no budget of its own; it used to get the full thread cap.
    expect(h.router.resumeParked(h.bot.id, h.room.id, { causeId: msg.id, hop: 0, runId: null, note: 'Approval granted.' })).toBe(true);
    await until(() => h.seen.length === 2);
    expect(h.seen[1].causeBudgetUsd).toBeCloseTo(0.4);
    expect(h.asked).toContain('trg1');
  });

  it('caps a turn resumed after a restart', async () => {
    const h = setup(0.25);
    const msg = h.router.fireTrigger(h.room, h.bot, { name: 'Issues', prompt: 'p', event: h.event, payload: h.payload });
    await until(() => h.seen.length === 1);
    h.router.resume(h.bot, h.room, { causeId: msg.id, hop: 0, triggerSeq: msg.seq, attempts: 1, note: 'cut off' });
    await until(() => h.seen.length === 2);
    expect(h.seen[1].causeBudgetUsd).toBeCloseTo(0.25);
  });

  it('does not start a resumed turn once the trigger budget is spent, or the trigger is gone', async () => {
    for (const left of [0, undefined]) {
      const h = setup(1);
      const msg = h.router.fireTrigger(h.room, h.bot, { name: 'Issues', prompt: 'p', event: h.event, payload: h.payload });
      await until(() => h.seen.length === 1);
      h.router.triggerBudget = () => left;
      h.router.resumeParked(h.bot.id, h.room.id, { causeId: msg.id, hop: 0, runId: null, note: 'Approval granted.' });
      await until(() => h.repos.messagesAfter(h.room.id, 0).some((m) => m.kind === 'system' && /Daily budget reached/.test(m.text)));
      expect(h.seen).toHaveLength(1);
    }
  });

  it('leaves threads a person started alone', async () => {
    const h = setup(0);
    h.router.onUserMessage(h.room.id, 'hello');
    await until(() => h.seen.length === 1);
    expect(h.seen[0].causeBudgetUsd).toBeGreaterThan(1);
    expect(h.asked).toEqual([]);
  });
});
