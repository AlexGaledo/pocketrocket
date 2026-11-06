// node --test scripts/pc-runner
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ALLOWED_TOOLS, validateConfig, folderFor, parseJob, buildClaudeArgs, capOutput, parseClaudeResult,
  promptPreview, cleanToken, toolError, backoffMs, logFileName,
  DISALLOWED_TOOLS, RUNNER_SETTINGS, GIT_FORCED_CONFIG, gitHardenedEnv, canRunCode, resolveClaudePath, isInside, buildMcpConfig, listenerIsOurs,
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

const files = { settingsPath: 'C:\\Temp\\job\\settings.json', mcpConfigPath: 'C:\\Temp\\job\\mcp.json' };
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

test('buildClaudeArgs never contains a permission bypass', () => {
  const args = buildClaudeArgs({ allowedTools: [...DEFAULT_ALLOWED_TOOLS], ...files });
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.equal(valueOf(args, '--allowedTools'), DEFAULT_ALLOWED_TOOLS.join(','));
  assert.doesNotMatch(args.join(' '), /dangerously|skip-permissions|bypassPermissions/i);
  assert.equal(args.filter((a) => a === '--permission-mode').length, 1);
  for (const bad of [['--dangerously-skip-permissions'], ['bypassPermissions'], ['Read', 'Bash'], [], 'Read']) {
    assert.throws(() => buildClaudeArgs({ allowedTools: bad, ...files }), undefined, JSON.stringify(bad));
  }
  assert.throws(() => buildClaudeArgs({ allowedTools: ['Read'] }), /settingsPath/);
  assert.throws(() => buildClaudeArgs({ allowedTools: ['Read'], settingsPath: files.settingsPath }), /mcpConfigPath/);
});

test('buildClaudeArgs always isolates the job from the folder and the user config', () => {
  for (const tools of [[...DEFAULT_ALLOWED_TOOLS], ['Read'], ['Read', 'mcp__wika__list_routes'], ['Edit', 'Bash(pnpm test:*)']]) {
    const args = buildClaudeArgs({ allowedTools: tools, ...files });
    assert.ok(args.includes('--restricted'), 'restricted');
    assert.equal(valueOf(args, '--setting-sources'), '', 'no settings files');
    assert.equal(valueOf(args, '--settings'), files.settingsPath, 'runner-owned settings');
    assert.equal(valueOf(args, '--permission-mode'), 'dontAsk');
    assert.equal(valueOf(args, '--permission-prompts'), 'none');
    assert.ok(args.includes('--strict-mcp-config'), 'strict mcp');
    assert.equal(valueOf(args, '--mcp-config'), files.mcpConfigPath, 'runner-owned mcp config');
    assert.equal(valueOf(args, '--disallowedTools'), DISALLOWED_TOOLS.join(','));
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(!valueOf(args, '--tools').includes('mcp__'), 'only built-in names in --tools');
    // Every variadic flag is followed by another flag, so none can swallow the next value.
    for (const f of ['--mcp-config', '--tools', '--allowedTools', '--disallowedTools']) assert.match(args[args.indexOf(f) + 2], /^--/, f);
  }
  assert.equal(valueOf(buildClaudeArgs({ allowedTools: [...DEFAULT_ALLOWED_TOOLS], ...files }), '--tools'), 'Read,Glob,Grep,Edit,Write,Bash');
});

test('runner settings deny the git escapes, allow nothing, and turn hooks off', () => {
  assert.equal(RUNNER_SETTINGS.permissions.defaultMode, 'dontAsk');
  assert.deepEqual(RUNNER_SETTINGS.permissions.allow, []);
  assert.equal(RUNNER_SETTINGS.disableAllHooks, true);
  for (const d of ['Bash(git diff --output*)', 'Bash(git * --ext-diff*)', 'Bash(git -c *)']) assert.ok(DISALLOWED_TOOLS.includes(d), d);
  assert.deepEqual(RUNNER_SETTINGS.permissions.deny, [...DISALLOWED_TOOLS]);
});

test('defaults have no test runners; canRunCode flags any write tool + any shell entry, git included', () => {
  assert.ok(!DEFAULT_ALLOWED_TOOLS.some((t) => /test/.test(t)));
  assert.equal(canRunCode([...DEFAULT_ALLOWED_TOOLS]), true);
  assert.equal(canRunCode([...DEFAULT_ALLOWED_TOOLS, 'Bash(pnpm test:*)']), true);
  assert.equal(canRunCode(['Edit', 'Bash(git diff:*)']), true);
  assert.equal(canRunCode(['Write', 'PowerShell(Get-ChildItem:*)']), true);
  assert.equal(canRunCode(['Read', 'Bash(pnpm test:*)']), false);
  assert.equal(canRunCode(['Read', 'Glob', 'Grep', 'Edit', 'Write']), false);
  assert.equal(canRunCode(['Read', 'mcp__wika-dashboard__list_routes']), false);
});

