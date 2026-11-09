import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { EMPTY_USAGE, type TurnContext, type TurnSink } from './types.js';

/**
 * Token accounting in the Claude adapter, against a scripted SDK stream. Seen live: `total_cost_usd` on a resumed
 * session is the session's running total, so recording it as the turn's cost inflated usage 3-18x and the SDK's
 * own budget check (which compares the same running total) killed turns in 1-2s with 0 tokens.
 */

let script: unknown[] = [];
let seenOptions: Options | undefined;
let interrupted = 0;
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ options }: { options: Options }) => {
    seenOptions = options;
    let stop = false;
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script) {
          if (stop) return;
          yield m;
        }
      },
      interrupt: async () => { interrupted++; stop = true; },
    };
  },
}));

const { ClaudeProvider, runCostUsd, sdkBudgetUsd, callInputTokens, claudeChildEnv, tokenBrakeError } = await import('./claude.js');
const { turnFailureNote } = await import('../agent/turnFailure.js');
const { BASH_MAX_OUTPUT_CHARS, MAX_MCP_OUTPUT_TOKENS } = await import('../config.js');

const usage = (cacheRead: number, input = 10, cacheWrite = 100, output = 50) =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output });
const assistant = (id: string, cacheRead: number, text = 'working') =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { id, usage: usage(cacheRead), content: [{ type: 'text', text }] } });
const result = (total: number, cacheRead: number) => ({
  type: 'result', subtype: 'success', total_cost_usd: total, duration_ms: 5, result: 'done',
  usage: usage(cacheRead), modelUsage: { 'claude-sonnet-5': { costUSD: total } },
});

const sink: TurnSink = { onSession: () => undefined, onDelta: () => undefined, onText: () => undefined, onToolUse: () => undefined, onToolResult: () => undefined, onState: () => undefined };
function ctx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 't1', bot: { id: 'b', handle: 'b', name: 'B', allowedTools: ['Read'] } as never, room: { id: 'r' } as never, members: [],
    systemPrompt: 'sys', input: 'hi', resumeToken: 'sess-1', workspaceDir: process.cwd(), botHome: process.cwd(), tools: [],
    allowedBuiltins: ['Read'], permission: async () => 'allow', model: 'claude-sonnet-5', maxBudgetUsd: 2, maxTurns: 30,
    signal: new AbortController().signal, mcp: { url: '', token: '' }, ...over,
  };
}

beforeEach(() => {
  script = [];
  seenOptions = undefined;
  interrupted = 0;
});

describe('per-run cost from the SDK running total', () => {
  it('subtracts the stored total on a resumed session and offsets the SDK budget flag by it', async () => {
    script = [assistant('m1', 50_000), result(64.987, 50_000)];
    const out = await new ClaudeProvider().runTurn(ctx({ sessionCostUsd: 64.687 }), sink);
    expect(out.costUsd).toBeCloseTo(0.3);
    expect(out.usage.costUsd).toBeCloseTo(0.3);
    expect(out.sessionCostUsd).toBe(64.987);
    // The SDK compares the flag with the running total: $64.687 already spent + $2 for this run.
    expect(seenOptions!.maxBudgetUsd).toBeCloseTo(66.687);
  });

  it('counts the whole total on a fresh session, and leaves the flag out with no budget', async () => {
    script = [result(0.25, 0)];
    const out = await new ClaudeProvider().runTurn(ctx({ resumeToken: null, sessionCostUsd: 64, maxBudgetUsd: Infinity }), sink);
    expect(out.costUsd).toBe(0.25);
    expect(seenOptions!.maxBudgetUsd).toBeUndefined();
  });

  it('pure helpers: legacy baseline, a reset total, no caps', () => {
    expect(runCostUsd(64.687, true, null)).toBe(0); // legacy row: never bill the history to one turn
    expect(runCostUsd(0.4, true, 10)).toBe(0.4); // total went down: the CLI started over
    expect(runCostUsd(1, false, 10)).toBe(1);
    expect(sdkBudgetUsd(2, true, null)).toBeUndefined();
    expect(sdkBudgetUsd(2, true, 5)).toBe(7);
    expect(sdkBudgetUsd(2, false, 5)).toBe(2);
    expect(sdkBudgetUsd(Infinity, true, 5)).toBeUndefined();
  });
});

describe('context size and the token brake', () => {
  it('reports the last top-level call\'s input size, not the run\'s sum', async () => {
    script = [
      assistant('m1', 10_000), assistant('m1', 10_000, 'second block of the same call'),
      { ...assistant('sub', 900_000), parent_tool_use_id: 'task-1' }, // a subagent's call is not this context
      assistant('m2', 30_000), result(0.1, 40_000),
    ];
    const out = await new ClaudeProvider().runTurn(ctx(), sink);
    expect(out.contextTokens).toBe(callInputTokens(usage(30_000)));
    expect(out.braked).toBeUndefined();
  });

  it('interrupts once the running cache-read sum passes the budget, and says so', async () => {
    script = [assistant('m1', 60_000), assistant('m2', 60_000), assistant('m3', 60_000), result(1, 180_000)];
    const out = await new ClaudeProvider().runTurn(ctx({ cacheReadBudget: 100_000 }), sink);
    expect(interrupted).toBe(1);
    expect(out.braked).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^token_budget: stopped after reading 120,000 cached tokens/);
    // No result arrived: what the calls reported is counted.
    expect(out.usage.cacheReadTokens).toBe(120_000);
    // Filed as external, not as a bot behaviour failure.
    expect(turnFailureNote('B', out.error!, false).payload.turnFailure).toBe('external');
    expect(tokenBrakeError(1, 2)).toContain('cap 2');
  });

  it('applies with no dollar budget at all', async () => {
    script = [assistant('m1', 200_000), result(1, 200_000)];
    const out = await new ClaudeProvider().runTurn(ctx({ maxBudgetUsd: Infinity, cacheReadBudget: 100_000 }), sink);
    expect(out.braked).toBe(true);
  });
});

describe('tool output caps and the subagent tool', () => {
  it('passes the caps to the child without forwarding anything outside the allowlist', () => {
    const env = claudeChildEnv({ PATH: '/bin', POCKETROCKET_TOKEN: 'secret', OPENAI_API_KEY: 'k' });
    expect(env.BASH_MAX_OUTPUT_LENGTH).toBe(String(BASH_MAX_OUTPUT_CHARS));
    expect(env.MAX_MCP_OUTPUT_TOKENS).toBe(String(MAX_MCP_OUTPUT_TOKENS));
    expect(env.POCKETROCKET_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('sets the inline Bash cap and keeps Task off unless the bot has it', async () => {
    script = [result(0, 0)];
    await new ClaudeProvider().runTurn(ctx(), sink);
    expect((seenOptions!.settings as { bashOutputMaxChars?: number }).bashOutputMaxChars).toBe(BASH_MAX_OUTPUT_CHARS);
    expect(seenOptions!.tools).toEqual(['Read']);
    expect(seenOptions!.disallowedTools).toEqual(expect.arrayContaining(['Task', 'Agent']));
    expect(seenOptions!.settingSources).toEqual([]);

    await new ClaudeProvider().runTurn(ctx({ allowedBuiltins: ['Read', 'Task'] }), sink);
    expect(seenOptions!.tools).toEqual(['Read', 'Task', 'Agent']);
    expect(seenOptions!.disallowedTools).not.toContain('Agent');
  });
});

void EMPTY_USAGE;
