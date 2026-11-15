import { describe, expect, it } from 'vitest';
import type { ApprovalPayload } from '@pocketrocket/shared';
import { broadPattern, suggestPattern } from './rulePattern';

const card = (toolName: string, toolInput: Record<string, unknown>) => ({ approvalId: 'a1', toolName, toolInput, reason: '', status: 'pending' }) as unknown as ApprovalPayload;

describe('broadPattern', () => {
  it('widens a command to its program', () => {
    expect(broadPattern(card('Bash', { command: "find . -type f -printf '%P\\n' > /tmp/m.tsv" }))).toBe('find *');
  });
  it('keeps the folder of a script that starts with cd', () => {
    expect(broadPattern(card('Bash', { command: 'cd /home/pr/data/workspace\nfind . -type f | wc -l' }))).toBe('cd /home/pr/data/workspace*');
  });
  it('keeps a one-word command exact', () => {
    expect(broadPattern(card('Bash', { command: 'pwd' }))).toBe('pwd');
  });
  it('widens a file to its folder and a page to its site', () => {
    expect(broadPattern(card('Write', { file_path: '/srv/app/notes/today.md' }))).toBe('/srv/app/notes/*');
    expect(broadPattern(card('WebFetch', { url: 'https://example.com/a/b?c=1' }))).toBe('https://example.com/*');
  });
  it('has nothing to offer where the hub would match any call', () => {
    expect(broadPattern(card('mcp__x__y', { a: 1 }))).toBeNull();
    expect(suggestPattern(card('Bash', { command: 'ls *' }))).toBeNull();
  });
});
