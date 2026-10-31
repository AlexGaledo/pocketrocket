import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Capture the options the Claude provider hands the SDK, and end the turn at once.
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

import { WORKSPACE_DIR } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ClaudeProvider } from '../providers/claude.js';
import type { TurnContext } from '../providers/types.js';
import { PermissionBroker } from './PermissionBroker.js';
import { computerToolGuard, isComputerTool } from './controlInterlock.js';
import { desktopTools } from '../agent/desktopTools.js';
import { hubTool } from '../agent/botTools.js';
import { createHub, type Hub } from '../hub.js';
import { USER_HAS_CONTROL } from '../services/ComputerControl.js';

/**
 * P2 2.2: while the user has control of a bot's computer, its desktop and Browser tools refuse. The check is a
 * safety interlock, not an approval, so it holds when approvals are bypassed too, at every layer a call passes.
 */

describe('which tools the interlock covers', () => {
  it('covers Playwright MCP and the desktop tools, under either naming, and nothing else', () => {
    for (const t of ['mcp__browser__browser_click', 'mcp__browser__browser_navigate', 'desktop_click', 'mcp__pocketrocket__desktop_screenshot']) {
      expect(isComputerTool(t)).toBe(true);
    }
    for (const t of ['Bash', 'mcp__pocketrocket__send_message', 'request_takeover', 'WebFetch']) expect(isComputerTool(t)).toBe(false);
  });
});

describe('desktop tool handlers', () => {
  it('refuse every desktop tool, screenshot included, while the guard says so, without touching the display', async () => {
    let blocked: string | null = USER_HAS_CONTROL;
    const tools = desktopTools({ display: ':999', home: os.tmpdir(), guard: () => blocked });
    for (const t of tools) {
      const out = await t.handler(t.name === 'desktop_type' ? { text: 'x' } : t.name === 'desktop_key' ? { keys: 'Return' } : t.name === 'desktop_launch' ? { command: 'thunar' } : { x: 1, y: 1, direction: 'up' });
      expect(out.isError).toBe(true);
      expect(JSON.stringify(out.content)).toContain('taken control');
    }
    // Back to the agent: the guard lets calls through to the real handler (which then fails: no X here).
    blocked = null;
    const shot = await tools.find((t) => t.name === 'desktop_scroll')!.handler({ x: 1, y: 1, direction: 'up' });
    expect(JSON.stringify(shot.content)).not.toContain('taken control');
  });
});

describe('PermissionBroker.decide', () => {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Shop', handle: 'shopper', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Browser'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const signal = new AbortController().signal;
  const ctx = (blocked: string | null) => ({ bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined, controlBlocked: () => blocked });

  it('denies browser and desktop calls while the user has control, also in bypass mode', async () => {
    for (const bypass of [false, true]) {
      const broker = new PermissionBroker(repos, { bypass: () => bypass });
      for (const t of ['mcp__browser__browser_click', 'mcp__pocketrocket__desktop_click']) {
        const d = await broker.decide(ctx(USER_HAS_CONTROL), t, {}, { signal });
        expect(d).toMatchObject({ behavior: 'deny', message: USER_HAS_CONTROL });
      }
    }
  });
  it('lets them through when the agent has control, and never blocks other tools', async () => {
    const broker = new PermissionBroker(repos, { bypass: () => true });
    expect(await broker.decide(ctx(null), 'mcp__browser__browser_click', {}, { signal })).toEqual({ behavior: 'allow' });
    expect(await broker.decide(ctx(USER_HAS_CONTROL), 'Bash', { command: 'ls' }, { signal })).toEqual({ behavior: 'allow' });
  });
});

describe('Claude SDK PreToolUse hook', () => {
  async function runTurn(bypass: boolean, blocked: () => string | null) {
    sdk.options.length = 0;
    const ctx = {
      turnId: 't', bot: { id: 'b', handle: 'b' }, room: {}, members: [], systemPrompt: '', input: 'hi', resumeToken: null,
      workspaceDir: WORKSPACE_DIR, botHome: path.join(os.tmpdir(), 'prc-home'), tools: [], allowedBuiltins: ['Read', 'Browser', 'Desktop'],
      bypassPermissions: bypass, permission: async () => 'allow', pluginDir: null, model: 'claude-sonnet-5',
      maxBudgetUsd: 1, maxTurns: 1, signal: new AbortController().signal, mcp: { url: '', token: '' }, controlGuard: blocked,
    } as unknown as TurnContext;
    const sink = { onSession() {}, onDelta() {}, onText() {}, onToolUse() {}, onToolResult() {}, onState() {} };
    await new ClaudeProvider().runTurn(ctx, sink);
    const o = sdk.options[0] as { hooks?: { PreToolUse: { matcher: string; hooks: ((i: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } }>)[] }[] } };
    return o.hooks!.PreToolUse.find((h) => h.matcher.includes('mcp__browser__'))!;
  }

  it('is installed in bypass mode too, and denies browser calls while the user has control', async () => {
    for (const bypass of [false, true]) {
      let blocked: string | null = USER_HAS_CONTROL;
      const hook = await runTurn(bypass, () => blocked);
      expect(new RegExp('^(' + hook.matcher + ')$').test('mcp__browser__browser_click')).toBe(true);
      expect(new RegExp('^(' + hook.matcher + ')$').test('mcp__pocketrocket__desktop_click')).toBe(true);
      const r = await hook.hooks[0]({ tool_name: 'mcp__browser__browser_click', tool_input: {} });
      expect(r.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: USER_HAS_CONTROL });
      blocked = null;
      expect(await hook.hooks[0]({ tool_name: 'mcp__browser__browser_click', tool_input: {} })).toEqual({});
    }
  });
});

describe('HTTP MCP endpoint (non-Claude providers)', () => {
  let hub: Hub;
  let base: string;
  let blocked: string | null = USER_HAS_CONTROL;
  let ran = 0;
  let token: string;
  beforeAll(async () => {
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null });
    base = 'http://127.0.0.1:' + (await hub.listen());
    token = hub.turns.registerTurn([
      hubTool('desktop_click', 'click', { x: z.number(), y: z.number() }, async () => { ran++; return { content: [{ type: 'text', text: 'clicked' }] }; }),
      hubTool('send_message', 'say', { text: z.string() }, async () => { ran++; return { content: [{ type: 'text', text: 'sent' }] }; }),
    ], computerToolGuard(() => blocked));
  });
  afterAll(async () => { await hub.shutdown(); });

  const call = async (name: string, args: unknown) => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  };

  it('refuses a desktop call while the user has control without running it, and runs it after hand-back', async () => {
    const r = await call('desktop_click', { x: 1, y: 2 });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe(USER_HAS_CONTROL);
    expect(ran).toBe(0);
    expect((await call('send_message', { text: 'hi' })).result.content[0].text).toBe('sent');
    blocked = null;
    expect((await call('desktop_click', { x: 1, y: 2 })).result.content[0].text).toBe('clicked');
    expect(ran).toBe(2);
  });
});
