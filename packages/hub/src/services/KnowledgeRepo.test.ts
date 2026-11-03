import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { KnowledgeRepo, knowledgeSourceError } from './KnowledgeRepo.js';
import { SettingsRejected, SettingsStore } from './SettingsStore.js';
import { parseGitSource, type GitRunner } from './git.js';

/** P7 (7.1): the knowledge repo source is validated, cloned/linked, pulled, and never handed to a shell. */

const tmps: string[] = [];
const tmp = (p = 'prc-know-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString();

/** A source repo with one committed file; returns its folder and a file:// URL for it. */
function sourceRepo() {
  const dir = tmp('prc-src-');
  g(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Team handbook\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'one');
  return { dir, url: pathToFileURL(dir).href };
}

describe('parseGitSource / knowledgeSourceError', () => {
  it('accepts the URL shapes git clones and an existing absolute folder', () => {
    for (const u of ['https://github.com/org/kb.git', 'ssh://git@host/org/kb', 'git@github.com:org/kb.git', 'file:///srv/kb']) {
      expect(parseGitSource(u), u).toEqual({ kind: 'url', value: u });
    }
    const d = tmp();
    expect(parseGitSource(d)).toEqual({ kind: 'path', value: path.resolve(d) });
  });

  it('refuses option injection, command-running remote helpers and odd shapes', () => {
    for (const bad of [
      '--upload-pack=touch /tmp/pwned', '-c core.sshCommand=calc', 'ext::sh -c touch% /tmp/pwned', 'fd::17',
      'relative/path', 'ftp://host/x', 'https://x/y\nrm -rf /', '', path.join(os.tmpdir(), 'definitely-missing-' + process.pid),
    ]) {
      expect(typeof parseGitSource(bad), bad).toBe('string');
    }
  });

  it('refuses a local folder that is, contains or sits inside the hub data folder', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    expect(knowledgeSourceError(DATA_DIR)).toMatch(/data folder/);
    expect(knowledgeSourceError(path.dirname(DATA_DIR))).toMatch(/data folder/);
    expect(knowledgeSourceError('')).toBeNull();
  });

  it('settings reject a bad source before it is stored', () => {
    const repos = new Repos(new Db(':memory:'));
    const store = new SettingsStore({ repos, enabled: ['claude'], approvalsEnv: null });
    expect(() => store.patch({ knowledgeRepo: 'ext::sh -c id' })).toThrow(SettingsRejected);
    expect(store.get().knowledgeRepo).toBe('');
    expect(store.patch({ knowledgeRepo: 'https://github.com/org/kb.git' }).knowledgeRepo).toBe('https://github.com/org/kb.git');
  });
});

describe('KnowledgeRepo.sync', () => {
  it('passes the URL to git as one argument after --, never through a shell', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'clone') fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
      return args.includes('rev-parse') ? 'abc1234\n' : '';
    };
    const url = 'https://example.com/kb.git; touch pwned';
    // A URL with a space is refused by parseGitSource; use a legal-but-nasty one instead.
    const legal = 'https://example.com/$(touch%20pwned).git';
    expect(typeof parseGitSource(url)).toBe('string');
    const k = new KnowledgeRepo({ repos: new Repos(new Db(':memory:')), source: () => legal, dir: path.join(tmp(), 'knowledge'), git });
    const s = await k.sync();
    expect(s).toMatchObject({ mode: 'clone', head: 'abc1234', lastError: null });
    const clone = calls.find((c) => c[0] === 'clone')!;
    expect(clone[clone.indexOf('--') + 1]).toBe(legal);
  });

  it('clones a git URL, then fast-forwards it on the next sync', async () => {
    const src = sourceRepo();
    const dir = path.join(tmp(), 'knowledge');
    const k = new KnowledgeRepo({ repos: new Repos(new Db(':memory:')), source: () => src.url, dir });
    const first = await k.sync();
    expect(first).toMatchObject({ source: src.url, mode: 'clone', dir, lastError: null });
    expect(first.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain('Team handbook');
    expect(k.activeDir()).toBe(dir);

    fs.writeFileSync(path.join(src.dir, 'onboarding.md'), 'Day one: say hi.\n');
    g(src.dir, 'add', '.');
    g(src.dir, 'commit', '-q', '-m', 'two');
    const second = await k.sync();
    expect(second.lastError).toBeNull();
    expect(second.head).not.toBe(first.head);
    expect(fs.existsSync(path.join(dir, 'onboarding.md'))).toBe(true);
  }, 30_000);

  it('records a failed sync and keeps the last good clone readable', async () => {
    const src = sourceRepo();
    const dir = path.join(tmp(), 'knowledge');
    const k = new KnowledgeRepo({ repos: new Repos(new Db(':memory:')), source: () => src.url, dir });
    await k.sync();
    fs.rmSync(src.dir, { recursive: true, force: true }); // the remote is gone
    const s = await k.sync();
    expect(s.lastError).toBeTruthy();
    expect(s.mode).toBe('clone');
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  }, 30_000);

  it('links a local folder, and unlinking never deletes the folder itself', async () => {
    const folder = tmp('prc-local-');
    fs.writeFileSync(path.join(folder, 'policy.md'), 'Refunds within 30 days.\n');
    const dir = path.join(tmp(), 'knowledge');
    let source = folder;
    const k = new KnowledgeRepo({ repos: new Repos(new Db(':memory:')), source: () => source, dir });
    expect(await k.sync()).toMatchObject({ mode: 'link', dir, lastError: null });
    expect(fs.readFileSync(path.join(dir, 'policy.md'), 'utf8')).toContain('30 days');

    source = '';
    expect(await k.sync()).toMatchObject({ mode: 'off', dir: null });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(folder, 'policy.md'), 'utf8')).toContain('30 days');
    expect(k.activeDir()).toBeNull();
  });

  it('will not delete a hand-made folder that sits where the clone goes', async () => {
    const dir = path.join(tmp(), 'knowledge');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep');
    const folder = tmp('prc-local-');
    const k = new KnowledgeRepo({ repos: new Repos(new Db(':memory:')), source: () => folder, dir });
    const s = await k.sync();
    expect(s.lastError).toMatch(/not a knowledge clone/);
    expect(fs.readFileSync(path.join(dir, 'mine.txt'), 'utf8')).toBe('keep');
  });

  it('activeDir is null until the configured source has actually been synced', async () => {
    const folder = tmp('prc-local-');
    let source = '';
    const k = new KnowledgeRepo({ repos: new Repos(new Db(':memory:')), source: () => source, dir: path.join(tmp(), 'knowledge') });
    source = folder;
    expect(k.activeDir()).toBeNull();
    await k.sync();
    expect(k.activeDir()).not.toBeNull();
    source = 'https://example.com/other.git'; // changed in Settings, not synced yet
    expect(k.activeDir()).toBeNull();
  });
});
