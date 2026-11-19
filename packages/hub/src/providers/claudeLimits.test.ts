import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { LimitReport, TurnContext, TurnSink } from './types.js';

/**
 * M5 (spec 01 P0-1, P0-4): plan limits and the overload fallback in the Claude adapter, against scripted SDK streams.
 * The fixtures are SYNTHETIC (built from the SDK's .d.ts). TODO(owner): add a stream captured on Claude Max.
 */

let script: unknown[] = [];
let seenOptions: Options | undefined;
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
      interrupt: async () => { stop = true; },
      close: () => { stop = true; },
    };
  },
}));

const { ClaudeProvider, fallbackModelFor, ranModel, resetMs, limitReport, retryLimitKind } = await import('./claude.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'claude');
const fixture = (name: string) => (JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as { messages: unknown[] }).messages;

function recorder() {
  const texts: string[] = [];
  const deltas: string[] = [];
  const limits: LimitReport[] = [];
  const sink: TurnSink = {
    onSession: () => undefined, onDelta: (t) => deltas.push(t), onText: (t) => texts.push(t),
    onToolUse: () => undefined, onToolResult: () => undefined, onState: () => undefined, onLimit: (r) => limits.push(r),
  };
  return { sink, texts, deltas, limits };
}

function ctx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 't1', bot: { id: 'b', handle: 'b', name: 'B', allowedTools: ['Read'] } as never, room: { id: 'r' } as never, members: [],
    systemPrompt: 'sys', input: 'hi', resumeToken: null, workspaceDir: process.cwd(), botHome: process.cwd(), tools: [],
    allowedBuiltins: ['Read'], permission: async () => 'allow', model: 'claude-sonnet-5', maxBudgetUsd: 2, maxTurns: 30,
    signal: new AbortController().signal, mcp: { url: '', token: '' }, ...over,
  };
}

const ok = (text = 'Done.', model = 'claude-sonnet-5') => [
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'm-ok', model, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 5, usage: {}, modelUsage: {} },
];

beforeEach(() => {
  script = [];
  seenOptions = undefined;
});

