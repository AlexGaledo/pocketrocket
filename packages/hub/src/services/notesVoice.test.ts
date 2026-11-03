import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: () => { throw new Error('no SDK calls in this suite'); },
}));

import { botHome } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { AutoMemory, parseVoice, type PassOutcome } from './AutoMemory.js';
import { MAX_NOTE_BYTES, MAX_VOICE_BYTES, MemoryService, noteSlug } from './MemoryService.js';
import { UsageTracker } from './UsageTracker.js';
import { MAX_PENDING_VOICE, VoiceProposals } from './VoiceProposals.js';

/** P7 (7.2): notes/ searched on demand, voice.md small and in the prompt, AutoMemory only proposes voice. */

const ids: string[] = [];
let n = 0;
const botId = () => {
  const id = 'p7test-' + process.pid + '-' + n++;
  ids.push(id);
  return id;
};
afterEach(() => {
  for (const id of ids.splice(0)) fs.rmSync(botHome(id), { recursive: true, force: true });
});

describe('notes', () => {
  it('turns any title into a file name inside the notes folder', () => {
    expect(noteSlug('Q3 Launch / Plan!')).toBe('q3-launch-plan');
    expect(noteSlug('../../../etc/passwd')).toBe('etc-passwd');
    expect(noteSlug('..\\..\\evil')).toBe('evil');
    expect(noteSlug('!!!')).toBe('note');
    const m = new MemoryService();
    const id = botId();
    const r = m.writeNote(id, '../../../escape', 'x');
    expect(path.dirname(r.file)).toBe(m.notesDir(id));
  });

  it('writes, appends, and finds notes by every term, ranked, with matching lines', () => {
    const m = new MemoryService();
    const id = botId();
    m.writeNote(id, 'Deploy runbook', 'Deploys go out on Fridays.\nRollback: run the previous tag.');
    m.writeNote(id, 'Customer list', 'Acme pays yearly.\nGlobex pays monthly.');
    m.writeNote(id, 'Deploy runbook', 'Staging deploys any day.', 'append');
    expect(fs.readFileSync(path.join(m.notesDir(id), 'deploy-runbook.md'), 'utf8')).toContain('Fridays');

    const hits = m.searchNotes(id, 'deploy fridays');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('deploy-runbook.md');
    expect(hits[0].lines.join('\n')).toContain('Fridays');
    expect(m.searchNotes(id, 'pays')[0].name).toBe('customer-list.md');
    expect(m.searchNotes(id, 'nonexistentword')).toEqual([]);
    expect(m.searchNotes(id, 'x')).toEqual([]); // too short to search
  });

  it('caps one note at MAX_NOTE_BYTES', () => {
    const m = new MemoryService();
    const id = botId();
    const r = m.writeNote(id, 'big', 'y'.repeat(MAX_NOTE_BYTES * 2));
    expect(r.trimmed).toBe(true);
    expect(fs.statSync(r.file).size).toBeLessThanOrEqual(MAX_NOTE_BYTES);
  });
});

describe('voice.md', () => {
  it('is capped at MAX_VOICE_BYTES, newest lines kept', () => {
    const m = new MemoryService();
    const id = botId();
    const lines = Array.from({ length: 100 }, (_, i) => '- rule ' + i + ' ' + 'z'.repeat(30));
    expect(m.writeVoice(id, lines.join('\n'))).toBe(true);
    const v = m.readVoice(id);
    expect(Buffer.byteLength(v)).toBeLessThanOrEqual(MAX_VOICE_BYTES);
    expect(v).toContain('rule 99');
    expect(v).not.toContain('rule 0 ');
  });
});

describe('VoiceProposals', () => {
  function setup() {
    const repos = new Repos(new Db(':memory:'));
    const memory = new MemoryService();
    const id = botId();
    return { repos, memory, id, voice: new VoiceProposals(repos, memory) };
  }

  it('stores new proposals, skipping ones already in voice.md or pending', () => {
    const s = setup();
    s.memory.writeVoice(s.id, '- No emoji.\n');
    expect(s.voice.propose(s.id, ['no EMOJI', 'Lead with the answer', 'lead with the answer.'])).toBe(1);
    expect(s.voice.list(s.id).map((p) => p.text)).toEqual(['Lead with the answer']);
    expect(s.voice.propose(s.id, ['Lead with the answer'])).toBe(0);
  });

  it('only approved proposals reach voice.md', () => {
    const s = setup();
    s.voice.propose(s.id, ['Short paragraphs', 'Use British spelling']);
    const [a, b] = s.voice.list(s.id);
    expect(s.memory.readVoice(s.id)).toBe('');
    expect(s.voice.decide(s.id, a.id, 'approve')).toBe(true);
    expect(s.voice.decide(s.id, b.id, 'dismiss')).toBe(true);
    expect(s.memory.readVoice(s.id)).toBe('- Short paragraphs\n');
    expect(s.voice.list(s.id)).toEqual([]);
    expect(s.voice.decide(s.id, 'nope', 'approve')).toBe(false);
  });

  it(`keeps at most ${MAX_PENDING_VOICE} pending per bot`, () => {
    const s = setup();
    s.voice.propose(s.id, Array.from({ length: MAX_PENDING_VOICE + 5 }, (_, i) => 'style ' + i));
    expect(s.voice.list(s.id)).toHaveLength(MAX_PENDING_VOICE);
  });
});

describe('AutoMemory voice proposals', () => {
  it('parseVoice reads the optional array and tolerates its absence', () => {
    expect(parseVoice('{"notes":[],"voice":["a","b","c","d"]}')).toEqual(['a', 'b', 'c']);
    expect(parseVoice('{"notes":["x"]}')).toEqual([]);
    expect(parseVoice('junk')).toEqual([]);
  });

  it('proposes style notes for review and never writes voice.md itself', async () => {
    const repos = new Repos(new Db(':memory:'));
    const memory = new MemoryService();
    const voice = new VoiceProposals(repos, memory);
    const bot = repos.createBot({ name: 'Ada', handle: 'ada' + n, title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    ids.push(bot.id);
    repos.updateBot(bot.id, { autoMemoryEvery: 3 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    repos.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'Too long. Keep it to three lines and no emoji.', payload: null, causeId: null, hop: 0, turnId: null });
    const reply: PassOutcome = {
      ok: true, text: '{"notes":["User wants brief replies"],"voice":["Keep replies to three lines","No emoji","API key sk-ant-abcdefghijklmnopqrstuvwxyz"]}',
      usage: { costUsd: 0.001, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: undefined, durationMs: 1 },
    };
    const seen: string[] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'voice.updated') seen.push(ev.botId); });
    const am = new AutoMemory({ repos, memory, usage: new UsageTracker(repos), activeProvider: () => 'claude', exeExists: () => true, run: async () => reply, voice });
    for (let i = 0; i < 2; i++) am.afterTurn(bot.id, room.id, { ok: true });
    await am.afterTurn(bot.id, room.id, { ok: true });
    off();
    expect(voice.list(bot.id).map((p) => p.text)).toEqual(['Keep replies to three lines', 'No emoji']);
    expect(memory.readVoice(bot.id)).toBe('');
    expect(memory.read(bot.id)).toContain('User wants brief replies');
    expect(seen).toContain(bot.id);
  });
});
