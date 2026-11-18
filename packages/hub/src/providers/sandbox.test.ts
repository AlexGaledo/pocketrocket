import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../services/SettingsStore.js';
import {
  assertMountable, botClaudeDir, browserMcpRoots, bwrapUsable, migrateTranscript, realProbe, sandboxActive, sandboxArgv, sandboxCommand,
  sandboxStatus, setSandboxProbeForTests, SandboxUnavailable, transcriptDirName, type SandboxFs, type SandboxSpec,
} from './sandbox.js';

const D = '/srv/pr/data';
const HOME = '/home/pr';
const present = new Set<string>([
  '/usr', '/etc/resolv.conf', '/etc/hosts', '/etc/ssl', '/etc/passwd', `${HOME}/.gitconfig`,
  `${D}/bots/botA`, `${D}/bots/botA/.claude-sandbox`, `${D}/projects/projA`, `${D}/workspace`, `${D}/knowledge`, `${D}/computers/botA/files`,
  `${HOME}/.local/share/claude/versions/2.1.9`, `${HOME}/.claude/.credentials.json`,
]);
const fakeFs: SandboxFs = {
  exists: (p) => present.has(p),
  readlink: (p) => (['/bin', '/sbin', '/lib', '/lib64'].includes(p) ? 'usr' + p : null),
  realpath: (p) => (p === `${HOME}/.local/bin/claude` ? `${HOME}/.local/share/claude/versions/2.1.9` : p),
};

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  dataDir: D, home: HOME, cwd: `${D}/workspace`, botHome: `${D}/bots/botA`,
  writable: [`${D}/projects/projA`, `${D}/computers/botA/files`], readOnly: [`${D}/knowledge`],
  executable: `${HOME}/.local/bin/claude`, credentials: `${HOME}/.claude/.credentials.json`,
  env: { PATH: '/usr/bin', LANG: 'C.UTF-8', POCKETROCKET_TOKEN: 'hub-secret', ANTHROPIC_API_KEY: 'sk-x', TMPDIR: '/var/tmp/x', DISPLAY: ':1', XDG_RUNTIME_DIR: '/run/user/1' },
  ...over,
});

/** Every (flag, src, dest) triple for the mount flags. */
function mounts(argv: string[]) {
  const out: { flag: string; src: string; dest: string }[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (['--bind', '--ro-bind'].includes(argv[i])) out.push({ flag: argv[i], src: argv[i + 1], dest: argv[i + 2] });
  }
  return out;
}

afterEach(() => {
  setSandboxProbeForTests();
  vi.restoreAllMocks();
});

