/**
 * The Needs you page in the new layout (docs/specs/toki-ui.md, W9): the same rows, grouped by the project whose room
 * they wait in. Projects keep the hub's order; everything else (rooms with no project, skills, which have no room)
 * goes under "Other rooms", last. Rows keep their order inside each group.
 */
import type { ProjectInfo } from './api';
import { projectOfRoom } from './projects';

export interface InboxGroup<T> {
  /** Null for "Other rooms". */
  project: ProjectInfo | null;
  items: T[];
}

export function groupByProject<T extends { roomId: string | null }>(items: readonly T[], projects: readonly ProjectInfo[]): InboxGroup<T>[] {
  const byProject = new Map<string, T[]>();
  const other: T[] = [];
  for (const it of items) {
    const p = projectOfRoom(projects, it.roomId);
    if (!p) { other.push(it); continue; }
    const list = byProject.get(p.slug);
    if (list) list.push(it); else byProject.set(p.slug, [it]);
  }
  const groups: InboxGroup<T>[] = projects.filter((p) => byProject.has(p.slug)).map((p) => ({ project: p, items: byProject.get(p.slug)! }));
  if (other.length) groups.push({ project: null, items: other });
  return groups;
}
