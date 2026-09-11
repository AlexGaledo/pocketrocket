import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openWorkspace } from './openWorkspace.js';
import { WORKSPACE_DIR } from '../config.js';

/**
 * The workspace only exists on the machine the hub runs on. For a local hub that is the user's own PC, so
 * Explorer/Finder is right; for a server hub there is no local desktop at all and the only place a VPS
 * folder can be shown is the virtual display the Screen tab already streams. `where` is what lets the UI
 * say which of those happened instead of promising a window that will never appear.
 */

interface Spawned { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

/** A spawn stand-in that records the call and then emits `event` on the next tick. */
function fakeSpawn(calls: Spawned[], event: 'spawn' | 'error', error?: string) {
  return ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: opts.env ?? {} });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    setTimeout(() => child.emit(event, event === 'error' ? new Error(error ?? 'boom') : undefined), 0);
    return child;
  }) as never;
}

const run = (platform: NodeJS.Platform, screen: boolean, calls: Spawned[], event: 'spawn' | 'error' = 'spawn', error?: string) =>
  openWorkspace({ platform, screen, spawnFn: fakeSpawn(calls, event, error), mkdir: () => undefined });

describe('openWorkspace', () => {
  it('uses Explorer on Windows and always passes the fixed workspace path', async () => {
    const calls: Spawned[] = [];
    const r = await run('win32', false, calls);
    expect(r).toMatchObject({ ok: true, where: 'explorer', path: WORKSPACE_DIR });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('explorer.exe');
    expect(calls[0].args).toEqual([WORKSPACE_DIR]);
  });

  it('uses Finder on macOS', async () => {
    const calls: Spawned[] = [];
    const r = await run('darwin', false, calls);
    expect(r.where).toBe('finder');
    expect(calls[0].cmd).toBe('open');
  });

  it('opens the virtual desktop when the hub is the server, not the machine the user is sitting at', async () => {
    const calls: Spawned[] = [];
    const r = await run('linux', true, calls);
    expect(r.where).toBe('screen');
    expect(calls[0].cmd).toBe('thunar');
    // Without DISPLAY the window would go nowhere; without HOME Thunar would not keep its settings.
    expect(calls[0].env.DISPLAY).toBeTruthy();
    expect(calls[0].env.HOME).toBeTruthy();
  });

  it('falls back to xdg-open on a Linux desktop with no virtual screen', async () => {
    const calls: Spawned[] = [];
    const r = await run('linux', false, calls);
    expect(r.where).toBe('file-manager');
    expect(calls[0].cmd).toBe('xdg-open');
    expect(calls[0].env.DISPLAY).toBe(process.env.DISPLAY);
  });

  it('reports a missing file manager instead of crashing the hub on the async error event', async () => {
    const calls: Spawned[] = [];
    const r = await run('linux', false, calls, 'error', 'spawn xdg-open ENOENT');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOENT');
    expect(r.where).toBe('file-manager');
  });

  it('survives a spawn that throws synchronously', async () => {
    const r = await openWorkspace({
      platform: 'win32',
      spawnFn: (() => { throw new Error('EPERM'); }) as never,
      mkdir: () => undefined,
    });
    expect(r).toMatchObject({ ok: false, error: 'EPERM' });
  });

  it('does not fail because the workspace directory is missing — it creates it', async () => {
    const made: string[] = [];
    const calls: Spawned[] = [];
    const r = await openWorkspace({ platform: 'win32', spawnFn: fakeSpawn(calls, 'spawn'), mkdir: (p) => made.push(p) });
    expect(made).toEqual([WORKSPACE_DIR]);
    expect(r.ok).toBe(true);
  });
});
