import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compactLine, lastContextTokens } from './SessionCompact.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIRROR = path.resolve(here, '..', '..', '..', '..', 'scripts', 'pc-runner', 'mirror.mjs');

const LINES: unknown[] = [
  { type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'fix the bug <system-reminder>hidden</system-reminder>' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-01T10:00:01.000Z', message: { model: 'claude-sonnet-5-5', content: [
    { type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } },
    { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x', path: '/w' } }, { type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'Done' },
  ] } },
  { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-11-01T10:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file text', is_error: false }, { type: 'text', text: 'and then?' }] } },
  { type: 'user', uuid: 'u3', isMeta: true, message: { content: 'meta' } },
  { type: 'user', uuid: 'u4', isCompactSummary: true, message: { content: 'earlier we did things' } },
  { type: 'summary', summary: 'A summary', leafUuid: 'leaf1' },
  { type: 'assistant', uuid: 'a2', message: { model: '<synthetic>', content: [{ type: 'text', text: 'no' }] } },
  { type: 'assistant', uuid: 'a3', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } },
  { type: 'system', uuid: 's1' },
  { type: 'user', uuid: 'u5', message: { content: '<local-command-stdout>x</local-command-stdout>' } },
  null,
  'text',
];

describe('compactLine', () => {
  it('maps the line kinds the way the runner does', () => {
    expect(compactLine(LINES[0], {}).map((e) => [e.kind, e.text])).toEqual([['user', 'fix the bug']]);
    const names = new Map<string, string>();
    const a = compactLine(LINES[1], { toolNames: names });
    expect(a.map((e) => [e.kind, e.tool ?? '', e.text])).toEqual([['assistant', '', 'Looking'], ['tool_use', 'Read', '/w/a.ts'], ['tool_use', 'Grep', 'x in /w'], ['assistant', '', 'Done']]);
    expect(a[0]).toMatchObject({ uuid: 'a1', model: 'claude-sonnet-5-5', parentUuid: 'u1' });
    expect(JSON.stringify(a)).not.toContain('secret thoughts');
    const r = compactLine(LINES[2], { toolNames: names });
    expect(r.map((e) => [e.kind, e.tool ?? '', e.text])).toEqual([['tool_result', 'Read', 'file text'], ['user', '', 'and then?']]);
    expect(compactLine(LINES[3], {})).toEqual([]);
    expect(compactLine(LINES[4], {})[0]).toMatchObject({ kind: 'summary', uuid: 'u4' });
    expect(compactLine(LINES[5], {})[0]).toMatchObject({ kind: 'summary', uuid: 'summary-leaf1' });
    expect(compactLine(LINES[6], {})).toEqual([]);
    expect(compactLine(LINES[7], {})[0].isSidechain).toBe(true);
    for (const x of [LINES[8], LINES[9], LINES[10], LINES[11]]) expect(compactLine(x, {})).toEqual([]);
  });

  it('keeps no secret the hub knows how to recognise', () => {
    const e = compactLine({ type: 'user', uuid: 'k', message: { content: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 now' } }, {});
    expect(e[0].text).not.toContain('ghp_abcdefghijklmnopqrstuv');
  });

  // The hub's copy must not drift from the runner's mapping: same lines in, same entries out.
  it.skipIf(!fs.existsSync(MIRROR))('gives the same entries as scripts/pc-runner/mirror.mjs mapLine for the same lines', async () => {
    const { mapLine } = (await import(pathToFileURL(MIRROR).href)) as { mapLine: (o: unknown, ctx?: unknown) => unknown[] };
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    for (const line of LINES) {
      expect(compactLine(line, { toolNames: a, lineKey: 7, fallbackAt: 99 }), JSON.stringify(line)).toEqual(mapLine(line, { toolNames: b, lineKey: 7, fallbackAt: 99 }));
    }
  });
});

describe('lastContextTokens', () => {
  const line = (u: object, type = 'assistant') => JSON.stringify({ type, message: { usage: u } });
  it('sums uncached input, cache reads and cache writes of the last assistant line that reports usage', () => {
    const tail = [line({ input_tokens: 1, cache_read_input_tokens: 10 }), line({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }), '{"type":"user"}'].join('\n');
    expect(lastContextTokens(tail)).toBe(125);
  });
  it('skips a cut first line and answers null when nothing reports usage', () => {
    expect(lastContextTokens('ge":{"usage":{}}}\n' + line({ input_tokens: 3 }))).toBe(3);
    expect(lastContextTokens('{"type":"user","message":{"content":"x"}}\n')).toBeNull();
    expect(lastContextTokens('')).toBeNull();
    expect(lastContextTokens(line({ input_tokens: 9 }, 'user'))).toBeNull();
  });
});
