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
import { SESSION_RETENTION_DAYS } from './cliRetention.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function claudeDir(settings?: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-cli-'));
  dirs.push(d);
  if (settings !== undefined) fs.writeFileSync(path.join(d, 'settings.json'), settings);
  return d;
}
const read = (d: string) => JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'));

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
