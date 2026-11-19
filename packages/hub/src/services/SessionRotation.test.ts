import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos, type SessionState } from '../db/repos.js';
import { EMPTY_USAGE } from '../providers/types.js';
import { buildSeed, buildSummaryPrompt, cleanSummary, contextUsage, readRoomNotes, rotationReason, ROOM_NOTES_CHARS } from './SessionRotation.js';

const state = (s: Partial<SessionState>): SessionState => ({
  costTotal: null, contextTokens: null, contextAt: null, contextWindow: null, memorySnapshot: null, identitySnapshot: null, summary: null, ...s,
});
const limits = { contextTokens: 120_000, idleMs: 30 * 60_000, idleMinTokens: 40_000 };
const NOW = 10_000_000;

describe('rotationReason', () => {
  it('rotates an unmeasured (legacy) session, a large one, and a large one gone cold', () => {
    expect(rotationReason(state({}), NOW, limits)).toBe('unknown');
    expect(rotationReason(state({ contextTokens: 200_000, contextAt: NOW }), NOW, limits)).toBe('size');
    expect(rotationReason(state({ contextTokens: 50_000, contextAt: NOW - limits.idleMs - 1 }), NOW, limits)).toBe('idle');
  });

  it('resumes a small session, warm or cold, and everything when switched off', () => {
    expect(rotationReason(state({ contextTokens: 50_000, contextAt: NOW - 1000 }), NOW, limits)).toBeNull();
    expect(rotationReason(state({ contextTokens: 30_000, contextAt: NOW - limits.idleMs - 1 }), NOW, limits)).toBeNull();
    expect(rotationReason(state({}), NOW, { ...limits, contextTokens: 0 })).toBeNull();
  });
});

describe('contextUsage (P4-2 meter)', () => {
  it('reports size, window and rotation point, and nothing before a measured call', () => {
    expect(contextUsage(state({ contextTokens: 84_000, contextWindow: 1_000_000 }), 120_000)).toEqual({ contextTokens: 84_000, window: 1_000_000, rotateAt: 120_000 });
    // No reported window: Claude's standard one.
    expect(contextUsage(state({ contextTokens: 84_000 }), 120_000)).toEqual({ contextTokens: 84_000, window: 200_000, rotateAt: 120_000 });
    expect(contextUsage(state({ contextTokens: 84_000 }), 0)?.rotateAt).toBeNull();
    expect(contextUsage(state({}), 120_000)).toBeUndefined();
    expect(contextUsage(state({ contextTokens: 0 }), 120_000)).toBeUndefined();
  });

  it('round-trips the window through the sessions row', () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'A', handle: 'a', title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'A', memberIds: [bot.id], coordinatorBotId: null });
    repos.saveSessionState(bot.id, room.id, { contextTokens: 5_000, contextWindow: 400_000 });
    expect(repos.getSessionState(bot.id, room.id)).toMatchObject({ contextTokens: 5_000, contextWindow: 400_000 });
    // A fresh session resets the size, not the window.
    repos.saveSessionState(bot.id, room.id, { contextTokens: 0 });
    expect(repos.getSessionState(bot.id, room.id).contextWindow).toBe(400_000);
  });
});

describe('the seed', () => {
  function room(n: number) {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'S', handle: 'seedy', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const r = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    for (let i = 1; i <= n; i++) repos.insertMessage({ roomId: r.id, authorType: 'user', authorId: null, kind: 'text', text: 'msg ' + i, payload: null, causeId: null, hop: 0, turnId: null });
    repos.insertMessage({ roomId: r.id, authorType: 'system', authorId: null, kind: 'system', text: 'a system note', payload: null, causeId: null, hop: 0, turnId: null });
    return { repos, bot, roomId: r.id };
  }

  it('replays only seen conversation messages, newest last, under the marker', () => {
    const { repos, roomId } = room(10);
    const seed = buildSeed(repos, roomId, 8, { maxMessages: 3, summary: '- fact', roomNotes: 'status: green' });
    expect(seed).toContain('Earlier context (session was reset to save tokens)');
    expect(seed).toContain('- fact');
    expect(seed).toContain('status: green');
    expect(seed).toMatch(/msg 6[\s\S]*msg 7[\s\S]*msg 8/);
    expect(seed).not.toContain('msg 5');
    expect(seed).not.toContain('msg 9'); // unseen: it arrives in the turn's own input
    expect(seed).not.toContain('a system note');
  });

  it('is empty when there is nothing to carry over', () => {
    const { repos, roomId } = room(0);
    expect(buildSeed(repos, roomId, 0)).toBe('');
  });

  it('asks for a summary only when there are messages older than the replayed window', () => {
    const { repos, bot, roomId } = room(5);
    expect(buildSummaryPrompt(repos, bot, roomId, 5, null, 20)).toBeNull();
    const p = buildSummaryPrompt(repos, bot, roomId, 5, 'old </previous_summary> trick', 2)!;
    expect(p).toContain('msg 3');
    expect(p).not.toContain('msg 4');
    expect(p).toContain('<\\/previous_summary> trick');
  });

  it('cleans the summary: failed or empty is null, secrets are scrubbed, length is capped', () => {
    expect(cleanSummary({ ok: false, text: 'x', usage: EMPTY_USAGE })).toBeNull();
    expect(cleanSummary({ ok: true, text: '   ', usage: EMPTY_USAGE })).toBeNull();
    expect(cleanSummary({ ok: true, text: 'y'.repeat(5000), usage: EMPTY_USAGE })!.length).toBe(2000);
  });

  it("reads the room's current.md, cut short", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-seed-'));
    try {
      expect(readRoomNotes(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, 'current.md'), 'z'.repeat(ROOM_NOTES_CHARS + 100));
      expect(readRoomNotes(dir)!).toContain('current.md continues');
      expect(readRoomNotes(null)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
