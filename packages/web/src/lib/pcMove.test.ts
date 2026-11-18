import { describe, expect, it } from 'vitest';
import { emptyRepo, type ProjectRepo } from './projectRepos';
import {
  continueBlockedReason, continueBody, jobRepos, moveBadge, moveBlockedReason, moveBody, pullBlockedReason, pullBody, roomChoices,
  type PcSessionMove,
} from './pcMove';
import { modeLabel } from './pcRun';

const R = (o: Partial<ProjectRepo> = {}): ProjectRepo => ({ ...emptyRepo(), name: 'app', remote: 'git@github.com:o/app.git', sync: 'bundle', ...o });
const link = { project: 'wika', repo: 'app' };
const M = (o: Partial<PcSessionMove> = {}): PcSessionMove => ({ state: 'on-vps', room: 'r1', project: 'wika', repos: [{ project: 'wika', repo: 'app', branch: 'wip/pc/abcdef12' }], worktree: 'abcdef12', movedAt: 1, pulledAt: null, turnRunning: false, ...o });

describe('moveBlockedReason', () => {
  const ok = { links: [link], repos: { wika: [R()] }, pcBlocked: null };
  it('allows a bundle, non-client repo', () => expect(moveBlockedReason(ok)).toBeNull());
  it('names PC offline and not signed in first', () => {
    expect(moveBlockedReason({ ...ok, pcBlocked: 'Your PC is offline.' })).toBe('Your PC is offline.');
    expect(moveBlockedReason({ ...ok, links: [], pcBlocked: 'Sign in with your password' })).toContain('Sign in');
  });
  it('needs a linked repo', () => expect(moveBlockedReason({ ...ok, links: [] })).toContain('not linked to a project repo'));
  it('refuses a client repo', () => expect(moveBlockedReason({ ...ok, repos: { wika: [R({ client: true })] } })).toContain('Client repo'));
  it('refuses a repo that is not in bundle mode', () => {
    expect(moveBlockedReason({ ...ok, repos: { wika: [R({ sync: 'wip-branch' })] } })).toContain('bundle sync');
    expect(moveBlockedReason({ ...ok, repos: { wika: [R({ sync: 'none' })] } })).toContain('bundle sync');
  });
  it('says so while repos load and when the repo is gone', () => {
    expect(moveBlockedReason({ ...ok, repos: {} })).toContain('Checking');
    expect(moveBlockedReason({ ...ok, repos: { wika: [] } })).toContain('no longer in the project');
  });
  it('blocks on the first failing repo of several', () => {
    const r = moveBlockedReason({ links: [link, { project: 'wika', repo: 'api' }], repos: { wika: [R(), R({ name: 'api', client: true })] }, pcBlocked: null });
    expect(r).toMatch(/^api: Client repo/);
  });
});

describe('badges', () => {
  it('labels each state and nothing for local or no move', () => {
    expect(moveBadge({ move: M() })?.label).toBe('On VPS');
    expect(moveBadge({ move: M({ state: 'moving' }) })?.label).toBe('Moving to VPS');
    expect(moveBadge({ move: M({ state: 'pulling' }) })?.label).toBe('Pulling back');
    expect(moveBadge({ move: M({ state: 'local' }) })).toBeNull();
    expect(moveBadge({})).toBeNull();
  });
});

describe('request bodies', () => {
  it('move sends room only when one was chosen', () => {
    expect(moveBody('s1')).toEqual({ mode: 'move', sessionId: 's1' });
    expect(moveBody('s1', null)).toEqual({ mode: 'move', sessionId: 's1' });
    expect(moveBody('s1', 'r2')).toEqual({ mode: 'move', sessionId: 's1', room: 'r2' });
  });
  it('pull and continue', () => {
    expect(pullBody('s1')).toEqual({ mode: 'pull', sessionId: 's1' });
    expect(continueBody('  go on \n')).toEqual({ prompt: 'go on' });
  });
});

describe('vps controls', () => {
  it('pull waits for a running turn and a missing PC', () => {
    expect(pullBlockedReason(M(), null)).toBeNull();
    expect(pullBlockedReason(M({ turnRunning: true }), null)).toContain('turn is running');
    expect(pullBlockedReason(M(), 'Your PC is offline.')).toBe('Your PC is offline.');
    expect(pullBlockedReason(M({ state: 'pulling' }), null)).toContain('Already');
  });
  it('continue is one turn at a time and needs a password session', () => {
    expect(continueBlockedReason(M(), true)).toBeNull();
    expect(continueBlockedReason(M({ turnRunning: true }), true)).toContain('One at a time');
    expect(continueBlockedReason(M(), false)).toContain('Sign in');
  });
});

describe('roomChoices', () => {
  const rooms = [
    { id: 'a', name: 'Wika', kind: 'group', memberIds: ['b1', 'b2'] },
    { id: 'b', name: 'Wika side', kind: 'group', memberIds: ['b1', 'b2', 'b3'] },
    { id: 'c', name: 'Other', kind: 'group', memberIds: ['b9'] },
    { id: 'd', name: 'DM', kind: 'dm', memberIds: ['b1', 'b2'] },
  ];
  it('lists the project room first, then group chats with all its members', () => {
    expect(roomChoices({ roomId: 'a', memberIds: ['b1', 'b2'] }, rooms).map((r) => r.id)).toEqual(['a', 'b']);
    expect(roomChoices(undefined, rooms)).toEqual([]);
  });
});

describe('job rows', () => {
  it('labels modes and lists repos from the request or the result', () => {
    expect(modeLabel({ mode: 'move' })).toBe('Move');
    expect(modeLabel({ mode: 'pull' })).toBe('Pull');
    expect(jobRepos({ mode: 'move', move: { room: null, repos: [{ project: 'wika', repo: 'app' }] } } as never)).toEqual(['wika / app']);
    expect(jobRepos({ mode: 'pull', pullResult: { repos: [{ repo: 'app', commit: 'abc' }], sessionBytes: 1 } } as never)).toEqual(['app']);
  });
});
