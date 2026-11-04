// Computer-use tools for a virtual desktop: screenshot via scrot, input via xdotool. Each bot drives its own
// computer's display (services/ComputerManager.ts); without per-bot computers, the one shared screen.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { DESKTOP_HOME, SCREEN_DISPLAY, WORKSPACE_DIR } from '../config.js';
import { hubTool } from './botTools.js';
import { isInside } from '../permissions/pathRules.js';
import type { HubTool, ToolOutput } from '../providers/types.js';
import type { Bot } from '@pocketrocket/shared';
import type { ComputerManager } from '../services/ComputerManager.js';

const run = promisify(execFile);

/** Which desktop the tools act on. Built per turn from the bot's `ComputerEndpoint`. */
export interface DesktopTarget {
  /** X display, e.g. ":201". */
  display: string;
  /** MIT cookie for that display; unset inherits the hub's XAUTHORITY (the shared screen). */
  xauthority?: string;
  /** HOME for launched apps, so their settings persist with that desktop. */
  home: string;
  /** Extra folders desktop_launch may open files from (the bot's own computer disk), besides the workspace. */
  fileRoots?: string[];
  /**
   * P2 control interlock: returns why the tools must not act right now (the user has control, or the bot is
   * paused), or null. Every desktop tool, screenshot included, refuses without touching the display.
   */
  guard?: () => string | null | Promise<string | null>;
}

/** The shared screen every bot used before per-bot computers, and still uses with them off. */
export function sharedDesktop(): DesktopTarget {
  return { display: SCREEN_DISPLAY, home: DESKTOP_HOME };
}
const text = (t: string): ToolOutput => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string): ToolOutput => ({ content: [{ type: 'text' as const, text: t }], isError: true });

async function geometry(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await run('xdotool', ['getdisplaygeometry'], { env });
    return stdout.trim().replace(' ', 'x');
  } catch {
    return 'unknown';
  }
}

async function takeScreenshot(env: NodeJS.ProcessEnv): Promise<ToolOutput> {
  const f = path.join(os.tmpdir(), 'pocketrocket-shot-' + nanoid(6) + '.png');
  try {
    await run('scrot', ['-o', '-z', f], { env });
    const data = fs.readFileSync(f).toString('base64');
    fs.unlinkSync(f);
    const geo = await geometry(env);
    return {
      content: [
        { type: 'image' as const, data, mimeType: 'image/png' },
        { type: 'text' as const, text: 'Desktop screenshot, ' + geo + ' px. Coordinates for desktop_click are pixels from the top-left of this image.' },
      ],
    };
  } catch (e) {
    return err('Screenshot failed: ' + (e as Error).message);
  }
}

