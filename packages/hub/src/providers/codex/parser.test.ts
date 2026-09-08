import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TurnSink } from '../types.js';
import { CodexEventParser } from './parser.js';
import { CODEX_RATES, estimateCostUsd, rateFor } from './pricing.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-fixtures', 'codex');

type Call = [string, ...unknown[]];

/** Records every sink call in order, so a test can assert the exact sequence the UI would see. */
function recorder() {
  const calls: Call[] = [];
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

/** Feed a fixture in two odd-sized chunks, proving the line buffer survives a split mid-JSON. */
function feed(name: string, sink: TurnSink): CodexEventParser {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const parser = new CodexEventParser(sink);
  const cut = Math.floor(raw.length / 3) + 7;
  parser.push(raw.slice(0, cut));
  parser.push(raw.slice(cut));
  parser.end();
  return parser;
}

describe('codex JSONL parser', () => {
  it('maps a plain answer stream to session + text and reports usage', () => {
    const r = recorder();
    const p = feed('simple.jsonl', r.sink);

    expect(p.threadId).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
    expect(p.completed).toBe(true);
    expect(p.turns).toBe(1);
    expect(p.error).toBeNull();
    expect(r.calls).toEqual([
      ['session', '0199a213-81c0-7800-8aa1-bbab2a035a53'],
      ['state', 'thinking'],
      ['state', 'thinking'], // reasoning item
      ['delta', 'pong'],
      ['text', 'pong'],
    ]);
    expect(p.usage).toEqual({ inputTokens: 24763, cachedInputTokens: 24448, outputTokens: 122, reasoningTokens: 64 });
    expect(estimateCostUsd('gpt-5.6-terra', {
      inputTokens: p.usage.inputTokens,
      cachedInputTokens: p.usage.cachedInputTokens,
      outputTokens: p.usage.outputTokens,
    })).toBeCloseTo(0.006984, 6);
  });

  it('maps shell, file-change and MCP items to tool chips', () => {
    const r = recorder();
    const p = feed('tools.jsonl', r.sink);

    expect(p.completed).toBe(true);
    expect(r.only('use')).toEqual([
      ['use', 'item_1', 'Bash', { command: 'bash -lc ls' }],
      ['use', 'item_2', 'Bash', { command: "bash -lc 'cat missing.txt'" }],
      ['use', 'item_3:0', 'Write', { path: 'notes/todo.md' }],
      ['use', 'item_3:1', 'Edit', { path: 'src/index.ts' }],
      ['use', 'item_4', 'mcp__pocketrocket__send_message', { to: '@alex', text: 'on it' }],
      ['use', 'item_5', 'mcp__pocketrocket__request_approval', { action: 'delete build cache' }],
    ]);
    expect(r.only('result')).toEqual([
      ['result', 'item_1', 'docs\nsrc\n', false],
      ['result', 'item_2', 'cat: missing.txt: No such file\n(exit code 1)', true],
      ['result', 'item_3:0', 'add notes/todo.md', false],
      ['result', 'item_3:1', 'update src/index.ts', false],
      ['result', 'item_4', 'delivered', false],
      ['result', 'item_5', 'the user declined this action', true],
    ]);
    // todo_list and an unknown future item type are dropped without touching the sink.
    expect(r.only('text')).toEqual([['text', 'Listed the repo and wrote the notes.']]);
    expect(p.error).toBeNull();
    expect(estimateCostUsd('gpt-5.6-terra', {
      inputTokens: p.usage.inputTokens,
      cachedInputTokens: p.usage.cachedInputTokens,
      outputTokens: p.usage.outputTokens,
    })).toBeCloseTo(0.00428, 6);
  });

  it('reports turn.failed as an error and never completes', () => {
    const r = recorder();
    const p = feed('failed.jsonl', r.sink);
    expect(p.completed).toBe(false);
    expect(p.error).toBe('model response stream ended unexpectedly');
    expect(r.only('text')).toEqual([]);
  });

  it('survives garbage, banners, unknown events and a top-level error', () => {
    const r = recorder();
    const p = new CodexEventParser(r.sink);
    p.push('Reading prompt from stdin...\n');
    p.push('{ not json at all\n');
    p.push('{"type":"totally.new.event","payload":1}\n');
    p.push('{"type":"item.completed","item":{"type":"agent_message"}}\n'); // no id, empty text
    p.push('{"type":"error","message":"stream error: broken pipe"}');
    p.end();
    expect(p.error).toBe('stream error: broken pipe');
    expect(r.calls).toEqual([]);
  });

  it('only announces a tool once when the CLI sends both started and completed', () => {
    const r = recorder();
    const p = new CodexEventParser(r.sink);
    const item = { id: 'x', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 0 };
    p.event({ type: 'item.started', item });
    p.event({ type: 'item.completed', item });
    expect(r.only('use')).toHaveLength(1);
    expect(r.only('result')).toHaveLength(1);
  });

  it('emits a tool chip even when only item.completed arrives', () => {
    const r = recorder();
    const p = new CodexEventParser(r.sink);
    p.event({ type: 'item.completed', item: { id: 'y', type: 'command_execution', command: 'ls', exit_code: 0 } });
    expect(r.only('use')).toEqual([['use', 'y', 'Bash', { command: 'ls' }]]);
    expect(r.only('result')).toEqual([['result', 'y', '', false]]);
  });

  it('sums usage across multiple turn.completed events', () => {
    const r = recorder();
    const p = new CodexEventParser(r.sink);
    p.event({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } });
    p.event({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } });
    expect(p.turns).toBe(2);
    expect(p.usage).toEqual({ inputTokens: 15, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: 0 });
  });
});

describe('codex pricing', () => {
  it('knows every model the picker offers', () => {
    for (const id of ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra']) {
      expect(CODEX_RATES[id]).toBeDefined();
    }
  });

  it('falls back to the balanced rate for an unknown id and matches dated snapshots by prefix', () => {
    expect(rateFor('gpt-5.6-luna-2026-08-01')).toEqual(CODEX_RATES['gpt-5.6-luna']);
    expect(rateFor('something-else')).toEqual(CODEX_RATES['gpt-5.6-terra']);
  });

  it('charges cache reads at the cached rate and never goes negative', () => {
    // 1M fresh input at $2 + 1M cached at $0.20 + 1M output at $12.
    expect(estimateCostUsd('gpt-5.6-terra', { inputTokens: 2e6, cachedInputTokens: 1e6, outputTokens: 1e6 })).toBe(14.2);
    expect(estimateCostUsd('gpt-5.6-terra', { inputTokens: 0, cachedInputTokens: 500, outputTokens: 0 })).toBe(0.0001);
  });
});
