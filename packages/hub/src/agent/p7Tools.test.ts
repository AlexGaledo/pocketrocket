import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { botHome } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { addSecret, clearSecrets } from '../providers/redact.js';
import { createHubTools, type ToolCtx } from './botTools.js';

/** P7 hub tools: handoff to a bot from the fleet directory (7.3), and search_notes / write_note (7.2). */

const homes: string[] = [];
afterEach(() => {
  for (const id of homes.splice(0)) fs.rmSync(botHome(id), { recursive: true, force: true });
});

function setup(kind: 'group' | 'dm', answer: boolean | null = true) {
  const repos = new Repos(new Db(':memory:'));
  const mk = (handle: string, title: string) =>
    repos.createBot({ name: handle[0].toUpperCase() + handle.slice(1), handle, title, description: title + ' work', avatar: '🤖', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const chief = mk('chief', 'Chief of staff');
  const writer = mk('writer', 'Writer');
  const analyst = mk('analyst', 'Analyst');
  homes.push(chief.id);
  const room = repos.createRoom(kind === 'group'
    ? { kind, name: 'ops', memberIds: [chief.id, writer.id], coordinatorBotId: chief.id }
    : { kind, name: 'DM', memberIds: [chief.id], coordinatorBotId: null });
  const gates: { tool: string; reason: string }[] = [];
  const dispatched: string[] = [];
  const members: Bot[] = kind === 'group' ? [chief, writer] : [chief];
  const ctx: ToolCtx = {
    bot: chief, room: room as Room, members, turnId: 't1', hop: 0, causeId: 'c1',
    repos, memory: new MemoryService(), skills: new SkillService(repos),
    dispatchFromBot: (targets) => { dispatched.push(...targets.map((t) => t.handle)); return targets.map((t) => t.handle); },
    setState: () => undefined,
    models: ['claude-sonnet-5'],
    confirmFleetChange: answer === null ? undefined : async (a) => {
      gates.push({ tool: a.tool, reason: a.reason });
      return answer ? { allowed: true, message: 'ok' } : { allowed: false, message: 'The user declined this change.' };
    },
  };
  const tool = (name: string) => createHubTools(ctx).find((t) => t.name === name)!;
  return { repos, room, chief, analyst, ctx, gates, dispatched, members, tool };
}

describe('handoff to a bot outside the room (7.3)', () => {
  it('adds the bot through the add_to_room gate, then hands it the task', async () => {
    const s = setup('group');
    const out = await s.tool('handoff').handler({ to_bot: '@analyst', task: 'Build the Q3 dashboard' });
    expect(out.isError).toBeFalsy();
    expect(s.gates).toEqual([{ tool: 'add_to_room', reason: expect.stringContaining('@analyst') }]);
    expect(s.repos.getRoom(s.room.id)!.memberIds).toContain(s.analyst.id);
    expect(s.members.map((m) => m.handle)).toContain('analyst');
    expect(s.dispatched).toEqual(['analyst']);
    const msgs = s.repos.listMessages(s.room.id, { limit: 10 });
    expect(msgs.some((m) => m.kind === 'system' && m.text.includes('added'))).toBe(true);
    expect(msgs.some((m) => m.kind === 'handoff' && m.text.includes('Build the Q3 dashboard'))).toBe(true);
  });

  it('does nothing when the user declines the card', async () => {
    const s = setup('group', false);
    const out = await s.tool('handoff').handler({ to_bot: 'analyst', task: 'x' });
    expect(out.isError).toBe(true);
    expect(s.repos.getRoom(s.room.id)!.memberIds).not.toContain(s.analyst.id);
    expect(s.dispatched).toEqual([]);
  });

  it('from a DM, asks first, then has the bot work in its own chat, and brings its result back as one line', async () => {
    const s = setup('dm');
    const asked: { to_bot: string; task: string }[] = [];
    let done: ((r: { ok: boolean; finalText: string }) => void) | undefined;
    let workRoom: Room | undefined;
    s.ctx.confirmOutsideHandoff = async (a) => { asked.push(a.input); return { allowed: true, message: 'ok' }; };
    s.ctx.dispatchFromBot = (targets, room, onDone) => { workRoom = room; done = onDone; return targets.map((t) => t.handle); };
    const out = await s.tool('handoff').handler({ to_bot: '@analyst', task: 'Build the Q3 dashboard' });
    expect(out.isError).toBeFalsy();
    expect(asked).toEqual([{ to_bot: 'analyst', task: 'Build the Q3 dashboard' }]);
    // A DM never gains a member, and adding one is not what the card asked about.
    expect(s.repos.getRoom(s.room.id)!.memberIds).toEqual([s.chief.id]);
    expect(s.gates).toEqual([]);
    expect(workRoom).toMatchObject({ kind: 'dm', memberIds: [s.analyst.id] });
    expect(s.repos.listMessages(workRoom!.id).some((m) => m.kind === 'handoff' && m.text.includes('Build the Q3 dashboard'))).toBe(true);
    done!({ ok: true, finalText: 'The dashboard is ready.' });
    const here = s.repos.listMessages(s.room.id);
    expect(here.map((m) => m.kind)).toEqual(['handoff', 'text']);
    expect(here[0].payload).toMatchObject({ toBotId: s.analyst.id, workRoomId: workRoom!.id });
    expect(here[1]).toMatchObject({ authorId: s.analyst.id, text: 'The dashboard is ready.', payload: { workRoomId: workRoom!.id } });
  });

  it('from a DM, a declined card sends nothing and creates no chat', async () => {
    const s = setup('dm');
    const before = s.repos.listRooms().length;
    s.ctx.confirmOutsideHandoff = async () => ({ allowed: false, message: 'Keep it here.' });
    const out = await s.tool('handoff').handler({ to_bot: 'analyst', task: 'x' });
    expect(out.isError).toBe(true);
    expect(s.dispatched).toEqual([]);
    expect(s.repos.listRooms().length).toBe(before);
    expect(s.repos.listMessages(s.room.id)).toEqual([]);
  });

  it('from a DM, reuses the chat the bot already has', async () => {
    const s = setup('dm');
    const own = s.repos.createRoom({ kind: 'dm', name: 'Analyst', memberIds: [s.analyst.id], coordinatorBotId: null });
    let workRoom: Room | undefined;
    s.ctx.dispatchFromBot = (targets, room) => { workRoom = room; return targets.map((t) => t.handle); };
    await s.tool('handoff').handler({ to_bot: 'analyst', task: 'x' });
    expect(workRoom?.id).toBe(own.id);
  });

  it('still reports an unknown bot, and skips the gate for a bot already in the room', async () => {
    const s = setup('group');
    expect((await s.tool('handoff').handler({ to_bot: 'nobody', task: 'x' })).isError).toBe(true);
    expect((await s.tool('handoff').handler({ to_bot: 'writer', task: 'Draft the post' })).isError).toBeFalsy();
    expect(s.gates).toEqual([]);
  });
});

describe('search_notes / write_note (7.2)', () => {
  it('writes a note into the bot home and finds it again', async () => {
    const s = setup('group');
    const w = await s.tool('write_note').handler({ title: 'Vendor contacts', text: 'Acme: jane@acme.test, renews in March.' });
    expect(w.isError).toBeFalsy();
    const found = await s.tool('search_notes').handler({ query: 'acme renews' });
    expect(found.content[0]).toMatchObject({ text: expect.stringContaining('vendor-contacts.md') });
    const none = await s.tool('search_notes').handler({ query: 'zebra' });
    expect(none.content[0]).toMatchObject({ text: expect.stringContaining('No notes match') });
  });
});

describe('memory and notes refuse secrets', () => {
  const KEY = 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0kLmN';
  afterEach(() => clearSecrets());

  it('update_memory refuses key-shaped text in every mode and leaves memory untouched', async () => {
    const s = setup('dm');
    expect((await s.tool('update_memory').handler({ mode: 'replace', text: 'Deploys go out Fridays.' })).isError).toBeFalsy();
    for (const a of [
      { mode: 'replace', text: 'Anthropic key: ' + KEY },
      { mode: 'append', text: 'Authorization: Bearer abcdefghijklmnop' },
      { mode: 'patch', find: 'Fridays', text: 'Fridays, token ghp_abcdefghijklmnopqrstuvwxyz0123' },
    ]) {
      const out = await s.tool('update_memory').handler(a);
      expect(out.isError).toBe(true);
      expect(out.content[0]).toMatchObject({ text: expect.stringContaining('looks like it contains a secret') });
    }
    expect(s.ctx.memory.read(s.chief.id)).toBe('Deploys go out Fridays.');
  });

  it('update_memory refuses a value the hub registered as a secret', async () => {
    const s = setup('dm');
    addSecret('plain-looking-hub-token-123');
    const out = await s.tool('update_memory').handler({ mode: 'append', text: 'hub token is plain-looking-hub-token-123' });
    expect(out.isError).toBe(true);
    expect(s.ctx.memory.read(s.chief.id)).toBe('');
  });

  it('write_note refuses a secret in the body or the title and writes no file', async () => {
    const s = setup('dm');
    expect((await s.tool('write_note').handler({ title: 'Keys', text: 'xoxb-1234567890-abcdefghij' })).isError).toBe(true);
    expect((await s.tool('write_note').handler({ title: KEY, text: 'harmless' })).isError).toBe(true);
    expect(s.ctx.memory.listNotes(s.chief.id)).toEqual([]);
    // Talking about keys without one is fine.
    expect((await s.tool('write_note').handler({ title: 'Keys', text: 'The API key lives in Settings > Secrets.' })).isError).toBeFalsy();
  });
});
