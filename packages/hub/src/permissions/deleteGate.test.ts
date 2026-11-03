import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Capture the options the Claude provider hands the SDK, and end the turn at once.
const sdk = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    async function* gen() {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, usage: {}, result: 'ok' };
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  },
}));

import { ClaudeProvider } from '../providers/claude.js';
import type { TurnContext } from '../providers/types.js';
import { classifyBash } from './bashRules.js';
import { deleteGate } from './deleteGate.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-del-'));
fs.writeFileSync(path.join(ws, 'a.txt'), 'a');
fs.writeFileSync(path.join(ws, 'b.txt'), 'b');
fs.mkdirSync(path.join(ws, 'sub'));
fs.writeFileSync(path.join(ws, 'sub', 'a.txt'), 'old');
fs.mkdirSync(path.join(ws, '.trash', '2026-11-03'), { recursive: true });
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));
const gate = (cmd: string) => deleteGate(cmd, ws);

describe('rm always asks', () => {
  it.each([
    'rm a.txt',
    'rm -f a.txt',
    'rm -rf sub',
    '/bin/rm a.txt',
    '/usr/bin/rm a.txt',
    '\\rm a.txt',
    '"rm" a.txt',
    "r''m a.txt",
    'rmdir sub',
    'unlink a.txt',
    'shred a.txt',
    'cd sub && rm a.txt',
    'ls; rm a.txt',
    'ls || rm a.txt',
    'ls | rm a.txt',
    'ls & rm a.txt',
    'ls\nrm a.txt',
    '(rm a.txt)',
    '{ rm a.txt; }',
    'f() { rm a.txt; }; f',
    'if true; then rm a.txt; fi',
    'for f in *.txt; do rm "$f"; done',
    'while read f; do rm "$f"; done < list',
    'FOO=1 rm a.txt',
    'sudo rm a.txt',
    'sudo -u bob /bin/rm a.txt',
    'env -i FOO=1 rm a.txt',
    'command rm a.txt',
    'exec rm a.txt',
    'nohup rm a.txt',
    'time rm a.txt',
    'timeout 5 rm a.txt',
    'busybox rm a.txt',
    'find . -delete',
    'find . -name "*.log" -delete',
    'find . -type f -exec rm {} +',
    'find . -execdir /bin/rm {} \\;',
    'find . -exec sh -c \'rm "$1"\' _ {} \\;',
    'ls | xargs rm',
    'ls | xargs -0 -n 1 rm -f',
    'ls | xargs -I{} rm {}',
    'sh -c "rm a.txt"',
    "bash -lc 'cd sub && rm a.txt'",
    'eval "rm a.txt"',
    'eval rm a.txt',
    'echo "$(rm a.txt)"',
    'echo `rm a.txt`',
    'X=$(rm a.txt)',
    'cat <(rm a.txt)',
  ])('%s', (cmd) => {
    expect(gate(cmd)).not.toBeNull();
    // The hook's ask lands in the broker: it must hold there too, and approval rules must not cover it.
    expect(classifyBash(cmd, [ws])).toMatchObject({ verdict: 'ask', danger: true });
  });

  it.each(['CMD=rm; $CMD a.txt', '"$(which rm)" a.txt', 'sudo $CMD a.txt'])('%s asks because the name is only known at run time', (cmd) => {
    expect(gate(cmd)).not.toBeNull();
    expect(classifyBash(cmd, [ws]).verdict).toBe('ask');
  });

  it.each([
    'ls -la',
    'cat a.txt',
    'grep "rm a.txt" log',
    "grep 'rm -rf' a.txt",
    'grep -r rm .',
    'echo rm a.txt',
    '# rm a.txt',
    'ls # then rm a.txt',
    'cat a.txt 2>/dev/null',
    'command -v rm',
    'find . -name rm',
    'git log --grep=rm',
    'npm run rm',
    'mkdir -p .trash/2026-11-03',
  ])('leaves %s alone', (cmd) => {
    expect(gate(cmd)).toBeNull();
  });
});

