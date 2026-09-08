// Computer-use tools for the virtual desktop (Xvfb :99 on the VPS): screenshot via scrot, input via xdotool.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import { DESKTOP_HOME, SCREEN_DISPLAY, WORKSPACE_DIR } from '../config.js';

const run = promisify(execFile);
const env = { ...process.env, DISPLAY: SCREEN_DISPLAY };
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

async function geometry(): Promise<string> {
  try {
    const { stdout } = await run('xdotool', ['getdisplaygeometry'], { env });
    return stdout.trim().replace(' ', 'x');
  } catch {
    return 'unknown';
  }
}

async function screenshot() {
  const f = path.join(os.tmpdir(), 'claudebot-shot-' + nanoid(6) + '.png');
  try {
    await run('scrot', ['-o', '-z', f], { env });
    const data = fs.readFileSync(f).toString('base64');
    fs.unlinkSync(f);
    const geo = await geometry();
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

export function desktopTools() {
  const shot = tool('desktop_screenshot', 'Take a screenshot of the whole virtual desktop (all windows). Use it to see the current state before and after acting.', {}, screenshot, {
    annotations: { readOnlyHint: true },
  });

  const click = tool(
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

  const type = tool(
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

  const key = tool(
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

  const scroll = tool(
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

  const launch = tool(
    'desktop_launch',
    'Start a desktop application by command, e.g. "xfce4-terminal", "thunar", "mousepad /path/file.txt". Returns a screenshot after it opens.',
    { command: z.string().min(1).describe('Program and arguments') },
    async (a) => {
      const allowed = /^(xfce4-terminal|thunar|mousepad|ristretto|xfce4-appfinder|xdg-open)\b/;
      if (!allowed.test(a.command.trim())) return err('Only desktop apps can be launched here: xfce4-terminal, thunar, mousepad, ristretto, xfce4-appfinder, xdg-open <file|url>. Use Bash for commands.');
      try {
        const [cmd, ...args] = a.command.trim().split(/\s+/);
        const { spawn } = await import('node:child_process');
        // Launch in the shared workspace (= desktop folder) with the desktop's HOME so app config persists.
        const child = spawn(cmd, args, { env: { ...env, HOME: DESKTOP_HOME }, cwd: WORKSPACE_DIR, detached: true, stdio: 'ignore' });
        child.unref();
        await new Promise((r) => setTimeout(r, 1500));
        return screenshot();
      } catch (e) {
        return err('Launch failed: ' + (e as Error).message);
      }
    },
  );

  return [shot, click, type, key, scroll, launch];
}

export const DESKTOP_TOOL_NAMES = ['desktop_screenshot', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_launch'];
// keep `text` referenced for future non-screenshot returns
void text;
