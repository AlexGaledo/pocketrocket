import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectReposFileSchema, normaliseRemote, wipBranchName } from '@pocketrocket/shared';
import { reposFileWriteDenied } from '../permissions/projectGuard.js';
import { BundleError, vpsDir } from './BundleImport.js';

/** Bridge P5: the repos.json schema, the remote normaliser and the bot write guard. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repos-schema-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = (over: Record<string, unknown> = {}) => ({ name: 'app', remote: 'git@github.com:org/app.git', ...over });
const parse = (repos: unknown[]) => ProjectReposFileSchema.safeParse({ repos });
const errors = (repos: unknown[]) => {
  const r = parse(repos);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.') + ': ' + i.message);
};

describe('repos.json schema', () => {
  it('accepts a full entry and fills the defaults of a short one', () => {
    const full = parse([repo({ sync: 'wip-branch', protected: ['main', 'staging', 'main'], client: true, vps: 'repos/wika-frontend-expo' })]);
    expect(full.success).toBe(true);
    if (full.success) expect(full.data.repos[0]).toMatchObject({ sync: 'wip-branch', protected: ['main', 'staging'], client: true, vps: 'repos/wika-frontend-expo' });
    const short = parse([repo()]);
    expect(short.success).toBe(true);
    if (short.success) expect(short.data.repos[0]).toMatchObject({ name: 'app', sync: 'none', protected: [], client: false, vps: 'repos/app' });
  });

  it('takes good repo names and refuses bad ones', () => {
    for (const name of ['a', 'app', 'wika-frontend-expo', 'planliftar_2', '0day', 'x'.repeat(41)]) expect(parse([repo({ name })]).success, name).toBe(true);
    for (const name of ['', 'App', 'has space', '-lead', '_lead', 'dot.name', 'slash/name', '../x', 'x'.repeat(42), 'ünï']) {
      expect(errors([repo({ name })]).join(), name).toMatch(/name/);
    }
  });

  it('refuses a vps path that is absolute, has .. or is not a plain relative folder', () => {
    for (const vps of ['/etc', '/repos/app', 'C:\\work\\app', 'C:/work/app', '..', '../x', 'repos/../../x', 'a/../b', 'repos\\app', '.git', 'repos/.git', '.incoming', 'repos//app', 'repos/', '', 'a/b/c/d/e/f/g']) {
      expect(errors([repo({ vps })]).join(), JSON.stringify(vps)).toMatch(/vps/);
    }
    for (const vps of ['repos/app', 'app', 'code/wika/app.v2']) expect(parse([repo({ vps })]).success, vps).toBe(true);
  });

  it('refuses duplicate names and two repos on one vps folder', () => {
    expect(errors([repo(), repo({ remote: 'git@github.com:org/other.git' })]).join()).toMatch(/duplicate repo name "app"/);
    expect(errors([repo(), repo({ name: 'two', vps: 'repos/app' })]).join()).toMatch(/same vps folder/);
  });

  it('needs a remote that is a git URL without credentials', () => {
    expect(errors([{ name: 'app' }]).join()).toMatch(/remote/);
    for (const remote of ['', 'not a url', '/local/path', 'file:///tmp/x', 'ext::sh -c id', '--upload-pack=x', 'C:\\repo']) {
      expect(errors([repo({ remote })]).join(), remote).toMatch(/remote/);
    }
    for (const remote of ['https://user:ghp_secret@github.com/org/app.git', 'https://token@github.com/org/app', 'ssh://user:pw@host/org/app']) {
      expect(errors([repo({ remote })]).join(), remote).toMatch(/credentials/);
    }
    for (const remote of ['https://github.com/org/app', 'git@github.com:org/app.git', 'ssh://git@github.com/org/app.git']) expect(parse([repo({ remote })]).success, remote).toBe(true);
  });

  it('refuses an unknown sync mode and a bad protected branch', () => {
    expect(errors([repo({ sync: 'rsync' })]).join()).toMatch(/sync/);
    for (const b of ['', '..', 'a..b', '-x', 'x lock', 'a//b', 'x.lock']) expect(errors([repo({ protected: [b] })]).join(), b).toMatch(/protected/);
  });
});

/** The same table lives in the runner's own test: keep them identical. */
export const NORMALISE_CASES: [input: string, expected: string | null][] = [
  // ssh and https agree
  ['git@github.com:org/app.git', 'https://github.com/org/app'],
  ['https://github.com/org/app.git', 'https://github.com/org/app'],
  ['https://github.com/org/app', 'https://github.com/org/app'],
  ['https://github.com/org/app/', 'https://github.com/org/app'],
  ['ssh://git@github.com/org/app.git', 'https://github.com/org/app'],
  ['ssh://git@github.com:22/org/app.git', 'https://github.com/org/app'],
  ['git://github.com/org/app.git', 'https://github.com/org/app'],
  ['http://github.com/org/app', 'https://github.com/org/app'],
  // host case, path case kept
  ['git@GitHub.COM:Org/App.git', 'https://github.com/Org/App'],
  ['HTTPS://GITHUB.COM/Org/App.GIT', 'https://github.com/Org/App'],
  // credentials dropped
  ['https://user:ghp_token@github.com/org/app.git', 'https://github.com/org/app'],
  ['https://token@github.com/org/app', 'https://github.com/org/app'],
  ['ssh://user:pw@host.example/org/app', 'https://host.example/org/app'],
  // ports: https keeps a non-default one, ssh drops its own
  ['https://git.example.com:8443/org/app.git', 'https://git.example.com:8443/org/app'],
  ['https://git.example.com:443/org/app.git', 'https://git.example.com/org/app'],
  ['ssh://git@git.example.com:2222/org/app.git', 'https://git.example.com/org/app'],
  // nested groups, query and fragment
  ['git@gitlab.com:group/sub/app.git', 'https://gitlab.com/group/sub/app'],
  ['https://gitlab.com/group/sub/app.git?x=1#y', 'https://gitlab.com/group/sub/app'],
  // whitespace around is trimmed
  ['  git@github.com:org/app.git  ', 'https://github.com/org/app'],
  // not remotes
  ['', null],
  ['   ', null],
  ['/home/me/app', null],
  ['C:\\Users\\me\\app', null],
  ['C:/Users/me/app', null],
  ['file:///tmp/app', null],
  ['ext::sh -c "id"', null],
  ['--upload-pack=touch /tmp/x', null],
  ['https://github.com', null],
  ['https://github.com/', null],
  ['https://github.com/../x', null],
  ['git@github.com:', null],
  ['org/app', null],
  ['https://exa mple.com/org/app', null],
];

