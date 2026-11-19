import { describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { buildProjectTree, type ProjectTreeInput } from './projectTree';
import type { ProjectInfo } from './api';
import type { BotStatus } from './botStatus';

const bot = (id: string) => ({ id, name: id, handle: id }) as Bot;
const group = (id: string, memberIds: string[]) => ({ id, kind: 'group', name: id, memberIds }) as unknown as Room;
const dm = (id: string, botId: string) => ({ id, kind: 'dm', name: botId, memberIds: [botId] }) as unknown as Room;
const project = (slug: string, roomId: string | null, memberIds: string[] = []): ProjectInfo => ({ slug, name: slug, dir: '/p/' + slug, memberIds, roomId, templateVersion: null, createdAt: 0 });

/**
 * Fleet: project "wika" runs in room r-wika (lead, eng); project "notes" has no room (writer); room r-train belongs to
 * no project (coach); "solo" is in no group; "old" is paused and alone in room r-old.
 */
function input(over: Partial<ProjectTreeInput> = {}): ProjectTreeInput {
  const paused = new Set(['old']);
  return {
    projects: [project('wika', 'r-wika'), project('notes', null, ['writer'])],
    rooms: [group('r-wika', ['lead', 'eng']), group('r-train', ['coach']), group('r-old', ['old']), dm('d-solo', 'solo'), dm('d-old', 'old')],
    bots: ['lead', 'eng', 'writer', 'coach', 'solo', 'old'].map(bot),
    statusOf: (id): BotStatus => (paused.has(id) ? 'paused' : 'idle'),
    activeRoomId: null,
    showPaused: false,
    ...over,
  };
}
const ids = (bots: Bot[]) => bots.map((b) => b.id);

describe('buildProjectTree', () => {
  it('lists projects first with their group chat and its bots, and a roomless project with its own members', () => {
    const t = buildProjectTree(input());
    expect(t.projects.map((p) => [p.project.slug, p.room?.id ?? null, ids(p.bots)])).toEqual([
      ['wika', 'r-wika', ['lead', 'eng']],
      ['notes', null, ['writer']],
    ]);
  });

  it('keeps a project chat out of Rooms', () => {
    const t = buildProjectTree(input());
    expect(t.rooms.map((r) => r.room.id)).toEqual(['r-train']);
  });

  it('puts a bot in no group chat under solo, and leaves podium bots out of every list', () => {
    expect(ids(buildProjectTree(input()).solo)).toEqual(['writer', 'solo']);
    const t = buildProjectTree(input({ podiumIds: new Set(['lead', 'solo']) }));
    expect(ids(t.projects[0].bots)).toEqual(['eng']);
    expect(ids(t.solo)).toEqual(['writer']);
  });

  it('hides paused bots and rooms with no live bot until asked, and says how many', () => {
    const t = buildProjectTree(input());
    expect(t.rooms.map((r) => r.room.id)).not.toContain('r-old');
    expect(t.hidden).toBe(1);
    const all = buildProjectTree(input({ showPaused: true }));
    expect(all.rooms.map((r) => r.room.id)).toEqual(['r-train', 'r-old']);
    expect(ids(all.rooms[1].bots)).toEqual(['old']);
    expect(all.hidden).toBe(0);
  });

  it('counts paused bots per list, so a folded list can leave them out of the count', () => {
    const paused = new Set(['eng']);
    const t = buildProjectTree(input({ statusOf: (id) => (paused.has(id) ? 'paused' : 'idle') }));
    expect(ids(t.projects[0].bots)).toEqual(['lead']);
    expect(t.projects[0].hiddenBots).toBe(1);
    expect(t.hiddenSolo).toBe(0);
  });

  it('hides a project whose bots are all paused, and an empty one', () => {
    const t = buildProjectTree(input({ projects: [project('wika', 'r-wika'), project('empty', null)], statusOf: (id) => (id === 'lead' || id === 'eng' ? 'paused' : 'idle') }));
    expect(t.projects).toEqual([]);
    expect(t.hidden).toBe(2); // the two projects; r-old's bot is live in this input, so its room shows
  });

  it('never hides what holds the open chat', () => {
    // The paused room is open.
    expect(buildProjectTree(input({ activeRoomId: 'r-old' })).rooms.map((r) => r.room.id)).toContain('r-old');
    // A DM with the paused bot is open: its room and the bot itself stay.
    const t = buildProjectTree(input({ activeRoomId: 'd-old' }));
    expect(t.rooms.find((r) => r.room.id === 'r-old')?.bots.map((b) => b.id)).toEqual(['old']);
    // A project whose bots are all paused, but its chat is open.
    const p = buildProjectTree(input({ activeRoomId: 'r-wika', statusOf: () => 'paused' }));
    expect(p.projects[0].active).toBe(true);
  });

  it('marks the project whose chat is open as active', () => {
    const t = buildProjectTree(input({ activeRoomId: 'r-wika' }));
    expect(t.projects.map((p) => p.active)).toEqual([true, false]);
  });

  it('ignores a project pointing at a room the store does not hold', () => {
    const t = buildProjectTree(input({ projects: [project('gone', 'r-missing', ['coach'])] }));
    expect(t.projects[0].room).toBeNull();
    expect(ids(t.projects[0].bots)).toEqual(['coach']);
    expect(t.rooms.map((r) => r.room.id)).toContain('r-train');
  });

  it('is stable: the same input gives the same tree', () => {
    expect(buildProjectTree(input())).toEqual(buildProjectTree(input()));
  });
});
