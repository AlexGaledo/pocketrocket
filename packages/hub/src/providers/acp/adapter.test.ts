import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { isStaleSessionError } from '../../agent/BotRunner.js';
import { createGeminiProvider, geminiPreset } from '../gemini.js';
import type { TurnContext, TurnSink } from '../types.js';
import { AcpProvider, READ_ONLY_NOTE } from './adapter.js';
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

/** The same fake behind a preset whose ask mode does ask before writes: the generic strict path, without read-only. */
function askingProvider(knobs: Record<string, string> = {}) {
  const opts = { exe: FAKE, env: { FAKE_ACP_RECORD: recordPath, ...knobs }, secrets: { get: () => null } };
  return new AcpProvider({ ...geminiPreset(opts), strictReadOnly: false }, opts);
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
    onNote: (t) => out.push(['note', t]),
    onLimit: (l) => out.push(['limit', l]),
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
    expect(o.contextWindow).toBe(200000);
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

describe('ACP adapter: usage of a run that reports no cost (agy on Gemini)', () => {
  it('marks a finished run accounted, at $0, with the context size and the agent model', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'quiet', FAKE_ACP_MODEL: 'gemini-3.1-pro' }).runTurn(makeCtx(), recorder().sink);
    expect(o.ok).toBe(true);
    expect(o.accounted).toBe(true);
    expect(o.costUsd).toBe(0);
    expect(o.usage).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(o.contextTokens).toBe(24368);
    expect(o.contextWindow).toBe(1048576);
    expect(o.model).toBe('gemini-3.1-pro');
  });

  it('takes token counts from the prompt answer usage when the agent gives them', async () => {
    const usage = JSON.stringify({ totalTokens: 1500, inputTokens: 1200, outputTokens: 300, cachedReadTokens: 800, thoughtTokens: 50 });
    const o = await provider({ FAKE_ACP_SCENARIO: 'quiet', FAKE_ACP_PROMPT_USAGE: usage }).runTurn(makeCtx(), recorder().sink);
    expect(o.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 });
    expect(o.model).toBeUndefined();
  });

  it('a run that failed before an answer is not accounted', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'crash' }).runTurn(makeCtx(), recorder().sink);
    expect(o.ok).toBe(false);
    expect(o.accounted).toBeUndefined();
  });

  it('a run that only called a hub tool (a hand-off, no text) is accounted (live G5)', async () => {
    const r = recorder();
    const o = await provider({ FAKE_ACP_SCENARIO: 'tool-only', FAKE_ACP_MODEL: 'gemini-3.1-pro' }).runTurn(makeCtx({ model: 'gemini-3.1-pro' }), r.sink);
    expect(o.ok).toBe(true);
    expect(r.only('text')).toEqual([]);
    expect(r.only('use').map((c) => c[2])).toEqual(['mcp_pocketrocket_handoff']);
    expect(o.accounted).toBe(true);
  });

  it('a run that called a tool and then died is still accounted, with its error', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'tool-only-crash' }).runTurn(makeCtx(), recorder().sink);
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/exited with code 3/);
    expect(o.accounted).toBe(true);
  });

  it('a bot saved on a pre-live model id asks agy for its replacement', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'quiet', FAKE_ACP_MODEL: 'gemini-3.1-pro' }).runTurn(makeCtx({ model: 'gemini-3-pro' }), recorder().sink);
    expect(o.ok).toBe(true);
    // Already agy's current model: nothing to set, and the usage row names what ran.
    expect(calls('session/set_config_option')).toEqual([]);
    expect(o.model).toBe('gemini-3.1-pro');
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
    await askingProvider({ FAKE_ACP_SCENARIO: 'tool', FAKE_ACP_KIND: 'other' }).runTurn(
      makeCtx({ strictApprovals: true, permission: async () => (asked++, 'allow') }),
      recorder().sink,
    );
    expect(calls('session/set_mode').map((c) => c.params)).toEqual([{ sessionId: 'sess-1', modeId: 'default' }]);
    expect(asked).toBe(1);
  });
});

