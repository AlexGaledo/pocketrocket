import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bot, Room } from '@pocketrocket/shared';
import { buildCodexArgs, buildCodexPrompt, createCodexProvider, parseAuth } from './codex.js';
import { EMPTY_USAGE, type TurnContext, type TurnSink } from './types.js';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(HUB, 'test-fixtures', 'codex');
const FAKE_EXE = path.join(FIXTURES, 'fake-codex.mjs');

const KNOBS = ['FAKE_CODEX_RECORD', 'FAKE_CODEX_STREAM', 'FAKE_CODEX_EXIT', 'FAKE_CODEX_STDERR', 'FAKE_CODEX_HANG', 'FAKE_CODEX_LOGIN'];

let tmp: string;
let recordPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-codex-'));
  recordPath = path.join(tmp, 'record.json');
  process.env.FAKE_CODEX_RECORD = recordPath;
});
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const sink: TurnSink = {
    onSession: (t) => calls.push(['session', t]),
    onDelta: (t) => calls.push(['delta', t]),
    onText: (t) => calls.push(['text', t]),
    onToolUse: (id, name, input) => calls.push(['use', id, name, input]),
    onToolResult: (id, out, isError) => calls.push(['result', id, out, isError]),
    onState: (s) => calls.push(['state', s]),
  };
  return { calls, sink, only: (kind: string) => calls.filter((c) => c[0] === kind) };
}

function makeCtx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 't1',
    bot: { id: 'b1', handle: 'nova', name: 'Nova' } as Bot,
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
    model: 'gpt-5.6-terra',
    maxBudgetUsd: 5,
    maxTurns: 40,
    signal: new AbortController().signal,
    mcp: { url: 'http://127.0.0.1:7788/mcp', token: 'tok-abc123' },
    ...over,
  };
}

function provider(secretKey: string | null = null) {
  return createCodexProvider({ exe: FAKE_EXE, secrets: { get: () => secretKey } });
}

function readRecord(): { argv: string[]; stdin: string; cwd: string; token: string | null; apiKey: string | null } {
  return JSON.parse(fs.readFileSync(recordPath, 'utf8')) as never;
}

