import { describe, it, expect } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { CAUSE_COST_CAP_USD } from '../config.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { BACKLOG_MAX_BYTES, BACKLOG_MAX_MESSAGES, RoomRouter, capBacklog } from './RoomRouter.js';

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

describe('RoomRouter backlog cap', () => {
  it('keeps the newest lines within the message and byte limits and counts the rest', () => {
    const lines = Array.from({ length: 100 }, (_, i) => 'line ' + i);
    expect(capBacklog(lines, 60, 1e6)).toEqual({ lines: lines.slice(40), dropped: 40 });
    const big = Array.from({ length: 10 }, (_, i) => String(i).repeat(999));
    // 1000 bytes per line with its newline: 3 fit in 3000.
    expect(capBacklog(big, 60, 3000)).toEqual({ lines: big.slice(7), dropped: 7 });
    expect(capBacklog(['a', 'b'])).toEqual({ lines: ['a', 'b'], dropped: 0 });
  });

  it('always keeps the newest line, even when it alone is over the byte limit', () => {
    expect(capBacklog(['old', 'x'.repeat(50)], 60, 10)).toEqual({ lines: ['x'.repeat(50)], dropped: 1 });
  });

  it('shows a fresh session only the last BACKLOG_MAX_MESSAGES messages, with a note about the rest', async () => {
    const { repos, router, bot } = setup();
    const a = bot('ann');
    const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [a.id], coordinatorBotId: null });
    for (let i = 0; i < BACKLOG_MAX_MESSAGES + 15; i++) {
      repos.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'old ' + i, payload: null, causeId: null, hop: 0, turnId: null });
    }
    const reqs: TurnRequest[] = [];
    router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
    router.onUserMessage(room.id, 'latest question');
    await until(() => reqs.length === 1);
    const input = reqs[0].injected;
    expect(input).toMatch(/^\(16 earlier unread messages were left out to keep this short\. Use read_room/);
    expect(input).toContain('latest question');
    expect(input).not.toContain('old 15\n');
    expect(input).toContain('old 16\n');
    expect(input.split('\n').filter((l) => /^#\d+ \[/.test(l))).toHaveLength(BACKLOG_MAX_MESSAGES);
  });

  it('caps the backlog by size too', async () => {
    const { repos, router, bot } = setup();
    const a = bot('ann');
    const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [a.id], coordinatorBotId: null });
    for (let i = 0; i < 20; i++) {
      repos.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'p' + i + ' ' + 'y'.repeat(4000), payload: null, causeId: null, hop: 0, turnId: null });
    }
    const reqs: TurnRequest[] = [];
    router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
    router.onUserMessage(room.id, 'go');
    await until(() => reqs.length === 1);
    expect(Buffer.byteLength(reqs[0].injected, 'utf8')).toBeLessThan(BACKLOG_MAX_BYTES + 1000);
    expect(reqs[0].injected).toMatch(/^\(\d+ earlier unread messages were left out/);
    expect(reqs[0].injected).toContain('go');
  });

  it('adds no note when nothing was left out', async () => {
    const { repos, router, bot } = setup();
    const a = bot('ann');
    const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [a.id], coordinatorBotId: null });
    const reqs: TurnRequest[] = [];
    router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
    router.onUserMessage(room.id, 'hi');
    await until(() => reqs.length === 1);
    expect(reqs[0].injected).not.toContain('left out');
  });
});