describe('sandboxArgv', () => {
  const argv = sandboxArgv(spec(), fakeFs);
  const m = mounts(argv);
  const dests = m.map((x) => x.dest);

  it('isolates pid, ipc and uts, dies with the hub and starts a new session, but keeps the network', () => {
    for (const f of ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session']) expect(argv).toContain(f);
    expect(argv).not.toContain('--unshare-net');
    expect(argv).not.toContain('--unshare-all');
    expect(argv).toContain('--clearenv');
  });

  it('mounts the bot home, its project and computer folders writable', () => {
    expect(m).toContainEqual({ flag: '--bind', src: `${D}/bots/botA`, dest: `${D}/bots/botA` });
    expect(m).toContainEqual({ flag: '--bind', src: `${D}/projects/projA`, dest: `${D}/projects/projA` });
    expect(m).toContainEqual({ flag: '--bind', src: `${D}/workspace`, dest: `${D}/workspace` });
    expect(m).toContainEqual({ flag: '--bind', src: `${D}/computers/botA/files`, dest: `${D}/computers/botA/files` });
  });

  it('mounts system, knowledge and the CLI read-only', () => {
    expect(m).toContainEqual({ flag: '--ro-bind', src: '/usr', dest: '/usr' });
    expect(m).toContainEqual({ flag: '--ro-bind', src: `${D}/knowledge`, dest: `${D}/knowledge` });
    const exe = `${HOME}/.local/share/claude/versions/2.1.9`;
    expect(m).toContainEqual({ flag: '--ro-bind', src: exe, dest: exe });
    expect(argv).toContain('--symlink'); // /bin -> usr/bin
    expect(m).toContainEqual({ flag: '--ro-bind', src: '/etc/resolv.conf', dest: '/etc/resolv.conf' });
    expect(argv).not.toContain('/etc/shadow');
  });

  it('never mounts the data root, the secrets, the database, other bots or other projects', () => {
    for (const hidden of [D, `${D}/vault.key`, `${D}/hub-token`, `${D}/pocketrocket.db`, `${D}/bots`, `${D}/bots/botB`, `${D}/projects`, `${D}/projects/projB`, `${D}/rooms`, `${HOME}/.ssh`, '/', '/home']) {
      expect(dests, hidden).not.toContain(hidden);
    }
    // Nothing mounted contains the data root.
    for (const d of dests) {
      expect(D.startsWith(d + '/') || d === D, d).toBe(false);
    }
    expect(argv.join(' ')).not.toContain('vault.key');
    expect(argv.join(' ')).not.toContain('hub-token');
  });

  it('gives the bot a private ~/.claude and the login file inside it, and an empty home otherwise', () => {
    const i = argv.indexOf('--tmpfs', argv.indexOf('/tmp'));
    expect(argv.slice(i, i + 2)).toEqual(['--tmpfs', HOME]);
    expect(m).toContainEqual({ flag: '--bind', src: botClaudeDir(`${D}/bots/botA`), dest: `${HOME}/.claude` });
    expect(m).toContainEqual({ flag: '--bind', src: `${HOME}/.claude/.credentials.json`, dest: `${HOME}/.claude/.credentials.json` });
    expect(dests).not.toContain(`${HOME}/.claude/projects`);
    expect(dests.filter((d) => d === `${HOME}/.claude`)).toHaveLength(1);
  });

  it('mounts parents before children', () => {
    expect(dests.indexOf(`${HOME}/.claude`)).toBeLessThan(dests.indexOf(`${HOME}/.claude/.credentials.json`));
  });

  it('passes an env allowlist: no hub token, no host temp/display/xdg, HOME and TMPDIR pinned', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--setenv') env[argv[i + 1]] = argv[i + 2];
    expect(env).toMatchObject({ HOME, TMPDIR: '/tmp', PATH: '/usr/bin', LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'sk-x' });
    expect(Object.keys(env)).not.toContain('POCKETROCKET_TOKEN');
    expect(Object.keys(env)).not.toContain('DISPLAY');
    expect(Object.keys(env)).not.toContain('XDG_RUNTIME_DIR');
    expect(argv.indexOf('--clearenv')).toBeLessThan(argv.indexOf('--setenv'));
    expect(argv.join('\0')).not.toContain('hub-secret');
  });

  it('is deterministic and the mounts differ per bot', () => {
    expect(sandboxArgv(spec(), fakeFs)).toEqual(argv);
    present.add(`${D}/bots/botB`);
    const b = mounts(sandboxArgv(spec({ botHome: `${D}/bots/botB`, writable: [] }), fakeFs)).map((x) => x.dest);
    present.delete(`${D}/bots/botB`);
    expect(b).toContain(`${D}/bots/botB`);
    expect(b).not.toContain(`${D}/bots/botA`);
    expect(b).not.toContain(`${D}/projects/projA`);
  });

  it('skips mounts that do not exist yet instead of failing the turn', () => {
    const m2 = mounts(sandboxArgv(spec({ writable: [`${D}/projects/not-made-yet`] }), fakeFs)).map((x) => x.dest);
    expect(m2).not.toContain(`${D}/projects/not-made-yet`);
  });

  it('refuses a mount that would expose the data root, the home or a secret', () => {
    for (const bad of [D, '/srv/pr', '/', HOME, `${D}/bots`, `${D}/projects`, `${D}/vault.key`, `${D}/hub-token`, `${D}/pocketrocket.db`]) {
      expect(() => sandboxArgv(spec({ writable: [bad] }), { ...fakeFs, exists: () => true }), bad).toThrow(/sandbox: refusing/);
    }
    expect(() => assertMountable(`${D}/projects/projA`, { dataDir: D, home: HOME }, fakeFs)).not.toThrow();
    expect(() => assertMountable(`${D}/workspace`, { dataDir: D, home: HOME }, fakeFs)).not.toThrow();
  });

  it('refuses a folder whose real path leads to the data root (a symlink in a project)', () => {
    const linked: SandboxFs = { ...fakeFs, realpath: (p) => (p === `${D}/projects/projA` ? D : fakeFs.realpath(p)) };
    expect(() => sandboxArgv(spec(), linked)).toThrow(/sandbox: refusing/);
  });

  it('adds the Browser MCP packages read-only when asked', () => {
    const roots = browserMcpRoots('/srv/pr/packages/hub/node_modules/@playwright/mcp/cli.js', '/usr/bin/node');
    expect(roots).toContain('/srv/pr/packages/hub/node_modules/@playwright');
  });
});

