import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { isStaleSessionError } from '../../agent/BotRunner.js';
import { createGeminiProvider } from '../gemini.js';
import type { TurnContext, TurnSink } from '../types.js';
import { MCP_STDIO_BRIDGE } from './client.js';

/**
 * P2-1a / P2-1b: the generic ACP adapter against a fake agent that speaks ACP over stdio (test-fixtures/acp). It runs
 * through the Gemini preset, since that is the one wired in, but nothing here is Gemini-specific except the limit matcher.
 */

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAKE = path.join(HUB, 'test-fixtures', 'acp', 'fake-acp-agent.mjs');

let tmp: string;
let recordPath: string;
const savedToken = process.env.POCKETROCKET_TOKEN;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-acp-'));
  fs.mkdirSync(path.join(tmp, 'workspace'));
  recordPath = path.join(tmp, 'record.jsonl');
  // The hub token must never reach an agent, whatever the hub's own environment holds.
  process.env.POCKETROCKET_TOKEN = 'hub-secret-token';
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.POCKETROCKET_TOKEN;
  else process.env.POCKETROCKET_TOKEN = savedToken;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function provider(knobs: Record<string, string> = {}) {
  return createGeminiProvider({ exe: FAKE, env: { FAKE_ACP_RECORD: recordPath, ...knobs }, secrets: { get: () => null } });
}

type Rec = Record<string, unknown> & { method?: string; params?: Record<string, unknown> };
function recorded(): Rec[] {
  return fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec) : [];
}
const calls = (method: string) => recorded().filter((r) => r.method === method);

function recorder() {
  const out: Array<[string, ...unknown[]]> = [];
  const sink: TurnSink = {
    onSession: (t) => out.push(['session', t]),
    onDelta: (t) => out.push(['delta', t]),
    onText: (t) => out.push(['text', t]),
    onToolUse: (id, name, input) => out.push(['use', id, name, input]),
    onToolResult: (id, o, isError) => out.push(['result', id, o, isError]),
    onState: (s) => out.push(['state', s]),
  };
  return { out, sink, only: (k: string) => out.filter((c) => c[0] === k) };
}

function makeCtx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 't1',
    bot: { id: 'b1', handle: 'gem', name: 'Gem' } as Bot,
    room: { id: 'r1' } as Room,
    members: [],
    systemPrompt: 'SYSTEM PROMPT',
    input: 'hello there',
    resumeToken: null,
    workspaceDir: path.join(tmp, 'workspace'),
    botHome: path.join(tmp, 'home'),
    tools: [],
    allowedBuiltins: ['Read', 'Write', 'Edit', 'Bash'],
    permission: async () => 'allow',
    model: 'gemini-default',
    maxBudgetUsd: 5,
    maxTurns: 40,
    signal: new AbortController().signal,
    mcp: { url: 'http://127.0.0.1:7788/mcp', token: 'turn-tok-abc123' },
    ...over,
  };
}

describe('ACP adapter: a plain text turn', () => {
  it('initializes, opens a session with the hub MCP over HTTP, streams text and reports context and cost', async () => {
    const r = recorder();
    const o = await provider().runTurn(makeCtx(), r.sink);
    expect(o.error).toBeUndefined();
    expect(o.ok).toBe(true);
    expect(r.only('delta').map((c) => c[1])).toEqual(['Hel', 'lo there']);
    expect(r.only('text')).toEqual([['text', 'Hello there']]);
    expect(r.only('session')).toEqual([['session', 'sess-1']]);
    expect(o.contextTokens).toBe(12345);
    expect(o.costUsd).toBeCloseTo(0.25);
    expect(o.sessionCostUsd).toBeCloseTo(0.25);

    const init = calls('initialize')[0].params!;
    expect(init.protocolVersion).toBe(1);
    // M8 (P4-1): compaction is asked for, so an agent may report one (it becomes a quiet note).
    expect(init.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } });
    const sn = calls('session/new')[0].params!;
    expect(sn.cwd).toBe(path.join(tmp, 'workspace'));
    expect(sn.mcpServers).toEqual([
      { type: 'http', name: 'pocketrocket', url: 'http://127.0.0.1:7788/mcp', headers: [{ name: 'Authorization', value: 'Bearer turn-tok-abc123' }] },
    ]);
    // A fresh session's first prompt carries the system prompt.
    const prompt = calls('session/prompt')[0].params!.prompt as Array<{ type: string; text: string }>;
    expect(prompt[0].text.startsWith('SYSTEM PROMPT')).toBe(true);
    expect(prompt[0].text).toContain('hello there');
    // A normal (non-strict) turn leaves the agent's mode alone.
    expect(calls('session/set_mode')).toEqual([]);
  });

  it('runs the agent with the allowlisted env only: never the hub token', async () => {
    await provider().runTurn(makeCtx(), recorder().sink);
    const names = (recorded().find((r) => r.env)!.env as string[]).map((n) => n.toLowerCase());
    expect(names).not.toContain('pocketrocket_token');
    expect(names).toContain('fake_acp_record');
  });

  it('falls back to the stdio bridge when the agent does not take HTTP MCP servers', async () => {
    await provider({ FAKE_ACP_NO_HTTP: '1' }).runTurn(makeCtx(), recorder().sink);
    const [server] = calls('session/new')[0].params!.mcpServers as Array<Record<string, unknown>>;
    expect(server.type).toBeUndefined();
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual(['-e', MCP_STDIO_BRIDGE]);
    expect(server.env).toEqual([
      { name: 'PR_MCP_URL', value: 'http://127.0.0.1:7788/mcp' },
      { name: 'PR_MCP_TOKEN', value: 'turn-tok-abc123' },
    ]);
  });
});

