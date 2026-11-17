import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SDKAssistantMessage, SDKControlInterruptResponse, SDKResultError, SDKResultSuccess, SDKSystemMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_SETTINGS, PROVIDER_IDS } from '@pocketrocket/shared';
import { steerTurn, type SteerInput, type TurnContext, type TurnSink } from './types.js';

/**
 * Steering in the Claude adapter (task 1.1), against a fake `query()` that reads the adapter's input channel and
 * answers the way CLI 2.1.326 did in spike 1.0: a message pushed mid-tool is folded into the running turn and named
 * in that result's `user_message_uuids`; one pushed later gets a result of its own; Stop's receipt lists it under
 * `still_queued`, and without a close the CLI then runs it.
 */

/** Scripted stand-in for the SDK's Query: the test emits frames and sees every user message the adapter writes. */
class FakeQuery {
  inputs: SDKUserMessage[] = [];
  interrupts = 0;
  closed = false;
  receipt: SDKControlInterruptResponse | undefined;
  onInput?: (m: SDKUserMessage) => void;
  onInterrupt?: () => void;
  private out: unknown[] = [];
  private wake?: () => void;
  private ended = false;

  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const m of prompt) {
        this.inputs.push(m);
        this.onInput?.(m);
      }
    })();
  }
  emit(...ms: unknown[]) {
    this.out.push(...ms);
    this.wake?.();
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.out.length && !this.closed) yield this.out.shift();
      if (this.ended || this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
  async interrupt() {
    this.interrupts++;
    this.onInterrupt?.();
    return this.receipt;
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  /** Emits once the adapter's opening message is in, so frames can name its uuid. */
  afterOpener(...ms: Array<(q: FakeQuery) => unknown>) {
    const go = () => this.emit(...ms.map((f) => f(this)));
    if (this.inputs.length) go();
    else {
      const prev = this.onInput;
      this.onInput = (m) => {
        this.onInput = prev;
        go();
        prev?.(m);
      };
    }
  }
}

let queries: FakeQuery[] = [];
/** Runs for each new query, so a test can script it before the adapter reads. */
let script: (q: FakeQuery) => void = () => undefined;
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    const q = new FakeQuery(prompt);
    queries.push(q);
    script(q);
    return q;
  },
}));
const update = vi.fn(async () => ({ ok: true, output: '' }));
vi.mock('./claudeUpdate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeUpdate.js')>()),
  updateClaudeCli: () => update(),
}));

const { ClaudeProvider, STEER_CAPABILITY, STOP_RESULT_WAIT_MS } = await import('./claude.js');
const { createProviders } = await import('./registry.js');

const init = (capabilities: string[] | undefined = [STEER_CAPABILITY]) =>
  ({ type: 'system', subtype: 'init', session_id: 'sess', apiKeySource: 'none', model: 'claude-haiku-4-5', claude_code_version: '2.1.326', tools: [], skills: [], capabilities }) as unknown as SDKSystemMessage;
const toolUse = (uuids?: string[]) =>
  ({
    type: 'assistant', parent_tool_use_id: null, user_message_uuids: uuids,
    message: { id: 'm-' + Math.random(), usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 8' } }] },
  }) as unknown as SDKAssistantMessage;
const text = (t: string) =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm-' + Math.random(), content: [{ type: 'text', text: t }] } }) as unknown as SDKAssistantMessage;
function result(o: { uuids?: string[]; total: number; tokens: number; ms: number; subtype?: string }): SDKResultSuccess | SDKResultError {
  return {
    type: 'result', subtype: o.subtype ?? 'success', result: 'done', total_cost_usd: o.total, duration_ms: o.ms, num_turns: 1,
    errors: o.subtype && o.subtype !== 'success' ? ['stopped'] : undefined,
    usage: { input_tokens: o.tokens, output_tokens: o.tokens, cache_read_input_tokens: o.tokens, cache_creation_input_tokens: o.tokens },
    ...(o.uuids ? { user_message_uuids: o.uuids, user_message_uuid: o.uuids.at(-1) } : {}),
  } as unknown as SDKResultSuccess;
}

const sink: TurnSink = { onSession: () => undefined, onDelta: () => undefined, onText: () => undefined, onToolUse: () => undefined, onToolResult: () => undefined, onState: () => undefined };
function ctx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 't1', bot: { id: 'b', handle: 'b', name: 'B', allowedTools: ['Bash'] } as never, room: { id: 'r' } as never, members: [],
    systemPrompt: 'sys', input: 'run the job', resumeToken: null, workspaceDir: process.cwd(), botHome: process.cwd(), tools: [],
    allowedBuiltins: ['Bash'], permission: async () => 'allow', model: 'claude-haiku-4-5', maxBudgetUsd: 2, maxTurns: 30,
    signal: new AbortController().signal, mcp: { url: '', token: '' }, ...over,
  };
}
const steer = (uuid: string, t = 'also say BANANA'): SteerInput => ({ uuid, text: t });
const opener = (q: FakeQuery) => q.inputs[0]!.uuid as string;
/** Lets the adapter's read loop and the fake's input reader catch up. */
async function until(cond: () => boolean) {
  let met = cond();
  for (let i = 0; i < 200 && !met; i++) {
    await new Promise((r) => setTimeout(r, 1));
    met = cond();
  }
  expect(met).toBe(true);
}

