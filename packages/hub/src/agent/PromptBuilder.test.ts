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