describe('ACP adapter: sessions', () => {
  it('resumes a stored session, sends the short prompt, and counts only this run against the cost baseline', async () => {
    const o = await provider({ FAKE_ACP_RESUME: '1' }).runTurn(makeCtx({ resumeToken: 'sess-old', sessionCostUsd: 0.1 }), recorder().sink);
    expect(o.ok).toBe(true);
    expect(calls('session/new')).toEqual([]);
    expect(calls('session/resume')[0].params!.sessionId).toBe('sess-old');
    const prompt = calls('session/prompt')[0].params!.prompt as Array<{ text: string }>;
    expect(prompt[0].text).not.toContain('SYSTEM PROMPT');
    expect(o.costUsd).toBeCloseTo(0.15);
    expect(o.sessionCostUsd).toBeCloseTo(0.25);
  });

  it('a session the agent no longer has ends with the error BotRunner retries fresh and seeded', async () => {
    const o = await provider({ FAKE_ACP_RESUME: '1' }).runTurn(makeCtx({ resumeToken: 'gone' }), recorder().sink);
    expect(o.ok).toBe(false);
    expect(isStaleSessionError(o.error)).toBe(true);
    expect(calls('session/prompt')).toEqual([]);
  });

  it('an agent that cannot resume starts a fresh session with the full prompt', async () => {
    const o = await provider().runTurn(makeCtx({ resumeToken: 'sess-old' }), recorder().sink);
    expect(o.ok).toBe(true);
    expect(calls('session/new')).toHaveLength(1);
    const prompt = calls('session/prompt')[0].params!.prompt as Array<{ text: string }>;
    expect(prompt[0].text.startsWith('SYSTEM PROMPT')).toBe(true);
  });
});

