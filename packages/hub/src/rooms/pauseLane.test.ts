import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ComputersRepo } from '../db/computers.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ComputerManager } from '../services/ComputerManager.js';
import { ComputerControlService } from '../services/ComputerControl.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';

/** P2: "Pause bot" holds its turns in the lane; a hand-back note rides along with the next turn. */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

function setup() {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-lane-'));
  const computers = new ComputerManager(new ComputersRepo(db), { enabled: false, dir, dataDir: dir });
  const control = new ComputerControlService({ computers, repos, vnc: { setViewOnly: async () => undefined } });
  const router = new RoomRouter(repos, new UsageTracker(repos));
  router.control = control;
  const reqs: TurnRequest[] = [];
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => { reqs.push(req); return { ok: true, turnId: 't', finalText: '', costUsd: 0 }; },
  } as unknown as BotRunner;
  const bot = repos.createBot({ name: 'Shop', handle: 'shopper', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Browser'], maxBudgetUsd: 1 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  return { repos, router, control, reqs, bot, room };
}

describe('pause and hand-back in the lane', () => {
  it('a paused bot starts nothing; its message runs once it is resumed', async () => {
    const s = setup();
    s.control.set(s.bot.id, 'paused');
    s.router.onUserMessage(s.room.id, 'buy milk');
    await new Promise((r) => setTimeout(r, 40));
    expect(s.reqs).toHaveLength(0);
    expect(s.router.isBusy(s.bot.id, s.room.id)).toBe(true);
    s.control.set(s.bot.id, 'agent');
    await until(() => s.reqs.length === 1);
    expect(s.reqs[0].injected).toContain('buy milk');
  });

  it('the hand-back note is injected into the bot\'s next turn, once', async () => {
    const s = setup();
    s.control.set(s.bot.id, 'user');
    s.control.set(s.bot.id, 'agent', { note: 'I closed the cookie banner' });
    s.router.onUserMessage(s.room.id, 'carry on');
    await until(() => s.reqs.length === 1);
    expect(s.reqs[0].injected).toContain('I closed the cookie banner');
    s.router.onUserMessage(s.room.id, 'and again');
    await until(() => s.reqs.length === 2);
    expect(s.reqs[1].injected).not.toContain('cookie banner');
  });

  it('resumeParked queues a turn on the same thread with the note, and closes the routine run', async () => {
    const s = setup();
    const r = s.repos.createRoutine({ botId: s.bot.id, roomId: s.room.id, name: 'n', cron: '0 3 * * *', prompt: 'p', enabled: true });
    const run = s.repos.createRun(r.id, null);
    expect(s.router.resumeParked(s.bot.id, s.room.id, { causeId: 'cause-x', hop: 1, runId: run.id, note: '(Approval granted)' })).toBe(true);
    await until(() => s.repos.listRuns(r.id)[0].status === 'success');
    expect(s.reqs[0]).toMatchObject({ causeId: 'cause-x', hop: 1, runId: run.id, strictApprovals: true });
    expect(s.reqs[0].injected).toContain('(Approval granted)');
  });
});
