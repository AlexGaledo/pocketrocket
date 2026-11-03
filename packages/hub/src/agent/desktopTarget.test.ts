import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1 task 1.3: "Bot A's clicks never land on Bot B's screen". Every xdotool/scrot call carries the DISPLAY and
 * XAUTHORITY of the computer the tools were built for, never the hub's own.
 */
const calls: Array<{ cmd: string; display?: string; xauth?: string }> = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: (cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: (e: Error | null, out?: string) => void) => {
      calls.push({ cmd, display: opts?.env?.DISPLAY, xauth: opts?.env?.XAUTHORITY });
      cb(null, '');
    },
  };
});

const { desktopTools, sharedDesktop } = await import('./desktopTools.js');
const { SCREEN_DISPLAY, WORKSPACE_DIR } = await import('../config.js');

beforeEach(() => { calls.length = 0; });

const tool = (tools: ReturnType<typeof desktopTools>, name: string) => tools.find((t) => t.name === name)!;

describe('desktop tools act on their own computer', () => {
  it('sends bot A\'s click to A\'s display and bot B\'s to B\'s', async () => {
    const a = desktopTools({ display: ':201', xauthority: '/c/a/home/.Xauthority', home: '/c/a/home' });
    const b = desktopTools({ display: ':202', xauthority: '/c/b/home/.Xauthority', home: '/c/b/home' });
    await tool(a, 'desktop_click').handler({ x: 1, y: 2 });
    const fromA = calls.splice(0);
    await tool(b, 'desktop_key').handler({ keys: 'Return' });
    const fromB = calls.splice(0);
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromA.every((c) => c.display === ':201' && c.xauth === '/c/a/home/.Xauthority')).toBe(true);
    expect(fromB.every((c) => c.display === ':202' && c.xauth === '/c/b/home/.Xauthority')).toBe(true);
  });

  it('defaults to the shared screen, as before', async () => {
    expect(sharedDesktop().display).toBe(SCREEN_DISPLAY);
    await tool(desktopTools(), 'desktop_scroll').handler({ x: 1, y: 1, direction: 'down' });
    expect(calls.every((c) => c.display === SCREEN_DISPLAY)).toBe(true);
  });

  it('lets desktop_launch open files on the bot\'s own disk, but not another bot\'s', async () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-files-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-other-'));
    fs.writeFileSync(path.join(own, 'a.txt'), 'x');
    fs.writeFileSync(path.join(other, 'b.txt'), 'x');
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    const tools = desktopTools({ display: ':201', home: own, fileRoots: [own] });
    const launch = tool(tools, 'desktop_launch');
    expect(launch.description).toContain("your computer's own disk");
    const refused = await launch.handler({ command: 'mousepad ' + path.join(other, 'b.txt') });
    expect(refused.isError).toBe(true);
    const ok = await launch.handler({ command: 'mousepad ' + path.join(own, 'a.txt') });
    expect(ok.content.map((c) => ('text' in c ? c.text : '')).join(' ')).not.toContain('inside the workspace');
    fs.rmSync(own, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }, 20_000);
});
