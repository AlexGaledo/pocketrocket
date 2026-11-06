// node --test scripts/pc-runner
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ALLOWED_TOOLS, validateConfig, folderFor, parseJob, buildClaudeArgs, capOutput, parseClaudeResult,
  promptPreview, cleanToken, toolError, backoffMs, logFileName,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const good = () => ({
  sshAlias: 'crm-agency', localPort: 7789,
  folders: { pocketrocket: { path: 'C:\\Users\\alex\\Desktop\\claude-grokbot' }, notes: { path: 'D:\\notes', allowedTools: ['Read', 'mcp__wika__list_routes'] } },
});

test('the example config is valid', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'config.example.json'), 'utf8'));
  const r = validateConfig(raw);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateConfig fills defaults and keeps per-folder tools', () => {
  const r = validateConfig(good());
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.folders.pocketrocket.allowedTools, [...DEFAULT_ALLOWED_TOOLS]);
  assert.deepEqual(r.config.folders.notes.allowedTools, ['Read', 'mcp__wika__list_routes']);
  const d = validateConfig({ folders: {} });
  assert.equal(d.ok, true);
  assert.equal(d.config.sshAlias, 'crm-agency');
  assert.equal(d.config.localPort, 7789);
});

test('validateConfig rejects bad folder names, paths, aliases and ports', () => {
  for (const name of ['Upper', '-dash', '_x', 'a b', 'a/b', '..', 'x'.repeat(42), '']) {
    const c = good(); c.folders[name] = { path: 'C:\\x' };
    assert.equal(validateConfig(c).ok, false, `name ${JSON.stringify(name)}`);
  }
  for (const p of ['relative\\dir', '\\\\server\\share\\x', '', 42, null]) {
    const c = good(); c.folders.x = { path: p };
    assert.equal(validateConfig(c).ok, false, `path ${JSON.stringify(p)}`);
  }
  for (const a of ['-oProxyCommand=calc', 'a b', '', 'x;y']) assert.equal(validateConfig({ ...good(), sshAlias: a }).ok, false, a);
  for (const p of [80, 70000, '7789', 7789.5]) assert.equal(validateConfig({ ...good(), localPort: p }).ok, false, String(p));
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig([]).ok, false);
  assert.equal(validateConfig({ folders: [] }).ok, false);
});

test('validateConfig rejects permission bypasses and unrestricted Bash in tool lists', () => {
  for (const t of ['--dangerously-skip-permissions', 'bypassPermissions', 'Bash', 'Bash(*)', 'Bash(:*)', 'Bash(*:*)', 'Read,Write', 'Bash(rm -rf /)(x)', '']) {
    const c = good(); c.folders.pocketrocket.allowedTools = ['Read', t];
    assert.equal(validateConfig(c).ok, false, `folder tool ${JSON.stringify(t)}`);
    assert.equal(validateConfig({ ...good(), defaultAllowedTools: [t] }).ok, false, `default tool ${JSON.stringify(t)}`);
  }
  assert.equal(toolError('Bash(git status:*)'), null);
  assert.equal(toolError('mcp__server__tool'), null);
});

test('folderFor only accepts allowlisted names', () => {
  const { config } = validateConfig(good());
  assert.equal(folderFor(config, 'pocketrocket').path, 'C:\\Users\\alex\\Desktop\\claude-grokbot');
  for (const n of ['other', '__proto__', 'constructor', 'toString', 'POCKETROCKET', '../pocketrocket', '', null, undefined, 1]) {
    assert.equal(folderFor(config, n), null, String(n));
  }
});

test('parseJob checks the job shape', () => {
  const j = parseJob({ id: 'j_1', bot: { handle: 'dev' }, room: { id: 'r1', name: 'Room' }, folder: 'pocketrocket', prompt: 'hi', createdAt: 1 });
  assert.equal(j.id, 'j_1');
  assert.equal(parseJob({ id: '../x', folder: 'a', prompt: 'p' }), null);
  assert.equal(parseJob({ id: 'a', folder: 'a', prompt: '  ' }), null);
  assert.equal(parseJob({ id: 'a', prompt: 'p' }), null);
  assert.equal(parseJob(null), null);
});

