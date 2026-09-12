import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '@pocketrocket/shared';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (args: unknown) => sdk.query(args) }));

import { botHome } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from './MemoryService.js';
import { UsageTracker } from './UsageTracker.js';
import {
  AUTO_MEMORY_MODEL, AutoMemory, MAX_NOTES, MAX_NOTE_CHARS, MAX_TRANSCRIPT_CHARS, PASS_BUDGET_USD,
  appendNotes, buildTranscript, cleanNotes, parseNotes, runPass, type PassOutcome,
} from './AutoMemory.js';

/**
 * Auto-memory: a cheap background pass that appends lasting facts to memory.md every N turns. Covers the reply
 * parsing and note hygiene, the per-(bot, room) trigger, and that the SDK call is pinned to the cheap options.
 */

const usage0 = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: null, durationMs: 1 };
const reply = (text: string, costUsd = 0.004): PassOutcome => ({ ok: true, text, usage: { ...usage0, costUsd, inputTokens: 900, outputTokens: 40 } });

describe('parseNotes', () => {
  it('reads strict JSON', () => {
    expect(parseNotes('{"notes":["Alex prefers tabs"]}')).toEqual(['Alex prefers tabs']);
  });
  it('tolerates code fences, prose and stray braces around the object', () => {
    expect(parseNotes('```json\n{"notes": ["a", "b"]}\n```')).toEqual(['a', 'b']);
    expect(parseNotes('Sure {here} you go: {"notes": ["a"]} done')).toEqual(['a']);
  });
  it('drops non-string entries', () => {
    expect(parseNotes('{"notes": ["a", 3, null, {"x": 1}]}')).toEqual(['a']);
  });
  it('returns null for junk, so nothing is saved', () => {
    expect(parseNotes('I could not find anything.')).toBeNull();
    expect(parseNotes('{"notes": "a"}')).toBeNull();
    expect(parseNotes('{"notes": [')).toBeNull();
    expect(parseNotes('')).toBeNull();
  });
});

describe('cleanNotes', () => {
  it('makes notes single-line and strips bullet and heading markers', () => {
    expect(cleanNotes(['- Alex\nprefers   tabs', '## Deploys go out Fridays'], '')).toEqual(['Alex prefers tabs', 'Deploys go out Fridays']);
  });
  it('drops notes already in memory (normalized) and repeats within the batch', () => {
    const memory = '# Notes\n- Alex prefers tabs.\n';
    expect(cleanNotes(['alex PREFERS tabs', 'Project codename is Falcon', 'project codename is falcon!'], memory)).toEqual(['Project codename is Falcon']);
  });
  it('caps the count and the length of each note', () => {
    const out = cleanNotes(Array.from({ length: 20 }, (_, i) => 'fact ' + i + ' ' + 'x'.repeat(500)), '');
    expect(out).toHaveLength(MAX_NOTES);
    for (const n of out) expect(n.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
  });
  it('drops secret-shaped notes whole', () => {
    expect(cleanNotes(['API key is sk-ant-abcdefghijklmnopqrstuvwxyz', 'Uses the staging cluster'], '')).toEqual(['Uses the staging cluster']);
  });
});

describe('appendNotes', () => {
  it('adds a dated group', () => {
    expect(appendNotes('# Memory\n- old\n', ['a', 'b'], '2026-09-13')).toBe('# Memory\n- old\n\n## Auto-saved 2026-09-13\n- a\n- b\n');
    expect(appendNotes('', ['a'], '2026-09-13')).toBe('## Auto-saved 2026-09-13\n- a\n');
  });
  it("reuses today's group when it is the tail, and starts a new one otherwise", () => {
    const today = '## Auto-saved 2026-09-13\n- a\n';
    expect(appendNotes(today, ['b'], '2026-09-13')).toBe('## Auto-saved 2026-09-13\n- a\n- b\n');
    expect(appendNotes(today + 'free text the bot wrote\n', ['b'], '2026-09-13')).toContain('free text the bot wrote\n\n## Auto-saved 2026-09-13\n- b\n');
  });
});

// ---------- trigger ----------
const made: string[] = [];
afterEach(() => {
  for (const id of made.splice(0)) fs.rmSync(botHome(id), { recursive: true, force: true });
  sdk.query.mockReset();
});

function setup(opts: { provider?: ProviderId; every?: number; run?: (prompt: string) => Promise<PassOutcome> } = {}) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'You research.', avatar: '🔎', model: 'm', allowedTools: [], maxBudgetUsd: 2, autoMemoryEvery: opts.every ?? 3 });
  made.push(bot.id);
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const memory = new MemoryService();
  const prompts: string[] = [];
  const run = opts.run ?? (async () => reply('{"notes":["Alex prefers short answers","Launch is on Friday"]}'));
  const auto = new AutoMemory({
    repos, memory, usage: new UsageTracker(repos),
    activeProvider: () => opts.provider ?? 'claude', exeExists: () => true,
    run: async (p) => { prompts.push(p); return run(p); },
  });
  const say = (text: string, authorType: 'user' | 'bot' = 'user') =>
    repos.insertMessage({ roomId: room.id, authorType, authorId: authorType === 'bot' ? bot.id : null, kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null });
  const turn = (result = { ok: true }) => { say('hello'); say('hi', 'bot'); return auto.afterTurn(bot.id, room.id, result); };
  return { repos, bot, room, memory, auto, prompts, say, turn };
}

