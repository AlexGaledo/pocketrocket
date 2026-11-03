import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openWorkspace, workspaceTarget } from './openWorkspace.js';
import { SCREEN_DISPLAY, WORKSPACE_DIR } from '../config.js';

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

// P1: on a hub with per-bot computers the shared screen (:99) is stopped, so the folder must open on a bot's
// own running computer, and otherwise the user is told what to do instead of a window going nowhere.
describe('openWorkspace with per-bot computers', () => {
  const ep = { display: ':201', xauthority: '/data/computers/b1/home/.Xauthority', home: '/data/computers/b1/home' };
  const fleet = (state: string, has = true) => ({
    enabled: true,
    status: () => ({ state }),
    existingEndpoint: () => (has ? ep : null),
  });
  const bot = { id: 'b1', name: 'Ada' };

  it('opens Thunar on the requesting bot\'s running computer, never the shared display', async () => {
    const calls: Spawned[] = [];
    const r = await openWorkspace({ platform: 'linux', screen: true, spawnFn: fakeSpawn(calls, 'spawn'), mkdir: () => undefined, ...workspaceTarget(fleet('live'), bot) });
    expect(r).toMatchObject({ ok: true, where: 'screen', path: WORKSPACE_DIR });
    expect(calls[0].cmd).toBe('thunar');
    expect(calls[0].env).toMatchObject({ DISPLAY: ':201', XAUTHORITY: ep.xauthority, HOME: ep.home });
    expect(calls[0].env.DISPLAY).not.toBe(SCREEN_DISPLAY);
  });

  it('spawns nothing and says to open a Screen first when no bot is named', async () => {
    const calls: Spawned[] = [];
    const r = await openWorkspace({ platform: 'linux', screen: true, spawnFn: fakeSpawn(calls, 'spawn'), mkdir: () => undefined, ...workspaceTarget(fleet('live'), null) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Screen tab first/);
    expect(calls).toHaveLength(0);
  });

  it('spawns nothing when the bot\'s computer is asleep or was never started', async () => {
    for (const f of [fleet('asleep'), fleet('starting'), fleet('live', false)]) {
      const calls: Spawned[] = [];
      const r = await openWorkspace({ platform: 'linux', screen: true, spawnFn: fakeSpawn(calls, 'spawn'), mkdir: () => undefined, ...workspaceTarget(f, bot) });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Ada's computer is asleep.*Wake/);
      expect(calls).toHaveLength(0);
    }
  });

  it('changes nothing when per-bot computers are off', () => {
    expect(workspaceTarget({ ...fleet('live'), enabled: false }, bot)).toEqual({});
  });
});
