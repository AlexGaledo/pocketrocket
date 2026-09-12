import { describe, it, expect } from 'vitest';
import { parseMentions } from './mentions.js';
import type { Bot } from '@pocketrocket/shared';

const bot = (id: string, handle: string): Bot => ({ id, handle, name: handle, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1, autoMemory: true, autoMemoryEvery: 10, createdAt: 0 });
const members = [bot('1', 'planner'), bot('2', 'coder'), bot('3', 'code-review')];

describe('parseMentions', () => {
  it('finds handles in order, unique, case-insensitive', () => {
    expect(parseMentions('@Coder then @planner and @coder again', members).map((b) => b.id)).toEqual(['2', '1']);
  });
  it('ignores unknown handles, emails and self', () => {
    expect(parseMentions('mail me@example.com @nobody @coder', members, '2')).toEqual([]);
  });
  it('handles punctuation and dashes', () => {
    expect(parseMentions('(@code-review) please, @planner: go', members).map((b) => b.handle)).toEqual(['code-review', 'planner']);
  });
  it('does not match inside words', () => {
    expect(parseMentions('email@coder.com', members)).toEqual([]);
  });
});