describe('normaliseRemote', () => {
  it.each(NORMALISE_CASES)('%j -> %j', (input, expected) => {
    expect(normaliseRemote(input)).toBe(expected);
  });
  it('makes every spelling of one repo equal', () => {
    const spellings = ['git@github.com:org/app.git', 'ssh://git@GITHUB.com/org/app', 'https://u:p@github.com/org/app.git/', 'https://github.com/org/app'];
    expect(new Set(spellings.map(normaliseRemote)).size).toBe(1);
    expect(normaliseRemote('git@github.com:org/app.git')).not.toBe(normaliseRemote('git@github.com:org/other.git'));
  });
});


/** Copied from the runner's REMOTE_TABLE (scripts/pc-runner/lib.test.mjs, PR #148): both copies must agree. */
const RUNNER_TABLE: [unknown, string | null][] = [
  ['git@github.com:org/repo.git', 'https://github.com/org/repo'],
  ['git@GitHub.com:org/repo', 'https://github.com/org/repo'],
  ['git@github.com:/org/repo.git', 'https://github.com/org/repo'],
  ['https://github.com/org/repo', 'https://github.com/org/repo'],
  ['https://GitHub.com/org/repo.git', 'https://github.com/org/repo'],
  ['https://github.com/org/repo.git/', 'https://github.com/org/repo'],
  ['  https://github.com/org/repo.git  ', 'https://github.com/org/repo'],
  ['http://github.com/org/repo.git', 'https://github.com/org/repo'],
  ['https://user:secret@github.com/org/repo.git', 'https://github.com/org/repo'],
  ['https://x-access-token:abc@github.com/org/repo', 'https://github.com/org/repo'],
  ['ssh://git@github.com/org/repo.git', 'https://github.com/org/repo'],
  ['ssh://git@github.com:22/org/repo.git', 'https://github.com/org/repo'],
  ['git://github.com/org/repo.git', 'https://github.com/org/repo'],
  ['https://github.com:443/org/repo', 'https://github.com/org/repo'],
  ['https://git.example.com:8443/org/repo.git', 'https://git.example.com:8443/org/repo'],
  ['git@gitlab.com:group/sub/repo.git', 'https://gitlab.com/group/sub/repo'],
  ['https://github.com/Org/Repo', 'https://github.com/Org/Repo'],
  ['', null], ['   ', null], ['not a url', null], ['github.com', null], ['https://github.com', null], ['https://github.com/', null],
  ['git@github.com:', null], ['https://github.com/org/../repo', null], ['ftp://github.com/org/repo', null],
  ['file:///srv/git/repo.git', null], ['C:' + String.fromCharCode(92) + 'repos' + String.fromCharCode(92) + 'app', null], ['/srv/git/repo.git', null], ['https://exa mple.com/o/r', null],
  [undefined, null], [42, null],
];
describe('normaliseRemote, the runner table', () => {
  it.each(RUNNER_TABLE)('%j -> %j', (input, expected) => {
    expect(normaliseRemote(input as string)).toBe(expected);
  });
});

