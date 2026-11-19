import { describe, expect, it } from 'vitest';
import { groupByProject } from './inboxGroups';
import type { ProjectInfo } from './api';

const project = (slug: string, roomId: string | null): ProjectInfo => ({ slug, name: slug, dir: '/p/' + slug, memberIds: [], roomId, templateVersion: null, createdAt: 0 });
const item = (key: string, roomId: string | null) => ({ key, roomId });

describe('groupByProject', () => {
  const projects = [project('wika', 'r1'), project('notes', null), project('mimegen', 'r3')];

  it('groups rows by project in the hub order, with other rooms last', () => {
    const groups = groupByProject([item('a', 'r3'), item('b', 'r9'), item('c', 'r1'), item('d', 'r3'), item('e', null)], projects);
    expect(groups.map((g) => g.project?.slug ?? null)).toEqual(['wika', 'mimegen', null]);
    expect(groups.map((g) => g.items.map((i) => i.key))).toEqual([['c'], ['a', 'd'], ['b', 'e']]);
  });

  it('leaves out projects with nothing waiting', () => {
    expect(groupByProject([item('a', 'r1')], projects).map((g) => g.project?.slug)).toEqual(['wika']);
  });

  it('is one "other" group when no project is involved, and nothing for no rows', () => {
    expect(groupByProject([item('a', 'r2')], projects)).toEqual([{ project: null, items: [item('a', 'r2')] }]);
    expect(groupByProject([item('a', 'r1')], [])).toEqual([{ project: null, items: [item('a', 'r1')] }]);
    expect(groupByProject([], projects)).toEqual([]);
  });
});