describe('AutoMemory trigger', () => {
  it('runs a pass on every Nth successful turn, appends the notes, posts a note and records usage', async () => {
    const s = setup({ every: 3 });
    expect(s.turn()).toBeUndefined();
    expect(s.turn()).toBeUndefined();
    await s.turn();
    expect(s.prompts).toHaveLength(1);
    expect(s.memory.read(s.bot.id)).toMatch(/## Auto-saved \d{4}-\d{2}-\d{2}\n- Alex prefers short answers\n- Launch is on Friday\n/);
    const notes = s.repos.listMessages(s.room.id).filter((m) => m.kind === 'system');
    expect(notes.map((m) => m.text)).toEqual(['Scout saved 2 notes to memory.']);
    expect(s.repos.usageTotals({ botId: s.bot.id }).costUsd).toBeCloseTo(0.004);
    expect(s.repos.getAutoMemory(s.bot.id, s.room.id)).toMatchObject({ turnsSince: 0, retryAt: 0 });
    expect(s.repos.getAutoMemory(s.bot.id, s.room.id).lastSeq).toBe(6);

    // The next pass only sees what came after, and a repeat of an existing note saves nothing and posts nothing.
    s.turn(); s.turn(); await s.turn();
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).not.toContain('#1 ');
    expect(s.prompts[1]).toContain('#8 ');
    expect(s.repos.listMessages(s.room.id).filter((m) => m.kind === 'system')).toHaveLength(1);
  });

  it('wraps the transcript and memory as data', async () => {
    const s = setup({ every: 3 });
    s.memory.write(s.bot.id, '- Alex prefers short answers\n');
    s.turn(); s.turn(); await s.turn();
    expect(s.prompts[0]).toContain('<transcript>\n#1 [');
    expect(s.prompts[0]).toContain('<current_memory>\n- Alex prefers short answers');
    // The existing note is not saved twice.
    expect(s.memory.read(s.bot.id).match(/Alex prefers short answers/g)).toHaveLength(1);
  });

  it('does nothing when the bot has auto-memory off', () => {
    const s = setup({ every: 3 });
    s.repos.updateBot(s.bot.id, { autoMemory: false });
    for (let i = 0; i < 5; i++) expect(s.turn()).toBeUndefined();
    expect(s.prompts).toHaveLength(0);
    expect(s.repos.getAutoMemory(s.bot.id, s.room.id).turnsSince).toBe(0);
  });

  it('does nothing when the global provider is not Claude', () => {
    const s = setup({ every: 3, provider: 'codex' });
    for (let i = 0; i < 5; i++) expect(s.turn()).toBeUndefined();
    expect(s.prompts).toHaveLength(0);
  });

  it('counts only successful turns, and the count survives a new service (hub restart)', async () => {
    const s = setup({ every: 3 });
    s.turn(); s.turn({ ok: false } as never); s.turn();
    expect(s.repos.getAutoMemory(s.bot.id, s.room.id).turnsSince).toBe(2);
    const again = new AutoMemory({ repos: s.repos, memory: s.memory, usage: new UsageTracker(s.repos), activeProvider: () => 'claude', exeExists: () => true, run: async () => reply('{"notes":["x y z"]}') });
    s.say('more');
    await again.afterTurn(s.bot.id, s.room.id, { ok: true });
    expect(s.memory.read(s.bot.id)).toContain('- x y z');
  });

  it('skips the model when nothing but system messages arrived, but still completes', async () => {
    const s = setup({ every: 3 });
    for (let i = 0; i < 2; i++) s.auto.afterTurn(s.bot.id, s.room.id, { ok: true });
    s.repos.insertMessage({ roomId: s.room.id, authorType: 'system', authorId: null, kind: 'system', text: 'note', payload: null, causeId: null, hop: 0, turnId: null });
    await s.auto.afterTurn(s.bot.id, s.room.id, { ok: true });
    expect(s.prompts).toHaveLength(0);
    expect(s.repos.getAutoMemory(s.bot.id, s.room.id)).toEqual({ turnsSince: 0, lastSeq: 1, retryAt: 0 });
  });

  it('on an unparseable reply saves nothing, keeps the count and backs off for N/2 turns', async () => {
    let calls = 0;
    const s = setup({ every: 4, run: async () => { calls++; return reply('no json here'); } });
    for (let i = 0; i < 3; i++) s.turn();
    await s.turn();
    expect(calls).toBe(1);
    expect(s.memory.read(s.bot.id)).toBe('');
    expect(s.repos.getAutoMemory(s.bot.id, s.room.id)).toMatchObject({ turnsSince: 4, lastSeq: 0, retryAt: 6 });
    expect(s.turn()).toBeUndefined(); // turn 5: still backing off
    await s.turn(); // turn 6: retries
    expect(calls).toBe(2);
  });

  it('runs one pass at a time per (bot, room)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const s = setup({ every: 3, run: async () => { calls++; await gate; return reply('{"notes":["a b c"]}'); } });
    s.turn(); s.turn();
    const first = s.turn();
    expect(s.turn()).toBeUndefined();
    expect(calls).toBe(1);
    release();
    await first;
  });

  it('drops the result when the bot is deleted mid-pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ every: 3, run: async () => { await gate; return reply('{"notes":["a b c"]}'); } });
    s.turn(); s.turn();
    const pass = s.turn();
    s.repos.deleteBot(s.bot.id);
    release();
    await expect(pass).resolves.toBeUndefined();
    expect(s.memory.read(s.bot.id)).toBe('');
    expect(s.repos.listMessages(s.room.id).filter((m) => m.kind === 'system')).toHaveLength(0);
  });

  it('caps the transcript', () => {
    const s = setup();
    for (let i = 0; i < 100; i++) s.say('m' + i + ' ' + 'x'.repeat(900));
    const t = buildTranscript(s.repos, s.repos.messagesAfter(s.room.id, 0));
    expect(t.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    expect(t).toContain('m99 ');
    expect(t).not.toContain('m60 ');
  });
});

