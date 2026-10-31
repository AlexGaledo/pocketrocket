import { describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { FLEET_LINE_CHARS, FLEET_MAX_BOTS, FLEET_MAX_CHARS, buildSystemPrompt, fleetDirectory } from './PromptBuilder.js';
import { MAX_VOICE_BYTES } from '../services/MemoryService.js';

/** P7: voice, notes, knowledge and the fleet directory join the prompt, each bounded. */

const mk = (i: number, extra: Partial<Bot> = {}): Bot => ({
  id: 'b' + i, name: 'Bot ' + i, handle: 'bot' + i, title: 'Specialist ' + i, description: 'Handles area ' + i + '.\nSecond line.',
  avatar: '🤖', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 2, autoMemory: true, autoMemoryEvery: 10, createdAt: i, ...extra,
});
const chief = mk(0, { handle: 'chief', name: 'Chief', title: 'Chief of staff' });
const writer = mk(1, { handle: 'writer', title: 'Writer' });
const analyst = mk(2, { handle: 'analyst', title: 'Analyst', description: 'Crunches numbers and builds dashboards.' });
const group: Room = { id: 'r1', kind: 'group', name: 'ops', memberIds: ['b0', 'b1'], coordinatorBotId: 'b0', createdAt: 0 };
const dm: Room = { id: 'r2', kind: 'dm', name: 'DM', memberIds: ['b0'], coordinatorBotId: null, createdAt: 0 };
const base = { bot: chief, room: group, members: [chief, writer], hop: 0, memory: '', identity: '' };

describe('fleet directory', () => {
  it('lists bots that are not in the room, compactly, so the coordinator can route to them', () => {
    const p = buildSystemPrompt({ ...base, fleet: [chief, writer, analyst] });
    expect(p).toContain('## Fleet directory');
    expect(p).toContain('- @analyst — Analyst: Crunches numbers and builds dashboards.');
    expect(p).toContain('call handoff with its @handle');
    // Room members are in the roster, not repeated in the directory; the bot itself is never listed.
    const dir = p.slice(p.indexOf('## Fleet directory'));
    expect(dir).not.toContain('@writer');
    expect(dir).not.toContain('@chief');
  });

  it('is left out when every bot is already in the room', () => {
    expect(buildSystemPrompt({ ...base, fleet: [chief, writer] })).not.toContain('## Fleet directory');
  });

  it('tells a DM bot that others cannot join the DM', () => {
    expect(buildSystemPrompt({ ...base, room: dm, members: [chief], fleet: [chief, analyst] })).toContain('This is a DM');
  });

  it('is capped by count, line length and total size however big the fleet is', () => {
    const huge = Array.from({ length: 200 }, (_, i) => mk(i + 10, { description: 'd'.repeat(3000), title: 't'.repeat(200) }));
    const dir = fleetDirectory(huge, new Set(), 'none');
    const lines = dir.split('\n');
    expect(lines.length).toBeLessThanOrEqual(FLEET_MAX_BOTS + 1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(FLEET_LINE_CHARS);
    expect(dir.length).toBeLessThanOrEqual(FLEET_MAX_CHARS + 40);
    expect(lines[lines.length - 1]).toMatch(/^- \(\+\d+ more: call list_bots\)$/);
  });
});

describe('voice, notes and knowledge in the prompt', () => {
  it('includes voice.md, capped at MAX_VOICE_BYTES', () => {
    expect(buildSystemPrompt({ ...base, voice: '- No emoji.' })).toContain('## Voice\nHow');
    const long = Array.from({ length: 300 }, (_, i) => '- style ' + i).join('\n');
    const p = buildSystemPrompt({ ...base, voice: long });
    const section = p.slice(p.indexOf('## Voice'), p.indexOf('## Notes and knowledge'));
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(MAX_VOICE_BYTES + 200);
    expect(section).toContain('style 299');
    expect(buildSystemPrompt({ ...base })).not.toContain('## Voice');
  });

  it('names the notes folder and tools but never puts note contents in the prompt', () => {
    const p = buildSystemPrompt({ ...base, notesCount: 42 });
    expect(p).toContain('Notes: 42 file(s)');
    expect(p).toContain('mcp__pocketrocket__search_notes');
    expect(p).toContain('mcp__pocketrocket__write_note');
  });

  it('describes the knowledge repo as read-only only when one is synced', () => {
    const p = buildSystemPrompt({ ...base, knowledgeDir: '/data/knowledge' });
    expect(p).toContain('Knowledge repo (shared by every bot, READ-ONLY): /data/knowledge');
    expect(p).toContain('cite the file path');
    expect(buildSystemPrompt({ ...base })).not.toContain('Knowledge repo');
  });

  it('keeps the whole P7 addition bounded, however large voice, notes and fleet get', () => {
    const plain = buildSystemPrompt({ ...base, memory: 'm' });
    const maxed = buildSystemPrompt({
      ...base, memory: 'm',
      voice: 'v'.repeat(100_000), notesCount: 500, knowledgeDir: '/data/knowledge',
      fleet: [chief, writer, ...Array.from({ length: 500 }, (_, i) => mk(i + 10, { description: 'x'.repeat(4000) }))],
    });
    // Voice 1 KB + directory 2.4 KB + fixed lines: the prompt can never grow past this from P7 alone.
    expect(maxed.length - plain.length).toBeLessThan(MAX_VOICE_BYTES + FLEET_MAX_CHARS + 1200);
  });
});