describe('wipBranchName', () => {
  it('is wip/<machine>/<first 8 of the session>, safe for a ref', () => {
    expect(wipBranchName('pc', '0a1b2c3d-1111-2222-3333-444455556666')).toBe('wip/pc/0a1b2c3d');
    expect(wipBranchName('My PC!', 'ABCDEF12-3456')).toBe('wip/my-pc/abcdef12');
    // Must match the PC runner's sanitizeMachine: '_' and other symbols become '-', no trailing '-'.
    expect(wipBranchName('Alex_PC', 'abcdef12-2222')).toBe('wip/alex-pc/abcdef12');
    expect(wipBranchName('a'.repeat(29) + '_b', 'abcdef12')).toBe('wip/' + 'a'.repeat(29) + '/abcdef12');
    expect(wipBranchName('../..', 'x')).toMatch(/^wip\/[a-z0-9_-]+\/[a-z0-9]+$/);
  });
});

describe('a bot writing repos.json', () => {
  const root = path.join(tmp, 'projects');
  const denied = (tool: string, input: Record<string, unknown>, cwd = path.join(root, 'wika')) => reposFileWriteDenied(tool, input, cwd, root);
  it('is refused for every write tool and for shell writes, wherever the path is spelled from', () => {
    expect(denied('Write', { file_path: path.join(root, 'wika', 'repos.json') })).toMatch(/owner/);
    expect(denied('Edit', { file_path: 'repos.json' })).toMatch(/owner/);
    expect(denied('MultiEdit', { file_path: './sub/../repos.json' })).toMatch(/owner/);
    expect(denied('Write', { file_path: path.join(root, 'wika', 'REPOS.JSON') })).toMatch(/owner/);
    for (const command of ['echo {} > repos.json', 'cat x >> repos.json', 'tee repos.json < x', 'mv x.json repos.json', 'rm repos.json', "sed -i 's/true/false/' repos.json", 'Set-Content repos.json "{}"']) {
      expect(denied('Bash', { command }), command).toMatch(/owner/);
    }
  });
  it('leaves reading it, other files and other folders alone', () => {
    expect(denied('Bash', { command: 'cat repos.json' })).toBeNull();
    expect(denied('Bash', { command: 'grep client repos.json | head' })).toBeNull();
    expect(denied('Write', { file_path: 'notes.json' })).toBeNull();
    expect(denied('Write', { file_path: path.join(tmp, 'elsewhere', 'repos.json') })).toBeNull();
  });
});

describe('the VPS folder', () => {
  it('stays inside the project, also through a link', () => {
    const project = path.join(tmp, 'p1');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(project, 'repos'), { recursive: true });
    fs.mkdirSync(outside);
    expect(vpsDir(project, 'repos/app')).toBe(path.join(project, 'repos', 'app'));
    for (const bad of ['../outside', '/abs', 'C:\\x', 'repos/../../outside']) expect(() => vpsDir(project, bad), bad).toThrow(BundleError);
    try {
      fs.symlinkSync(outside, path.join(project, 'repos', 'link'), 'junction');
    } catch {
      return; // no permission to make a link here
    }
    expect(() => vpsDir(project, 'repos/link/app')).toThrow(/outside the project/);
  });
});