describe('runPass', () => {
  it('calls the SDK with the cheap, tool-less options and returns the result text and cost', async () => {
    sdk.query.mockImplementation(() => (async function* () {
      yield { type: 'result', subtype: 'success', result: '{"notes":[]}', total_cost_usd: 0.003, duration_ms: 5, usage: { input_tokens: 800, output_tokens: 10 } };
    })());
    const out = await runPass('transcript');
    expect(out).toMatchObject({ ok: true, text: '{"notes":[]}', usage: { costUsd: 0.003, inputTokens: 800, outputTokens: 10 } });

    const { prompt, options } = sdk.query.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(prompt).toBe('transcript');
    expect(options).toMatchObject({
      model: AUTO_MEMORY_MODEL, settingSources: [], tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
      plugins: [], skills: [], maxTurns: 1, maxBudgetUsd: PASS_BUDGET_USD, persistSession: false,
    });
    expect(AUTO_MEMORY_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.hooks).toBeUndefined();
    expect(options.canUseTool).toBeUndefined();
    expect((options.env as Record<string, string>).POCKETROCKET_TOKEN).toBeUndefined();
  });

  it('reports a failed result as an error', async () => {
    sdk.query.mockImplementation(() => (async function* () {
      yield { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 0.05, duration_ms: 5, usage: {} };
    })());
    expect(await runPass('x')).toMatchObject({ ok: false, error: 'error_max_budget_usd', usage: { costUsd: 0.05 } });
  });
});
