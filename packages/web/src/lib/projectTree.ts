/**
 * What the project-first sidebar lists (docs/specs/toki-ui.md, W4), worked out from data the store already holds.
 * Pure, so the rules below are tested rather than eyeballed:
 *
 * - Projects come first, in the hub's order. A project's bots are its group chat's members, or its own member list
 *   while it has no chat.
 * - Rooms are the group chats that belong to no project, in the hub's order.
 * - Solo bots are the ones in no group chat (the podium is drawn apart and passed in to be left out).
 * - Paused bots, and rooms and projects with no live bot, are hidden until "Show paused" is pressed. Whatever holds
 *   the chat you are in is never hidden, so opening one from search never loses your place.
 */
import type { Bot, Room } from '@pocketrocket/shared';
import type { ProjectInfo } from './api';
import type { BotStatus } from './botStatus';

export interface ProjectNode {
  project: ProjectInfo;
  /** Its linked group chat, when it has one the store knows. */
  room: Room | null;
  /** The bots to list under it, already filtered for paused ones. */
  bots: Bot[];
  /** Its group chat is the open chat. */
  active: boolean;
  /** Paused bots left out of `bots`. */
  hiddenBots: number;
}

export interface RoomNode {
  room: Room;
  bots: Bot[];
  hiddenBots: number;
}

export interface ProjectTree {
  projects: ProjectNode[];
  rooms: RoomNode[];
  solo: Bot[];
  /** Paused solo bots left out of `solo`. */
  hiddenSolo: number;
  /**
   * Projects and rooms "Show paused" would bring back. Paused bots are counted per node instead, so the sidebar can
   * add only those of the sections it has unfolded: a count must match what pressing the button shows.
   */
  hidden: number;
}

export interface ProjectTreeInput {
  projects: readonly ProjectInfo[];
  rooms: readonly Room[];
  bots: readonly Bot[];
  statusOf: (botId: string) => BotStatus;
  activeRoomId: string | null;
  /** Bots drawn on the podium: left out of every list below it, as in the classic sidebar. */
  podiumIds?: ReadonlySet<string>;
  showPaused: boolean;
}

export function buildProjectTree({ projects, rooms, bots, statusOf, activeRoomId, podiumIds = new Set(), showPaused }: ProjectTreeInput): ProjectTree {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const groups = rooms.filter((r) => r.kind === 'group');
  const roomById = new Map(groups.map((r) => [r.id, r]));
  const activeDmBot = rooms.find((r) => r.id === activeRoomId && r.kind === 'dm')?.memberIds[0] ?? null;

  const live = (id: string) => statusOf(id) !== 'paused';
  let hidden = 0;

  /** Members that exist, minus the podium, minus paused ones unless asked for or open. */
  const listed = (ids: readonly string[]): { bots: Bot[]; hiddenBots: number } => {
    const all = ids.map((id) => byId.get(id)).filter((b): b is Bot => !!b && !podiumIds.has(b.id));
    const shown = all.filter((b) => showPaused || live(b.id) || b.id === activeDmBot);
    return { bots: shown, hiddenBots: all.length - shown.length };
  };
  /** Somebody in it is not paused (the podium counts: a podium bot still works in its rooms). */
  const anyLive = (ids: readonly string[]) => ids.some((id) => byId.has(id) && live(id));

  const linked = new Set<string>();
  const projectNodes: ProjectNode[] = [];
  for (const project of projects) {
    const room = project.roomId ? roomById.get(project.roomId) ?? null : null;
    if (room) linked.add(room.id);
    const ids = room ? room.memberIds : project.memberIds;
    const active = !!room && room.id === activeRoomId;
    const holdsOpenDm = !!activeDmBot && ids.includes(activeDmBot);
    if (!showPaused && !active && !holdsOpenDm && !anyLive(ids)) { hidden++; continue; }
    projectNodes.push({ project, room, active, ...listed(ids) });
  }

  const roomNodes: RoomNode[] = [];
  for (const room of groups) {
    if (linked.has(room.id)) continue;
    const holdsOpenDm = !!activeDmBot && room.memberIds.includes(activeDmBot);
    if (!showPaused && room.id !== activeRoomId && !holdsOpenDm && !anyLive(room.memberIds)) { hidden++; continue; }
    roomNodes.push({ room, ...listed(room.memberIds) });
  }

  const inAnyGroup = new Set(groups.flatMap((r) => r.memberIds));
  const solo = listed(bots.filter((b) => !inAnyGroup.has(b.id)).map((b) => b.id));

  return { projects: projectNodes, rooms: roomNodes, solo: solo.bots, hiddenSolo: solo.hiddenBots, hidden };
}
