import { describe, expect, it } from 'vitest';
import {
  emptyRepo, hasErrors, linksOf, normaliseRemote, reposBody, syncBlockedReason, syncResultOf, validateRepos, type ProjectRepo,
} from './projectRepos';

const R = (o: Partial<ProjectRepo> = {}): ProjectRepo => ({ ...emptyRepo(), name: 'app', remote: 'git@github.com:org/app.git', ...o });
const msgs = (repos: ProjectRepo[]) => validateRepos(repos).map((i) => i.index + ':' + i.field + ':' + i.level);

describe('normaliseRemote', () => {
  it.each([
    ['git@github.com:Org/app.git', 'https://github.com/Org/app'],
    ['https://GitHub.com/Org/app.git', 'https://github.com/Org/app'],
    ['https://user:pw@github.com/Org/app/', 'https://github.com/Org/app'],
    ['ssh://git@github.com:22/Org/app.git', 'https://github.com/Org/app'],
  ])('%s', (raw, want) => expect(normaliseRemote(raw)).toBe(want));
  it('scp and https spellings agree', () => expect(normaliseRemote('git@github.com:o/r.git')).toBe(normaliseRemote('https://github.com/o/r')));
});

describe('validateRepos', () => {
  it('accepts a good repo', () => expect(validateRepos([R()])).toEqual([]));
  it('names the missing and malformed fields', () => {
    expect(msgs([R({ name: '', remote: '' })])).toEqual(['0:name:error', '0:remote:error']);
    expect(validateRepos([R({ name: 'My App' })])[0].message).toMatch(/lower-case/);
    expect(validateRepos([R({ remote: 'not a url' })])[0].message).toMatch(/does not look like/);
  });
  it('refuses credentials in the remote', () => {
    expect(validateRepos([R({ remote: 'https://me:secret@github.com/o/r.git' })])[0].message).toMatch(/password/);
  });
  it('flags duplicate names as errors and duplicate remotes as a warning', () => {
    const issues = validateRepos([R(), R({ remote: 'https://github.com/org/app' })]);
    expect(issues.map((i) => i.field + ':' + i.level)).toEqual(['name:error', 'remote:warn']);
    expect(issues[0].message).toBe('Another repo here is already called app.');
    expect(issues[1].message).toBe('Same remote as app.');
    expect(hasErrors(validateRepos([R({ name: 'a' }), R({ name: 'b' })]))).toBe(false);
  });
  it('keeps the VPS folder relative', () => {
    expect(msgs([R({ vps: '../x' })])).toEqual(['0:vps:error']);
    expect(msgs([R({ vps: String.raw`C:\x`})])).toEqual(['0:vps:error']);
    expect(msgs([R({ vps: '/etc' })])).toEqual(['0:vps:error']);
    expect(msgs([R({ vps: 'repos/app' })])).toEqual([]);
  });
});

describe('reposBody (the PUT body)', () => {
  it('trims, de-duplicates branches and omits a blank VPS folder', () => {
    expect(reposBody([R({ name: ' app ', remote: ' git@github.com:o/r.git ', sync: 'wip-branch', protected: ['main', ' staging ', 'main', ''], client: false, vps: ' ' })])).toEqual({
      repos: [{ name: 'app', remote: 'git@github.com:o/r.git', sync: 'wip-branch', protected: ['main', 'staging'], client: false }],
    });
  });
  it('keeps a chosen VPS folder and the client flag', () => {
    expect(reposBody([R({ client: true, vps: 'repos/x' })]).repos[0]).toMatchObject({ client: true, vps: 'repos/x', sync: 'none' });
  });
});

describe('syncBlockedReason', () => {
  it('explains client repos, sync none and a removed repo before the PC state', () => {
    expect(syncBlockedReason(R({ client: true, sync: 'bundle' }), 'Your PC is offline.')).toMatch(/Client repo.*bots are sandboxed/);
    expect(syncBlockedReason(R({ sync: 'none' }), null)).toMatch(/Sync is off/);
    expect(syncBlockedReason(undefined, null)).toMatch(/no longer in the project/);
  });
  it('lets a client repo through when the bot sandbox is on, but not the other reasons (bridge P7)', () => {
    expect(syncBlockedReason(R({ client: true, sync: 'bundle' }), null, true)).toBeNull();
    expect(syncBlockedReason(R({ client: true, sync: 'none' }), null, true)).toMatch(/Sync is off/);
    expect(syncBlockedReason(R({ client: true, sync: 'bundle' }), 'Your PC is offline.', true)).toBe('Your PC is offline.');
  });
  it('falls through to the PC reason, or null when sync can start', () => {
    expect(syncBlockedReason(R({ sync: 'bundle' }), 'Your PC is offline.')).toBe('Your PC is offline.');
    expect(syncBlockedReason(R({ sync: 'wip-branch' }), null)).toBeNull();
  });
});

describe('job and session helpers', () => {
  it('reads links and the sync result', () => {
    expect(linksOf({})).toEqual([]);
    expect(linksOf({ links: [{ project: 'p', repo: 'r' }] })).toHaveLength(1);
    const r = { mode: 'bundle' as const, commit: 'abc', scan: { blocked: false, findings: [] } };
    expect(syncResultOf({ syncResult: r })).toBe(r);
    expect(syncResultOf({ syncResult: null })).toBeNull();
    expect(syncResultOf({})).toBeNull();
  });
});
