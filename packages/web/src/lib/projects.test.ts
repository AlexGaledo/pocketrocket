import { describe, expect, it } from 'vitest';
import { fetchProjects, projectOfRoom } from './projects';
import type { ProjectInfo } from './api';

const project = (slug: string, roomId: string | null): ProjectInfo => ({ slug, name: slug, dir: '/p/' + slug, memberIds: [], roomId, templateVersion: null, createdAt: 0 });

describe('projectOfRoom', () => {
  const list = [project('wika', 'r1'), project('notes', null), project('mimegen', 'r3')];

  it('finds the project whose group chat it is', () => {
    expect(projectOfRoom(list, 'r3')?.slug).toBe('mimegen');
  });

  it('is null for a room no project owns, and for no room', () => {
    expect(projectOfRoom(list, 'r2')).toBeNull();
    expect(projectOfRoom(list, null)).toBeNull();
    expect(projectOfRoom(list, undefined)).toBeNull();
    expect(projectOfRoom([], 'r1')).toBeNull();
  });
});

describe('fetchProjects', () => {
  it('passes the list through', async () => {
    const list = [project('wika', 'r1')];
    expect(await fetchProjects(async () => list)).toBe(list);
  });

  it('is an empty list, never an error, when the hub refuses (a paired phone) or is older (404)', async () => {
    expect(await fetchProjects(async () => { throw new Error('Forbidden'); })).toEqual([]);
    expect(await fetchProjects(async () => { throw new Error('Not found'); })).toEqual([]);
  });

  it('ignores a body that is not a list', async () => {
    expect(await fetchProjects(async () => ({ error: 'x' }) as unknown as ProjectInfo[])).toEqual([]);
  });
});