describe('ACP adapter: strict turns on Gemini run read-only (live G6, spec 01 §4.7 item 7)', () => {
  const target = () => path.join(tmp, 'outside', 'g6-probe.txt');
  beforeEach(() => fs.mkdirSync(path.join(tmp, 'outside')));

  it('NEGATIVE: an ordinary turn shows the gap: agy-like writes happen with no permission request', async () => {
    let asked = 0;
    const o = await provider({ FAKE_ACP_SCENARIO: 'silent-write', FAKE_ACP_PATH: target() }).runTurn(
      makeCtx({ permission: async () => (asked++, 'deny') }),
      recorder().sink,
    );
    expect(o.ok).toBe(true);
    expect(asked).toBe(0);
    expect(fs.existsSync(target())).toBe(true);
  });

  it('a strict turn switches to plan mode before the prompt, tells the bot, and the write does not happen', async () => {
    let asked = 0;
    const r = recorder();
    const o = await provider({ FAKE_ACP_SCENARIO: 'silent-write', FAKE_ACP_PATH: target() }).runTurn(
      makeCtx({ strictApprovals: true, permission: async () => (asked++, 'allow') }),
      r.sink,
    );
    expect(calls('session/set_mode').map((c) => c.params)).toEqual([{ sessionId: 'sess-1', modeId: 'plan' }]);
    // The mode is set before the prompt goes out.
    const order = recorded().map((x) => x.method).filter((m) => m === 'session/set_mode' || m === 'session/prompt');
    expect(order).toEqual(['session/set_mode', 'session/prompt']);
    const prompt = calls('session/prompt')[0].params!.prompt as Array<{ text: string }>;
    expect(prompt[0].text).toContain(READ_ONLY_NOTE);
    expect(fs.existsSync(target())).toBe(false);
    expect(asked).toBe(0);
    // The announced edit stops the turn: it is an error, not a normal reply.
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/tried to change files .*read-only run/);
  });

  it('NEGATIVE: an agent that ignores plan mode is cancelled on the announced edit, before it writes', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'silent-write', FAKE_ACP_PATH: target(), FAKE_ACP_IGNORE_PLAN: '1' }).runTurn(
      makeCtx({ strictApprovals: true }),
      recorder().sink,
    );
    expect(calls('session/cancel').map((c) => c.params)).toEqual([{ sessionId: 'sess-1' }]);
    expect(fs.existsSync(target())).toBe(false);
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/read-only run/);
  });

  it('NEGATIVE: an agent with no read-only mode does not run a strict turn at all', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'silent-write', FAKE_ACP_PATH: target(), FAKE_ACP_NO_PLAN: '1' }).runTurn(
      makeCtx({ strictApprovals: true }),
      recorder().sink,
    );
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/offers no read-only mode, so this unattended run was not started/);
    expect(calls('session/prompt')).toEqual([]);
    expect(calls('session/set_mode')).toEqual([]);
    expect(fs.existsSync(target())).toBe(false);
  });

  it('NEGATIVE: a refused mode switch refuses the turn', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'silent-write', FAKE_ACP_PATH: target(), FAKE_ACP_SET_MODE_FAIL: '1' }).runTurn(
      makeCtx({ strictApprovals: true }),
      recorder().sink,
    );
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/would not switch to its read-only mode/);
    expect(calls('session/prompt')).toEqual([]);
    expect(fs.existsSync(target())).toBe(false);
  });

  it('NEGATIVE: the agent leaving read-only mode on its own stops the turn', async () => {
    const o = await provider({ FAKE_ACP_SCENARIO: 'leave-mode' }).runTurn(makeCtx({ strictApprovals: true }), recorder().sink);
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/left read-only mode \(default\)/);
    expect(calls('session/cancel')).toHaveLength(1);
  });

  it('NEGATIVE: an edit permission request on a read-only turn is refused without asking anyone', async () => {
    let asked = 0;
    await provider({ FAKE_ACP_SCENARIO: 'tool', FAKE_ACP_KIND: 'edit', FAKE_ACP_PATH: path.join(tmp, 'workspace', 'a.txt') }).runTurn(
      makeCtx({ strictApprovals: true, permission: async () => (asked++, 'allow') }),
      recorder().sink,
    );
    expect(asked).toBe(0);
    expect(recorded().find((x) => x.permissionAnswer)!.permissionAnswer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });

  it('a strict turn still asks the broker for shell on a read-only turn', async () => {
    let asked = 0;
    await provider({ FAKE_ACP_SCENARIO: 'tool', FAKE_ACP_KIND: 'execute', FAKE_ACP_COMMAND: 'ls' }).runTurn(
      makeCtx({ strictApprovals: true, permission: async () => (asked++, 'deny') }),
      recorder().sink,
    );
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

describe('ACP adapter: agy reports its limit as answer text (live G11, real capture)', () => {
  const CAPTURE = path.join(HUB, 'src', 'providers', '__fixtures__', 'gemini', 'limit-quota.agy.json');
  type Capture = { updates: Array<{ params: { update: { content: { text: string } } } }>; promptResponse: unknown };
  const capture = () => JSON.parse(fs.readFileSync(CAPTURE, 'utf8')) as Capture;
  /** A capture file shaped like the real one, with these chunk texts as its updates. */
  function captureOf(texts: string[]): string {
    const c = capture();
    const file = path.join(tmp, 'capture-' + String(Math.random()).slice(2) + '.json');
    const tpl = c.updates[0];
    c.updates = texts.map((text) => ({ ...tpl, params: { ...tpl.params, update: { ...tpl.params.update, content: { ...tpl.params.update.content, text } } } }));
    fs.writeFileSync(file, JSON.stringify(c));
    return file;
  }
  const H = 3_600_000;

  it('the captured quota run ends on a usage limit with its reset time, and no warning reaches the room', async () => {
    const r = recorder();
    const before = Date.now();
    const o = await provider({ FAKE_ACP_SCENARIO: 'replay', FAKE_ACP_REPLAY: CAPTURE }).runTurn(makeCtx(), r.sink);
    expect(o.ok).toBe(false);
    expect(o.error).toMatch(/usage limit reached/);
    expect(o.limit?.kind).toBe('usage');
    // The last positive "Resets in" of the capture: 167h47m0s.
    const reset = (167 * 60 + 47) * 60_000;
    expect(o.limit!.resetsAt! - before).toBeGreaterThanOrEqual(reset - 1000);
    expect(o.limit!.resetsAt! - Date.now()).toBeLessThanOrEqual(reset);
    expect(r.only('text')).toEqual([]);
    expect(r.only('delta')).toEqual([]);
  });

  it('only agy retry lines (no quota line) is a limit with no reset, for the default hold', async () => {
    const retries = capture().updates.map((u) => u.params.update.content.text).filter((t) => t.includes('RESOURCE_EXHAUSTED'));
    expect(retries.length).toBeGreaterThan(0);
    const r = recorder();
    const o = await provider({ FAKE_ACP_SCENARIO: 'replay', FAKE_ACP_REPLAY: captureOf(retries) }).runTurn(makeCtx(), r.sink);
    expect(o.ok).toBe(false);
    expect(o.limit).toEqual({ kind: 'usage' });
    expect(r.only('text')).toEqual([]);
  });

  it('a real answer plus the warnings keeps the answer and still records the limit', async () => {
    const r = recorder();
    const o = await provider({ FAKE_ACP_SCENARIO: 'replay', FAKE_ACP_REPLAY: CAPTURE, FAKE_ACP_REPLY: 'Here is the answer.' }).runTurn(makeCtx(), r.sink);
    expect(o.ok).toBe(true);
    expect(o.limit).toBeUndefined();
    expect(r.only('text')).toEqual([['text', 'Here is the answer.']]);
    expect(r.out.some((c) => String(c[1]).includes('⚠'))).toBe(false);
    const limits = r.only('limit');
    expect(limits).toHaveLength(1);
    expect(limits[0][1]).toMatchObject({ status: 'rejected', kind: 'usage' });
    expect((limits[0][1] as { resetsAt: number }).resetsAt - Date.now()).toBeGreaterThan(167 * H);
  });

  it('an answer after agy retried its way through is only a warning, not a hold', async () => {
    const r = recorder();
    const file = captureOf(['\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Resets in 0s.\n']);
    const o = await provider({ FAKE_ACP_SCENARIO: 'replay', FAKE_ACP_REPLAY: file, FAKE_ACP_REPLY: 'Done.' }).runTurn(makeCtx(), r.sink);
    expect(o.ok).toBe(true);
    expect(r.only('text')).toEqual([['text', 'Done.']]);
    expect(r.only('limit')).toEqual([['limit', { status: 'allowed_warning', kind: 'usage' }]]);
  });

  it('NEGATIVE: a bot that talks about quotas and 429s without the agy warning shape is a normal answer', async () => {
    const r = recorder();
    const texts = [
      'Your Individual quota reached its cap last week; RESOURCE_EXHAUSTED (code 429) means you are out of quota. Resets in 2h.',
      '\n⚠ Note: my quota is fine, I checked the 429 docs.\n',
    ];
    const o = await provider({ FAKE_ACP_SCENARIO: 'replay', FAKE_ACP_REPLAY: captureOf(texts) }).runTurn(makeCtx(), r.sink);
    expect(o.ok).toBe(true);
    expect(o.limit).toBeUndefined();
    expect(r.only('limit')).toEqual([]);
    expect(r.only('text')).toEqual([['text', texts.join('')]]);
  });
});

describe('ACP adapter: a model the sign-in does not offer (live G11, Google sign-in)', () => {
  const tier = { FAKE_ACP_SCENARIO: 'quiet', FAKE_ACP_MODEL: 'gemini-3.8-flash-high' };

  it('agy refusing the model (-32602 Unknown model ID) does not fail the turn: its own model runs, noted once', async () => {
    const p = provider({ ...tier, FAKE_ACP_MODELS: 'gemini-3.8-flash-high,gemini-4-neon', FAKE_ACP_REJECT_MODEL: '1' });
    const r = recorder();
    const o = await p.runTurn(makeCtx({ model: 'gemini-4-neon' }), r.sink);
    expect(o.ok).toBe(true);
    expect(r.only('text')).toEqual([['text', 'Hi']]);
    expect(o.model).toBe('gemini-3.8-flash-high');
    expect(calls('session/set_config_option').map((c) => c.params?.value)).toEqual(['gemini-4-neon']);
    expect(r.only('note')).toEqual([['note', 'could not use gemini-4-neon (agy does not offer it on this sign-in), so it ran on gemini-3.8-flash-high.']]);
    // The next turn of the same bot is not noted again.
    const r2 = recorder();
    const o2 = await p.runTurn(makeCtx({ model: 'gemini-4-neon', turnId: 't2' }), r2.sink);
    expect(o2.ok).toBe(true);
    expect(o2.model).toBe('gemini-3.8-flash-high');
    expect(r2.only('note')).toEqual([]);
  });

  it('a model agy does not list in session/new is not asked for; its current one runs and is recorded', async () => {
    const r = recorder();
    const o = await provider(tier).runTurn(makeCtx({ model: 'gemini-4-neon' }), r.sink);
    expect(o.ok).toBe(true);
    expect(calls('session/set_config_option')).toEqual([]);
    expect(o.model).toBe('gemini-3.8-flash-high');
    expect(r.only('note')).toHaveLength(1);
  });

  it('a model agy lists and accepts is applied, with no note', async () => {
    const r = recorder();
    const o = await provider({ ...tier, FAKE_ACP_MODELS: 'gemini-3.8-flash-high,gemini-3.7-flash' }).runTurn(makeCtx({ model: 'gemini-3.7-flash' }), r.sink);
    expect(o.ok).toBe(true);
    expect(calls('session/set_config_option').map((c) => c.params?.value)).toEqual(['gemini-3.7-flash']);
    expect(o.model).toBeUndefined(); // what the bot asked for ran
    expect(r.only('note')).toEqual([]);
  });
});
