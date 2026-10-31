import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

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
import { events } from '../events.js';
import { ClaudeProvider } from '../providers/claude.js';
import type { TurnContext } from '../providers/types.js';
import { classifyBash } from './bashRules.js';
import { PermissionBroker } from './PermissionBroker.js';
import { readOnlyWriteDecision } from './readOnlyRoots.js';

/**
 * P7 acceptance: "All bots cite it; none can write it." The knowledge folder is a read-only root: every read
 * path passes silently, every write path (file tools, shell, the Claude SDK's acceptEdits) asks or is denied.
 */

const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-kro-'));
fs.writeFileSync(path.join(kdir, 'handbook.md'), '# Handbook\n');
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
afterAll(() => fs.rmSync(kdir, { recursive: true, force: true }));
const kfile = path.join(kdir, 'handbook.md');

function broker(bypass = false) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'm', allowedTools: ['Read', 'Write', 'Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const b = new PermissionBroker(repos, { bypass: () => bypass, readOnlyRoots: () => [kdir] });
  const ctx = { bot, room, turnId: 't1', hop: 0, causeId: 'c1', setState: () => undefined };
  return { b, ctx };
}

/** Decide, answering any approval card with `deny`; reports whether a card was raised and its reason. */
async function decide(toolName: string, input: Record<string, unknown>, bypass = false) {
  const { b, ctx } = broker(bypass);
  let card: string | null = null;
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') {
      card = ev.approval.reason;
      setTimeout(() => b.resolve(ev.approval.approvalId, 'deny'), 0);
    }
  });
  const r = await b.decide(ctx, toolName, input, { signal: new AbortController().signal });
  off();
  return { behavior: r.behavior, card: card as string | null };
}

describe('PermissionBroker with a read-only knowledge root', () => {
  it('lets Read, Glob and Grep into the knowledge repo without a card', async () => {
    expect(await decide('Read', { file_path: kfile })).toEqual({ behavior: 'allow', card: null });
    expect(await decide('Glob', { pattern: '**/*.md', path: kdir })).toEqual({ behavior: 'allow', card: null });
    expect(await decide('Grep', { pattern: 'Handbook', path: kdir })).toEqual({ behavior: 'allow', card: null });
  });

  it('cards every write into the knowledge repo, and the bot cannot write it when declined', async () => {
    for (const [tool, input] of [
      ['Write', { file_path: path.join(kdir, 'new.md'), content: 'x' }],
      ['Edit', { file_path: kfile, old_string: 'Handbook', new_string: 'Hacked' }],
      ['MultiEdit', { file_path: kfile, edits: [] }],
      ['NotebookEdit', { notebook_path: path.join(kdir, 'n.ipynb') }],
    ] as const) {
      const r = await decide(tool, input as Record<string, unknown>);
      expect(r.behavior, tool).toBe('deny');
      expect(r.card, tool).toMatch(/read-only knowledge repo/);
    }
    expect(fs.readFileSync(kfile, 'utf8')).toBe('# Handbook\n');
  });

  it('lets a shell read it but cards a shell write', async () => {
    expect((await decide('Bash', { command: 'cat ' + kfile })).behavior).toBe('allow');
    for (const cmd of ['echo hacked > ' + kfile, 'cp a.txt ' + kdir, 'rm ' + kfile, 'sort -o ' + kfile + ' a.txt']) {
      const r = await decide('Bash', { command: cmd });
      expect(r.behavior, cmd).toBe('deny');
      expect(r.card, cmd).toBeTruthy();
    }
  });
});

