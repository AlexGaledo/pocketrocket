import { describe, expect, it } from 'vitest';
import { Db } from './db.js';
import { ComputersRepo } from './computers.js';

describe('computers table (migration 10)', () => {
  it('is created and recorded in P1\'s block', () => {
    const db = new Db(':memory:');
    expect(db.schemaVersions()).toContain(10);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='computers'")).toHaveLength(1);
  });

  it('hands out unique slots and stops when they run out', () => {
    const repo = new ComputersRepo(new Db(':memory:'));
    expect(repo.allocate('a', 2, 10, 1)!.slot).toBe(1);
    expect(repo.allocate('b', 2, 10, 1)!.slot).toBe(2);
    expect(repo.allocate('c', 2, 10, 1)).toBeNull();
    expect(repo.allocate('a', 2, 10, 1)!.slot).toBe(1);
    expect(repo.get('a')).toMatchObject({ state: 'asleep', keepAwake: false, quotaBytes: 10, diskBytes: 0, lastUsedAt: null });
    repo.setKeepAwake('a', true);
    repo.setState('a', 'live');
    repo.setDisk('a', 12.6);
    repo.touch('a', 5);
    expect(repo.get('a')).toMatchObject({ state: 'live', keepAwake: true, diskBytes: 13, lastUsedAt: 5 });
    repo.remove('a');
    expect(repo.list().map((r) => r.botId)).toEqual(['b']);
  });
});