describe('transcripts', () => {
  it('names the transcript folder the way the CLI does', () => {
    expect(transcriptDirName('/home/pocketrocket/pocketrocket/data/workspace')).toBe('-home-pocketrocket-pocketrocket-data-workspace');
    expect(transcriptDirName('/tmp/pr-cont-s6Vp/workspace')).toBe('-tmp-pr-cont-s6Vp-workspace');
  });

  it('copies a resumed session into the bot private config dir once, and ignores bad ids', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-mig-'));
    try {
      const cwd = '/srv/pr/data/workspace';
      const host = path.join(root, 'claude');
      const from = path.join(host, 'projects', transcriptDirName(cwd));
      const id = '11111111-2222-3333-4444-555555555555';
      fs.mkdirSync(path.join(from, id), { recursive: true });
      fs.writeFileSync(path.join(from, id + '.jsonl'), 'line\n');
      fs.writeFileSync(path.join(from, id, 'note.txt'), 'x');
      const botHome = path.join(root, 'bot');
      migrateTranscript(host, botHome, cwd, id);
      const to = path.join(botHome, '.claude-sandbox', 'projects', transcriptDirName(cwd));
      expect(fs.readFileSync(path.join(to, id + '.jsonl'), 'utf8')).toBe('line\n');
      expect(fs.existsSync(path.join(to, id, 'note.txt'))).toBe(true);
      // A second call must not overwrite what the sandboxed CLI has since appended.
      fs.appendFileSync(path.join(to, id + '.jsonl'), 'more\n');
      migrateTranscript(host, botHome, cwd, id);
      expect(fs.readFileSync(path.join(to, id + '.jsonl'), 'utf8')).toBe('line\nmore\n');
      // Not an id: nothing happens (no path traversal).
      migrateTranscript(host, botHome, cwd, '../../etc/passwd');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('availability and fail-closed', () => {
  const turn = { cwd: '/w', botHome: '/b', writable: [], readOnly: [] };
  const mode = (m: 'off' | 'on') => vi.spyOn(settings, 'get').mockReturnValue({ sandbox: m } as never);

  it('is off by default: nothing is wrapped and client repos stay blocked', () => {
    mode('off');
    expect(sandboxCommand({ command: '/x/claude', args: ['a'], env: {} }, turn, { dataDir: D })).toBeNull();
    expect(sandboxActive()).toBe(false);
  });

  it('on with bubblewrap unusable: the turn throws with the reason, never runs unsandboxed', () => {
    mode('on');
    setSandboxProbeForTests(() => ({ ok: false, reason: 'bubblewrap (bwrap) is not installed.' }));
    expect(() => sandboxCommand({ command: '/x/claude', args: [], env: {} }, turn, { dataDir: D })).toThrow(SandboxUnavailable);
    expect(() => sandboxCommand({ command: '/x/claude', args: [], env: {} }, turn, { dataDir: D })).toThrow(/not installed[\s\S]*Turn it off in Settings|fails closed[\s\S]*not installed/);
    expect(sandboxActive()).toBe(false);
    expect(sandboxStatus()).toEqual({ available: false, active: false, reason: 'bubblewrap (bwrap) is not installed.' });
  });

  it('on and usable: active, and the status says so', () => {
    mode('on');
    setSandboxProbeForTests(() => ({ ok: true, reason: '' }));
    expect(sandboxActive()).toBe(true);
    expect(sandboxStatus()).toEqual({ available: true, active: true, reason: '' });
  });

  it('off but usable: available, not active', () => {
    mode('off');
    setSandboxProbeForTests(() => ({ ok: true, reason: '' }));
    expect(sandboxStatus()).toEqual({ available: true, active: false, reason: '' });
  });

  it('remembers a success for a minute and a failure for a few seconds', () => {
    const probe = vi.fn(() => ({ ok: true, reason: '' }));
    setSandboxProbeForTests(probe);
    bwrapUsable(1000);
    bwrapUsable(30_000);
    expect(probe).toHaveBeenCalledTimes(1);
    bwrapUsable(70_000);
    expect(probe).toHaveBeenCalledTimes(2);
    const bad = vi.fn(() => ({ ok: false, reason: 'no' }));
    setSandboxProbeForTests(bad);
    bwrapUsable(0);
    bwrapUsable(2000);
    expect(bad).toHaveBeenCalledTimes(1);
    bwrapUsable(6000);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it('reports a non-Linux host as unavailable without trying', () => {
    if (process.platform === 'linux') return;
    expect(realProbe()).toMatchObject({ ok: false, reason: expect.stringContaining('Linux') });
  });
});

describe('only the REST API writes the sandbox setting', () => {
  it('no other source file calls settings.patch', () => {
    const root = path.resolve(__dirname, '..');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && /\bsettings\.patch\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p).replaceAll('\\', '/'));
      }
    };
    walk(root);
    expect(hits).toEqual(['api/rest.ts']);
  });
});

// The real thing, on a Linux box with bubblewrap: bot A (with Bash) cannot read project B, another bot, the vault key,
// the hub token or the database, and still reaches its own folders.
const hasBwrap = process.platform === 'linux' && realProbe().ok;
describe.skipIf(!hasBwrap)('bubblewrap integration (Linux)', () => {
  it('bot A cannot cat project B or the hub secrets, and can use its own folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-int-'));
    try {
      const data = path.join(root, 'data');
      const home = path.join(root, 'home');
      const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true }); fs.writeFileSync(path.join(data, rel), text); };
      w('projects/a/notes.md', 'A'); w('projects/b/secret.md', 'B'); w('bots/botA/home.txt', 'a'); w('bots/botB/home.txt', 'b');
      w('vault.key', 'KEY'); w('hub-token', 'TOKEN'); w('pocketrocket.db', 'DB'); w('workspace/x.txt', 'w');
      fs.mkdirSync(botClaudeDir(path.join(data, 'bots/botA')), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      const argv = sandboxArgv({
        dataDir: data, home, cwd: path.join(data, 'workspace'), botHome: path.join(data, 'bots/botA'),
        writable: [path.join(data, 'projects/a')], readOnly: [], executable: '/usr/bin/true', env: { PATH: '/usr/bin:/bin' },
      });
      const run = (...cmd: string[]) => spawnSync('bwrap', [...argv, '--', ...cmd], { encoding: 'utf8' });
      expect(run('/usr/bin/cat', path.join(data, 'projects/a/notes.md')).stdout).toBe('A');
      expect(run('/usr/bin/touch', path.join(data, 'bots/botA/new.txt')).status).toBe(0);
      expect(fs.existsSync(path.join(data, 'bots/botA/new.txt'))).toBe(true);
      expect(run('/usr/bin/touch', '/usr/x').status).not.toBe(0);
      for (const hidden of ['projects/b/secret.md', 'bots/botB/home.txt', 'vault.key', 'hub-token', 'pocketrocket.db']) {
        const r = run('/usr/bin/cat', path.join(data, hidden));
        expect(r.status, hidden).not.toBe(0);
        expect(r.stdout, hidden).toBe('');
      }
      expect(run('/usr/bin/ls', data).stdout.split('\n').sort()).toEqual(['', 'bots', 'projects', 'workspace']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
