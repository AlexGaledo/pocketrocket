/**
 * Projects in the web app (docs/specs/toki-ui.md, W3). The hub owns them (`GET /api/projects`); the store keeps the
 * list so any part of the UI can ask which project a room belongs to.
 *
 * A paired phone is refused (`api/guard.ts` DEVICE_ALLOW) and an older hub answers 404: both simply mean "no
 * projects", never an error the owner has to read.
 */
import type { ProjectInfo } from './api';

/** The project whose linked group chat is `roomId`, or null. */
export function projectOfRoom(projects: readonly ProjectInfo[], roomId: string | null | undefined): ProjectInfo | null {
  if (!roomId) return null;
  return projects.find((p) => p.roomId === roomId) ?? null;
}

/** The fetched list, or `[]` for any refusal or failure. `list` is the API call, passed in so this stays testable. */
export async function fetchProjects(list: () => Promise<ProjectInfo[]>): Promise<ProjectInfo[]> {
  try {
    const projects = await list();
    return Array.isArray(projects) ? projects : [];
  } catch {
    return [];
  }
}
