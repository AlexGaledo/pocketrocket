import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => execFile(...args) }));

describe('isOutdatedCliError', () => {
  it('matches the CLI minimum-version rejection', async () => {
    const { isOutdatedCliError } = await import('./claudeUpdate.js');
    expect(isOutdatedCliError(
      "API Error: 400 Claude Code 2.1.227 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
    )).toBe(true);
  });

  it('ignores other API errors and empty input', async () => {
    const { isOutdatedCliError } = await import('./claudeUpdate.js');
    expect(isOutdatedCliError('API Error: 529 Overloaded')).toBe(false);
    expect(isOutdatedCliError(undefined)).toBe(false);
  });
});

describe('updateClaudeCli', () => {
  beforeEach(() => {
    vi.resetModules();
    execFile.mockReset();
  });

  it('runs `claude update` once for concurrent callers and reuses the fresh result', async () => {
    let finish: (err: Error | null, stdout: string, stderr: string) => void = () => undefined;
    execFile.mockImplementation((_exe: string, args: string[], _opts: unknown, cb: typeof finish) => {
      expect(args).toEqual(['update']);
      finish = cb;
      return { on: () => undefined };
    });
    const { updateClaudeCli } = await import('./claudeUpdate.js');

    const a = updateClaudeCli();
    const b = updateClaudeCli();
    finish(null, 'Successfully updated from 2.1.227 to version 2.1.269', '');
    await expect(a).resolves.toEqual({ ok: true, output: 'Successfully updated from 2.1.227 to version 2.1.269' });
    await expect(b).resolves.toEqual(await a);
    await expect(updateClaudeCli()).resolves.toMatchObject({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('reports a failed update', async () => {
    execFile.mockImplementation((_exe: string, _args: string[], _opts: unknown, cb: (e: Error, o: string, s: string) => void) => {
      cb(new Error('exit 1'), '', 'EBUSY: resource busy or locked');
      return { on: () => undefined };
    });
    const { updateClaudeCli } = await import('./claudeUpdate.js');
    await expect(updateClaudeCli()).resolves.toEqual({ ok: false, output: 'EBUSY: resource busy or locked' });
  });
});
