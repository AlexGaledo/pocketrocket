import { describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { ESCALATE_COOLDOWN_MS, createHubTools, escalateTool, type ToolCtx } from './botTools.js';

function setup(o: { support?: 'none' | 'elsewhere' | 'here' } = {}) {
  const repos = new Repos(new Db(':memory:'));
  const mk = (handle: string) => repos.createBot({ name: handle, handle, title: '', description: 'x', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const bot = mk('paper-scout');
  const support = o.support && o.support !== 'none' ? mk('pocketrocket-support') : null;
  const members = [bot, ...(support && o.support === 'here' ? [support] : [])];
  const room = repos.createRoom({ kind: 'group', name: 'R', memberIds: members.map((m) => m.id), coordinatorBotId: null });
  const woken: string[][] = [];
  let t = 1_000_000;
  const ctx: ToolCtx = {
    bot, room: room as Room, members: members as Bot[], turnId: 't1', hop: 0, causeId: 'c1',
    repos, memory: new MemoryService(), skills: new SkillService(repos),
    dispatchFromBot: (targets) => { woken.push(targets.map((b) => b.handle)); return targets.map((b) => b.handle); },
    setState: () => undefined, models: ['claude-sonnet-5'],
  };
  const tool = escalateTool(ctx, () => t);
  const call = async (input: Record<string, unknown>) => {
    const out = await tool.handler(input);
    return { text: (out.content[0] as { text: string }).text, isError: !!out.isError };
  };
  const posts = () => repos.listMessages(room.id).filter((m) => m.authorType === 'bot' && m.kind === 'text');
  return { call, posts, woken, advance: (ms: number) => (t += ms), ctx };
}

const ask = { to: 'support', blocked: 'open the Gneef video', error: 'connect ECONNREFUSED 127.0.0.1:9414', ask: 'restart my computer' };

describe('escalate tool', () => {
  it('is offered to every bot', () => {
    expect(createHubTools(setup().ctx).some((t) => t.name === 'escalate')).toBe(true);
  });

  it('posts the ask, what was blocked and the exact error, and wakes support when it is in the room', async () => {
    const s = setup({ support: 'here' });
    const r = await s.call(ask);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('woke @pocketrocket-support');
    const [p] = s.posts();
    expect(p.text).toBe('🚩 Blocked, need help. @pocketrocket-support: please restart my computer.\nTrying to: open the Gneef video\nError: connect ECONNREFUSED 127.0.0.1:9414');
    expect(s.woken).toEqual([['pocketrocket-support']]);
  });

  it('names support but wakes nobody when support is not in the room', async () => {
    const s = setup({ support: 'elsewhere' });
    const r = await s.call(ask);
    expect(r.text).toContain('not in this room');
    expect(s.posts()[0].text).toContain('@pocketrocket-support: please');
    expect(s.woken).toEqual([]);
  });

  it('addresses the owner when asked to, or when there is no support bot', async () => {
    const s = setup({ support: 'none' });
    await s.call(ask);
    expect(s.posts()[0].text).toMatch(/\(owner\): please restart my computer\./);
    const o = setup({ support: 'here' });
    await o.call({ ...ask, to: 'owner', ask: 'add the Firecrawl key' });
    expect(o.posts()[0].text).toMatch(/\(owner\): please add the Firecrawl key\./);
    expect(o.woken).toEqual([]);
  });

  it('refuses the same blocker again within the cooldown, then allows it', async () => {
    const s = setup({ support: 'here' });
    await s.call(ask);
    s.advance(60_000);
    const again = await s.call({ ...ask, blocked: '  Open the Gneef VIDEO ' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already escalated');
    expect(s.posts()).toHaveLength(1);
    expect((await s.call({ ...ask, blocked: 'push the branch' })).isError).toBe(false);
    s.advance(ESCALATE_COOLDOWN_MS);
    expect((await s.call(ask)).isError).toBe(false);
    expect(s.posts()).toHaveLength(3);
  });

  it('refuses a secret pasted into the error, and posts nothing', async () => {
    const s = setup();
    const r = await s.call({ ...ask, error: '401 with Authorization: Bearer sk-ant-api03-' + 'a'.repeat(90) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('secret');
    expect(s.posts()).toHaveLength(0);
  });

  it('rejects a missing ask', async () => {
    const s = setup();
    const { ask: _, ...rest } = ask;
    expect((await s.call(rest)).isError).toBe(true);
    expect(s.posts()).toHaveLength(0);
  });
});
