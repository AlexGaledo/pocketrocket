import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyRepo, validateRepos, type PcJobWithSync, type ProjectRepo } from '../lib/projectRepos';
import type { PcSessionSummary } from '../lib/pcSessions';

let SyncRows: typeof import('./PcSyncPanel').SyncRows;
let SyncSummary: typeof import('./PcSyncPanel').SyncSummary;
let SessionGroups: typeof import('./PcSessionViews').SessionGroups;
let ReposForm: typeof import('./settings/ReposEditor').ReposForm;
let groupSessions: typeof import('../lib/pcSessions').groupSessions;
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  ({ SyncRows, SyncSummary } = await import('./PcSyncPanel'));
  ({ SessionGroups } = await import('./PcSessionViews'));
  ({ ReposForm } = await import('./settings/ReposEditor'));
  ({ groupSessions } = await import('../lib/pcSessions'));
}, 60000);

const R = (o: Partial<ProjectRepo> = {}): ProjectRepo => ({ ...emptyRepo(), name: 'app', remote: 'git@github.com:o/app.git', ...o });
const link = { project: 'wika', repo: 'app' };
const noop = () => undefined;
const rows = (repo: ProjectRepo | undefined, blocked: string | null = null) =>
  renderToStaticMarkup(<SyncRows links={[link]} repos={{ wika: repo ? [repo] : [] }} blocked={blocked} onSync={noop} />);

describe('SyncRows', () => {
  it('enables the action with the mode as its label', () => {
    const wip = rows(R({ sync: 'wip-branch' }));
    expect(wip).toContain('Push wip branch');
    expect(wip).not.toContain('disabled=""');
    expect(rows(R({ sync: 'bundle' }))).toContain('Sync to VPS');
  });
  it('disables a client repo and says why', () => {
    const html = rows(R({ client: true, sync: 'bundle' }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('stays on your PC until bots are sandboxed');
  });
  it('enables a client repo when the bot sandbox is on (bridge P7)', () => {
    const html = renderToStaticMarkup(<SyncRows links={[link]} repos={{ wika: [R({ client: true, sync: 'bundle' })] }} blocked={null} sandboxOn onSync={noop} />);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('stays on your PC');
  });
  it('disables sync none and says why', () => {
    const html = rows(R({ sync: 'none' }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('Sync is off for this repo');
  });
  it('disables while the PC is offline and when the repo is gone', () => {
    expect(rows(R({ sync: 'bundle' }), 'Your PC is offline.')).toContain('Your PC is offline.');
    expect(rows(undefined)).toContain('no longer in the project');
  });
});

const job = (o: Partial<PcJobWithSync>) => ({ sync: { project: 'wika', repo: 'app', mode: 'wip-branch' }, ...o }) as PcJobWithSync;
describe('SyncSummary', () => {
  it('shows repo, branch and short commit when clean', () => {
    const html = renderToStaticMarkup(<SyncSummary j={job({ syncResult: { mode: 'wip-branch', branch: 'wip/pc/abcd1234', commit: '0123456789abcdef', scan: { blocked: false, findings: [] } } })} />);
    expect(html).toContain('wika / app');
    expect(html).toContain('wip/pc/abcd1234');
    expect(html).toContain('01234567');
    expect(html).not.toContain('>0123456789abcdef<');
    expect(html).toContain('Scan clean');
  });
  it('lists scan findings when blocked and shows bundle size', () => {
    const html = renderToStaticMarkup(<SyncSummary j={job({ syncResult: { mode: 'bundle', commit: 'abc12345', bundleBytes: 2097152, scan: { blocked: true, findings: ['.env.production', 'src/a.ts: ghp_ token'] } } })} />);
    expect(html).toContain('Nothing was pushed');
    expect(html).toContain('.env.production');
    expect(html).toContain('src/a.ts: ghp_ token');
    expect(html).toContain('2.0 MB');
  });
});

describe('session links', () => {
  it('tags a linked session row with project / repo', () => {
    const s = { id: 's1', parentId: null, machine: 'pc', projectDir: 'p', cwd: null, repo: null, title: 'T', firstAt: 0, lastAt: 1, entryCount: 1, bytes: 1, truncated: false, status: 'ended', links: [link] } as PcSessionSummary;
    expect(renderToStaticMarkup(<SessionGroups groups={groupSessions([s])} onOpen={noop} />)).toContain('wika / app');
  });
});

describe('ReposForm', () => {
  const form = (repos: ProjectRepo[], o: { attempted?: boolean; serverError?: string } = {}) =>
    renderToStaticMarkup(<ReposForm repos={repos} onChange={noop} issues={validateRepos(repos)} onSave={noop} dirty {...o} />);
  it('shows the client explanation and protected chips', () => {
    const html = form([R({ client: true, protected: ['staging'] })]);
    expect(html).toContain('Stays on your PC and is never synced');
    expect(html).toContain('staging');
    expect(html).toContain('aria-label="Remove branch staging"');
  });
  it('shows validation under the field once attempted, and the hub message', () => {
    const empty = R({ name: '', remote: '' });
    expect(form([empty])).not.toContain('Give the repo a name.');
    const html = form([empty], { attempted: true, serverError: 'repos.0.remote: Invalid' });
    expect(html).toContain('Give the repo a name.');
    expect(html).toContain('Add the remote URL');
    expect(html).toContain('repos.0.remote: Invalid');
    expect(html).toContain('aria-invalid="true"');
  });
  it('warns about a duplicate remote without blocking save', () => {
    const html = form([R(), R({ name: 'app2', remote: 'https://github.com/o/app' })]);
    expect(html).toContain('Same remote as app.');
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});
