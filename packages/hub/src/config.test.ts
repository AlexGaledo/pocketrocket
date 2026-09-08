import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { HUB_DIR, PLAYWRIGHT_MCP_CLI, VERSION, resolveHubDir, resolveVersion } from './config.js';

// The bundle collapses src/ away: hub.mjs sits at <hub>/hub.mjs next to node_modules and
// package.json, while the source lives at <hub>/src/config.ts. Both layouts have to resolve
// to the same package dir, or PLAYWRIGHT_MCP_CLI points nowhere and VERSION falls back.
// Absolute on every platform: `C:/...` is relative on Linux, so build from the temp root instead.
const BUNDLE = path.resolve(os.tmpdir(), 'pr-app', 'hub');
const SRC = path.join(BUNDLE, 'src');

describe('resolveHubDir', () => {
  it('goes up one level from the source layout (src/config.ts)', () => {
    const exists = (p: string) => p === path.join(BUNDLE, 'node_modules');
    expect(resolveHubDir(SRC, exists)).toBe(BUNDLE);
  });

  it('stays put in the bundle layout (hub.mjs next to node_modules)', () => {
    const exists = (p: string) => p === path.join(BUNDLE, 'node_modules');
    expect(resolveHubDir(BUNDLE, exists)).toBe(BUNDLE);
  });

  it('prefers the nearer node_modules when both candidates have one', () => {
    const exists = () => true;
    expect(resolveHubDir(BUNDLE, exists)).toBe(BUNDLE);
    expect(resolveHubDir(SRC, exists)).toBe(SRC);
  });

  it('falls back to the parent when nothing is installed', () => {
    expect(resolveHubDir(SRC, () => false)).toBe(BUNDLE);
  });
});

describe('resolveVersion', () => {
  const pkg = (version: string) => JSON.stringify({ name: '@pocketrocket/hub', version });

  it('reads <here>/../package.json in the source layout', () => {
    const read = (p: string) => {
      if (p === path.join(BUNDLE, 'package.json')) return pkg('1.2.3');
      throw new Error('ENOENT');
    };
    expect(resolveVersion(SRC, read)).toBe('1.2.3');
  });

  it('reads <here>/package.json in the bundle layout', () => {
    const read = (p: string) => {
      if (p === path.join(BUNDLE, 'package.json')) return pkg('2.0.0');
      throw new Error('ENOENT');
    };
    expect(resolveVersion(BUNDLE, read)).toBe('2.0.0');
  });

  it('prefers the nearer package.json', () => {
    const read = (p: string) => (p === path.join(BUNDLE, 'package.json') ? pkg('9.9.9') : pkg('1.0.0'));
    expect(resolveVersion(SRC, read)).toBe('1.0.0');
  });

  it('skips a package.json without a version and falls through', () => {
    const read = (p: string) => (p === path.join(SRC, 'package.json') ? '{"name":"x"}' : pkg('3.4.5'));
    expect(resolveVersion(SRC, read)).toBe('3.4.5');
  });

  it('returns a marker rather than a plausible-looking version when nothing is readable', () => {
    expect(
      resolveVersion(SRC, () => {
        throw new Error('ENOENT');
      }),
    ).toBe('0.0.0-unknown');
  });
});

describe('live values', () => {
  it('VERSION is the real hub version, not the fallback', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).not.toBe('0.0.0-unknown');
  });

  it('PLAYWRIGHT_MCP_CLI sits under a HUB_DIR that has node_modules', () => {
    expect(PLAYWRIGHT_MCP_CLI).toBe(path.join(HUB_DIR, 'node_modules', '@playwright', 'mcp', 'cli.js'));
    expect(HUB_DIR.endsWith(`${path.sep}src`)).toBe(false);
  });
});