test('buildClaudeArgs never contains a permission bypass', () => {
  const args = buildClaudeArgs([...DEFAULT_ALLOWED_TOOLS]);
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--permission-mode', 'default']);
  assert.equal(args[5], '--allowedTools');
  assert.equal(args[6], DEFAULT_ALLOWED_TOOLS.join(','));
  const joined = args.join(' ');
  assert.doesNotMatch(joined, /dangerously|skip-permissions|bypassPermissions/i);
  assert.equal(args.filter((a) => a === '--permission-mode').length, 1);
  for (const bad of [['--dangerously-skip-permissions'], ['bypassPermissions'], ['Read', 'Bash'], [], 'Read']) {
    assert.throws(() => buildClaudeArgs(bad), undefined, JSON.stringify(bad));
  }
});

test('capOutput caps at 20 KB on a character boundary', () => {
  assert.equal(capOutput('short'), 'short');
  const big = 'x'.repeat(50_000);
  const c = capOutput(big);
  assert.ok(Buffer.byteLength(c) <= 20 * 1024);
  assert.match(c, /output truncated/);
  const emoji = '\u{1F680}'.repeat(10_000); // 4 bytes each
  const ce = capOutput(emoji);
  assert.ok(Buffer.byteLength(ce) <= 20 * 1024);
  assert.doesNotMatch(ce, /\uFFFD/);
  assert.equal(capOutput(undefined), '');
});

test('parseClaudeResult reads result, cost and duration', () => {
  const r = parseClaudeResult(JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.12, duration_ms: 3456.7 }), 0);
  assert.deepEqual(r, { ok: true, output: 'done', costUsd: 0.12, durationMs: 3457 });
  assert.equal(parseClaudeResult(JSON.stringify({ is_error: true, result: 'nope' }), 0).ok, false);
  assert.equal(parseClaudeResult(JSON.stringify({ result: 'x' }), 1).ok, false);
  const pre = parseClaudeResult('warning: something\n' + JSON.stringify({ result: 'ok' }), 0);
  assert.equal(pre.output, 'ok');
  const junk = parseClaudeResult('not json', 1);
  assert.equal(junk.ok, false);
  assert.equal(junk.output, 'not json');
  assert.ok(Buffer.byteLength(parseClaudeResult(JSON.stringify({ result: 'y'.repeat(30_000) }), 0).output) <= 20 * 1024);
});

test('promptPreview keeps at most 200 characters on one line', () => {
  assert.equal(promptPreview('a\n b'), 'a b');
  assert.equal(promptPreview('z'.repeat(500)).length, 203);
});

test('cleanToken accepts one URL-safe line only', () => {
  assert.equal(cleanToken('  abcdefABCDEF0123456789\r\n'), 'abcdefABCDEF0123456789');
  for (const t of ['short', 'has space inside 1234567890', 'line\nbreak1234567890', '', null, 'a'.repeat(600)]) assert.equal(cleanToken(t), null, String(t));
});

test('backoff and log file name', () => {
  assert.equal(backoffMs(0), 2000);
  assert.equal(backoffMs(3), 16000);
  assert.equal(backoffMs(20), 60000);
  assert.equal(logFileName(new Date(2026, 0, 5)), 'runner-2026-01-05.log');
});

test('runner.mjs never passes a bypass flag and never logs the token', () => {
  const src = fs.readFileSync(path.join(HERE, 'runner.mjs'), 'utf8');
  assert.doesNotMatch(src, /dangerously-skip-permissions|bypassPermissions/);
  // The token variable is never handed to log() or console.*, as a value, a shorthand property or in a template.
  for (const line of src.split('\n')) {
    if (/\b(log|console\.\w+)\(/.test(line)) assert.doesNotMatch(line, /\$\{token\}|[({,]\s*token\s*[,)}]/, line);
  }
  // It is sent only as a Bearer header.
  assert.match(src, /authorization: `Bearer \$\{token\}`/);
});
