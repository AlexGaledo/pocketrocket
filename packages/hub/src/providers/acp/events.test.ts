import { describe, expect, it } from 'vitest';
import type { TurnSink } from '../types.js';
import { AcpEventMapper, toolOutputText } from './events.js';

function rec() {
  const out: Array<[string, ...unknown[]]> = [];
  const sink: TurnSink = {
    onSession: () => undefined,
    onDelta: (t) => out.push(['delta', t]),
    onText: (t) => out.push(['text', t]),
    onToolUse: (id, name, input) => out.push(['use', id, name, input]),
    onToolResult: (id, o, e) => out.push(['result', id, o, e]),
    onState: () => undefined,
  };
  return { out, sink };
}

describe('AcpEventMapper', () => {
  it('splits text blocks at tool calls, and settles a tool once', () => {
    const r = rec();
    const m = new AcpEventMapper(r.sink);
    m.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } });
    m.push({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read x', kind: 'read', status: 'in_progress', rawInput: { path: 'x' } });
    m.push({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: { lines: 3 } });
    m.push({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed' });
    m.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    m.flush();
    expect(r.out).toEqual([
      ['delta', 'Looking.'],
      ['text', 'Looking.'],
      ['use', 'a', 'Read x', { path: 'x' }],
      ['result', 'a', '{"lines":3}', false],
      ['delta', 'Done.'],
      ['text', 'Done.'],
    ]);
  });

  it('an update for a call it never saw still makes a chip', () => {
    const r = rec();
    const m = new AcpEventMapper(r.sink);
    m.push({ sessionUpdate: 'tool_call_update', toolCallId: 'b', title: 'Run tests', status: 'failed', content: [{ type: 'diff', path: '/w/a.ts', newText: '' }] });
    expect(r.out).toEqual([['use', 'b', 'Run tests', { title: 'Run tests' }], ['result', 'b', 'changed /w/a.ts', true]]);
  });

  it('muted (a session/load replay) posts nothing and keeps no usage', () => {
    const r = rec();
    const m = new AcpEventMapper(r.sink);
    m.muted = true;
    m.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } });
    m.push({ sessionUpdate: 'usage_update', used: 5, size: 10 });
    m.muted = false;
    m.flush();
    expect(r.out).toEqual([]);
    expect(m.contextTokens).toBeUndefined();
    expect(m.answered).toBe(false);
  });

  it('keeps usage, dollar cost only in USD, and error notices', () => {
    const m = new AcpEventMapper(rec().sink);
    m.push({ sessionUpdate: 'usage_update', used: 900, size: 1000, cost: { amount: 3, currency: 'EUR' } });
    expect(m.contextTokens).toBe(900);
    expect(m.sessionCostUsd).toBeUndefined();
    m.push({ sessionUpdate: 'usage_update', used: 950, size: 1000, cost: { amount: 0.5, currency: 'usd' } });
    expect(m.sessionCostUsd).toBe(0.5);
    m.push({ sessionUpdate: 'notice', severity: 'info', title: 'fyi' });
    m.push({ sessionUpdate: 'notice', severity: 'error', title: 'Quota', description: 'RESOURCE_EXHAUSTED' });
    expect(m.notices).toEqual(['Quota: RESOURCE_EXHAUSTED']);
  });

  it('caps tool output', () => {
    expect(toolOutputText({ rawOutput: 'x'.repeat(30_000) })).toHaveLength(20_000);
  });
});