/** The value of the flag that follows `name` in argv. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

describe('codex argv + prompt', () => {
  const base = {
    workspaceDir: 'C:\\ws',
    botHome: 'C:\\bots\\b1',
    model: 'gpt-5.6-terra',
    mcpUrl: 'http://127.0.0.1:7788/mcp',
    resumeToken: null,
    readOnly: false,
  };

  it('builds a fresh-thread command line with the MCP override', () => {
    expect(buildCodexArgs(base)).toEqual([
      'exec', '--json', '--skip-git-repo-check',
      '-C', 'C:\\ws', '-m', 'gpt-5.6-terra',
      '--sandbox', 'workspace-write',
      '--ask-for-approval', 'never',
      '-c', 'mcp_servers.pocketrocket.url="http://127.0.0.1:7788/mcp"',
      '-c', 'mcp_servers.pocketrocket.bearer_token_env_var="POCKETROCKET_MCP_TOKEN"',
      '-c', 'sandbox_workspace_write.writable_roots=["C:\\\\bots\\\\b1"]',
      '-',
    ]);
  });

  it('resumes a thread and drops writable_roots when the bot has no shell', () => {
    const args = buildCodexArgs({ ...base, resumeToken: 'thread-9', readOnly: true });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(flag(args, '--sandbox')).toBe('read-only');
    expect(args.some((a) => a.startsWith('sandbox_workspace_write'))).toBe(false);
    expect(args[args.length - 1]).toBe('-');
  });

  it('sends the system prompt only on a fresh thread', () => {
    const bot = { handle: 'nova' } as Bot;
    expect(buildCodexPrompt({ systemPrompt: 'RULES', input: 'hi', resumeToken: null, bot })).toBe('RULES\n\n---\n\nhi');
    const resumed = buildCodexPrompt({ systemPrompt: 'RULES', input: 'hi', resumeToken: 'x', bot });
    expect(resumed).not.toContain('RULES');
    expect(resumed).toContain('@nova');
    expect(resumed).toContain('NO_REPLY');
    expect(resumed.endsWith('hi')).toBe(true);
  });
});

describe('codex check()', () => {
  it('reports the CLI version and a ChatGPT login', async () => {
    process.env.FAKE_CODEX_LOGIN = 'chatgpt';
    expect(await provider().check()).toEqual({
      ok: true,
      auth: 'subscription',
      version: 'codex-cli 0.153.2',
      hint: expect.stringContaining('npm i -g @openai/codex'),
    });
  });

  it('reports an API-key login', async () => {
    process.env.FAKE_CODEX_LOGIN = 'apikey';
    expect(await provider().check()).toMatchObject({ ok: true, auth: 'apiKey' });
  });

  it('fails when the CLI is installed but logged out', async () => {
    process.env.FAKE_CODEX_LOGIN = 'none';
    expect(await provider().check()).toMatchObject({ ok: false, auth: 'none', error: 'codex is installed but not logged in' });
  });

  it('falls back to a stored OPENAI_API_KEY when the CLI has no login', async () => {
    process.env.FAKE_CODEX_LOGIN = 'none';
    expect(await provider('sk-stored').check()).toMatchObject({ ok: true, auth: 'apiKey' });
  });

  it('reports a missing binary with install + login instructions', async () => {
    const missing = createCodexProvider({ exe: path.join(FIXTURES, 'nope.mjs'), secrets: { get: () => null } });
    const check = await missing.check();
    expect(check.ok).toBe(false);
    expect(check.hint).toContain('codex login');
  });

  it('parseAuth prefers what the CLI says over the stored key', () => {
    expect(parseAuth(true, 'Logged in using an API key', false)).toBe('apiKey');
    expect(parseAuth(true, 'Logged in using ChatGPT (alex@example.com)', true)).toBe('subscription');
    expect(parseAuth(false, 'Not logged in', true)).toBe('apiKey');
    expect(parseAuth(false, 'Not logged in', false)).toBe('none');
  });
});

describe('codex runTurn()', () => {
  it('spawns the CLI with the right argv, cwd, stdin and MCP token', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'simple.jsonl');
    const r = recorder();
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });

    const out = await provider('sk-live').runTurn(ctx, r.sink);
    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();

    const rec = readRecord();
    expect(rec.argv).toContain('exec');
    expect(rec.argv).toContain('--json');
    expect(flag(rec.argv, '-C')).toBe(ctx.workspaceDir);
    expect(flag(rec.argv, '-m')).toBe('gpt-5.6-terra');
    expect(flag(rec.argv, '--sandbox')).toBe('workspace-write');
    expect(flag(rec.argv, '--ask-for-approval')).toBe('never');
    expect(rec.argv).toContain('mcp_servers.pocketrocket.url="http://127.0.0.1:7788/mcp"');
    expect(rec.argv).toContain('mcp_servers.pocketrocket.bearer_token_env_var="POCKETROCKET_MCP_TOKEN"');
    expect(rec.argv).toContain('sandbox_workspace_write.writable_roots=[' + JSON.stringify(ctx.botHome) + ']');
    expect(rec.argv[rec.argv.length - 1]).toBe('-');
    expect(rec.stdin).toBe('SYSTEM PROMPT\n\n---\n\nhello there');
    expect(rec.token).toBe('tok-abc123');
    expect(rec.apiKey).toBe('sk-live');
    expect(path.resolve(rec.cwd)).toBe(path.resolve(ctx.workspaceDir));
  });

  it('turns the stream into sink calls and an estimated cost', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'simple.jsonl');
    const r = recorder();
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });

    const out = await provider().runTurn(ctx, r.sink);
    expect(r.only('session')).toEqual([['session', '0199a213-81c0-7800-8aa1-bbab2a035a53']]);
    expect(r.only('text')).toEqual([['text', 'pong']]);
    expect(out.costUsd).toBeCloseTo(0.006984, 6);
    // input_tokens includes the cache reads; the hub splits them into two columns.
    expect(out.usage.inputTokens).toBe(315);
    expect(out.usage.cacheReadTokens).toBe(24448);
    expect(out.usage.outputTokens).toBe(122);
    expect(out.usage.costUsd).toBe(out.costUsd);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes the resume token and skips the system prompt on a follow-up turn', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'simple.jsonl');
    const ctx = makeCtx({ resumeToken: 'thread-42' });
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    await provider().runTurn(ctx, recorder().sink);

    const rec = readRecord();
    expect(rec.argv.slice(0, 3)).toEqual(['exec', 'resume', 'thread-42']);
    expect(rec.stdin).not.toContain('SYSTEM PROMPT');
    expect(rec.stdin).toContain('@nova');
  });

  it('drops the sandbox to read-only for a bot without Bash', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'simple.jsonl');
    const ctx = makeCtx({ allowedBuiltins: ['Read', 'Glob'] });
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    await provider().runTurn(ctx, recorder().sink);
    expect(flag(readRecord().argv, '--sandbox')).toBe('read-only');
  });

  it('reports tool chips from a stream with shell, file and MCP items', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'tools.jsonl');
    const r = recorder();
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const out = await provider().runTurn(ctx, r.sink);
    expect(out.ok).toBe(true);
    expect(r.only('use').map((c) => c[2])).toEqual([
      'Bash', 'Bash', 'Write', 'Edit', 'mcp__pocketrocket__send_message', 'mcp__pocketrocket__request_approval',
    ]);
  });

  it('fails the turn on turn.failed', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'failed.jsonl');
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const out = await provider().runTurn(ctx, recorder().sink);
    expect(out.ok).toBe(false);
    expect(out.error).toBe('model response stream ended unexpectedly');
    expect(out.costUsd).toBe(0);
  });

  it('surfaces a non-zero exit with the tail of stderr', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'simple.jsonl');
    process.env.FAKE_CODEX_EXIT = '3';
    process.env.FAKE_CODEX_STDERR = 'error: unexpected argument --ask-for-approval';
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const out = await provider().runTurn(ctx, recorder().sink);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('codex exited with code 3');
    expect(out.error).toContain('unexpected argument');
  });

  it('fails when the CLI exits cleanly without completing a turn', async () => {
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const out = await provider().runTurn(ctx, recorder().sink);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('without a turn.completed');
  });

  it('kills the process and reports a budget breach', async () => {
    process.env.FAKE_CODEX_STREAM = path.join(FIXTURES, 'simple.jsonl');
    const ctx = makeCtx({ maxBudgetUsd: 0.0001 });
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const out = await provider().runTurn(ctx, recorder().sink);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('budget exceeded');
    // The usage that blew the budget is still reported so it lands in the ledger.
    expect(out.usage.outputTokens).toBe(122);
  });

  it('interrupt() tree-kills a running turn', async () => {
    process.env.FAKE_CODEX_HANG = '1';
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const p = provider();
    const running = p.runTurn(ctx, recorder().sink);
    for (let i = 0; i < 100 && !p.interrupt(ctx.turnId); i++) await new Promise((r) => setTimeout(r, 20));
    const out = await running;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('interrupted');
    expect(p.interrupt(ctx.turnId)).toBe(false); // no longer registered
  }, 20000);

  it('aborting ctx.signal stops the turn the same way', async () => {
    process.env.FAKE_CODEX_HANG = '1';
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const p = provider();
    const running = p.runTurn(ctx, recorder().sink);
    // The fake writes its record right after it has read the prompt, i.e. once the child is really up.
    for (let i = 0; i < 100 && !fs.existsSync(recordPath); i++) await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const out = await running;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('interrupted');
  }, 20000);

  it('reports a missing binary instead of throwing', async () => {
    const missing = createCodexProvider({ exe: path.join(FIXTURES, 'nope.mjs'), secrets: { get: () => null } });
    const ctx = makeCtx();
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    const out = await missing.runTurn(ctx, recorder().sink);
    expect(out.ok).toBe(false);
    expect(out.costUsd).toBe(0);
    expect(out.usage.inputTokens).toBe(EMPTY_USAGE.inputTokens);
  });
});