export function desktopTools(target: DesktopTarget = sharedDesktop()): HubTool[] {
  // Per target, never the hub's own DISPLAY: bot A's clicks must only ever land on bot A's screen.
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: target.display, ...(target.xauthority ? { XAUTHORITY: target.xauthority } : {}) };
  const roots = [WORKSPACE_DIR, ...(target.fileRoots ?? [])];
  const screenshot = () => takeScreenshot(env);
  const shot = hubTool('desktop_screenshot', 'Take a screenshot of the whole virtual desktop (all windows). Use it to see the current state before and after acting.', {}, () => screenshot(), { readOnly: true });

  const click = hubTool(
    'desktop_click',
    'Move the mouse to (x, y) on the desktop and click. Coordinates are pixels from the top-left of the last screenshot.',
    {
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      button: z.enum(['left', 'right', 'middle', 'double']).optional().describe('Default left'),
    },
    async (a) => {
      const btn = a.button ?? 'left';
      const args = ['mousemove', String(a.x), String(a.y)];
      if (btn === 'double') args.push('click', '--repeat', '2', '--delay', '80', '1');
      else args.push('click', btn === 'right' ? '3' : btn === 'middle' ? '2' : '1');
      try {
        await run('xdotool', args, { env });
        await new Promise((r) => setTimeout(r, 400));
        return screenshot();
      } catch (e) {
        return err('Click failed: ' + (e as Error).message);
      }
    },
  );

  const type = hubTool(
    'desktop_type',
    'Type text into the focused window (click a field first). Use desktop_key for Enter/Tab/shortcuts.',
    { text: z.string().min(1) },
    async (a) => {
      try {
        await run('xdotool', ['type', '--delay', '12', '--', a.text], { env });
        await new Promise((r) => setTimeout(r, 300));
        return screenshot();
      } catch (e) {
        return err('Type failed: ' + (e as Error).message);
      }
    },
  );

  const key = hubTool(
    'desktop_key',
    'Press a key or shortcut in xdotool syntax, e.g. "Return", "Tab", "ctrl+l", "ctrl+shift+t", "alt+F4", "super". Space-separate to press several in sequence.',
    { keys: z.string().min(1) },
    async (a) => {
      try {
        await run('xdotool', ['key', '--delay', '60', '--', ...a.keys.split(/\s+/)], { env });
        await new Promise((r) => setTimeout(r, 400));
        return screenshot();
      } catch (e) {
        return err('Key failed: ' + (e as Error).message);
      }
    },
  );

  const scroll = hubTool(
    'desktop_scroll',
    'Scroll at (x, y).',
    { x: z.number().int().min(0), y: z.number().int().min(0), direction: z.enum(['up', 'down']), clicks: z.number().int().min(1).max(30).optional().describe('Default 5') },
    async (a) => {
      try {
        await run('xdotool', ['mousemove', String(a.x), String(a.y), 'click', '--repeat', String(a.clicks ?? 5), '--delay', '30', a.direction === 'up' ? '4' : '5'], { env });
        await new Promise((r) => setTimeout(r, 400));
        return screenshot();
      } catch (e) {
        return err('Scroll failed: ' + (e as Error).message);
      }
    },
  );

  const launch = hubTool(
    'desktop_launch',
    'Start a desktop GUI application by command, e.g. "thunar", "mousepad notes.txt", "ristretto shot.png". File arguments must be inside the shared workspace' + (target.fileRoots?.length ? ' or your computer\'s own disk' : '') + '. Returns a screenshot after it opens.',
    { command: z.string().min(1).describe('Program and arguments') },
    async (a) => {
      // No terminals and no shells (audit 2026-09-09, B14): xfce4-terminal used to be launchable and
      // desktop_type/desktop_key then drove it, which is arbitrary command execution that never touches
      // bashRules or an approval card. GUI viewers and editors only.
      const allowed = /^(thunar|mousepad|ristretto|xfce4-appfinder|xdg-open)(\s|$)/;
      if (!allowed.test(a.command.trim())) return err('Only these desktop apps can be launched: thunar, mousepad, ristretto, xfce4-appfinder, xdg-open <file>. Terminals and shells are not launchable; use Bash for commands.');
      const [cmd, ...args] = a.command.trim().split(/\s+/);
      // Every argument is a file the app will open: keep them inside the workspace (or the bot's own disk).
      const outside = args.filter((x) => !x.startsWith('-') && !isInside(x, roots, WORKSPACE_DIR));
      if (outside.length) return err('Only files inside the workspace can be opened: ' + outside.join(', '));
      try {
        const { spawn } = await import('node:child_process');
        // Launch in the shared workspace (= desktop folder) with the desktop's HOME so app config persists.
        const child = spawn(cmd, args, { env: { ...env, HOME: target.home }, cwd: WORKSPACE_DIR, detached: true, stdio: 'ignore' });
        // A missing binary surfaces as an async 'error' event; without a listener it would crash the hub.
        const spawnError = new Promise<string | null>((resolve) => {
          child.once('error', (e) => resolve(e.message));
          child.once('spawn', () => resolve(null));
        });
        child.unref();
        const failed = await Promise.race([spawnError, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
        if (failed) return err('Launch failed: ' + failed);
        await new Promise((r) => setTimeout(r, 1500));
        return screenshot();
      } catch (e) {
        return err('Launch failed: ' + (e as Error).message);
      }
    },
  );

  const all = [shot, click, type, key, scroll, launch];
  const guard = target.guard;
  if (!guard) return all;
  return all.map((t) => ({
    ...t,
    handler: async (input: Record<string, unknown>) => {
      const why = await guard();
      return why ? err(why) : t.handler(input);
    },
  }));
}

/** Told to a turn that tries the browser while another turn is on the same computer. */
export const SHARED_BROWSER_NOTE =
  'Another of your chats is using this browser right now. Call browser_tabs with action "new" first and work only in the tab it opens, or you will both drive the same page.';

/** Told to a turn that tries to reach a tab by number while another turn is on the same computer. */
export const SHARED_TAB_NOTE =
  'Another of your chats is using this browser, and tab numbers shift as chats close tabs. Close your own tab with browser_tabs action "close" and no index, once you have opened one with action "new". Selecting a tab by number is refused while the browser is shared.';

/**
 * Look at the screen of a bot in this room, without driving it and without starting anything, so one bot can do the
 * browser work while others follow along with no computer of their own.
 */
export function viewScreenTool(computers: ComputerManager, members: Bot[], selfId: string): HubTool {
  return hubTool(
    'view_screen',
    'See the current screen of another bot in this room. Read only, and it never starts their computer. Use it to follow browser work a teammate is already doing instead of repeating it on your own computer.',
    { handle: z.string().describe('The bot, e.g. "researcher"') },
    async (a) => {
      const handle = a.handle.replace(/^@/, '');
      const b = members.find((m) => m.handle === handle && m.id !== selfId);
      if (!b) return err('@' + handle + ' is not another bot in this room.');
      const ep = computers.existingEndpoint(b.id);
      if (!ep || computers.status(b.id).state !== 'live') return err('@' + handle + "'s computer is not running. Ask them for what you need.");
      return takeScreenshot({ ...process.env, DISPLAY: ep.display, XAUTHORITY: ep.xauthority });
    },
  );
}

export const DESKTOP_TOOL_NAMES = ['desktop_screenshot', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_launch'];
// keep `text` referenced for future non-screenshot returns
void text;
