import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { DESKTOP_HOME, SCREEN_DISPLAY, WORKSPACE_DIR } from '../config.js';

/** Where the folder was actually opened, so the UI can name the right place in its toast. */
export type OpenWhere = 'explorer' | 'finder' | 'screen' | 'file-manager';

export interface OpenResult {
  ok: boolean;
  where: OpenWhere;
  path: string;
  error?: string;
}

export interface OpenDeps {
  platform?: NodeJS.Platform;
  /** True when this hub has the virtual X screen (the VPS), so "open a folder" means the Screen tab. */
  screen?: boolean;
  spawnFn?: typeof spawn;
  mkdir?: (p: string) => void;
}

/**
 * Open the shared workspace in the file manager of whatever computer the hub is running on.
 *
 * That last part is the whole design. The web UI may be a browser tab or a desktop webview, and neither can
 * open a folder on its own — but more importantly, in server mode the folder simply is not on the machine
 * you are sitting at. So the hub opens it where it lives: Explorer or Finder for a local hub, and Thunar on
 * the virtual display for a server hub, which is the desktop the Screen tab is already showing. `where`
 * tells the caller which of those happened.
 *
 * The path is always WORKSPACE_DIR and never comes from the request, so there is nothing to inject here.
 */
export function openWorkspace(deps: OpenDeps = {}): Promise<OpenResult> {
  const platform = deps.platform ?? process.platform;
  const onScreen = deps.screen ?? false;
  const spawnFn = deps.spawnFn ?? spawn;
  const path = WORKSPACE_DIR;

  try {
    (deps.mkdir ?? ((p: string) => fs.mkdirSync(p, { recursive: true })))(path);
  } catch {
    /* already there, or unwritable — the launch below reports the real problem */
  }

  let cmd: string;
  let args: string[];
  let where: OpenWhere;
  let env: NodeJS.ProcessEnv = process.env;

  if (platform === 'win32') {
    cmd = 'explorer.exe';
    args = [path];
    where = 'explorer';
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [path];
    where = 'finder';
  } else if (onScreen) {
    // The virtual desktop, with the desktop's own HOME so Thunar's settings persist like every other app there.
    cmd = 'thunar';
    args = [path];
    where = 'screen';
    env = { ...process.env, DISPLAY: SCREEN_DISPLAY, HOME: DESKTOP_HOME };
  } else {
    cmd = 'xdg-open';
    args = [path];
    where = 'file-manager';
  }

  return new Promise<OpenResult>((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { env, detached: true, stdio: 'ignore' });
    } catch (e) {
      resolve({ ok: false, where, path, error: (e as Error).message });
      return;
    }
    let settled = false;
    const done = (r: OpenResult) => { if (!settled) { settled = true; resolve(r); } };
    // A missing binary arrives as an async 'error' event; with no listener it would take the hub down.
    child.once('error', (e: Error) => done({ ok: false, where, path, error: e.message }));
    child.once('spawn', () => done({ ok: true, where, path }));
    child.unref?.();
    // explorer.exe exits 1 even when it opened the window, so exit codes are never consulted: the process
    // starting at all is the success signal, and this timeout is only a floor for a runner that emits neither.
    setTimeout(() => done({ ok: true, where, path }), 2000);
  });
}
