import { describe, expect, it } from 'vitest';
import type { ApprovalPayload, Bot, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { WorkflowRepo } from '../db/workflowRepo.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { WorkflowRunner } from '../services/WorkflowRunner.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';
import { createHubTools, type ToolCtx } from './botTools.js';

/**
 * Workflows 3.4: `create_workflow` / `update_workflow` are fleet changes (a workflow is autonomous future spend), so
 * both show the owner an approval card first and change nothing when it is declined; `list_workflows` is silent.
 * No workflow tool can answer a workflow approval card or touch settings.
 */

type Answer = 'allow' | 'deny';

function setup(answer: Answer) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const other = repos.createBot({ name: 'Nova', handle: 'nova', title: '', description: 'y', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'group', name: 'Team', memberIds: [bot.id, other.id], coordinatorBotId: null });
  const usage = new UsageTracker(repos);
  const router = new RoomRouter(repos, usage);
  const workflows = new WorkflowRunner({ repos, workflows: new WorkflowRepo(repos.db), router, usage });
  const broker = new PermissionBroker(repos);
  const permCtx = { bot, room, turnId: 't1', hop: 0, causeId: 'c1', setState: () => undefined };
  const cards: ApprovalPayload[] = [];
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') {
      cards.push(ev.approval);
      setTimeout(() => broker.resolve(ev.approval.approvalId, answer), 0);
    }
  });
  const ctx: ToolCtx = {
    bot, room: room as Room, members: [bot as Bot, other as Bot], turnId: 't1', hop: 0, causeId: 'c1',
    repos, memory: new MemoryService(), skills: new SkillService(repos),
    dispatchFromBot: () => [], setState: () => undefined, models: ['m1'],
    confirmFleetChange: (a) => broker.askFleetChange(permCtx, a.tool, a.input, a.reason, new AbortController().signal),
    workflows,
  };
  const tools = createHubTools(ctx);
  return { repos, bot, other, room, cards, off, workflows, tool: (n: string) => tools.find((t) => t.name === n)!, names: tools.map((t) => t.name) };
}

const STEPS = [
  { bot: '@nova', prompt: 'Draft the weekly note from {{previous}}' },
  { approve: 'Post it?' },
  { post_to_room: true },
];

