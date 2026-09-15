import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only execFile is faked; check() never spawns anything else, and the SDK keeps the real module.
const execFile = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
}));

type Callback = (err: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void;

/** Answers `--version` and `auth status` the way the real CLI would. */
function fakeCli(answers: { version?: string | 'timeout' | 'fail'; auth?: string }) {
  execFile.mockImplementation((_exe: string, args: string[], _opts: unknown, cb: Callback) => {
    if (args[0] === '--version') {
      if (answers.version === 'timeout') cb(Object.assign(new Error('timed out'), { killed: true }), '', '');
      else if (answers.version === 'fail') cb(new Error('exit 1'), '', '');
      else cb(null, answers.version ?? '2.1.300 (Claude Code)\n', '');
    } else {
      cb(null, answers.auth ?? '', '');
    }
    return { on: () => undefined };
  });
}

const SIGNED_IN = JSON.stringify({
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'alex@example.com',
  orgId: 'org-1', orgName: "Alex's Organization", subscriptionType: 'max',
});

describe('claude check()', () => {
  let dir: string;
  let exe: string;
  const saved = { exe: process.env.CLAUDE_EXE, key: process.env.ANTHROPIC_API_KEY };

  beforeEach(() => {
    vi.resetModules();
    execFile.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-claude-'));
    exe = path.join(dir, 'claude.exe');
    fs.writeFileSync(exe, '');
    // CLAUDE_EXE is read once at import, so each test sets it and imports afresh.
    process.env.CLAUDE_EXE = exe;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved.exe === undefined) delete process.env.CLAUDE_EXE; else process.env.CLAUDE_EXE = saved.exe;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
  });

  const check = async () => {
    const { ClaudeProvider } = await import('./claude.js');
    return new ClaudeProvider().check();
  };

  it('reports the account, plan, auth method and org of a subscription login', async () => {
    fakeCli({ auth: SIGNED_IN });
    expect(await check()).toMatchObject({
      ok: true, auth: 'subscription', version: '2.1.300 (Claude Code)', exePath: exe,
      account: 'alex@example.com', plan: 'Max', authMethod: 'claude.ai', orgName: "Alex's Organization",
    });
  });

  it('reports a missing binary with the path it looked at and the native installer', async () => {
    process.env.CLAUDE_EXE = path.join(dir, 'nope', 'claude.exe');
    const result = await check();
    expect(result).toMatchObject({ ok: false, auth: 'none', exePath: process.env.CLAUDE_EXE });
    expect(result.unresponsive).toBeUndefined();
    expect(result.error).toContain(process.env.CLAUDE_EXE);
    expect(result.hint).toContain('https://claude.ai/install.ps1');
    expect(result.hint).not.toContain('npm');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('marks a binary that is there but does not answer as unresponsive, not missing', async () => {
    fakeCli({ version: 'timeout' });
    const result = await check();
    expect(result).toMatchObject({ ok: false, unresponsive: true, exePath: exe });
    expect(result.error).toContain('10s');
    expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 10_000 });
  });

  it('marks a binary that fails to run as unresponsive too', async () => {
    fakeCli({ version: 'fail' });
    expect(await check()).toMatchObject({ ok: false, unresponsive: true });
  });

  it('fails an installed CLI that is signed out', async () => {
    fakeCli({ auth: JSON.stringify({ loggedIn: false }) });
    const result = await check();
    expect(result).toMatchObject({ ok: false, auth: 'none', version: '2.1.300 (Claude Code)' });
    expect(result.plan).toBeUndefined();
  });

  it('prefers ANTHROPIC_API_KEY and reports no plan', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    fakeCli({ auth: SIGNED_IN });
    const result = await check();
    expect(result).toMatchObject({ ok: true, auth: 'apiKey' });
    expect(result.plan).toBeUndefined();
  });
});

describe('parseAuthStatus / planLabel', () => {
  it('keeps only string fields and rejects other output', async () => {
    const { parseAuthStatus } = await import('./claude.js');
    expect(parseAuthStatus(SIGNED_IN)).toEqual({
      loggedIn: true, email: 'alex@example.com', subscriptionType: 'max', authMethod: 'claude.ai', orgName: "Alex's Organization",
    });
    expect(parseAuthStatus('Not logged in')).toBeUndefined();
    expect(parseAuthStatus(JSON.stringify({ email: 'x' }))).toBeUndefined();
  });

  it('spells known plans and capitalizes unknown ones', async () => {
    const { planLabel } = await import('./claude.js');
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('MAX')).toBe('Max');
    expect(planLabel('ultra')).toBe('Ultra');
    expect(planLabel(undefined)).toBeUndefined();
  });
});