describe('classifyBash read-only roots', () => {
  const ro = { readOnlyRoots: [kdir] };
  it('allows the plain readers on a read-only root, including after cd', () => {
    for (const c of ['cat ' + kfile, 'head -5 ' + kfile, 'grep -n Handbook ' + kfile, 'ls ' + kdir, 'cd ' + kdir + ' && ls', 'rg Handbook ' + kdir]) {
      expect(classifyBash(c, [WORKSPACE_DIR], ro).verdict, c).toBe('allow');
    }
  });
  it('asks for anything that writes there', () => {
    for (const c of [
      'echo x > ' + kfile, 'cat a.txt >> ' + kfile, 'cd ' + kdir + ' && echo x > y.md', 'sort -o ' + kfile + ' a.txt',
      'uniq a.txt ' + path.join(kdir, 'out.md'), 'tree -o ' + path.join(kdir, 'x'), 'cp a.txt ' + kdir, 'mv a.txt ' + kdir,
    ]) {
      expect(classifyBash(c, [WORKSPACE_DIR], ro).verdict, c).toBe('ask');
    }
  });
  it('without read-only roots the knowledge folder is just outside the workspace', () => {
    expect(classifyBash('cat ' + kfile, [WORKSPACE_DIR]).verdict).toBe('ask');
  });
});

describe('Claude SDK wiring', () => {
  it('readOnlyWriteDecision asks normally and denies under bypass, and ignores reads and other folders', () => {
    expect(readOnlyWriteDecision('Write', { file_path: kfile }, [kdir], WORKSPACE_DIR, false)).toMatchObject({ decision: 'ask' });
    expect(readOnlyWriteDecision('Edit', { file_path: kfile }, [kdir], WORKSPACE_DIR, true)).toMatchObject({ decision: 'deny' });
    expect(readOnlyWriteDecision('Read', { file_path: kfile }, [kdir], WORKSPACE_DIR, false)).toBeNull();
    expect(readOnlyWriteDecision('Write', { file_path: path.join(WORKSPACE_DIR, 'a.md') }, [kdir], WORKSPACE_DIR, false)).toBeNull();
    expect(readOnlyWriteDecision('Write', { file_path: kfile }, [], WORKSPACE_DIR, false)).toBeNull();
  });

  async function runTurn(bypass: boolean, knowledgeDir: string | null) {
    sdk.options.length = 0;
    const ctx = {
      turnId: 't', bot: { id: 'b', handle: 'b' }, room: {}, members: [], systemPrompt: '', input: 'hi', resumeToken: null,
      workspaceDir: WORKSPACE_DIR, botHome: path.join(os.tmpdir(), 'prc-home'), tools: [], allowedBuiltins: ['Read', 'Write', 'Edit'],
      bypassPermissions: bypass, permission: async () => 'allow', pluginDir: null, model: 'claude-sonnet-5',
      maxBudgetUsd: 1, maxTurns: 1, signal: new AbortController().signal, mcp: { url: '', token: '' }, knowledgeDir,
    } as unknown as TurnContext;
    const sink = { onSession() {}, onDelta() {}, onText() {}, onToolUse() {}, onToolResult() {}, onState() {} };
    await new ClaudeProvider().runTurn(ctx, sink);
    return sdk.options[0] as {
      additionalDirectories: string[];
      hooks?: { PreToolUse: { matcher: string; hooks: ((i: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision: string } }>)[] }[] };
    };
  }
  const writeHook = (o: Awaited<ReturnType<typeof runTurn>>) => o.hooks!.PreToolUse.find((h) => h.matcher.includes('Write'))!.hooks[0];

  it('adds the knowledge folder to additionalDirectories and escalates writes there to a card', async () => {
    const o = await runTurn(false, kdir);
    expect(o.additionalDirectories).toContain(kdir);
    const out = await writeHook(o)({ tool_name: 'Write', tool_input: { file_path: path.join(kdir, 'x.md') } });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(await writeHook(o)({ tool_name: 'Write', tool_input: { file_path: path.join(WORKSPACE_DIR, 'x.md') } })).toEqual({});
  });

  it('still refuses writes there when approvals are bypassed', async () => {
    const o = await runTurn(true, kdir);
    const out = await writeHook(o)({ tool_name: 'Edit', tool_input: { file_path: kfile } });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('adds nothing when no knowledge repo is synced', async () => {
    const o = await runTurn(false, null);
    expect(o.additionalDirectories).toHaveLength(1);
    expect(o.hooks!.PreToolUse.some((h) => h.matcher.includes('Write'))).toBe(false);
  });
});
