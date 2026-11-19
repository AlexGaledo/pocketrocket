import { describe, it, expect } from 'vitest';
import { Db } from './db.js';
import { Repos } from './repos.js';

function fresh() {
  return new Repos(new Db(':memory:'));
}

describe('Repos', () => {
  it('assigns per-room sequence numbers and lists in order', () => {
    const r = fresh();
    const bot = r.createBot({ name: 'A', handle: 'a', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = r.createRoom({ kind: 'dm', name: 'A', memberIds: [bot.id], coordinatorBotId: null });
    const other = r.createRoom({ kind: 'dm', name: 'B', memberIds: [bot.id], coordinatorBotId: null });
    const m1 = r.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'one', payload: null, causeId: null, hop: 0, turnId: null });
    const m2 = r.insertMessage({ roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'text', text: 'two', payload: null, causeId: null, hop: 0, turnId: null });
    const o1 = r.insertMessage({ roomId: other.id, authorType: 'user', authorId: null, kind: 'text', text: 'x', payload: null, causeId: null, hop: 0, turnId: null });
    expect([m1.seq, m2.seq, o1.seq]).toEqual([1, 2, 1]);
    expect(r.messagesAfter(room.id, 1).map((m) => m.text)).toEqual(['two']);
    expect(r.listMessages(room.id, { limit: 1 }).map((m) => m.text)).toEqual(['two']);
  });

  it('round-trips sessions and usage totals', () => {
    const r = fresh();
    const bot = r.createBot({ name: 'A', handle: 'a', title: '', description: '', avatar: '', model: 'm', allowedTools: ['Read'], maxBudgetUsd: 1 });
    const room = r.createRoom({ kind: 'dm', name: 'A', memberIds: [bot.id], coordinatorBotId: null });
    expect(r.getSession(bot.id, room.id)).toEqual({ sdkSessionId: null, lastSeenSeq: 0, provider: null });
    r.saveSession(bot.id, room.id, { sdkSessionId: 'sess-1' });
    r.saveSession(bot.id, room.id, { lastSeenSeq: 7 });
    expect(r.getSession(bot.id, room.id)).toEqual({ sdkSessionId: 'sess-1', lastSeenSeq: 7, provider: null });
    r.recordUsage({ botId: bot.id, roomId: room.id, turnId: 't1', causeId: 'c1', costUsd: 0.5, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, modelUsage: null, durationMs: 10 });
    r.recordUsage({ botId: bot.id, roomId: room.id, turnId: 't2', causeId: 'c1', costUsd: 0.25, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, modelUsage: null, durationMs: 10 });
    expect(r.usageTotals({ causeId: 'c1' }).costUsd).toBeCloseTo(0.75);
    expect(r.usageTotals({ botId: bot.id }).turns).toBe(2);
    expect(r.usageTotals({ botId: bot.id, sinceMs: Date.now() + 1000 }).turns).toBe(0);
    expect(r.getBot(bot.id)?.allowedTools).toEqual(['Read']);
  });

  it('deletes rooms with their messages', () => {
    const r = fresh();
    const bot = r.createBot({ name: 'A', handle: 'a', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = r.createRoom({ kind: 'group', name: 'g', memberIds: [bot.id], coordinatorBotId: bot.id });
    r.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'hi', payload: null, causeId: null, hop: 0, turnId: null });
    r.deleteRoom(room.id);
    expect(r.getRoom(room.id)).toBeUndefined();
    expect(r.listMessages(room.id)).toEqual([]);
  });

  it('expires approval cards left pending by a previous hub process', () => {
    const r = fresh();
    const bot = r.createBot({ name: 'A', handle: 'a', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = r.createRoom({ kind: 'dm', name: 'A', memberIds: [bot.id], coordinatorBotId: null });
    const card = (approvalId: string, status: 'pending' | 'allow') => {
      r.createApproval({ id: approvalId, botId: bot.id, roomId: room.id, turnId: 't', toolName: 'Bash', toolInput: { command: 'ls' }, reason: 'r' });
      if (status !== 'pending') r.decideApproval(approvalId, status);
      return r.insertMessage({ roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'approval', text: '', causeId: null, hop: 0, turnId: 't',
        payload: { approvalId, toolName: 'Bash', toolInput: { command: 'ls' }, reason: 'r', danger: false, status } });
    };
    const open = card('ap1', 'pending');
    const done = card('ap2', 'allow');

    const changed = r.expirePendingApprovals();
    expect(changed.map((m) => m.id)).toEqual([open.id]);
    expect((r.getMessage(open.id)!.payload as { status: string }).status).toBe('expired');
    expect((r.getMessage(done.id)!.payload as { status: string }).status).toBe('allow');
    expect(r.db.all('SELECT id, status FROM approvals ORDER BY id')).toEqual([{ id: 'ap1', status: 'expired' }, { id: 'ap2', status: 'allow' }]);
    expect(r.expirePendingApprovals()).toEqual([]);
  });
});

describe('session state (migration 170)', () => {
  it('reads a legacy row as all-unknown and writes only the fields given', () => {
    const r = new Repos(new Db(':memory:'));
    const bot = r.createBot({ name: 'L', handle: 'legacy', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = r.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    // A row written the old way: no cost_total, no context size.
    r.saveSession(bot.id, room.id, { sdkSessionId: 'old', lastSeenSeq: 3, provider: 'claude' });
    expect(r.getSessionState(bot.id, room.id)).toEqual({ costTotal: null, contextTokens: null, contextAt: null, memorySnapshot: null, identitySnapshot: null, summary: null });
    r.saveSessionState(bot.id, room.id, { contextTokens: 5000, costTotal: 1.5 });
    r.saveSessionState(bot.id, room.id, { summary: '- s' });
    expect(r.getSessionState(bot.id, room.id)).toMatchObject({ contextTokens: 5000, costTotal: 1.5, summary: '- s' });
    // saveSession keeps them, and the old shape of getSession is unchanged.
    r.saveSession(bot.id, room.id, { lastSeenSeq: 9 });
    expect(r.getSessionState(bot.id, room.id).costTotal).toBe(1.5);
    expect(r.getSession(bot.id, room.id)).toEqual({ sdkSessionId: 'old', lastSeenSeq: 9, provider: 'claude' });
    // A row that does not exist yet is created.
    const other = r.createRoom({ kind: 'dm', name: 'DM2', memberIds: [bot.id], coordinatorBotId: null });
    r.saveSessionState(bot.id, other.id, { memorySnapshot: 'm' });
    expect(r.getSessionState(bot.id, other.id).memorySnapshot).toBe('m');
    expect(r.getSession(bot.id, other.id).lastSeenSeq).toBe(0);
  });
});

describe('M6: provider per bot', () => {
  const base = { name: 'A', handle: 'a', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 };

  it('round-trips provider and backup, and defaults both to null', () => {
    const r = fresh();
    const plain = r.createBot(base);
    expect(plain).toMatchObject({ provider: null, backup: null });
    expect(r.getBot(plain.id)).toMatchObject({ provider: null, backup: null });

    const own = r.createBot({ ...base, handle: 'b', provider: 'codex', backup: { provider: 'claude', model: 'claude-sonnet-5' } });
    expect(r.getBot(own.id)).toMatchObject({ provider: 'codex', backup: { provider: 'claude', model: 'claude-sonnet-5' } });

    r.updateBot(own.id, { provider: null, backup: null });
    expect(r.getBot(own.id)).toMatchObject({ provider: null, backup: null });
    // A patch that leaves them out keeps them.
    r.updateBot(plain.id, { provider: 'grok', backup: { provider: 'claude', model: 'auto' } });
    r.updateBot(plain.id, { name: 'Renamed' });
    expect(r.getBot(plain.id)).toMatchObject({ name: 'Renamed', provider: 'grok', backup: { provider: 'claude', model: 'auto' } });
  });

  it('reads an unknown stored provider or a broken backup as null', () => {
    const r = fresh();
    const b = r.createBot(base);
    r.db.run("UPDATE bots SET provider='nope', backup='{not json' WHERE id=?", b.id);
    expect(r.getBot(b.id)).toMatchObject({ provider: null, backup: null });
  });

  it('records the provider on usage rows and groups by it', () => {
    const r = fresh();
    const bot = r.createBot(base);
    const room = r.createRoom({ kind: 'dm', name: 'A', memberIds: [bot.id], coordinatorBotId: null });
    const u = { botId: bot.id, roomId: room.id, turnId: 't', causeId: null, costUsd: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: null, durationMs: 1 };
    r.recordUsage({ ...u, provider: 'claude' });
    r.recordUsage({ ...u, provider: 'codex', costUsd: 2 });
    r.recordUsage({ ...u, costUsd: 0.5 });
    expect(r.usageBy('provider').map((g) => [g.key, g.costUsd])).toEqual([['codex', 2], ['claude', 1], ['', 0.5]]);
  });
});
