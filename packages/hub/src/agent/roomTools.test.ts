import { describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { createHubTools, type ToolCtx } from './botTools.js';
import type { ToolOutput } from '../providers/types.js';

/**
 * A bot used to be trapped in the room its turn was running in: add_to_room and remove_from_room only
 * touched ctx.room, there was no delete_room at all, and nothing could even list a room the bot was not a
 * member of. So a bot that created a group chat could never manage or disband it again — which is exactly
 * what Smoke reported. Every room tool now takes an optional `room` and defaults to the current one.
 */

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const scout = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: '', avatar: '🔎', model: 'm', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const lead = repos.createBot({ name: 'Lead', handle: 'leadeng', title: '', description: '', avatar: '🧭', model: 'm', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const qa = repos.createBot({ name: 'QA', handle: 'qa', title: '', description: '', avatar: '🧪', model: 'm', allowedTools: ['Read'], maxBudgetUsd: 2 });
  // The turn runs in Scout's DM; the team room is one Scout is not a member of.
  const dm = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [scout.id], coordinatorBotId: null });
  const team = repos.createRoom({ kind: 'group', name: 'build-team', memberIds: [lead.id, qa.id], coordinatorBotId: lead.id });
  const dispatched: Array<{ handles: string[]; roomId: string | undefined }> = [];
  const ctx: ToolCtx = {
    bot: scout, room: dm as Room, members: [scout as Bot], turnId: 't1', hop: 0, causeId: 'c1',
    repos, memory: new MemoryService(), skills: new SkillService(repos),
    dispatchFromBot: (targets, room) => {
      dispatched.push({ handles: targets.map((t) => t.handle), roomId: room?.id });
      return targets.map((t) => t.handle);
    },
    setState: () => undefined,
    models: ['m'],
  };
  return { repos, scout, lead, qa, dm, team, dispatched, tools: createHubTools(ctx) };
}

const call = (s: ReturnType<typeof setup>, name: string, args: Record<string, unknown> = {}) =>
  s.tools.find((t) => t.name === name)!.handler(args);

const said = (o: ToolOutput) => o.content.map((c) => ('text' in c ? c.text : '')).join('');

describe('room tools reach rooms the bot is not in', () => {
  it('list_rooms shows every room, its id and its members, and marks the current one', async () => {
    const s = setup();
    const out = said(await call(s, 'list_rooms'));
    expect(out).toContain('build-team');
    expect(out).toContain('id=' + s.team.id);
    expect(out).toContain('@leadeng');
    expect(out).toContain('* DM');
  });

  it('read_room reads another room by name', async () => {
    const s = setup();
    s.repos.insertMessage({ roomId: s.team.id, authorType: 'bot', authorId: s.lead.id, kind: 'text', text: 'scaffold is up', payload: null, causeId: null, hop: 0, turnId: null });
    const out = said(await call(s, 'read_room', { room: 'build-team' }));
    expect(out).toContain('scaffold is up');
    expect(out).toContain('@leadeng');
  });

  it('send_message posts into another room and wakes that room’s bots', async () => {
    const s = setup();
    const out = said(await call(s, 'send_message', { room: 'build-team', text: '@qa please retest' }));
    expect(out).toContain('build-team');
    expect(s.repos.listMessages(s.team.id, { limit: 10 }).some((m) => m.text === '@qa please retest')).toBe(true);
    expect(s.dispatched).toEqual([{ handles: ['qa'], roomId: s.team.id }]);
    // Nothing landed in the room the turn is actually running in.
    expect(s.repos.listMessages(s.dm.id, { limit: 10 })).toHaveLength(0);
  });

  it('add_to_room and remove_from_room target another room', async () => {
    const s = setup();
    await call(s, 'add_to_room', { handle: 'scout', room: 'build-team' });
    expect(s.repos.getRoom(s.team.id)!.memberIds).toContain(s.scout.id);
    await call(s, 'remove_from_room', { bot: '@qa', room: 'build-team' });
    expect(s.repos.getRoom(s.team.id)!.memberIds).not.toContain(s.qa.id);
    // The current room's member list is untouched by edits to another room.
    expect(s.repos.getRoom(s.dm.id)!.memberIds).toEqual([s.scout.id]);
  });

  it('delete_room disbands a group chat and its history, keeping the bots', async () => {
    const s = setup();
    s.repos.insertMessage({ roomId: s.team.id, authorType: 'bot', authorId: s.lead.id, kind: 'text', text: 'wip', payload: null, causeId: null, hop: 0, turnId: null });
    const out = said(await call(s, 'delete_room', { room: 'build-team', confirm: true }));
    expect(out).toContain('Deleted "build-team"');
    expect(s.repos.getRoom(s.team.id)).toBeUndefined();
    expect(s.repos.listMessages(s.team.id, { limit: 10 })).toHaveLength(0);
    expect(s.repos.getBot(s.lead.id)).toBeTruthy();
    expect(s.repos.getBot(s.qa.id)).toBeTruthy();
  });

  it('delete_room refuses without confirm, on a DM, and on the room the turn is in', async () => {
    const s = setup();
    const noConfirm = await call(s, 'delete_room', { room: 'build-team', confirm: false });
    expect(noConfirm.isError).toBe(true);
    expect(s.repos.getRoom(s.team.id)).toBeTruthy();

    const dm = await call(s, 'delete_room', { room: 'DM', confirm: true });
    expect(dm.isError).toBe(true);
    expect(said(dm)).toMatch(/you are in|not yours to delete/i);
    expect(s.repos.getRoom(s.dm.id)).toBeTruthy();
  });

  it('names an unknown room clearly instead of silently using the current one', async () => {
    const s = setup();
    const out = await call(s, 'send_message', { room: 'no-such-room', text: 'hello' });
    expect(out.isError).toBe(true);
    expect(said(out)).toContain('list_rooms');
    expect(s.repos.listMessages(s.dm.id, { limit: 10 })).toHaveLength(0);
  });

  it('still defaults to the current room when no room is given', async () => {
    const s = setup();
    await call(s, 'send_message', { text: 'status: green' });
    expect(s.repos.listMessages(s.dm.id, { limit: 10 }).some((m) => m.text === 'status: green')).toBe(true);
    expect(s.repos.listMessages(s.team.id, { limit: 10 })).toHaveLength(0);
  });
});
