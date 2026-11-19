import { describe, expect, it } from 'vitest';
import { CLAUDE_SLASH_COMMANDS, TOKI_SLASH_COMMANDS, slashCommandOf } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';

const settle = () => new Promise((r) => setTimeout(r, 50));

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const bot = repos.createBot({ name: 'ann', handle: 'ann', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
  const room = repos.createRoom({ kind: 'dm', name: 'a', memberIds: [bot.id], coordinatorBotId: null });
  const reqs: TurnRequest[] = [];
  router.runner = { runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; } } as unknown as BotRunner;
  return { router, room, reqs };
}

describe('slashCommandOf', () => {
  it('reads the command at the very start only', () => {
    expect(slashCommandOf('/compact keep the plan')).toBe('compact');
    expect(slashCommandOf('  /Context')).toBe('context');
    expect(slashCommandOf('/security-review')).toBe('security-review');
    expect(slashCommandOf('see /compact')).toBeNull();
    expect(slashCommandOf('/home/user/file.txt')).toBeNull();
    expect(slashCommandOf('/')).toBeNull();
  });
  it('the lists do not overlap', () => {
    const names = [...CLAUDE_SLASH_COMMANDS, ...TOKI_SLASH_COMMANDS].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('a Claude command sent on its own', () => {
  it('reaches the turn as the raw command', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, '/compact keep the open tasks');
    await settle();
    expect(s.reqs[0]?.slashCommand).toBe('/compact keep the open tasks');
  });
  it('is plain text when it is not a Claude command, or not at the start', async () => {
    const s = setup();
    s.router.onUserMessage(s.room.id, '/nosuchthing please');
    await settle();
    expect(s.reqs[0]?.slashCommand).toBeUndefined();
    const t = setup();
    t.router.onUserMessage(t.room.id, 'run /compact later');
    await settle();
    expect(t.reqs[0]?.slashCommand).toBeUndefined();
  });
});