beforeEach(() => {
  queries = [];
  script = () => undefined;
  update.mockClear();
});

describe('steering a running Claude turn', () => {
  it('folds a steer pushed mid-tool into the running turn and reports it consumed', async () => {
    const p = new ClaudeProvider();
    script = (q) => {
      q.emit(init(), toolUse());
      // Spike 1.0: the CLI folds the message in at the next tool round and the one result names both sends.
      q.onInput = (m) => { if (String(m.uuid) === 's1') q.emit(text('DONE, BANANA'), result({ uuids: [opener(q), 's1'], total: 0.02, tokens: 10, ms: 100 })); };
    };
    const run = p.runTurn(ctx(), sink);
    await until(() => queries.length === 1 && queries[0]!.inputs.length === 1);
    await until(() => p.steer('t1', steer('s1')).status === 'accepted');
    const out = await run;

    const q = queries[0]!;
    expect(q.inputs.map((m) => m.uuid)).toEqual([opener(q), 's1']);
    expect(q.inputs[1]!.message.content).toBe('also say BANANA');
    expect(q.inputs[1]!.priority).toBeUndefined(); // 'now' aborts the running tool; 'later' never folds (spike 1.0)
    expect(out.ok).toBe(true);
    expect(out.steers).toEqual({ consumed: ['s1'], pending: [] });
    expect(q.closed).toBe(false); // nothing left for the CLI to run: no forced close
    // The turn is over: a later message queues.
    expect(p.steer('t1', steer('s2'))).toEqual({ status: 'queued', reason: 'between-runs' });
  });

  it('reads on to a second result, sums its tokens and time, and takes cost and ok from the last one', async () => {
    const p = new ClaudeProvider();
    script = (q) => {
      q.emit(init(), toolUse());
      q.onInput = (m) => {
        if (String(m.uuid) !== 's1') return;
        // Taken after the turn finished: the first result names only the opener, the steer gets a turn of its own.
        q.emit(result({ uuids: [opener(q)], total: 0.0112, tokens: 100, ms: 19_000 }));
        setTimeout(() => q.emit(text('BANANA'), result({ uuids: ['s1'], total: 0.0125, tokens: 7, ms: 1_300 })), 5);
      };
    };
    const run = p.runTurn(ctx(), sink);
    await until(() => queries[0]?.inputs.length === 1);
    await until(() => p.steer('t1', steer('s1')).status === 'accepted');
    const out = await run;

    expect(out.ok).toBe(true);
    expect(out.costUsd).toBeCloseTo(0.0125); // cumulative across the query's results: the last one, not a sum
    expect(out.sessionCostUsd).toBeCloseTo(0.0125);
    expect(out.usage).toMatchObject({ inputTokens: 107, outputTokens: 107, cacheReadTokens: 107, cacheWriteTokens: 107 });
    expect(out.durationMs).toBe(20_300);
    expect(out.steers).toEqual({ consumed: ['s1'], pending: [] });
  });

  it('ends on a result that lists no uuids and returns every unanswered steer as pending', async () => {
    const p = new ClaudeProvider();
    script = (q) => {
      q.emit(init(), toolUse());
      q.onInput = (m) => { if (String(m.uuid) === 's2') q.emit(result({ total: 0.01, tokens: 5, ms: 50 })); };
    };
    const run = p.runTurn(ctx(), sink);
    await until(() => queries[0]?.inputs.length === 1);
    await until(() => p.steer('t1', steer('s1')).status === 'accepted');
    expect(p.steer('t1', steer('s2', 'and BANANA')).status).toBe('accepted');
    const out = await run;

    expect(out.ok).toBe(true);
    expect(out.steers).toEqual({ consumed: [], pending: ['s1', 's2'] });
    // The CLI still holds them and would run them as a turn of their own: the query is closed.
    expect(queries[0]!.closed).toBe(true);
    expect(queries).toHaveLength(1);
  });

  it('Stop interrupts, reads the receipt, closes before the queued steer runs, and returns it as pending', async () => {
    const p = new ClaudeProvider();
    const ac = new AbortController();
    let ranSteer = false;
    script = (q) => {
      q.emit(init(), toolUse());
      q.receipt = { still_queued: ['s1'] };
      q.onInterrupt = () => {
        // The interrupted turn's result, then (spike 1.0) the CLI would start the queued steer about a second later.
        setTimeout(() => {
          q.emit(result({ uuids: [opener(q)], subtype: 'error_during_execution', total: 0.01, tokens: 10, ms: 8_000 }));
          setTimeout(() => { if (!q.closed) { ranSteer = true; q.emit(text('BANANA'), result({ uuids: ['s1'], total: 0.012, tokens: 3, ms: 1_000 })); } }, 20);
        }, 5);
      };
    };
    const run = p.runTurn(ctx({ signal: ac.signal }), sink);
    await until(() => queries[0]?.inputs.length === 1);
    await until(() => p.steer('t1', steer('s1')).status === 'accepted');
    ac.abort();
    // Stopping: no further steer gets in.
    expect(p.steer('t1', steer('s2'))).toEqual({ status: 'queued', reason: 'between-runs' });
    const out = await run;
    await new Promise((r) => setTimeout(r, 40));

    const q = queries[0]!;
    expect(q.interrupts).toBe(1);
    expect(q.closed).toBe(true);
    expect(ranSteer).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.costUsd).toBeCloseTo(0.01); // the interrupted result's cost was read before closing
    expect(out.steers).toEqual({ consumed: [], pending: ['s1'] });
  });

  it('Stop closes after a bounded wait when the interrupted result never comes', async () => {
    const p = new ClaudeProvider();
    const ac = new AbortController();
    script = (q) => {
      q.emit(init(), toolUse());
      q.receipt = { still_queued: ['s1'] };
    };
    const run = p.runTurn(ctx({ signal: ac.signal }), sink);
    await until(() => queries[0]?.inputs.length === 1);
    await until(() => p.steer('t1', steer('s1')).status === 'accepted');
    vi.useFakeTimers();
    try {
      ac.abort();
      await vi.advanceTimersByTimeAsync(STOP_RESULT_WAIT_MS - 1);
      expect(queries[0]!.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(queries[0]!.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const out = await run;
    expect(out.steers).toEqual({ consumed: [], pending: ['s1'] });
  });

  it('the owner Stop through interrupt() takes the same path', async () => {
    const p = new ClaudeProvider();
    script = (q) => {
      q.emit(init(), toolUse());
      q.receipt = { still_queued: ['s1'] };
      q.onInterrupt = () => setTimeout(() => q.emit(result({ uuids: [opener(q)], subtype: 'error_during_execution', total: 0, tokens: 0, ms: 1 })), 5);
    };
    const run = p.runTurn(ctx(), sink);
    await until(() => queries[0]?.inputs.length === 1);
    await until(() => p.steer('t1', steer('s1')).status === 'accepted');
    expect(p.interrupt('t1')).toBe(true);
    const out = await run;
    expect(queries[0]!.closed).toBe(true);
    expect(out.steers?.pending).toEqual(['s1']);
    expect(p.interrupt('t1')).toBe(false);
  });

  it('an error result with a steer still queued (max turns) ends the run and returns the steer as pending', async () => {
    const p = new ClaudeProvider();
    script = (q) => {
      q.emit(init(), toolUse());
      // Spike 1.0: the steer was not folded (no model call left) and the CLI would run it next, with a fresh maxTurns.
      q.onInput = (m) => { if (String(m.uuid) === 's1') q.emit(result({ uuids: [opener(q)], subtype: 'error_max_turns', total: 0.01, tokens: 5, ms: 10 })); };
    };
    const run = p.runTurn(ctx(), sink);
    await until(() => queries[0]?.inputs.length === 1);
    await until(() => p.steer('t1', steer('s1')).status === 'accepted');
    const out = await run;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^error_max_turns/);
    expect(out.steers).toEqual({ consumed: [], pending: ['s1'] });
    expect(queries[0]!.closed).toBe(true);
  });
});

describe('when a steer is refused', () => {
  it('queues with reason provider when the CLI does not advertise the interrupt receipt, and canSteer follows init', async () => {
    const p = new ClaudeProvider();
    expect(p.canSteer()).toBe(false); // no turn yet: unknown counts as no
    script = (q) => q.emit(init(['msg_lifecycle_v1']), toolUse());
    const run = p.runTurn(ctx(), sink);
    await until(() => queries[0]?.inputs.length === 1 && p.lastInit.capabilities !== undefined);
    await until(() => p.steer('t1', steer('s1')).status === 'queued');
    expect(p.steer('t1', steer('s1'))).toEqual({ status: 'queued', reason: 'provider' });
    expect(p.canSteer()).toBe(false);
    queries[0]!.emit(result({ uuids: [opener(queries[0]!)], total: 0, tokens: 0, ms: 1 }));
    const out = await run;
    expect(out.steers).toBeUndefined();
    expect(queries[0]!.inputs).toHaveLength(1);

    script = (q) => q.afterOpener(() => init(), (f) => result({ uuids: [opener(f)], total: 0, tokens: 0, ms: 1 }));
    await p.runTurn(ctx({ turnId: 't2' }), sink);
    expect(p.canSteer()).toBe(true);
  });

  it('queues as between-runs before the run has started reading and for an unknown turn', async () => {
    const p = new ClaudeProvider();
    expect(p.steer('nope', steer('s1'))).toEqual({ status: 'queued', reason: 'between-runs' });
    script = () => undefined; // no init yet
    const run = p.runTurn(ctx(), sink);
    await until(() => queries[0]?.inputs.length === 1);
    expect(p.steer('t1', steer('s1'))).toEqual({ status: 'queued', reason: 'between-runs' });
    queries[0]!.emit(init(), result({ uuids: [opener(queries[0]!)], total: 0, tokens: 0, ms: 1 }));
    await run;
  });

  it('non-Claude providers never steer', () => {
    const reg = createProviders({ settings: { get: () => ({ ...DEFAULT_SETTINGS, provider: 'claude' }) }, enabled: PROVIDER_IDS });
    for (const id of PROVIDER_IDS.filter((i) => i !== 'claude')) {
      const provider = reg.get(id);
      expect(provider.canSteer?.() ?? false).toBe(false);
      expect(steerTurn(provider, 't1', steer('s1'))).toEqual({ status: 'queued', reason: 'provider' });
    }
  });
});

describe('carried steers', () => {
  it('go into the opening message and count as consumed with it', async () => {
    const p = new ClaudeProvider();
    script = (q) => q.afterOpener(() => init(), (f) => result({ uuids: [opener(f)], total: 0.01, tokens: 1, ms: 1 }));
    const out = await p.runTurn(ctx({ carriedSteers: [steer('c1', 'fix the other file')] }), sink);
    expect(queries[0]!.inputs[0]!.message.content).toBe('run the job\n\nfix the other file');
    expect(out.steers).toEqual({ consumed: ['c1'], pending: [] });
  });

  it('the outdated-CLI replay carries every steer the failed run was given', async () => {
    const p = new ClaudeProvider();
    const outdated = 'API Error: 400 Claude Code 2.1.227 does not support this model; version 2.1.251 or newer is required.';
    let n = 0;
    script = (q) => {
      n++;
      if (n === 1) {
        q.emit(init());
        q.onInput = (m) => { if (String(m.uuid) === 's1') q.emit(text(outdated), result({ uuids: [opener(q)], total: 0, tokens: 0, ms: 1 })); };
      } else {
        q.afterOpener(() => init(), (f) => result({ uuids: [opener(f)], total: 0.02, tokens: 4, ms: 10 }));
      }
    };
    const run = p.runTurn(ctx({ carriedSteers: [steer('c1', 'carried')] }), sink);
    await until(() => queries[0]?.inputs.length === 1 && p.lastInit.capabilities !== undefined);
    await until(() => p.steer('t1', steer('s1', 'live')).status === 'accepted');
    const out = await run;

    expect(update).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.inputs[0]!.message.content).toBe('run the job\n\ncarried\n\nlive');
    expect(out.ok).toBe(true);
    expect(out.steers).toEqual({ consumed: ['c1', 's1'], pending: [] });
  });
});
