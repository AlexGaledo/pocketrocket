import { describe, it, expect } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { CAUSE_COST_CAP_USD, MAX_HOPS } from '../config.js';
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

describe('RoomRouter per-turn context (kept out of the cached system prompt)', () => {
  /** A runner that records each request and, like BotRunner, saves the session it ran on. */
  function recorder(s: ReturnType<typeof setup>, opts: { sessionId?: (n: number) => string; reply?: (req: TurnRequest) => string } = {}) {
    const reqs: TurnRequest[] = [];
    s.router.runner = {
      runTurn: async (req: TurnRequest): Promise<TurnResult> => {
        reqs.push(req);
        s.repos.saveSession(req.bot.id, req.room.id, { sdkSessionId: opts.sessionId?.(reqs.length) ?? 'sess-1' });
        return { ok: true, turnId: 't' + reqs.length, finalText: opts.reply?.(req) ?? '', costUsd: 0 };
      },
    } as unknown as BotRunner;
    return reqs;
  }

  it('ends every input with the hop budget', async () => {
    const s = setup();
    const a = s.bot('ann');
    const room = s.repos.createRoom({ kind: 'dm', name: 'a', memberIds: [a.id], coordinatorBotId: null });
    const reqs = recorder(s);
    s.router.onUserMessage(room.id, 'hi');
    await until(() => reqs.length === 1);
    s.router.onUserMessage(room.id, 'again');
    await until(() => reqs.length === 2);
    for (const r of reqs) expect(r.injected).toContain('(Hop budget: ' + MAX_HOPS + ' bot-to-bot hops left on this thread.)');
  });

  it('shows the roster on the first turn, omits it while unchanged, and shows it again when it changes', async () => {
    const s = setup();
    const a = s.bot('ann');
    const b = s.bot('bob');
    const room = s.repos.createRoom({ kind: 'group', name: 'g', memberIds: [a.id, b.id], coordinatorBotId: a.id });
    const reqs = recorder(s);
    s.router.onUserMessage(room.id, 'first');
    await until(() => reqs.length === 1);
    expect(reqs[0].injected).toContain('Room members:');
    expect(reqs[0].injected).toContain('- @bob');
    s.router.onUserMessage(room.id, 'second');
    await until(() => reqs.length === 2);
    expect(reqs[1].injected).not.toContain('Room members:');
    const c = s.bot('cat');
    s.repos.updateRoom(room.id, { memberIds: [a.id, b.id, c.id] });
    s.router.onUserMessage(room.id, 'third');
    await until(() => reqs.length === 3);
    expect(reqs[2].injected).toContain('Room members:');
    expect(reqs[2].injected).toContain('- @cat');
  });

  it('shows the roster again when the turn ended on a different session (fresh or rotated)', async () => {
    const s = setup();
    const a = s.bot('ann');
    const room = s.repos.createRoom({ kind: 'dm', name: 'a', memberIds: [a.id], coordinatorBotId: null });
    // Turn 2 rotates to a new session without the roster in it; turn 3 must show it again.
    const reqs = recorder(s, { sessionId: (n) => (n >= 2 ? 'sess-2' : 'sess-1') });
    s.router.onUserMessage(room.id, 'one');
    await until(() => reqs.length === 1);
    s.router.onUserMessage(room.id, 'two');
    await until(() => reqs.length === 2);
    expect(reqs[1].injected).not.toContain('Room members:');
    s.router.onUserMessage(room.id, 'three');
    await until(() => reqs.length === 3);
    expect(reqs[2].injected).toContain('Room members:');
  });

  it('does not wake a bot twice when the turn handed off with a tool and then names it in its final message', async () => {
    const s = setup();
    const a = s.bot('ann');
    const b = s.bot('bob');
    const room = s.repos.createRoom({ kind: 'group', name: 'g', memberIds: [a.id, b.id], coordinatorBotId: a.id });
    const reqs: TurnRequest[] = [];
    s.router.runner = {
      runTurn: async (req: TurnRequest): Promise<TurnResult> => {
        reqs.push(req);
        if (req.bot.id === a.id && req.hop === 0) {
          s.router.dispatchFromBot(req, [b]); // the handoff tool
          return { ok: true, turnId: 'ta', finalText: 'Handed this to @bob.', costUsd: 0 };
        }
        return { ok: true, turnId: 'tb', finalText: '', costUsd: 0 };
      },
    } as unknown as BotRunner;
    s.router.onUserMessage(room.id, 'please do it');
    await until(() => reqs.some((r) => r.bot.id === b.id));
    await new Promise((r) => setTimeout(r, 50));
    expect(reqs.filter((r) => r.bot.id === b.id)).toHaveLength(1);
  });

  it('still wakes a bot named in the final message when no tool woke it', async () => {
    const s = setup();
    const a = s.bot('ann');
    const b = s.bot('bob');
    const room = s.repos.createRoom({ kind: 'group', name: 'g', memberIds: [a.id, b.id], coordinatorBotId: a.id });
    const reqs = recorder(s, { reply: (req) => (req.bot.id === a.id ? '@bob your turn' : '') });
    s.router.onUserMessage(room.id, 'go');
    await until(() => reqs.some((r) => r.bot.id === b.id));
    expect(reqs.find((r) => r.bot.id === b.id)!.hop).toBe(1);
    expect(reqs.find((r) => r.bot.id === b.id)!.injected).toContain('(Hop budget: ' + (MAX_HOPS - 1));
  });
});
