import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyRepo, type ProjectRepo } from '../lib/projectRepos';
import type { PcJobWithMove, PcSessionMove } from '../lib/pcMove';
import type { PcSessionSummary } from '../lib/pcSessions';

let MoveRows: typeof import('./PcMovePanel').MoveRows;
let VpsComposer: typeof import('./PcMovePanel').VpsComposer;
let MoveSummary: typeof import('./PcMovePanel').MoveSummary;
let MoveBadge: typeof import('./PcMovePanel').MoveBadge;
let SessionGroups: typeof import('./PcSessionViews').SessionGroups;
let groupSessions: typeof import('../lib/pcSessions').groupSessions;
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  ({ MoveRows, VpsComposer, MoveSummary, MoveBadge } = await import('./PcMovePanel'));
  ({ SessionGroups } = await import('./PcSessionViews'));
  ({ groupSessions } = await import('../lib/pcSessions'));
}, 60000);

const noop = () => undefined;
const R = (o: Partial<ProjectRepo> = {}): ProjectRepo => ({ ...emptyRepo(), name: 'app', remote: 'git@github.com:o/app.git', sync: 'bundle', ...o });
const link = { project: 'wika', repo: 'app' };
const rows = (o: Partial<Parameters<typeof MoveRows>[0]> = {}) =>
  renderToStaticMarkup(<MoveRows links={[link]} repos={{ wika: [R()] }} pcBlocked={null} rooms={[]} room="" onRoom={noop} onMove={noop} {...o} />);

describe('MoveRows', () => {
  it('enables the button when every repo can move', () => {
    const html = rows();
    expect(html).toContain('Move to VPS');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('wika / app');
  });
  it.each([
    ['PC offline', { pcBlocked: 'Your PC is offline.' }, 'Your PC is offline.'],
    ['not signed in', { pcBlocked: 'Sign in with your password to run things' }, 'Sign in with your password'],
    ['no linked repo', { links: [], repos: {} }, 'not linked to a project repo'],
    ['client repo', { repos: { wika: [R({ client: true })] } }, 'Client repo'],
    ['not bundle mode', { repos: { wika: [R({ sync: 'wip-branch' })] } }, 'bundle sync'],
  ])('disables with the reason: %s', (_n, o, text) => {
    const html = rows(o);
    expect(html).toContain('disabled=""');
    expect(html).toContain(text);
    expect(html).toContain('aria-describedby');
  });
  it('shows a room picker only for several rooms', () => {
    expect(rows()).not.toContain('<select');
    const html = rows({ rooms: [{ id: 'a', name: 'Wika' }, { id: 'b', name: 'Wika side' }], room: 'b' });
    expect(html).toContain('<select');
    expect(html).toContain('Wika side');
  });
});

const M = (o: Partial<PcSessionMove> = {}): PcSessionMove => ({ state: 'on-vps', room: 'r1', project: 'wika', repos: ['app'], movedAt: 1, turnRunning: false, ...o });
const composer = (move: PcSessionMove, o: Partial<Parameters<typeof VpsComposer>[0]> = {}) =>
  renderToStaticMarkup(<VpsComposer move={move} signedIn pcBlocked={null} prompt="next" onPrompt={noop} onSend={noop} onPull={noop} {...o} />);

describe('VpsComposer', () => {
  it('is ready when idle', () => {
    const html = composer(M());
    expect(html).toContain('Continue on VPS');
    expect(html).toContain('Pull back');
    expect(html).not.toContain('disabled=""');
  });
  it('locks the box and Pull back while a turn runs and says so', () => {
    const html = composer(M({ turnRunning: true }));
    expect(html).toContain('A turn is running on the VPS');
    expect(html).toContain('One at a time');
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it('shows pending states and a send error', () => {
    expect(composer(M({ state: 'pulling' }))).toContain('pull this session back');
    expect(composer(M({ state: 'moving' }))).toContain('finish moving');
    expect(composer(M(), { error: 'Session is already running a turn.' })).toContain('already running a turn');
  });
  it('needs a password session', () => expect(composer(M(), { signedIn: false })).toContain('Sign in with your password'));
});

describe('badges in list and header', () => {
  it('renders the state badge', () => {
    expect(renderToStaticMarkup(<MoveBadge s={{ move: M() }} />)).toContain('On VPS');
    expect(renderToStaticMarkup(<MoveBadge s={{}} />)).toBe('');
  });
  it('shows On VPS on a list row', () => {
    const s = { id: 's', parentId: null, machine: 'pc', projectDir: 'p', cwd: null, repo: null, title: 'Fix bug', firstAt: 0, lastAt: 1, entryCount: 1, bytes: 1, truncated: false, status: 'ended', links: [], move: M() } as PcSessionSummary;
    expect(renderToStaticMarkup(<SessionGroups groups={groupSessions([s])} onOpen={noop} now={1000} />)).toContain('On VPS');
  });
});

describe('MoveSummary', () => {
  const job = (o: object) => ({ mode: 'move', move: { room: null, repos: [{ project: 'wika', repo: 'app' }] }, ...o }) as unknown as PcJobWithMove;
  it('lists the requested repo before a result', () => expect(renderToStaticMarkup(<MoveSummary j={job({})} />)).toContain('wika / app'));
  it('shows commits and session size for a move', () => {
    const html = renderToStaticMarkup(<MoveSummary j={job({ moveResult: { repos: [{ repo: 'app', commit: '0123456789abcdef', branch: 'wip/pc/abcd1234' }], sessionBytes: 2097152 } })} />);
    expect(html).toContain('01234567');
    expect(html).toContain('wip/pc/abcd1234');
    expect(html).toContain('2.0 MB');
    expect(html).not.toContain('Not applied');
  });
  it('says applied or not applied for a pull', () => {
    const html = renderToStaticMarkup(<MoveSummary j={job({ mode: 'pull', pullResult: { repos: [{ repo: 'app', commit: 'aaaaaaaa11', applied: true }, { repo: 'api', commit: 'bbbbbbbb22', applied: false }], sessionBytes: 10 } })} />);
    expect(html).toContain('Applied');
    expect(html).toContain('Not applied');
    expect(html).toContain('merge the wip branch yourself');
  });
});