describe('P0-1: a rejected limit ends the turn as a limit', () => {
  it('maps the rejected event and the synthetic error message to ok:false with a structured limit', async () => {
    script = fixture('limit-rejected.synthetic.json');
    const r = recorder();
    const out = await new ClaudeProvider().runTurn(ctx(), r.sink);
    expect(out.ok).toBe(false);
    expect(out.limit).toEqual({ kind: 'usage', resetsAt: 1795442400 * 1000, window: 'five_hour' });
    expect(out.error).toMatch(/usage limit/);
    // The CLI's own wording (which here even carries an @mention) is never handed on as the bot's reply.
    expect(r.texts).toEqual([]);
    expect(out.error).not.toMatch(/@everyone|hit your limit/);
    expect(r.limits).toEqual([{ status: 'rejected', kind: 'usage', window: 'five_hour', resetsAt: 1795442400 * 1000, utilization: 1 }]);
  });

  it('an assistant rate_limit error alone (no event) is still a usage limit, with no reset time', async () => {
    script = fixture('limit-rejected.synthetic.json').filter((m) => (m as { type: string }).type !== 'rate_limit_event');
    const r = recorder();
    const out = await new ClaudeProvider().runTurn(ctx(), r.sink);
    expect(out.ok).toBe(false);
    expect(out.limit).toStrictEqual({ kind: 'usage' });
    expect(r.texts).toEqual([]);
  });

  it('a rejected event alone, on a result the CLI called a success, is still ok:false', async () => {
    const [, event, , result] = fixture('limit-rejected.synthetic.json');
    script = [event, { ...(result as object), is_error: false }];
    const out = await new ClaudeProvider().runTurn(ctx(), recorder().sink);
    expect(out.ok).toBe(false);
    expect(out.limit?.kind).toBe('usage');
  });

  it('a real answer after the rejection means the CLI got through: no limit', async () => {
    const [, event] = fixture('limit-rejected.synthetic.json');
    script = [event, ...ok()];
    const r = recorder();
    const out = await new ClaudeProvider().runTurn(ctx(), r.sink);
    expect(out.ok).toBe(true);
    expect(out.limit).toBeUndefined();
    expect(r.texts).toEqual(['Done.']);
  });

  it('allowed_warning only records utilization: the turn runs and reports no limit', async () => {
    script = fixture('limit-warning.synthetic.json');
    const r = recorder();
    const out = await new ClaudeProvider().runTurn(ctx(), r.sink);
    expect(out.ok).toBe(true);
    expect(out.limit).toBeUndefined();
    expect(r.texts).toEqual(['Done.']);
    expect(r.limits).toEqual([{ status: 'allowed_warning', kind: 'usage', window: 'five_hour', resetsAt: 1795442400 * 1000, utilization: 0.82 }]);
  });

  it('a rejected window that extra usage still pays for is a warning, not a stop', () => {
    expect(limitReport({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed', resetsAt: 10 }).status).toBe('allowed_warning');
    expect(limitReport({ status: 'rejected', rateLimitType: 'overage', overageStatus: 'allowed' }).status).toBe('rejected');
    expect(limitReport({ status: 'rejected', rateLimitType: 'seven_day', overageStatus: 'rejected' }).status).toBe('rejected');
  });

  it('an overloaded error that the retries never got past ends as overloaded, its text unposted', async () => {
    script = [
      { type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, retry_delay_ms: 1, error_status: 529, error: 'overloaded' },
      { type: 'assistant', parent_tool_use_id: null, error: 'overloaded', message: { id: 'syn', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } },
      { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded', total_cost_usd: 0, duration_ms: 5, usage: {}, modelUsage: {} },
    ];
    const r = recorder();
    const out = await new ClaudeProvider().runTurn(ctx(), r.sink);
    expect(out).toMatchObject({ ok: false, limit: { kind: 'overloaded' }, error: 'overloaded' });
    expect(r.texts).toEqual([]);
  });

  it('a failed run after retries reads the last api_retry; a successful one ignores it', async () => {
    script = [
      { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 3, retry_delay_ms: 1, error_status: null, error: 'unknown' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, duration_ms: 5, usage: {}, modelUsage: {} },
    ];
    expect((await new ClaudeProvider().runTurn(ctx(), recorder().sink)).limit).toEqual({ kind: 'down' });
    script = [{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1, error_status: 529, error: 'overloaded' }, ...ok()];
    const out = await new ClaudeProvider().runTurn(ctx(), recorder().sink);
    expect(out.ok).toBe(true);
    expect(out.limit).toBeUndefined();
    expect(retryLimitKind({ error_status: 429, error: 'rate_limit' })).toBe('usage');
    expect(retryLimitKind({ error_status: 400, error: 'invalid_request' })).toBeUndefined();
  });

  it('a Stop is never a limit', async () => {
    const ac = new AbortController();
    ac.abort();
    script = fixture('limit-rejected.synthetic.json');
    const out = await new ClaudeProvider().runTurn(ctx({ signal: ac.signal }), recorder().sink);
    expect(out.limit).toBeUndefined();
  });

  it('resetsAt: seconds become ms, ms stay, junk is dropped', () => {
    expect(resetMs(1795442400)).toBe(1795442400000);
    expect(resetMs(1795442400000)).toBe(1795442400000);
    expect(resetMs(undefined)).toBeUndefined();
    expect(resetMs(-1)).toBeUndefined();
    expect(resetMs('soon')).toBeUndefined();
  });
});

describe('P0-4: fallbackModel is the next cheaper Claude model', () => {
  it('Fable falls back to Opus, Opus to Sonnet; Sonnet, Haiku and unknown get none (never upward)', () => {
    expect(fallbackModelFor('claude-fable-5-1')).toBe('claude-opus-5');
    expect(fallbackModelFor('claude-opus-5')).toBe('claude-sonnet-5');
    expect(fallbackModelFor('claude-sonnet-5')).toBeUndefined();
    expect(fallbackModelFor('claude-sonnet-5-5')).toBeUndefined();
    expect(fallbackModelFor('claude-haiku-4-5-20251001')).toBeUndefined();
    expect(fallbackModelFor('gpt-5')).toBeUndefined();
  });

  it('the options builder passes it for Opus and leaves it out for Sonnet', async () => {
    script = ok();
    await new ClaudeProvider().runTurn(ctx({ model: 'claude-opus-5' }), recorder().sink);
    expect(seenOptions!.model).toBe('claude-opus-5');
    expect(seenOptions!.fallbackModel).toBe('claude-sonnet-5');
    script = ok();
    await new ClaudeProvider().runTurn(ctx({ model: 'claude-sonnet-5' }), recorder().sink);
    expect(seenOptions!.fallbackModel).toBeUndefined();
  });

  it('reports the model that answered when the fallback did, and nothing when the asked model did', async () => {
    script = fixture('overload-fallback.synthetic.json');
    const r = recorder();
    const out = await new ClaudeProvider().runTurn(ctx({ model: 'claude-opus-5' }), r.sink);
    expect(out.ok).toBe(true);
    expect(out.model).toBe('claude-sonnet-5');
    expect(r.texts).toEqual(['Answered on the fallback.']);
    script = ok('Done.', 'claude-opus-5-20261101');
    expect((await new ClaudeProvider().runTurn(ctx({ model: 'claude-opus-5' }), recorder().sink)).model).toBeUndefined();
  });

  it('ranModel names only a confirmed fallback, so usage rows keep the hub ids', () => {
    expect(ranModel('claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-20261101')).toBeUndefined();
    expect(ranModel('claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-20261001')).toBe('claude-sonnet-5');
    expect(ranModel('claude-opus-5', 'claude-sonnet-5', undefined)).toBeUndefined();
    expect(ranModel('claude-opus-5', 'claude-sonnet-5', 'opus')).toBeUndefined();
    expect(ranModel('claude-sonnet-5', undefined, 'claude-haiku-4-5')).toBeUndefined();
  });

  it('a retry the run got past does not relabel a later step-limit failure (continuations key on it)', async () => {
    script = [
      { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1, error_status: 529, error: 'overloaded' },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 1 }, content: [{ type: 'text', text: 'working' }] } },
      { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.01, duration_ms: 5, usage: {}, modelUsage: {} },
    ];
    const out = await new ClaudeProvider().runTurn(ctx(), recorder().sink);
    expect(out.error).toBe('error_max_turns');
    expect(out.limit).toBeUndefined();
  });
});
