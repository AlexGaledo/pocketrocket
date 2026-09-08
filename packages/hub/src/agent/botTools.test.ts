import { describe, expect, it, vi } from 'vitest';
import type { ApprovalPayload, Bot, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { events } from '../events.js';
import { createHubTools, type ToolCtx } from './botTools.js';

function setup(extra: Partial<ToolCtx> = {}) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const ctx: ToolCtx = {
    bot, room: room as Room, members: [bot as Bot], turnId: 't1', hop: 0, causeId: 'c1',
    repos, memory: new MemoryService(), skills: new SkillService(repos),
    dispatchFromBot: () => [], setState: () => undefined,
    models: ['claude-sonnet-5', 'claude-opus-5'],
    ...extra,
  };
  return { repos, bot, room, ctx, tools: createHubTools(ctx) };
}

const byName = (tools: ReturnType<typeof createHubTools>, name: string) => tools.find((t) => t.name === name)!;

describe('createHubTools', () => {
  it('returns the 12 hub tools and no request_approval for a full-permission provider', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room',
      'create_bot', 'add_to_room', 'update_bot', 'delete_bot', 'remove_from_room',
    ]);
  });

  it('validates create_bot/update_bot models against the active provider', async () => {
    const { tools, bot, repos } = setup();
    const out = await byName(tools, 'update_bot').handler({ bot: 'me', model: 'test-model-x' });
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining('Unknown model') });
    expect(repos.getBot(bot.id)!.model).toBe('claude-sonnet-5');

    const ok = await byName(tools, 'update_bot').handler({ bot: 'me', model: 'claude-opus-5' });
    expect(ok.isError).toBeFalsy();
    expect(repos.getBot(bot.id)!.model).toBe('claude-opus-5');

    const bad = await byName(tools, 'create_bot').handler({ name: 'X', handle: 'xx', title: '', description: 'a description', model: 'grok-4.6' });
    expect(bad.isError).toBe(true);
    expect(repos.getBotByHandle('xx')).toBeUndefined();
  });

  it('reports bad arguments instead of throwing', async () => {
    const { tools } = setup();
    const out = await byName(tools, 'send_message').handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining('Invalid arguments') });
  });

  it('request_approval routes to the PermissionBroker and reports the decision', async () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'test-model-x', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const broker = new PermissionBroker(repos);
    const ac = new AbortController();
    const setState = vi.fn();
    const permCtx = { bot, room, turnId: 't1', hop: 0, causeId: 'c1', setState };

    const tools = createHubTools({
      bot, room, members: [bot], turnId: 't1', hop: 0, causeId: 'c1',
      repos, memory: new MemoryService(), skills: new SkillService(repos),
      dispatchFromBot: () => [], setState: () => undefined, models: ['test-model-x'],
      requestApproval: (a) => broker.ask(permCtx, a, ac.signal),
    });
    const tool = byName(tools, 'request_approval');
    expect(tool).toBeTruthy();

    // The approval card reaches the UI as an approval.request event; answer it like the web client does.
    const seen: ApprovalPayload[] = [];
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') {
        seen.push(ev.approval);
        setTimeout(() => broker.resolve(ev.approval.approvalId, 'allow'), 0);
      }
    });
    const out = await tool.handler({ action: 'delete the build cache', command: 'rm -rf /tmp/build', reason: 'stale' });
    off();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolName: 'request_approval', reason: 'delete the build cache', danger: true });
    // The approval now returns the id of the recorded grant (audit 2026-09-09, B10).
    const parsed = JSON.parse((out.content[0] as { text: string }).text) as { allowed: boolean; message: string; approvalId: string };
    expect(parsed).toMatchObject({ allowed: true, message: 'Approved by the user.' });
    expect(parsed.approvalId).toBe(seen[0].approvalId);
    expect(setState).toHaveBeenCalledWith('blocked');
  });

  it('request_approval reports a denial back to the bot', async () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'Codey', handle: 'codey2', title: '', description: 'x', avatar: '🤖', model: 'test-model-x', allowedTools: [], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const broker = new PermissionBroker(repos);
    const permCtx = { bot, room, turnId: 't1', hop: 0, causeId: 'c1', setState: () => undefined };
    const tools = createHubTools({
      bot, room, members: [bot], turnId: 't1', hop: 0, causeId: 'c1',
      repos, memory: new MemoryService(), skills: new SkillService(repos),
      dispatchFromBot: () => [], setState: () => undefined, models: [],
      requestApproval: (a) => broker.ask(permCtx, a, new AbortController().signal),
    });
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') setTimeout(() => broker.resolve(ev.approval.approvalId, 'deny'), 0);
    });
    const out = await byName(tools, 'request_approval').handler({ action: 'email the customer list' });
    off();
    const parsed = JSON.parse((out.content[0] as { text: string }).text) as { allowed: boolean; message: string };
    expect(parsed.allowed).toBe(false);
    expect(parsed.message).toContain('declined');
  });
});
