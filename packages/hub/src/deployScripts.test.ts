import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOrCreateVapid } from './services/WebPush.js';

/**
 * Hardening pass: static checks on the deploy scripts the hub cannot exercise in a test (they run on a VPS).
 * - P1: every port a per-bot computer (and the shared screen) opens binds 127.0.0.1 only.
 * - P4/P9: backups leave `vault.key` out and keep `vapid.json`; `vapid.json` is owner-only on disk.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
/** Script lines without comments, so a "127.0.0.1" in a comment proves nothing. */
const code = (rel: string) => read(rel).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

describe('bots browse in a normal browser', () => {
  it('prefers real Google Chrome and never starts it in test mode', () => {
    const screen = code('deploy/screen.sh');
    expect(screen).toContain('command -v google-chrome-stable');
    expect(screen).not.toContain('--test-type');
    expect(screen).not.toContain('--enable-automation');
    expect(code('deploy/setup-vps.sh')).toContain('google-chrome-stable_current_amd64.deb');
  });
});

describe('per-bot computers stay on loopback (P1)', () => {
  const screen = code('deploy/screen.sh');
  const computer = code('deploy/computer.sh');

  it('computer.sh derives its ports from the slot and runs screen.sh with them', () => {
    expect(computer).toMatch(/SCREEN_DISPLAY=":\$\(\(200 \+ SLOT\)\)"/);
    expect(computer).toMatch(/CDP_PORT="\$\(\(9400 \+ SLOT\)\)"/);
    expect(computer).toMatch(/VNC_PORT="\$\(\(5800 \+ SLOT\)\)"/);
    expect(computer).toMatch(/NOVNC_PORT="\$\(\(6200 \+ SLOT\)\)"/);
    expect(computer).toMatch(/exec bash "\$\(dirname "\$0"\)\/screen\.sh"/);
    expect(read('deploy/pocketrocket-computer@.service')).toMatch(/ExecStart=.*deploy\/computer\.sh %i/);
  });

  it('keeps a bot\'s logins across restarts', () => {
    // Session-only cookies survive only when Chrome is set to continue where it left off.
    expect(screen).toMatch(/\["restore_on_startup"\] = 1/);
    // Chrome closes before systemd takes the display away, and the port it looks for is the one computer.sh sets.
    expect(read('deploy/pocketrocket-computer@.service')).toMatch(/ExecStop=.*deploy\/computer-stop\.sh %i/);
    expect(code('deploy/computer-stop.sh')).toMatch(/--remote-debugging-port=\$\(\(9400 \+ SLOT\)\)/);
  });

  it('screen.sh binds X, CDP, VNC and noVNC to 127.0.0.1 only', () => {
    expect(screen).not.toMatch(/0\.0\.0\.0|::\b|\[::\]/);
    // X: no TCP listener at all.
    expect(screen).toMatch(/Xvfb [^\n]*-nolisten tcp/);
    // CDP: Chromium binds the debugging port to loopback.
    expect(screen).toMatch(/--remote-debugging-port="\$CDP_PORT" --remote-debugging-address=127\.0\.0\.1/);
    // VNC: x11vnc accepts only local connections.
    expect(screen).toMatch(/x11vnc [^\n]*-localhost[^\n]*-rfbport "\$VNC_PORT"/);
    // noVNC: websockify listens on loopback and proxies to the loopback VNC port.
    expect(screen).toMatch(/websockify [^\n]*"127\.0\.0\.1:\$NOVNC_PORT" "127\.0\.0\.1:\$VNC_PORT"/);
  });
});

describe('backups (P4, P9)', () => {
  const backup = code('deploy/backup.sh');
  it('leaves vault.key out of every archive and does not exclude vapid.json', () => {
    expect(backup).toMatch(/'data\/vault\.key'/);
    // The excludes feed both the tar and the restic branch.
    expect(backup).toMatch(/for e in "\$\{EXCLUDES\[@\]\}"; do args\+=\(--exclude "\$ROOT\/\$e"\); done/);
    expect(backup).toMatch(/for e in "\$\{EXCLUDES\[@\]\}"; do args\+=\(--exclude="\$e"\); done/);
    // Losing the VAPID key forces every phone to re-subscribe, so it stays in the backup.
    expect(backup).not.toMatch(/vapid/);
  });

  it('setup keeps the service user\'s Claude transcripts past the CLI\'s 30-day default', () => {
    const setup = read('deploy/setup-vps.sh');
    expect(setup).toMatch(/sudo -u "\$APP_USER" -H python3 - <<'PY'/);
    expect(setup).toContain("s['cleanupPeriodDays'] = 3650");
  });

  it('archives a consistent copy of the database, not the live WAL files', () => {
    // python3's sqlite3 online backup (the server has no sqlite3 CLI), run as the database's owner.
    expect(backup).toMatch(/as_owner python3 - "\$DB" "\$SNAP\/db-snapshot\/pocketrocket\.db"/);
    expect(backup).toMatch(/src\.backup\(dst\)/);
    expect(backup).toMatch(/runuser -u "\$owner"/);
    for (const f of ['pocketrocket.db', 'pocketrocket.db-wal', 'pocketrocket.db-shm']) expect(backup).toContain("'data/" + f + "'");
    // Both branches take the snapshot and the service user's Claude transcripts.
    expect(backup).toMatch(/tar -czf [^\n]* -C "\$ROOT" data "\$\{EXTRA\[@\]\}"/);
    expect(backup).toMatch(/restic backup [^\n]*"\$ROOT\/data" "\$\{EXTRA_PATHS\[@\]\}"/);
    expect(backup).toMatch(/\$CLAUDE_HOME\/projects/);
    // Retention is unchanged: 7 archives.
    expect(backup).toMatch(/tail -n \+8/);
    expect(backup).toMatch(/--keep-daily 7/);
  });

  it('vapid.json is owner-only when minted and again when loaded with looser modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-vapid-'));
    try {
      const file = path.join(dir, 'vapid.json');
      const a = loadOrCreateVapid(file);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
      fs.chmodSync(file, 0o644);
      const b = loadOrCreateVapid(file);
      expect(b.publicKey).toBe(a.publicKey);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backups stay private (2026-11-03 live findings)', () => {
  const backup = code('deploy/backup.sh');
  it('leaves the hub token and browser snapshots out, and is readable by root only', () => {
    expect(backup).toMatch(/'data\/hub-token'/);
    expect(backup).toMatch(/'data\/bots\/\*\/playwright-output'/);
    expect(backup).toMatch(/^umask 077$/m);
    expect(backup).toMatch(/chmod 700 "\$OUT"/);
    expect(backup).toMatch(/-exec chmod 600/);
  });
});

describe('browser snapshots (2026-11-03 live findings)', () => {
  it('go to the bot home, not the shared workspace', () => {
    expect(code('packages/hub/src/providers/claude.ts')).toMatch(/'--output-dir', path\.join\(ctx\.botHome, 'playwright-output'\)/);
  });
  it('the playwright-core that @playwright/mcp loads leaves password values out', () => {
    const mcp = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
    const core = createRequire(fs.realpathSync(mcp)).resolve('playwright-core/package.json');
    const bundle = fs.readFileSync(path.join(path.dirname(core), 'lib', 'coreBundle.js'), 'utf8');
    expect(bundle).toContain('element.type !== "file" && element.type !== "password")');
  });
});
