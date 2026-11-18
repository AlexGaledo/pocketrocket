import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PcEntry, PcSessionPut } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { events } from '../events.js';
import { PC_EVENT_COALESCE_MS, PcSessions } from './PcSessions.js';

const DAY = 24 * 60 * 60_000;
const meta = (o: Partial<PcSessionPut> = {}): PcSessionPut => ({
  machine: 'pc', projectDir: 'C--proj', cwd: 'C:\\proj', repo: null, title: 'Fix the thing', firstAt: 1000, lastAt: 2000, ...o,
});
let u = 0;
const entry = (o: Partial<PcEntry> = {}): PcEntry => ({ uuid: 'u' + u++, at: 1500, kind: 'user', text: 'hello', ...o });

afterEach(() => vi.useRealTimers());

describe('PcSessions', () => {
  it('prunes by age (90 days by lastAt) and takes children with a parent', () => {
    let now = 100 * DAY;
    const s = new PcSessions(new Db(':memory:'), { now: () => now });
    s.upsert('old', meta({ lastAt: 5 * DAY }));
    s.upsert('old:sub', meta({ parentId: 'old', lastAt: 99 * DAY }));
    s.upsert('fresh', meta({ lastAt: 99 * DAY }));
    expect(s.prune().removed).toBe(2);
    expect(s.get('old')).toBeNull();
    expect(s.get('old:sub')).toBeNull();
    expect(s.get('fresh')).not.toBeNull();
    now = 200 * DAY; // 101 days later
    expect(s.prune().removed).toBe(1);
  });

  it('prunes the oldest lastAt first until the mirror fits its byte cap', () => {
    const db = new Db(':memory:');
    const s = new PcSessions(db, { now: () => 1000, maxTotalBytes: 2500, retentionDays: 36500 });
    for (const [id, lastAt] of [['a', 300], ['b', 100], ['c', 200]] as const) {
      s.upsert(id, meta({ lastAt }));
      s.appendEntries(id, 0, 10, [entry({ text: 'x'.repeat(1000), at: lastAt })]);
    }
    // 3000 bytes > 2500: b (oldest lastAt) goes, then 2000 <= 2500 stops.
    expect(s.prune().removed).toBe(1);
    expect(s.get('b')).toBeNull();
    expect(s.get('a')).not.toBeNull();
    expect(s.get('c')).not.toBeNull();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pc_session_entries WHERE session_id = 'b'")!.n).toBe(0);
    expect(s.prune().removed).toBe(0);
  });

  it('coalesces pc_session_updated to one per session per 2 s (first now, the rest once at the end)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const s = new PcSessions(new Db(':memory:'));
    s.upsert('s1', meta());
    s.upsert('s2', meta());
    const seen: { id: string; lastAt: number }[] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'pc_session_updated') seen.push({ id: ev.id, lastAt: ev.lastAt }); });
    try {
      let off1 = 0;
      for (let i = 0; i < 5; i++) {
        s.appendEntries('s1', off1, off1 + 10, [entry({ at: 5000 + i })]);
        off1 += 10;
        vi.advanceTimersByTime(100);
      }
      s.appendEntries('s2', 0, 5, [entry()]);
      expect(seen.filter((e) => e.id === 's1')).toHaveLength(1);
      expect(seen.filter((e) => e.id === 's2')).toHaveLength(1);
      vi.advanceTimersByTime(PC_EVENT_COALESCE_MS);
      const s1 = seen.filter((e) => e.id === 's1');
      expect(s1).toHaveLength(2); // the trailing one, carrying the newest lastAt
      expect(s1[1].lastAt).toBe(5004);
      vi.advanceTimersByTime(PC_EVENT_COALESCE_MS * 3);
      expect(seen.filter((e) => e.id === 's1')).toHaveLength(2);
      // after the window a new batch goes out at once
      s.appendEntries('s1', off1, off1 + 10, [entry()]);
      expect(seen.filter((e) => e.id === 's1')).toHaveLength(3);
    } finally {
      off();
      s.stop();
    }
  });
});

describe('PcSessions tombstones', () => {
  it('refuses a session the owner deleted, for good', () => {
    let now = 10_000;
    const s = new PcSessions(new Db(':memory:'), { now: () => now });
    s.upsert('a', meta());
    s.upsert('a:sub', meta({ parentId: 'a' }));
    expect(s.delete('a')).toBe(true);
    now += DAY;
    expect(s.refused('a', now + DAY)).toBe(true);
    expect(s.refused('a:sub', now + DAY)).toBe(true);
    expect(s.refused('other', 1)).toBe(false);
  });

  it('lets a pruned session come back only with newer activity', () => {
    const now = 400 * DAY;
    const s = new PcSessions(new Db(':memory:'), { now: () => now, retentionDays: 90 });
    s.upsert('old', meta({ firstAt: 1, lastAt: 2 }));
    expect(s.prune().removed).toBe(1);
    expect(s.refused('old', 2)).toBe(true);
    expect(s.refused('old', now + 1)).toBe(false);
    expect(s.refused('old', 2)).toBe(false); // the tombstone is gone once it came back
  });
});