describe('workflow bot tools', () => {
  it('are offered only when the hub has workflows', () => {
    const s = setup('allow');
    s.off();
    expect(s.names).toEqual(expect.arrayContaining(['list_workflows', 'create_workflow', 'update_workflow']));
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'A', handle: 'a', title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'd', memberIds: [bot.id], coordinatorBotId: null });
    const none = createHubTools({ bot, room, members: [bot], turnId: 't', hop: 0, causeId: 'c', repos, memory: new MemoryService(), skills: new SkillService(repos), dispatchFromBot: () => [], setState: () => undefined, models: [] }).map((t) => t.name);
    expect(none).not.toContain('create_workflow');
  });

  it('create_workflow shows a card first and creates nothing when declined', async () => {
    const s = setup('deny');
    const out = await s.tool('create_workflow').handler({ name: 'Weekly', steps: STEPS });
    s.off();
    expect(s.cards.map((c) => c.toolName)).toEqual(['create_workflow']);
    expect(s.cards[0].reason).toContain('Weekly');
    expect(out.isError).toBe(true);
    expect(s.workflows.list()).toHaveLength(0);
  });

  it('creates the workflow once allowed, in the bot\'s chat, with its steps as a line graph', async () => {
    const s = setup('allow');
    const out = await s.tool('create_workflow').handler({ name: 'Weekly', steps: STEPS, budget_usd: 3 });
    s.off();
    expect(out.isError).toBeFalsy();
    const [w] = s.workflows.list();
    expect(w).toMatchObject({ name: 'Weekly', roomId: s.room.id, budgetUsd: 3, enabled: true });
    expect(w.graph.nodes.map((n) => n.kind)).toEqual(['trigger', 'agent', 'approval', 'output']);
    expect(w.graph.nodes[1]).toMatchObject({ botId: s.other.id });
    expect(w.graph.nodes[0]).toMatchObject({ manual: true, routineId: null });
    expect(s.repos.listMessages(s.room.id, { limit: 10 }).some((m) => m.authorType === 'system' && m.text.includes('created workflow "Weekly"'))).toBe(true);
  });

  it('refuses bad steps before any card: a bot outside the chat, an approval first, an unsafe file path, a mixed step', async () => {
    const s = setup('allow');
    const stray = s.repos.createBot({ name: 'Pip', handle: 'pip', title: '', description: 'z', avatar: '🤖', model: 'm1', allowedTools: [], maxBudgetUsd: 1 });
    const outs = [
      await s.tool('create_workflow').handler({ name: 'x', steps: [{ bot: '@pip', prompt: 'p' }] }),
      await s.tool('create_workflow').handler({ name: 'x', steps: [{ approve: 'ok?' }, { bot: '@nova', prompt: 'p' }] }),
      await s.tool('create_workflow').handler({ name: 'x', steps: [{ bot: '@nova', prompt: 'p' }, { save_to_file: '../../outside.md' }] }),
      await s.tool('create_workflow').handler({ name: 'x', steps: [{ bot: '@nova', prompt: 'p', post_to_room: true }] }),
      await s.tool('create_workflow').handler({ name: 'x', steps: [{ bot: '@ghost', prompt: 'p' }] }),
      await s.tool('create_workflow').handler({ name: 'x', steps: STEPS, routine: 'no-such-routine' }),
    ];
    s.off();
    expect(stray.handle).toBe('pip');
    expect(outs.every((o) => o.isError)).toBe(true);
    expect(s.cards).toHaveLength(0);
    expect(s.workflows.list()).toHaveLength(0);
  });

  it('a routine can start it; update asks again, keeps what it is not given, and a decline changes nothing', async () => {
    const s = setup('allow');
    const routine = s.repos.createRoutine({ botId: s.bot.id, roomId: s.room.id, name: 'Mon', cron: '0 9 * * 1', prompt: 'p', enabled: true });
    await s.tool('create_workflow').handler({ name: 'Weekly', steps: STEPS, routine: 'Mon' });
    const [w] = s.workflows.list();
    expect(w.graph.nodes[0]).toMatchObject({ routineId: routine.id, manual: false });

    const up = await s.tool('update_workflow').handler({ workflow: 'weekly', budget_usd: 4, enabled: false });
    expect(up.isError).toBeFalsy();
    expect(s.workflows.list()[0]).toMatchObject({ name: 'Weekly', budgetUsd: 4, enabled: false });
    expect(s.workflows.list()[0].graph.nodes[0]).toMatchObject({ routineId: routine.id });
    expect(s.cards.map((c) => c.toolName)).toEqual(['create_workflow', 'update_workflow']);
    s.off();

    const d = setup('deny');
    const r2 = d.repos.createRoutine({ botId: d.bot.id, roomId: d.room.id, name: 'Mon', cron: '0 9 * * 1', prompt: 'p', enabled: true });
    expect(r2.id).toBeTruthy();
    d.workflows.create({ name: 'Keep', enabled: true, roomId: d.room.id, budgetUsd: 1, graph: { nodes: [{ id: 't', kind: 'trigger', routineId: null, triggerId: null, manual: true }, { id: 'a', kind: 'agent', botId: d.other.id, prompt: 'x' }], edges: [{ from: 't', to: 'a' }] } });
    const out = await d.tool('update_workflow').handler({ workflow: 'Keep', name: 'Changed', budget_usd: 9 });
    d.off();
    expect(out.isError).toBe(true);
    expect(d.workflows.list()[0]).toMatchObject({ name: 'Keep', budgetUsd: 1 });
  });

  it('list_workflows is silent and update_workflow reports an unknown workflow or nothing to change', async () => {
    const s = setup('allow');
    expect((await s.tool('list_workflows').handler({})).content[0]).toMatchObject({ text: '(no workflows)' });
    expect((await s.tool('update_workflow').handler({ workflow: 'ghost', name: 'x' })).isError).toBe(true);
    await s.tool('create_workflow').handler({ name: 'W', steps: STEPS });
    expect((await s.tool('update_workflow').handler({ workflow: 'W' })).isError).toBe(true);
    const listed = (await s.tool('list_workflows').handler({})).content[0] as { text: string };
    s.off();
    expect(listed.text).toContain('W id=');
    expect(s.cards.map((c) => c.toolName)).toEqual(['create_workflow']); // the list and the failed updates raised no card
  });

  it('decide() lets the gated tools through to raise their own card, and the list through silently', async () => {
    const repos = new Repos(new Db(':memory:'));
    const broker = new PermissionBroker(repos);
    const bot = repos.createBot({ name: 'S', handle: 's', title: '', description: 'x', avatar: '🔎', model: 'm1', allowedTools: [], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'd', memberIds: [bot.id], coordinatorBotId: null });
    const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
    for (const t of ['create_workflow', 'update_workflow', 'list_workflows']) {
      expect(await broker.decide(ctx, 'mcp__pocketrocket__' + t, {}, { signal: new AbortController().signal })).toEqual({ behavior: 'allow' });
    }
  });
});
