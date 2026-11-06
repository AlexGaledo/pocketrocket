import fs from 'node:fs';
import path from 'node:path';
import type { Room, RoomFolderKind } from '@pocketrocket/shared';
import type { ProjectService } from '../services/ProjectService.js';

export interface RoomFolder {
  kind: RoomFolderKind;
  dir: string;
  /** The linked project, for kind 'project'. */
  projectSlug: string | null;
}

/** Room ids are nanoids. Anything else never becomes part of a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Which folder a room's files live in:
 *   - a room linked to a project: the project's folder,
 *   - any other group room: `<roomsDir>/<roomId>/`, made the first time it is needed,
 *   - a direct chat: the bot's `files/` subfolder, so its memory, identity and notes stay out of view.
 * A bot replying in a room may use that room's folder and no other room's.
 */
export class RoomFiles {
  constructor(private deps: { projects?: ProjectService; roomsDir: string; dmDir: (botId: string) => string }) {}

  get roomsDir() { return this.deps.roomsDir; }

  /** The folder the owner sees for this room, or null when the room cannot have one. */
  folderOf(room: Room): RoomFolder | null {
    if (!SAFE_ID.test(room.id)) return null;
    if (room.kind === 'dm') {
      const botId = room.memberIds[0];
      return botId && SAFE_ID.test(botId) ? { kind: 'dm', dir: this.deps.dmDir(botId), projectSlug: null } : null;
    }
    const project = this.deps.projects?.forRoom(room.id);
    if (project) return { kind: 'project', dir: project.dir, projectSlug: project.slug };
    return { kind: 'room', dir: path.join(this.deps.roomsDir, room.id), projectSlug: null };
  }

  /**
   * The folder `botId` may work in while replying in `room`, or null. A project's folder also needs the bot to be
   * on the project, which only the owner sets, so adding a bot to the chat alone does not open it.
   */
  forBot(room: Room, botId: string): RoomFolder | null {
    if (!room.memberIds.includes(botId)) return null;
    const folder = this.folderOf(room);
    if (!folder) return null;
    if (folder.kind === 'dm' && room.memberIds[0] !== botId) return null;
    if (folder.kind === 'project' && !this.deps.projects?.get(folder.projectSlug!)?.memberIds.includes(botId)) return null;
    return folder;
  }

  /** Creates the folder if it is not there yet, and returns it. */
  ensure(folder: RoomFolder): string {
    fs.mkdirSync(folder.dir, { recursive: true });
    return folder.dir;
  }
}