describe('ACP adapter: tool calls and permission requests', () => {
  it('asks the broker as Edit for an edit with a location, and answers allow_once on allow', async () => {
    const file = path.join(tmp, 'workspace', 'a.txt');
    const asked: Array<[string, Record<string, unknown>]> = [];
    const r = recorder();
    const o = await provider({ FAKE_ACP_SCENARIO: 'tool', FAKE_ACP_KIND: 'edit', FAKE_ACP_PATH: file }).runTurn(
      makeCtx({ permission: async (n, i) => (asked.push([n, i]), 'allow') }),
      r.sink,
    );
    expect(o.ok).toBe(true);
    expect(asked).toEqual([['Edit', { file_path: file }]]);
    expect(recorded().find((x) => x.permissionAnswer)!.permissionAnswer).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(r.only('use')).toEqual([['use', 'tc1', 'Change a file', { title: 'Change a file', kind: 'edit', paths: [file] }]]);
    expect(r.only('result')).toEqual([['result', 'tc1', 'file changed', false]]);
    expect(r.only('text').map((c) => c[1])).toEqual(['Done.']);
  });

  it('a denied request answers reject_once and the tool fails', async () => {
    const r = recorder();
    await provider({ FAKE_ACP_SCENARIO: 'tool', FAKE_ACP_KIND: 'execute', FAKE_ACP_COMMAND: 'rm -rf /' }).runTurn(
      makeCtx({ permission: async () => 'deny' }),
      r.sink,
    );
    expect(recorded().find((x) => x.permissionAnswer)!.permissionAnswer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(r.only('result')).toEqual([['result', 'tc1', 'permission denied', true]]);
  });

  it('bypass answers allow_once without asking', async () => {
    let asked = 0;
    await provider({ FAKE_ACP_SCENARIO: 'tool', FAKE_ACP_KIND: 'other' }).runTurn(
      makeCtx({ bypassPermissions: true, permission: async () => (asked++, 'deny') }),
      recorder().sink,
    );
    expect(asked).toBe(0);
    expect(recorded().find((x) => x.permissionAnswer)!.permissionAnswer).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
  });

  it('a strict turn starts the agent in its most restrictive mode that asks, and still asks', async () => {
    let asked = 0;
    await provider({ FAKE_ACP_SCENARIO: 'tool', FAKE_ACP_KIND: 'other' }).runTurn(
      makeCtx({ strictApprovals: true, permission: async () => (asked++, 'allow') }),
      recorder().sink,
    );
    expect(calls('session/set_mode').map((c) => c.params)).toEqual([{ sessionId: 'sess-1', modeId: 'default' }]);
    expect(asked).toBe(1);
  });
});

describe('ACP adapter: stop, limits, failures', () => {
  it('interrupt sends session/cancel and the run ends as interrupted', async () => {
    const p = provider({ FAKE_ACP_SCENARIO: 'cancel' });
    const r = recorder();
    const run = p.runTurn(makeCtx(), r.sink);
    for (let i = 0; i < 400 && !r.only('delta').length; i++) await new Promise((res) => setTimeout(res, 10));
    expect(p.interrupt('t1')).toBe(true);
    const o = await run;
    expect(o.ok).toBe(false);
    expect(o.error).toBe('interrupted');
    expect(calls('session/cancel').map((c) => c.params)).toEqual([{ sessionId: 'sess-1' }]);
    expect(p.interrupt('t1')).toBe(false);
  });

  it('the turn signal aborting cancels the same way', async () => {
    const ac = new AbortController();
    const r = recorder();
    const run = provider({ FAKE_ACP_SCENARIO: 'cancel' }).runTurn(makeCtx({ signal: ac.signal }), r.sink);
    for (let i = 0; i < 400 && !r.only('delta').length; i++) await new Promise((res) => setTimeout(res, 10));
    ac.abort();
    expect((await run).error).toBe('interrupted');
  });

  it('a quota error ends the run on a usage limit with the reset time, not as the bot reply', async () => {
    const before = Date.now();
    const r = recorder();
    const o = await provider({ FAKE_ACP_SCENARIO: 'limit' }).runTurn(makeCtx(), r.sink);
    expect(o.ok).toBe(false);
    expect(o.limit?.kind).toBe('usage');
    expect(o.limit!.resetsAt! - before).toBeGreaterThanOrEqual(119_000);
    expect(r.only('text')).toEqual([]);
  });

  it('a limit notice followed by an empty end_turn is a limit too', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'notice-limit' }).runTurn(makeCtx(), recorder().sink);
    expect(o.ok).toBe(false);
    expect(o.limit?.kind).toBe('usage');
  });

  it('auth_required on session/new is an auth limit with the sign-in hint', async () => {
    const o = await provider({ FAKE_ACP_AUTH: '1' }).runTurn(makeCtx(), recorder().sink);
    expect(o.ok).toBe(false);
    expect(o.limit).toEqual({ kind: 'auth' });
    expect(o.error).toContain('agy');
  });

  it('an agent that dies mid-turn ends the run with its exit code', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'crash' }).runTurn(makeCtx(), recorder().sink);
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/exited with code 3/);
  });

  it('a missing binary is a clear failure, and nothing is downloaded', async () => {
    const o = await createGeminiProvider({ exe: path.join(tmp, 'no-such-agy.exe'), secrets: { get: () => null } }).runTurn(makeCtx(), recorder().sink);
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/agy failed to start/);
    expect(fs.readdirSync(tmp).sort()).toEqual(['workspace']);
  });
});
