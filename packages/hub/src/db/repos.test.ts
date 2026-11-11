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
