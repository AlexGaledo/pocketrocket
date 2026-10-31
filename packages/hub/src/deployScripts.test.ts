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

describe('per-bot computers stay on loopback (P1)', () => {
  const screen = code('deploy/screen.sh');
  const computer = code('deploy/computer.sh');

  it('computer.sh derives its ports from the slot and runs screen.sh with them', () => {
    expect(computer).toMatch(/SCREEN_DISPLAY=":\$\(\(200 \+ SLOT\)\)"/);
    expect(computer).toMatch(/CDP_PORT="\$\(\(9400 \+ SLOT\)\)"/);
    expect(computer).toMatch(/VNC_PORT="\$\(\(5800 \+ SLOT\)\)"/);
    expect(computer).toMatch(/NOVNC_PORT="\$\(\(6200 \+ SLOT\)\)"/);
    expect(computer).toMatch(/exec bash "\$\(dirname "\$0"\)\/screen\.sh"/);
    expect(read('deploy/pocketrocket-crew-computer@.service')).toMatch(/ExecStart=.*deploy\/computer\.sh %i/);
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
