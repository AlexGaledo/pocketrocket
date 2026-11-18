import { describe, expect, it, vi } from 'vitest';
import { activeSessions, dispatchPcSessionEvent, groupSessions, listQuery, mergeEntries, nextBefore, onPcSessionUpdated, relativeTime, repoOptions, toolRowLabel, type PcSeqEntry, type PcSessionSummary } from './pcSessions';

const S = (id: string, o: Partial<PcSessionSummary> = {}): PcSessionSummary => ({
  id, parentId: null, machine: 'pc', projectDir: 'C--proj', cwd: null, repo: null, title: null, firstAt: 0, lastAt: 1, entryCount: 1, bytes: 1, truncated: false, status: 'ended', links: [], ...o,
});
const repo = (name: string) => ({ name, remote: null, branch: null, head: null });

describe('activeSessions', () => {
  const mk = (id: string, o: Partial<PcSessionSummary> = {}) => ({ id, status: 'ended', parentId: null, move: null, ...o }) as unknown as PcSessionSummary;
  it('keeps live sessions, sessions away on the VPS, and a parent whose subagent is live', () => {
    const list = [
      mk('live', { status: 'live' }),
      mk('old'),
      mk('vps', { move: { state: 'on-vps' } as PcSessionSummary['move'] }),
      mk('back', { move: { state: 'local' } as PcSessionSummary['move'] }),
      mk('parent'),
      mk('parent:kid', { status: 'live', parentId: 'parent' }),
      mk('live:kid', { parentId: 'live' }),
    ];
    expect(activeSessions(list).map((x) => x.id).sort()).toEqual(['live', 'live:kid', 'parent', 'parent:kid', 'vps']);
  });
});

describe('groupSessions', () => {
  it('groups by repo name else project dir, newest group first, newest row first', () => {
    const g = groupSessions([
      S('a', { repo: repo('alpha'), lastAt: 10 }),
      S('b', { projectDir: 'C--loose', lastAt: 50 }),
      S('c', { repo: repo('alpha'), lastAt: 30 }),
    ]);
    expect(g.map((x) => x.label)).toEqual(['C--loose', 'alpha']);
    expect(g[1].nodes.map((n) => n.session.id)).toEqual(['c', 'a']);
  });
  it('nests subagents under their parent and counts them toward the group recency', () => {
    const g = groupSessions([
      S('p', { repo: repo('r'), lastAt: 10 }),
      S('p:1', { parentId: 'p', repo: repo('r'), lastAt: 99 }),
      S('p:2', { parentId: 'p', repo: repo('r'), lastAt: 20 }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].nodes).toHaveLength(1);
    expect(g[0].nodes[0].children.map((c) => c.id)).toEqual(['p:1', 'p:2']);
    expect(g[0].lastAt).toBe(99);
  });
  it('keeps a child whose parent is not loaded as its own row', () => {
    const g = groupSessions([S('x:1', { parentId: 'x' })]);
    expect(g[0].nodes[0].session.id).toBe('x:1');
  });
});

describe('paging and query', () => {
  it('stops paging on a short page, else uses the oldest lastAt', () => {
    const list = [S('a', { lastAt: 9 }), S('b', { lastAt: 4 })];
    expect(nextBefore(list, 2, 2)).toBe(4);
    expect(nextBefore(list, 1, 2)).toBeNull();
  });
  it('builds the list query without empty values', () => {
    expect(listQuery({ q: ' hi ', repo: 'r', before: 5 })).toBe('?repo=r&q=hi&before=5&limit=50');
    expect(listQuery({})).toBe('?limit=50');
  });
  it('lists repo names once, sorted', () => {
    expect(repoOptions([S('a', { repo: repo('b') }), S('c', { repo: repo('a') }), S('d', { repo: repo('b') }), S('e')])).toEqual(['a', 'b']);
  });
  it('merges entries by seq in order', () => {
    const e = (seq: number, text = ''): PcSeqEntry => ({ seq, uuid: 'u' + seq, at: 0, kind: 'user', text });
    expect(mergeEntries([e(1), e(2, 'old')], [e(2, 'new'), e(3)]).map((x) => x.text + x.seq)).toEqual(['1', 'new2', '3']);
  });
});

describe('display helpers', () => {
  it('labels tool rows', () => {
    expect(toolRowLabel({ kind: 'tool_use', tool: 'Bash', text: 'npm test\nmore' })).toBe('Bash · npm test');
    expect(toolRowLabel({ kind: 'tool_result', text: '' })).toBe('result');
  });
  it('formats relative time', () => {
    expect(relativeTime(1000, 1000 + 30_000)).toBe('just now');
    expect(relativeTime(0, 5 * 60_000)).toBe('5m ago');
    expect(relativeTime(0, 3 * 3600_000)).toBe('3h ago');
    expect(relativeTime(0, 2 * 86400_000)).toBe('2d ago');
  });
});

describe('pc_session_updated', () => {
  it('reaches listeners and is claimed; other events and bad shapes are not', () => {
    const fn = vi.fn();
    const off = onPcSessionUpdated(fn);
    expect(dispatchPcSessionEvent({ type: 'pc_session_updated', id: 's1', lastAt: 7 })).toBe(true);
    expect(fn).toHaveBeenCalledWith({ type: 'pc_session_updated', id: 's1', lastAt: 7 });
    expect(dispatchPcSessionEvent({ type: 'hello' })).toBe(false);
    expect(dispatchPcSessionEvent({ type: 'pc_session_updated' })).toBe(false);
    off();
    dispatchPcSessionEvent({ type: 'pc_session_updated', id: 's2', lastAt: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
