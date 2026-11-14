import { describe, expect, it } from 'vitest';
import { ASK_EVERY_TIME_TOOLS, SIGN_IN_TOOLS, type ApprovalPayload, type ControlStatus, type Message, type Skill } from '@pocketrocket/shared';
import { fmtAge, selectInbox, titleWithCount } from './inbox';
import { cardWords } from './approvalWords';

const approval = (id: string, roomId: string, createdAt: number, p: Partial<ApprovalPayload> = {}): Message => ({
  id: 'm-' + id, roomId, seq: 1, authorType: 'bot', authorId: 'b1', kind: 'approval', text: '', causeId: null, hop: 0, turnId: null, createdAt,
  payload: { approvalId: id, toolName: 'Bash', toolInput: {}, reason: 'run a script', danger: false, status: 'pending', ...p },
});
const takeover = (botId: string, roomId: string, messageId: string, since = 5): ControlStatus =>
  ({ botId, control: 'agent', holder: null, since, takeover: { messageId, roomId, reason: 'log in', parked: false } });
const skill = (id: string, over: Partial<Skill> = {}): Skill =>
  ({ id, name: id, description: '', path: '', source: 'user', reviewStatus: 'approved', createdByBot: null, ...over }) as Skill;

const base = { openApprovals: [], messages: {}, control: {}, skills: null };

describe('selectInbox', () => {
  it('is empty when nothing waits', () => {
    expect(selectInbox(base)).toEqual([]);
  });

  it('lists an approval known only from hello, with no age or inline answer', () => {
    const [it] = selectInbox({ ...base, openApprovals: [{ approvalId: 'a1', botId: 'b1', roomId: 'r1' }] });
    expect(it).toMatchObject({ kind: 'approval', roomId: 'r1', botId: 'b1', since: null, canDeny: false, title: 'Needs your approval' });
  });

  it('adds detail and age from a loaded card, and lists it once', () => {
    const items = selectInbox({ ...base, openApprovals: [{ approvalId: 'a1', botId: 'b1', roomId: 'r1' }], messages: { r1: [approval('a1', 'r1', 100)] } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ since: 100, canDeny: true, detail: 'run a script', approval: { toolName: 'Bash' } });
    expect(items[0].title).not.toContain('Bash');
  });

  it('finds a pending card the hello list missed, and ignores answered ones', () => {
    const items = selectInbox({ ...base, messages: { r1: [approval('a1', 'r1', 1), approval('a2', 'r1', 2, { status: 'allow' })] } });
    expect(items.map((i) => i.key)).toEqual(['approval:a1']);
  });

  it('never exposes an inline allow on any row', () => {
    const items = selectInbox({ ...base, messages: { r1: [approval('a1', 'r1', 1)] } });
    for (const i of items) expect(Object.keys(i)).not.toContain('inline');
    expect(items[0].canDeny).toBe(true);
  });

  it('shows Open only (no inline Deny) for danger, once, sign-in, ask-every-time and proposal cards', () => {
    const ask = [...ASK_EVERY_TIME_TOOLS][0];
    const signIn = [...SIGN_IN_TOOLS][0];
    const cards = [
      approval('danger', 'r1', 1, { danger: true }),
      approval('once', 'r1', 2, { once: true }),
      approval('signin', 'r1', 3, { signInRequired: true }),
      approval('ask', 'r1', 4, { toolName: ask }),
      approval('pc', 'r1', 5, { toolName: signIn }),
      approval('handoff', 'r1', 6, { toolName: 'handoff', toolInput: { task: 'do it' } }),
      approval('route', 'r1', 7, { toolName: 'propose_routing_change', toolInput: { line: 'x' } }),
    ];
    const items = selectInbox({ ...base, messages: { r1: cards } });
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.canDeny)).toEqual(Array(7).fill(false));
  });

  it('allows an inline Deny for an ordinary gated call only', () => {
    const items = selectInbox({ ...base, messages: { r1: [approval('a1', 'r1', 1, { toolName: 'Write' })] } });
    expect(items[0].canDeny).toBe(true);
    expect(items[0].approval).toEqual({ toolName: 'Write', toolInput: {} });
  });

  it('words a hand-off or routing card like the approval card does', () => {
    expect(cardWords({ toolName: 'handoff', toolInput: { task: 'ship it', context: 'c' } })).toEqual({ main: 'ship it', more: 'c' });
    expect(cardWords({ toolName: 'propose_routing_change', toolInput: { line: 'L' } })).toEqual({ main: 'L', more: undefined });
    expect(cardWords({ toolName: 'Bash', toolInput: { command: 'ls' } })).toBeNull();
  });

  it('lists takeovers, using the card time when loaded and the control time otherwise', () => {
    const card: Message = { ...approval('x', 'r2', 50), id: 'tm1', kind: 'takeover', payload: null };
    const items = selectInbox({ ...base, control: { b1: takeover('b1', 'r2', 'tm1'), b2: takeover('b2', 'r3', 'tm2', 9) }, messages: { r2: [card] } });
    expect(items.map((i) => [i.key, i.since])).toEqual([['takeover:tm2', 9], ['takeover:tm1', 50]]);
  });

  it('lists skills pending review and skills with pending versions, but not approved ones', () => {
    const items = selectInbox({ ...base, skills: [skill('s1', { reviewStatus: 'pending' }), skill('s2', { pendingVersions: 2 }), skill('s3')] });
    expect(items.map((i) => [i.key, i.title])).toEqual([['skill:s1', 'New skill to review'], ['skill:s2', '2 skill changes to review']]);
  });

  it('orders the longest wait first, unknown ages last', () => {
    const items = selectInbox({
      ...base,
      openApprovals: [{ approvalId: 'old', botId: 'b1', roomId: 'r1' }, { approvalId: 'unknown', botId: 'b1', roomId: 'r9' }],
      messages: { r1: [approval('old', 'r1', 10)], r2: [approval('new', 'r2', 99)] },
    });
    expect(items.map((i) => i.key)).toEqual(['approval:old', 'approval:new', 'approval:unknown']);
  });
});

describe('fmtAge / titleWithCount', () => {
  it('formats waits', () => {
    expect(fmtAge(null, 1000)).toBeNull();
    expect(fmtAge(0, 30_000)).toBe('just now');
    expect(fmtAge(0, 5 * 60_000)).toBe('5m');
    expect(fmtAge(0, 3 * 3_600_000)).toBe('3h');
    expect(fmtAge(0, 2 * 86_400_000)).toBe('2d');
  });
  it('puts the count in front of the title once', () => {
    expect(titleWithCount('PocketRocket', 2)).toBe('(2) PocketRocket');
    expect(titleWithCount('(2) PocketRocket', 3)).toBe('(3) PocketRocket');
    expect(titleWithCount('(3) PocketRocket', 0)).toBe('PocketRocket');
  });
});