describe('mv asks only when it would overwrite', () => {
  it.each([
    'mv a.txt new.txt',
    'mv a.txt sub/new.txt',
    'mv b.txt sub',
    'mv b.txt sub/',
    'mv a.txt .trash/2026-11-03/',
    'mv a.txt b.txt .trash/2026-11-03/',
    'mkdir -p .trash/2026-11-04 && mv a.txt .trash/2026-11-04/',
    'mv -t .trash/2026-11-03 a.txt',
    'mv --target-directory=.trash/2026-11-03 a.txt',
    'mv -n a.txt b.txt',
    'mv --no-clobber a.txt b.txt',
    'mv -v a.txt new.txt',
    'mv a.txt new.txt 2>/dev/null',
    'cd sub && mv a.txt new.txt',
    'mv "$F" new.txt',
    'mv *.txt new-dir',
    'mv -- -odd new.txt',
  ])('%s stays silent', (cmd) => {
    expect(gate(cmd)).toBeNull();
  });

  it.each([
    'mv a.txt b.txt',
    'mv -f a.txt b.txt',
    'mv -nf a.txt b.txt',
    'mv a.txt sub',
    'mv a.txt sub/',
    'mv a.txt sub/a.txt',
    'mv -t sub a.txt',
    'mv --target-directory=sub a.txt',
    'mv -T a.txt sub',
    'cd sub && mv a.txt ../b.txt',
    'cat a.txt && mv a.txt b.txt',
    'mv a.txt new.txt && mv b.txt new.txt',
    'sh -c "ls" ; mv a.txt b.txt',
  ])('%s asks', (cmd) => {
    expect(gate(cmd)?.reason).toContain('overwrites');
    expect(classifyBash(cmd, [ws])).toMatchObject({ verdict: 'ask', danger: true });
  });

  it.each([
    'mv a.txt "$DEST"',
    'mv a.txt $(pwd)/x',
    'mv a.txt ~/x',
    'mv a.txt {b,c}',
    'mv *.txt sub',
    'mv "$F" .trash/2026-11-03/',
    'cd "$D" && mv a.txt x',
  ])('%s asks because the command line does not show the answer', (cmd) => {
    expect(gate(cmd)).toMatchObject({ danger: false, reason: expect.stringContaining('Cannot tell') });
  });
});

describe('the PreToolUse hook', () => {
  async function bashHooks(bypass: boolean) {
    sdk.options.length = 0;
    const ctx = {
      turnId: 't', bot: { id: 'b', handle: 'b' }, room: {}, members: [], systemPrompt: '', input: 'hi', resumeToken: null,
      workspaceDir: ws, botHome: path.join(os.tmpdir(), 'prc-home'), tools: [], allowedBuiltins: ['Bash'],
      bypassPermissions: bypass, permission: async () => 'allow', pluginDir: null, model: 'claude-sonnet-5',
      maxBudgetUsd: 1, maxTurns: 1, signal: new AbortController().signal, mcp: { url: '', token: '' },
    } as unknown as TurnContext;
    const sink = { onSession() {}, onDelta() {}, onText() {}, onToolUse() {}, onToolResult() {}, onState() {} };
    await new ClaudeProvider().runTurn(ctx, sink);
    const o = sdk.options[0] as { hooks?: { PreToolUse: { matcher: string; hooks: ((i: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision: string } }>)[] }[] } };
    return (o.hooks?.PreToolUse ?? []).filter((h) => h.matcher === 'Bash');
  }

  it('asks for rm and an overwriting mv, and passes a move into .trash', async () => {
    const [h] = await bashHooks(false);
    const run = (command: string) => h.hooks[0]({ tool_name: 'Bash', tool_input: { command }, cwd: ws });
    expect((await run('rm a.txt')).hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
    expect((await run('mv a.txt b.txt')).hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
    expect(await run('mv a.txt .trash/2026-11-03/')).toEqual({});
    expect(await run('ls')).toEqual({});
  });

  it('follows the working directory the CLI reports', async () => {
    const [h] = await bashHooks(false);
    const r = await h.hooks[0]({ tool_name: 'Bash', tool_input: { command: 'mv ../b.txt a.txt' }, cwd: path.join(ws, 'sub') });
    expect(r.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('is not installed under bypass, where nothing asks', async () => {
    expect(await bashHooks(true)).toEqual([]);
  });
});
