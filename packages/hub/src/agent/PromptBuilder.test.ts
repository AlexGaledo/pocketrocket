import { describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { buildSystemPrompt } from './PromptBuilder.js';

const bot: Bot = {
  id: 'b1', name: 'Scout', handle: 'scout', title: 'Researcher', description: 'You research things.',
  avatar: '🔎', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2, autoMemory: true, autoMemoryEvery: 10, createdAt: 0,
};
const room: Room = { id: 'r1', kind: 'dm', name: 'DM', memberIds: ['b1'], coordinatorBotId: null, createdAt: 0 };
const base = { bot, room, members: [bot], hop: 0, memory: '', identity: '' };

describe('buildSystemPrompt', () => {
  it('prefixes hub tools with mcp__pocketrocket__ by default (Claude)', () => {
    const p = buildSystemPrompt({ ...base });
    expect(p).toContain('mcp__pocketrocket__send_message');
    expect(p).not.toContain('request_approval');
  });

  it('uses bare tool names for providers that reach the MCP endpoint', () => {
    const p = buildSystemPrompt({ ...base, toolPrefix: '' });
    expect(p).toContain('Custom tools: send_message');
    expect(p).not.toContain('mcp__pocketrocket__');
  });

  it('explains request_approval only for best-effort providers', () => {
    const p = buildSystemPrompt({ ...base, toolPrefix: '', requestApproval: true });
    expect(p).toContain('request_approval({ action, command?, paths?, reason? })');
    expect(p).toContain('Approvals:');
  });

  it('names the desktop tools with the provider prefix', () => {
    expect(buildSystemPrompt({ ...base, desktop: true })).toContain('Desktop: mcp__pocketrocket__desktop_*');
    expect(buildSystemPrompt({ ...base, desktop: true, toolPrefix: '' })).toContain('Desktop: desktop_*');
  });
});

describe('buildSystemPrompt: per-bot computers (P1)', () => {
  const computer = { display: ':201', filesDir: '/data/computers/b1/files', diskBytes: 1, quotaBytes: 10 * 1024 ** 3 };

  it('tells the bot about its own computer and the shared folder, without claiming isolation', () => {
    const p = buildSystemPrompt({ ...base, browser: true, desktop: true, computer });
    expect(p).toContain('## Your computer');
    expect(p).not.toContain('## Shared computer');
    expect(p).toContain('display :201');
    expect(p).toContain('/data/computers/b1/files');
    expect(p).toContain('~/Shared');
    expect(p).toContain('not private');
    expect(p).not.toMatch(/isolat/i);
    expect(p).toContain('drive a real Chromium on your computer');
    expect(p).toContain('operate the XFCE desktop on your computer');
    expect(p).not.toContain('Disk warning');
  });

  it('warns at 80% of the disk quota', () => {
    const p = buildSystemPrompt({ ...base, computer: { ...computer, diskBytes: 8.5 * 1024 ** 3 } });
    expect(p).toContain('Disk warning: your computer uses 8.5 GB of its 10.0 GB quota');
  });

  it('explains when the computer is unavailable this turn', () => {
    const p = buildSystemPrompt({ ...base, computerUnavailable: 'Its disk is full.' });
    expect(p).toContain('Your computer is unavailable this turn, so the Browser and Desktop tools are off: Its disk is full.');
  });

  it('keeps the shared-computer wording when there are no per-bot computers', () => {
    const p = buildSystemPrompt({ ...base, browser: true, desktop: true });
    expect(p).toContain('## Shared computer');
    expect(p).toContain('drive a real Chromium on this computer');
    expect(p).toContain('The desktop folder is the shared workspace.');
  });
});
