import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HUB_DIR, PLAYWRIGHT_MCP_CLI, VERSION, parseApprovalsEnv, parseEnabledProviders, resolveHubDir, resolveVersion,
} from './config.js';

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

describe('parseApprovalsEnv (POCKETROCKET_BYPASS_PERMISSIONS)', () => {
  it('unset or empty leaves the Settings value in charge', () => {
    expect(parseApprovalsEnv(undefined)).toBeNull();
    expect(parseApprovalsEnv('')).toBeNull();
    expect(parseApprovalsEnv('  ')).toBeNull();
  });

  it('1 pins bypass and 0 pins ask', () => {
    for (const v of ['1', 'true', 'YES', ' on ']) expect(parseApprovalsEnv(v)).toBe('bypass');
    for (const v of ['0', 'false', 'no', 'off']) expect(parseApprovalsEnv(v)).toBe('ask');
  });

  it('fails closed on anything it does not recognise', () => {
    expect(parseApprovalsEnv('bypass-please')).toBe('ask');
    expect(parseApprovalsEnv('2')).toBe('ask');
  });
});

describe('parseEnabledProviders (POCKETROCKET_PROVIDERS)', () => {
  it('defaults to Claude only', () => {
    expect(parseEnabledProviders(undefined)).toEqual(['claude']);
    expect(parseEnabledProviders('')).toEqual(['claude']);
  });

  it('re-enables adapters for development, in registry order, and always keeps Claude', () => {
    expect(parseEnabledProviders('claude,opencode')).toEqual(['claude', 'opencode']);
    expect(parseEnabledProviders(' Grok , codex ')).toEqual(['claude', 'codex', 'grok']);
    expect(parseEnabledProviders('opencode,nope')).toEqual(['claude', 'opencode']);
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

describe('Supabase account config (env only, nothing built in)', () => {
  const NAMES = ['POCKETROCKET_SUPABASE_URL', 'POCKETROCKET_SUPABASE_KEY'] as const;
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  const setEnv = (url: string | undefined, key: string | undefined) => {
    for (const [n, v] of [[NAMES[0], url], [NAMES[1], key]] as const) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    vi.resetModules();
  };
  afterEach(() => setEnv(saved[NAMES[0]], saved[NAMES[1]]));

  it('has no URL or key without the env, so the default AccountService is off and never writes the session', async () => {
    setEnv(undefined, undefined);
    const cfg = await import('./config.js');
    expect(cfg.SUPABASE_URL).toBe('');
    expect(cfg.SUPABASE_PUBLISHABLE_KEY).toBe('');
    const { AccountService } = await import('./services/AccountService.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-account-off-'));
    const file = path.join(dir, 'account.json');
    try {
      const s = new AccountService({ file });
      expect(s.enabled).toBe(false);
      expect(s.state()).toMatchObject({ enabled: false, signedIn: false, user: null, email: false });
      await s.start();
      await expect(s.oauthUrl('google', 'http://127.0.0.1:7788/auth/callback')).rejects.toMatchObject({ status: 409 });
      await s.signOut();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays off when only one of the two is set', async () => {
    setEnv('https://proj.supabase.co', undefined);
    const { AccountService } = await import('./services/AccountService.js');
    expect(new AccountService({ file: path.join(os.tmpdir(), 'pr-account-never-written.json') }).enabled).toBe(false);
  });

  it('reads both from the env, trimmed', async () => {
    setEnv(' https://proj.supabase.co ', 'sb_publishable_x\n');
    const cfg = await import('./config.js');
    expect(cfg.SUPABASE_URL).toBe('https://proj.supabase.co');
    expect(cfg.SUPABASE_PUBLISHABLE_KEY).toBe('sb_publishable_x');
  });
});
