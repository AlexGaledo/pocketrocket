import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrokProvider, GROK_INFO, GROK_MODELS, type Probe } from './grok.js';
import type { TurnContext, TurnSink } from './types.js';
import { buildArgs, denyRules, grokConfigToml, ensureGrokHome, parseModelsOutput, removeAuthMirror, removeRulesFile, writeRulesFile } from './grok/cli.js';
import { NdjsonParser, renderToolOutput, tokensFrom } from './grok/stream.js';
import { estimateCostUsd, rateFor } from './grok/pricing.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-fixtures', 'grok');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-grok-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- a fake `grok` process: records argv/env, replays a fixture on stdout ----------

interface FakeRun {
  exe: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

function fakeCli(output: string, opts: { code?: number; stderr?: string; chunkSize?: number } = {}) {
  const runs: FakeRun[] = [];
  const spawn = ((exe: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
    runs.push({ exe, args, env: o?.env ?? {}, cwd: o?.cwd });
    const child = new EventEmitter() as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    (child as unknown as { pid: number }).pid = 4242;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    setTimeout(() => {
      const size = opts.chunkSize ?? output.length;
      for (let i = 0; i < output.length; i += size) child.stdout.write(output.slice(i, i + size));
      if (opts.stderr) child.stderr.write(opts.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', opts.code ?? 0);
    }, 0);
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;
  return { spawn, runs };
}

interface Recorded {
  sessions: string[];
  deltas: string[];
  texts: string[];
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ id: string; output: string; isError: boolean }>;
  states: string[];
}

function recorder(): { sink: TurnSink; rec: Recorded } {
  const rec: Recorded = { sessions: [], deltas: [], texts: [], toolUses: [], toolResults: [], states: [] };
  const sink: TurnSink = {
    onSession: (t) => rec.sessions.push(t),
    onDelta: (t) => rec.deltas.push(t),
    onText: (t) => rec.texts.push(t),
    onToolUse: (id, name, input) => rec.toolUses.push({ id, name, input }),
    onToolResult: (id, output, isError) => rec.toolResults.push({ id, output, isError }),
    onState: (s) => rec.states.push(s),
  };
  return { sink, rec };
}

function turnCtx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 't1',
    bot: { handle: 'nova' } as TurnContext['bot'],
    room: { id: 'r1' } as TurnContext['room'],
    members: [],
    systemPrompt: 'You are Nova.',
    input: 'hello',
    resumeToken: null,
    workspaceDir: path.join(tmp, 'workspace'),
    botHome: path.join(tmp, 'bots', 'b1'),
    tools: [],
    allowedBuiltins: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
    permission: async () => 'allow',
    model: 'grok-4.6',
    maxBudgetUsd: 5,
    maxTurns: 40,
    signal: new AbortController().signal,
    mcp: { url: 'http://127.0.0.1:7788/mcp', token: 'tok-abc' },
    ...over,
  };
}

const provider = (deps: ConstructorParameters<typeof GrokProvider>[0]) =>
  new GrokProvider({ home: path.join(tmp, 'grok-home'), exe: 'grok-fake', secrets: { get: () => null }, ...deps });

// ---------- pure parsers ----------

describe('grok streaming-json parser', () => {
  it('splits NDJSON across arbitrary chunk boundaries and ignores junk', () => {
    const p = new NdjsonParser();
    const events = [
      ...p.push('{"type":"te'),
      ...p.push('xt","data":"hi"}\nnot json\n{"type":"end","sessionId":"s1"}'),
      ...p.flush(),
    ];
    expect(events.map((e) => e.type)).toEqual(['text', 'end']);
    expect((events[1] as { sessionId?: string }).sessionId).toBe('s1');
  });

  it('maps usage blocks onto the hub token counts', () => {
    expect(tokensFrom({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })).toEqual({
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
    });
    expect(tokensFrom(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('renders rawOutput, falling back to content', () => {
    expect(renderToolOutput({ rawOutput: 'plain' })).toBe('plain');
    expect(renderToolOutput({ rawOutput: { lines: 42 } })).toBe('{"lines":42}');
    expect(renderToolOutput({ content: ['a'] })).toBe('["a"]');
    expect(renderToolOutput({})).toBe('');
  });
});

describe('grok pricing', () => {
  it('prices the documented models and falls back to grok-4.6 rates', () => {
    expect(rateFor('grok-build-0.1')).toEqual({ input: 1, cachedInput: 0.2, output: 2 });
    expect(rateFor('grok-4.6-2026-09-01')).toEqual(rateFor('grok-4.6'));
    expect(rateFor('who-knows')).toEqual(rateFor('grok-4.6'));
  });

  it('bills cache reads at the discounted rate and cache writes at the input rate', () => {
    const cost = estimateCostUsd('grok-4.6', {
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2 + 6 + 0.5 + 2, 6);
  });
});

describe('grok CLI wiring', () => {
  it('denies exactly the rule classes no allowed built-in maps to', () => {
    expect(denyRules(['Read', 'Grep', 'Glob'])).toEqual(['Bash', 'Edit', 'WebFetch', 'WebSearch', 'Write']);
    expect(denyRules(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'])).toEqual([]);
    expect(denyRules([])).toEqual(['Bash', 'Edit', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write']);
  });

  it('builds a headless argv with structured output, cwd, model, rules and resume', () => {
    const args = buildArgs({
      prompt: 'hi', rules: 'SEE RULES FILE', model: 'grok-4.6', cwd: '/ws', maxTurns: 7,
      resumeToken: 'sess-1', allowedBuiltins: ['Read'], sandbox: null,
    });
    expect(args.slice(0, 4)).toEqual(['-p', 'hi', '--output-format', 'streaming-json']);
    expect(args).toContain('--always-approve');
    expect(args[args.indexOf('--cwd') + 1]).toBe('/ws');
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.6');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('7');
    expect(args[args.indexOf('--rules') + 1]).toBe('SEE RULES FILE');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('--deny');
  });

  it('omits --resume for a fresh session and honours an explicit sandbox profile', () => {
    const args = buildArgs({
      prompt: 'hi', rules: 'SEE RULES FILE', model: 'grok-4.6', cwd: '/ws', maxTurns: 1,
      resumeToken: null, allowedBuiltins: [], sandbox: 'workspace',
    });
    expect(args).not.toContain('--resume');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace');
  });

  it('writes a config.toml whose MCP credentials are env placeholders, not the live token', () => {
    const home = ensureGrokHome(path.join(tmp, 'cfg-home'));
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(toml).toBe(grokConfigToml());
    expect(toml).toContain('[mcp_servers.pocketrocket]');
    expect(toml).toContain('url = "${POCKETROCKET_MCP_URL}"');
    expect(toml).toContain('Bearer ${POCKETROCKET_MCP_TOKEN}');
  });

  // ---- audit 2026-09-09, B19 ----
  it('keeps the system prompt and memory off the command line', () => {
    const home = path.join(tmp, 'rules-home');
    fs.mkdirSync(home, { recursive: true });
    const prompt = ['# You are Nova', '', '## Memory', 'The API key for staging is hunter2.'].join('\n');
    const { path: file, rules } = writeRulesFile('turn-abc', prompt, home);

    expect(fs.readFileSync(file, 'utf8')).toBe(prompt);
    expect(file).toBe(path.join(home, 'rules', 'turn-abc.md'));
    // The value that lands in argv names the file; it never carries the prompt or the memory.
    expect(rules).toContain(file);
    expect(rules).not.toContain('hunter2');
    expect(rules).not.toContain('You are Nova');
    if (process.platform !== 'win32') expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');

    const args = buildArgs({ prompt: 'hi', rules, model: 'grok-4.6', cwd: '/ws', maxTurns: 1, resumeToken: null, allowedBuiltins: [], sandbox: null });
    expect(args.join(' ')).not.toContain('hunter2');

    removeRulesFile(file);
    expect(fs.existsSync(file)).toBe(false);
    removeRulesFile(null);
  });

  it('sanitizes the turn id used as the rules filename', () => {
    const home = path.join(tmp, 'rules-home-2');
    fs.mkdirSync(home, { recursive: true });
    const { path: file } = writeRulesFile('../../evil', 'x', home);
    expect(path.dirname(file)).toBe(path.join(home, 'rules'));
    expect(path.basename(file)).toBe('evil.md');
  });

  // ---- audit 2026-09-09, B18 ----
  it('mirrors auth.json 0600 into the private home and deletes it on shutdown', () => {
    const userHome = path.join(tmp, 'user-grok');
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, 'auth.json'), '{"refresh_token":"secret"}');
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = userHome;
    try {
      const home = ensureGrokHome(path.join(tmp, 'mirror-home'));
      const mirror = path.join(home, 'auth.json');
      expect(fs.existsSync(mirror)).toBe(true);
      // It lives under the hub's private grok home, never next to the workspace.
      expect(path.dirname(mirror)).toBe(home);
      if (process.platform !== 'win32') expect((fs.statSync(mirror).mode & 0o777).toString(8)).toBe('600');
      removeAuthMirror(home);
      expect(fs.existsSync(mirror)).toBe(false);
      // The user's own credentials are untouched.
      expect(fs.existsSync(path.join(userHome, 'auth.json'))).toBe(true);
      // Never deletes the user's file when the two paths coincide.
      removeAuthMirror(userHome);
      expect(fs.existsSync(path.join(userHome, 'auth.json'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it('parses `grok models` output and its unauthenticated banner', () => {
    const signedOut = parseModelsOutput('You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n');
    expect(signedOut).toEqual({ ids: ['grok-4.6', 'grok-4.5'], defaultId: 'grok-4.6', authenticated: false });
    expect(parseModelsOutput('Available models:\n  * grok-4.6 (default)\n').authenticated).toBe(true);
  });
});

// ---------- check() / models() ----------

describe('grok check()', () => {
  const probeOk = async (_e: string, args: string[]): Promise<Probe> =>
    args[0] === '--version' ? { stdout: 'grok 1.0.13 (5e9a5852)\n' } : { stdout: 'Available models:\n  * grok-4.6 (default)\n' };

  it('reports the missing CLI with an install hint', async () => {
    const check = await provider({ probe: async () => ({ stdout: '', error: 'spawn grok ENOENT' }) }).check();
    expect(check.ok).toBe(false);
    expect(check.auth).toBe('none');
    expect(check.hint).toContain('x.ai/cli/install');
    expect(check.hint).toContain('grok login');
  });

  it('reports apiKey auth when XAI_API_KEY resolves', async () => {
    const p = provider({ probe: probeOk, secrets: { get: (k: string) => (k === 'XAI_API_KEY' ? 'xai-test' : null) } });
    expect(await p.check()).toMatchObject({ ok: true, auth: 'apiKey', version: 'grok 1.0.13 (5e9a5852)' });
  });

  it('falls back to `grok models` to tell a subscription login from no login', async () => {
    const signedIn = await provider({ probe: probeOk }).check();
    expect(signedIn).toMatchObject({ ok: true, auth: 'subscription' });

    const signedOut = await provider({
      probe: async (_e, args) =>
        args[0] === '--version' ? { stdout: 'grok 1.0.13\n' } : { stdout: 'You are not authenticated.\n\n  * grok-4.6 (default)\n' },
    }).check();
    expect(signedOut).toMatchObject({ ok: false, auth: 'none', error: 'Not signed in to Grok' });
  });

  it('models() prefers the CLI list and caches it; modelsSync() falls back to the static list', async () => {
    let calls = 0;
    const p = provider({
      probe: async () => {
        calls++;
        return { stdout: 'Available models:\n  * grok-4.5 (default)\n  - grok-4.3\n' };
      },
    });
    expect(p.modelsSync()).toEqual(GROK_MODELS);
    const models = await p.models();
    expect(models.map((m) => m.id)).toEqual(['grok-4.5', 'grok-4.3']);
    expect(models[0]).toMatchObject({ label: 'Grok 4.5', default: true });
    await p.models();
    expect(calls).toBe(1);
    expect(p.modelsSync()).toEqual(models);
  });

  it('keeps the static list when the CLI answers nothing usable', async () => {
    const p = provider({ probe: async () => ({ stdout: '', error: 'ENOENT' }) });
    expect(await p.models()).toEqual(GROK_MODELS);
  });
});

// ---------- runTurn() ----------

describe('grok runTurn()', () => {
  it('streams a text turn into the sink and reports the CLI-stamped cost', async () => {
    const cli = fakeCli(fixture('text-turn.jsonl'), { chunkSize: 7 });
    const { sink, rec } = recorder();
    const outcome = await provider({ spawn: cli.spawn }).runTurn(turnCtx(), sink);

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(rec.deltas.join('')).toBe("Here's a summary");
    expect(rec.texts).toEqual(["Here's a summary"]);
    expect(rec.sessions).toEqual(['3f2a1c88-0000-4000-8000-000000000001']);
    // total_cost_usd from the `end` event wins over the local estimate.
    expect(outcome.costUsd).toBe(0.0018886);
    expect(outcome.usage).toMatchObject({ inputTokens: 812, outputTokens: 45, costUsd: 0.0018886 });
  });

  it('passes cwd, model, resume, deny rules and the per-turn MCP token through argv and env', async () => {
    const cli = fakeCli(fixture('text-turn.jsonl'));
    const { sink } = recorder();
    const ctx = turnCtx({ resumeToken: 'prev-session', model: 'grok-build-0.1', allowedBuiltins: ['Read', 'Grep'] });
    await provider({ spawn: cli.spawn }).runTurn(ctx, sink);

    const run = cli.runs[0];
    expect(run.exe).toBe('grok-fake');
    expect(run.cwd).toBe(ctx.workspaceDir);
    expect(run.args[run.args.indexOf('--cwd') + 1]).toBe(ctx.workspaceDir);
    expect(run.args[run.args.indexOf('-m') + 1]).toBe('grok-build-0.1');
    expect(run.args[run.args.indexOf('--resume') + 1]).toBe('prev-session');
    // The system prompt is NOT on the command line any more (audit 2026-09-09, B19): --rules carries a
    // pointer at a 0600 file inside the private grok home, and the file is deleted when the turn ends.
    const rules = run.args[run.args.indexOf('--rules') + 1];
    expect(rules).not.toContain(ctx.systemPrompt);
    expect(rules).toContain(path.join(tmp, 'grok-home', 'rules'));
    expect(fs.existsSync(path.join(tmp, 'grok-home', 'rules', ctx.turnId + '.md'))).toBe(false);
    const denied = run.args.filter((a, i) => run.args[i - 1] === '--deny');
    expect(denied).toEqual(['Bash', 'Edit', 'WebFetch', 'WebSearch', 'Write']);
    // The bearer token rides the environment so concurrent turns never race on config.toml.
    expect(run.env.POCKETROCKET_MCP_URL).toBe(ctx.mcp.url);
    expect(run.env.POCKETROCKET_MCP_TOKEN).toBe(ctx.mcp.token);
    expect(run.env.GROK_HOME).toBe(path.join(tmp, 'grok-home'));
    expect(run.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
  });

  it('turns tool_call / tool_call_update into chips and estimates cost when none is stamped', async () => {
    const cli = fakeCli(fixture('tool-turn.jsonl'));
    const { sink, rec } = recorder();
    const outcome = await provider({ spawn: cli.spawn }).runTurn(turnCtx(), sink);

    expect(rec.toolUses.map((t) => [t.id, t.name])).toEqual([
      ['call_1', 'read_file'],
      ['call_2', 'pocketrocket__request_approval'],
    ]);
    expect(rec.toolUses[0].input).toEqual({ path: 'src/main.rs' });
    expect(rec.toolResults).toEqual([
      { id: 'call_1', output: '{"lines":42}', isError: false },
      { id: 'call_2', output: 'denied by the user', isError: true },
    ]);
    // Text is flushed before each tool chip, so the chips land between the assistant blocks.
    expect(rec.texts).toEqual(['Let me read the file.', 'Done.']);
    expect(rec.states).toContain('working');
    // No total_cost_usd on `end` (OAuth traffic): the adapter estimates from grok-4.6 rates.
    expect(outcome.usage).toMatchObject({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 50 });
    expect(outcome.costUsd).toBeCloseTo(
      estimateCostUsd('grok-4.6', { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 50 }),
      12,
    );
    expect(outcome.ok).toBe(true);
  });

  it('stops the turn once the running estimate passes the budget', async () => {
    const expensive =
      '{"type":"usage","usage":{"input_tokens":100000000,"output_tokens":100000000}}\n' +
      '{"type":"end","stopReason":"cancelled","sessionId":"s-budget"}\n';
    const cli = fakeCli(expensive);
    const { sink } = recorder();
    const outcome = await provider({ spawn: cli.spawn }).runTurn(turnCtx({ maxBudgetUsd: 0.5 }), sink);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('Budget of $0.50 exhausted');
  });

  it('surfaces an `error` event and a non-zero exit', async () => {
    const cli = fakeCli('{"type":"error","message":"Couldn\'t start session: bad key"}\n', { code: 1 });
    const { sink } = recorder();
    const outcome = await provider({ spawn: cli.spawn }).runTurn(turnCtx(), sink);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("Couldn't start session: bad key");
  });

  it('reports a bare non-zero exit with the tail of stderr', async () => {
    const cli = fakeCli('', { code: 1, stderr: 'error: unknown flag\n' });
    const { sink } = recorder();
    const outcome = await provider({ spawn: cli.spawn }).runTurn(turnCtx(), sink);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('grok exited with code 1');
    expect(outcome.error).toContain('unknown flag');
  });

  it('reads exit 130/143 as an interrupt, and interrupt() only knows live turns', async () => {
    const cli = fakeCli('', { code: 130 });
    const p = provider({ spawn: cli.spawn });
    expect(p.interrupt('t1')).toBe(false);
    const { sink } = recorder();
    const outcome = await p.runTurn(turnCtx(), sink);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('Interrupted');
    expect(p.interrupt('t1')).toBe(false);
  });

  it('keeps the provider metadata the picker and registry rely on', () => {
    expect(GROK_INFO).toMatchObject({ id: 'grok', permissions: 'best-effort', secretKeys: ['XAI_API_KEY'] });
    expect(GROK_MODELS.filter((m) => m.default).map((m) => m.id)).toEqual(['grok-4.6']);
  });
});
