import { describe, it, expect } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { CAUSE_COST_CAP_USD } from '../config.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const usage = new UsageTracker(repos);
  const router = new RoomRouter(repos, usage);
  const bot = (h: string) => repos.createBot({ name: h, handle: h, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
  return { repos, usage, router, bot };
}
const spend = (usage: UsageTracker, req: TurnRequest, costUsd: number) =>
  usage.record(req.bot.id, req.room.id, 't-' + req.bot.handle, req.causeId, { costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: null, durationMs: 0 });
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('RoomRouter cause cost cap', () => {
  it('passes what is left of the cap to a user-caused turn as its budget', async () => {
    const { repos, router, bot } = setup();
    const a = bot('ann');
    const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [a.id], coordinatorBotId: null });
    const reqs: TurnRequest[] = [];
    router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
    router.onUserMessage(room.id, 'hello');
    await until(() => reqs.length === 1);
    expect(reqs[0].causeBudgetUsd).toBe(CAUSE_COST_CAP_USD);
  });

  it('does not start a queued turn once its cause has spent the cap, and says so', async () => {
    const { repos, usage, router, bot } = setup();
    const a = bot('ann');
    const b = bot('bob');
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [a.id, b.id], coordinatorBotId: null });
    const reqs: TurnRequest[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    router.runner = {
      runTurn: async (req: TurnRequest): Promise<TurnResult> => {
        reqs.push(req);
        if (req.bot.id === a.id) {
          await gateA;
          spend(usage, req, CAUSE_COST_CAP_USD + 1);
          return { ok: true, turnId: 'ta', finalText: 'done', costUsd: CAUSE_COST_CAP_USD + 1 };
        }
        // bob hands back to @ann while a's first turn is still running, so the hop passes the check at dispatch
        // time and queues in a's lane behind the turn that is about to blow the cap.
        return { ok: true, turnId: 'tb', finalText: '@ann over to you', costUsd: 0 };
      },
    } as unknown as BotRunner;

    router.onUserMessage(room.id, '@ann @bob go');
    await until(() => reqs.length === 2);
    releaseA();
    await until(() => repos.listMessages(room.id, { limit: 50 }).some((m) => m.kind === 'system' && m.text.includes('did not start')));
    expect(reqs.map((r) => r.bot.handle).sort()).toEqual(['ann', 'bob']);
  });
});

describe('RoomRouter coordinator fallback', () => {
  it('gives a group with no coordinator one on the first unaddressed message, and routes to it', async () => {
    const { repos, router, bot } = setup();
    const a = bot('ann');
    const lead = bot('team-lead');
    const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [a.id, lead.id], coordinatorBotId: null });
    const reqs: TurnRequest[] = [];
    router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
    router.onUserMessage(room.id, 'who can help?');
    await until(() => reqs.length === 1);
    expect(reqs[0].bot.id).toBe(lead.id);
    expect(repos.getRoom(room.id)!.coordinatorBotId).toBe(lead.id);
    expect(repos.listMessages(room.id, { limit: 20 }).some((m) => m.kind === 'system' && m.text.includes('@team-lead) is now coordinator'))).toBe(true);
  });
});
