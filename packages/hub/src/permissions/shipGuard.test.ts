import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultBranchPushDenied, type GitInfo } from './shipGuard.js';

const on = (branch: string | null, remoteDefault: string | null = null): GitInfo => ({ currentBranch: () => branch, defaultBranch: () => remoteDefault });
const denied = (cmd: string, info: GitInfo = on('feature')) => defaultBranchPushDenied(cmd, '/repo', info);

describe('pushing to the default branch', () => {
  it('is refused however the target is written', () => {
    for (const cmd of [
      'git push origin main',
      'git push origin master',
      'git push -u origin main',
      'git push --force origin main',
      'git push origin +main',
      'git push origin HEAD:main',
      'git push origin feature:refs/heads/main',
      'git push origin refs/heads/main',
      'git add -A && git commit -m x && git push origin main',
      'cd /repo && git push origin main',
      'git -C /repo push origin main',
      'git -c user.name=x push origin main',
      'FOO=1 git push origin main',
      '(cd /repo && git push origin main)',
      'git push --all',
      'git push --mirror origin',
    ]) expect(denied(cmd), cmd).not.toBeNull();
  });
  it('is refused when a bare push would land on it', () => {
    for (const cmd of ['git push', 'git push origin', 'git push -u origin HEAD', 'git push origin HEAD']) expect(denied(cmd, on('main')), cmd).not.toBeNull();
  });
  it('knows a default branch with another name', () => {
    expect(denied('git push origin develop', on('feature', 'develop'))).not.toBeNull();
    expect(denied('git push', on('develop', 'develop'))).not.toBeNull();
  });
  it('asks for a named branch when it cannot tell where a push would land', () => {
    expect(denied('git push', on(null))).toMatch(/Name it/);
    expect(denied('git push origin feature', on(null))).toBeNull();
  });
  it('is refused inside a wrapper it cannot read', () => {
    expect(denied('bash -c "git push origin main"')).toMatch(/plain command/);
    expect(denied('sudo git push')).toMatch(/plain command/);
  });
});

describe('merging a pull request', () => {
  it('is left to the owner', () => {
    expect(denied('gh pr merge 12 --squash')).toMatch(/left to the owner/);
    expect(denied('gh pr create --fill')).toBeNull();
  });
});

describe('ordinary work', () => {
  it('is left alone', () => {
    for (const cmd of [
      'git push origin feature',
      'git push -u origin fix/main-menu',
      'git push origin feature:feature',
      'git push',
      'git push origin HEAD',
      'git push -o ci.skip origin feature',
      'git status',
      'git commit -m "push to main later"',
      'git pull origin main',
      'git fetch origin main',
      'git checkout main',
      'grep -r "git push origin main" docs',
      'npm test',
    ]) expect(denied(cmd), cmd).toBeNull();
  });
});

describe('against a real repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-shipguard-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'init');

  it('reads the checked out branch, and follows cd and -C to it', () => {
    expect(defaultBranchPushDenied('git push', dir)).not.toBeNull();
    expect(defaultBranchPushDenied('cd ' + dir.replaceAll('\\', '/') + ' && git push', os.tmpdir())).not.toBeNull();
    expect(defaultBranchPushDenied('git -C ' + dir.replaceAll('\\', '/') + ' push', os.tmpdir())).not.toBeNull();
    g('checkout', '-q', '-b', 'feature');
    expect(defaultBranchPushDenied('git push', dir)).toBeNull();
  });
  it('asks for a branch outside any repo', () => {
    expect(defaultBranchPushDenied('git push', path.join(dir, '.git', 'hooks', 'nowhere'))).toMatch(/Name it/);
  });
});
