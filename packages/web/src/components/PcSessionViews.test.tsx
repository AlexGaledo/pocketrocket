import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupSessions, type PcSeqEntry, type PcSessionSummary } from '../lib/pcSessions';

// Markdown reaches for the store, which reads window at import time.
let MirrorEmptyState: typeof import('./PcSessionViews').MirrorEmptyState;
let SessionGroups: typeof import('./PcSessionViews').SessionGroups;
let TranscriptEntries: typeof import('./PcSessionViews').TranscriptEntries;
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  ({ MirrorEmptyState, SessionGroups, TranscriptEntries } = await import('./PcSessionViews'));
});

const e = (seq: number, o: Partial<PcSeqEntry>): PcSeqEntry => ({ seq, uuid: 'u' + seq, at: 0, kind: 'user', text: '', ...o });
const S = (id: string, o: Partial<PcSessionSummary> = {}): PcSessionSummary => ({
  id, parentId: null, machine: 'pc', projectDir: 'C--proj', cwd: 'C:/proj', repo: null, title: null, firstAt: 0, lastAt: 1, entryCount: 3, bytes: 1, truncated: false, status: 'ended', links: [], ...o,
});

describe('TranscriptEntries', () => {
  const entries = [
    e(1, { kind: 'user', text: 'run the tests' }),
    e(2, { kind: 'tool_use', tool: 'Bash', text: 'npm test' }),
    e(3, { kind: 'tool_result', tool: 'Bash', text: 'boom', isError: true }),
    e(4, { kind: 'summary', text: 'we fixed it' }),
  ];
  it('collapses tool rows by default and tints errors', () => {
    const html = renderToStaticMarkup(<TranscriptEntries entries={entries} />);
    expect(html).toContain('Bash · npm test');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('text-bad');
    expect(html).toContain('Conversation summary');
  });
  it('shows the truncation notice only when asked', () => {
    expect(renderToStaticMarkup(<TranscriptEntries entries={entries} truncated />)).toContain('This session was cut short');
    expect(renderToStaticMarkup(<TranscriptEntries entries={entries} />)).not.toContain('cut short');
  });
});

describe('list rendering', () => {
  it('shows a live dot, untitled fallback and a collapsed subagent group', () => {
    const groups = groupSessions([S('p', { status: 'live' }), S('p:1', { parentId: 'p', title: 'Explore' })]);
    const html = renderToStaticMarkup(<SessionGroups groups={groups} onOpen={() => undefined} now={1000} />);
    expect(html).toContain('Untitled session');
    expect(html).toContain('Running');
    expect(html).toContain('Idle · ');
    expect(html).toContain('1 subagent session');
    expect(html).toContain('aria-expanded="false"');
  });
  it('repo groups are open buttons with a count, and remember being folded', async () => {
    const { setJson, resetPersistMemory } = await import('../lib/persist');
    resetPersistMemory();
    const groups = groupSessions([S('a', { repo: { name: 'one', remote: null, branch: 'main', head: null } }), S('b', { repo: { name: 'two', remote: null, branch: 'main', head: null } })]);
    let html = renderToStaticMarkup(<SessionGroups groups={groups} onOpen={() => undefined} now={1000} />);
    expect(html).toContain('Collapse all');
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(2);
    setJson('pc-sessions.collapsed-groups', [groups[0].key]);
    html = renderToStaticMarkup(<SessionGroups groups={groups} onOpen={() => undefined} now={1000} />);
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(1);
    expect(html).toContain('hidden=""');
    resetPersistMemory();
  });
  it('explains how to turn the mirror on when empty', () => {
    const html = renderToStaticMarkup(<MirrorEmptyState filtered={false} />);
    expect(html).toContain('Mirror your Claude Code sessions');
    expect(renderToStaticMarkup(<MirrorEmptyState filtered />)).toContain('No sessions match');
  });
});
