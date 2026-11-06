import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    async function* gen() {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, usage: {}, result: 'ok' };
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  },
}));

import { ClaudeProvider } from './claude.js';
import type { TurnContext } from './types.js';
import { SESSION_RETENTION_DAYS, ensureCliRetention } from './cliRetention.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function claudeDir(settings?: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-cli-'));
  dirs.push(d);
  if (settings !== undefined) fs.writeFileSync(path.join(d, 'settings.json'), settings);
  return d;
}
const read = (d: string) => JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'));

describe('ensureCliRetention', () => {
  it('does nothing when the CLI was never used here', () => {
    expect(ensureCliRetention(path.join(os.tmpdir(), 'prc-no-such-dir-' + Date.now()))).toBe('skipped');
  });

  it('creates settings.json when there is none', () => {
    const d = claudeDir();
    expect(ensureCliRetention(d)).toBe('created');
    expect(read(d)).toEqual({ cleanupPeriodDays: SESSION_RETENTION_DAYS });
  });

  it('adds the key and keeps everything else', () => {
    const d = claudeDir(JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }));
    expect(ensureCliRetention(d)).toBe('added');
    expect(read(d)).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, cleanupPeriodDays: SESSION_RETENTION_DAYS });
    // Idempotent.
    const before = fs.readFileSync(path.join(d, 'settings.json'), 'utf8');
    expect(ensureCliRetention(d)).toBe('kept');
    expect(fs.readFileSync(path.join(d, 'settings.json'), 'utf8')).toBe(before);
  });

  it('never overrides a value the owner chose, and never rewrites a file it cannot read', () => {
    const low = claudeDir(JSON.stringify({ cleanupPeriodDays: 7 }));
    expect(ensureCliRetention(low)).toBe('lower');
    expect(read(low)).toEqual({ cleanupPeriodDays: 7 });
    for (const bad of ['{ not json', '[1,2]', '"x"', JSON.stringify({ cleanupPeriodDays: 'forever' })]) {
      const d = claudeDir(bad);
      expect(ensureCliRetention(d)).toBe('skipped');
      expect(fs.readFileSync(path.join(d, 'settings.json'), 'utf8')).toBe(bad);
    }
  });
});

describe('bot turns', () => {
  it('pass the retention as flag settings, which load although settingSources is empty', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-ret-'));
    dirs.push(ws);
    const ctx = {
      turnId: 't', bot: { id: 'b', handle: 'b' }, room: {}, members: [], systemPrompt: '', input: 'hi', resumeToken: null,
      workspaceDir: ws, botHome: path.join(ws, 'home'), tools: [], allowedBuiltins: [],
      bypassPermissions: false, permission: async () => 'allow', pluginDir: null, model: 'claude-sonnet-5',
      maxBudgetUsd: 1, maxTurns: 1, signal: new AbortController().signal, mcp: { url: '', token: '' },
    } as unknown as TurnContext;
    const sink = { onSession() {}, onDelta() {}, onText() {}, onToolUse() {}, onToolResult() {}, onState() {} };
    await new ClaudeProvider().runTurn(ctx, sink);
    expect(sdk.options[0]).toMatchObject({ settingSources: [], settings: { cleanupPeriodDays: SESSION_RETENTION_DAYS } });
  });
});
