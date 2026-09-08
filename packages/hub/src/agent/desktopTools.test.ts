import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopTools, DESKTOP_TOOL_NAMES } from './desktopTools.js';
import { WORKSPACE_DIR } from '../config.js';
import type { ToolOutput } from '../providers/types.js';

/**
 * Audit 2026-09-09, B14: `desktop_launch` allowlisted `xfce4-terminal`, and `desktop_type`/`desktop_key`
 * then drove it — arbitrary command execution that never reaches bashRules or an approval card.
 */

const launch = () => desktopTools().find((t) => t.name === 'desktop_launch')!;
const message = (o: ToolOutput) => o.content.map((c) => ('text' in c ? c.text : '')).join(' ');

describe('desktop_launch', () => {
  it('refuses terminals and shells', async () => {
    for (const cmd of [
      'xfce4-terminal', 'xfce4-terminal -e "id"', 'xterm', 'gnome-terminal', 'konsole',
      'bash', 'sh -c id', 'python3', 'node -e 1', '/bin/sh',
    ]) {
      const out = await launch().handler({ command: cmd });
      expect(out.isError, cmd).toBe(true);
      expect(message(out), cmd).toContain('Terminals and shells are not launchable');
    }
  });

  it('does not allow a prefix trick past the allowlist', async () => {
    for (const cmd of ['thunar-evil', 'mousepadx', 'xdg-openish /etc/passwd']) {
      expect((await launch().handler({ command: cmd })).isError, cmd).toBe(true);
    }
  });

  it('refuses a file argument outside the workspace', async () => {
    for (const cmd of ['mousepad /etc/shadow', 'mousepad ../../secrets.json', 'ristretto ~/private.png', 'xdg-open ../..']) {
      const out = await launch().handler({ command: cmd });
      expect(out.isError, cmd).toBe(true);
      expect(message(out), cmd).toContain('inside the workspace');
    }
  });

  it('accepts a GUI app on a workspace file (the launch itself only works on a real desktop)', async () => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    const f = path.join(WORKSPACE_DIR, 'desktop-launch-probe.txt');
    fs.writeFileSync(f, 'hello');
    // On a machine with no xdotool/scrot the spawn or screenshot fails, but the guard must not be what
    // rejects it: the allowlist and path check are the thing under test.
    const out = await launch().handler({ command: 'mousepad desktop-launch-probe.txt' });
    expect(message(out)).not.toContain('Terminals and shells are not launchable');
    expect(message(out)).not.toContain('inside the workspace');
    fs.rmSync(f, { force: true });
  }, 20_000);

  it('still exposes exactly the six desktop tools', () => {
    expect(desktopTools().map((t) => t.name)).toEqual(DESKTOP_TOOL_NAMES);
  });
});