test('git metadata is never editable: .git/**, .gitattributes, .gitmodules denied for Edit and Write', () => {
  for (const tool of ['Edit', 'Write']) {
    for (const p of ['.git/**', '**/.git/**', '**/.gitattributes', '**/.gitmodules']) {
      assert.ok(DISALLOWED_TOOLS.includes(`${tool}(${p})`), `${tool}(${p})`);
    }
  }
  const args = buildClaudeArgs({ allowedTools: [...DEFAULT_ALLOWED_TOOLS], ...files });
  for (const d of ['Edit(.git/**)', 'Write(**/.gitattributes)', 'Edit(**/.gitmodules)']) assert.ok(valueOf(args, '--disallowedTools').split(',').includes(d), d);
  for (const d of DISALLOWED_TOOLS) assert.ok(toolError(d) === null || /^(Edit|Write)\(/.test(d), d);
});

test('gitHardenedEnv: no system/global config, forced safe values, hostile git env vars dropped', () => {
  const env = gitHardenedEnv({
    PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\a', git_dir: 'C:\\elsewhere', GIT_EXTERNAL_DIFF: 'evil', GIT_SSH_COMMAND: 'evil',
    Git_Config_Count: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'evil', GIT_CONFIG_PARAMETERS: "'core.pager=evil'", PAGER: 'evil', EDITOR: 'evil',
  });
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.USERPROFILE, 'C:\\Users\\a');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, 'NUL');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.PAGER, 'cat');
  for (const k of ['git_dir', 'GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'Git_Config_Count', 'GIT_CONFIG_PARAMETERS', 'EDITOR']) assert.ok(!(k in env), k);
  assert.equal(env.GIT_CONFIG_COUNT, String(GIT_FORCED_CONFIG.length));
  const forced = Object.fromEntries(GIT_FORCED_CONFIG.map((_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.deepEqual(forced, { 'core.fsmonitor': 'false', 'core.pager': 'cat', 'core.hooksPath': 'NUL', 'core.sshCommand': '' });
  assert.equal(Object.keys(env).filter((k) => /^GIT_CONFIG_KEY_/.test(k)).length, GIT_FORCED_CONFIG.length);
});

test('resolveClaudePath: config, then ~/.local/bin, then absolute PATH entries; never inside a folder', () => {
  const folders = { repo: { path: 'C:\\work\\repo' } };
  const have = (...ps) => (p) => ps.map((x) => x.toLowerCase()).includes(p.toLowerCase());
  assert.deepEqual(resolveClaudePath({ claudePath: 'D:\\tools\\claude.exe', home: 'C:\\Users\\a', pathEnv: '', folders, exists: have('D:\\tools\\claude.exe') }), { path: 'D:\\tools\\claude.exe' });
  assert.deepEqual(resolveClaudePath({ home: 'C:\\Users\\a', pathEnv: 'C:\\bin', folders, exists: have('C:\\Users\\a\\.local\\bin\\claude.exe', 'C:\\bin\\claude.exe') }), { path: 'C:\\Users\\a\\.local\\bin\\claude.exe' });
  assert.deepEqual(resolveClaudePath({ home: 'C:\\Users\\a', pathEnv: '.;bin;C:\\bin', folders, exists: have('C:\\bin\\claude.exe', '.\\claude.exe', 'bin\\claude.exe') }), { path: 'C:\\bin\\claude.exe' });
  assert.match(resolveClaudePath({ home: null, pathEnv: 'C:\\work\\repo\\node_modules\\.bin', folders, exists: () => true }).error, /inside an allowlisted folder/);
  assert.match(resolveClaudePath({ claudePath: 'C:\\WORK\\Repo\\claude.exe', folders, exists: () => true }).error, /inside/);
  assert.match(resolveClaudePath({ home: 'C:\\Users\\a', pathEnv: '', folders, exists: () => false }).error, /not found/);
  assert.equal(isInside('C:\\work\\repo2\\x', 'C:\\work\\repo'), false);
  const c = good(); c.claudePath = 'C:\\Users\\alex\\Desktop\\claude-grokbot\\claude.exe';
  assert.equal(validateConfig(c).ok, false);
  assert.equal(validateConfig({ ...good(), claudePath: 'claude' }).ok, false);
});

test('buildMcpConfig takes only the named servers', () => {
  const defs = { wika: { type: 'http', url: 'https://x' }, evil: { command: 'node' } };
  assert.deepEqual(buildMcpConfig(['wika'], defs), { config: { mcpServers: { wika: defs.wika } }, missing: [] });
  assert.deepEqual(buildMcpConfig([], defs).config, { mcpServers: {} });
  assert.deepEqual(buildMcpConfig(['nope', 'toString'], defs).missing, ['nope', 'toString']);
  const c = good(); c.folders.notes.mcpServers = ['wika', 'bad name'];
  assert.equal(validateConfig(c).ok, false);
  c.folders.notes.mcpServers = ['wika'];
  assert.deepEqual(validateConfig(c).config.folders.notes.mcpServers, ['wika']);
});

test('listenerIsOurs: every listener on the port must be the ssh child', () => {
  assert.equal(listenerIsOurs([{ address: '127.0.0.1', pid: 42 }], 42), true);
  assert.equal(listenerIsOurs([], 42), false);
  assert.equal(listenerIsOurs([{ address: '127.0.0.1', pid: 7 }], 42), false);
  assert.equal(listenerIsOurs([{ address: '127.0.0.1', pid: 42 }, { address: '0.0.0.0', pid: 7 }], 42), false);
  assert.equal(listenerIsOurs([{ address: '127.0.0.1', pid: 42 }], undefined), false);
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
