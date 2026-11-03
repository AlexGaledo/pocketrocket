import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SKILLS_DIR } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SkillService, findSkillDirs } from './SkillService.js';
import { runGit, type GitRunner } from './git.js';

/** P7 (7.4): skills imported from a git repo (a local "marketplace") all start pending review. */

const uniq = 'p7g' + process.pid.toString(36);
const names = { good: uniq + '-good', nested: uniq + '-nested', taken: uniq + '-taken' };
const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  for (const n of Object.values(names)) fs.rmSync(path.join(SKILLS_DIR, n), { recursive: true, force: true });
});

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

function skill(root: string, rel: string, fm: string, body = 'Do the thing step by step.') {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\n' + fm + '\n---\n\n' + body + '\n');
  return dir;
}

/** A marketplace repo: good skills, broken ones, and one whose name is already in the pool. */
function marketplace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-market-'));
  tmps.push(root);
  skill(root, 'skills/' + names.good, 'name: ' + names.good + '\ndescription: Writes release notes');
  fs.writeFileSync(path.join(root, 'skills', names.good, 'template.md'), '# Notes\n');
  skill(root, 'plugins/pack/skills/' + names.nested, 'name: ' + names.nested + '\ndescription: Nested in a plugin');
  skill(root, 'skills/no-description', 'name: no-description');
  skill(root, 'skills/Bad_Name', 'description: bad folder name and no name');
  skill(root, 'skills/' + names.taken, 'name: ' + names.taken + '\ndescription: Would overwrite');
  skill(root, 'skills/huge-one', 'name: huge-one\ndescription: too big', 'x'.repeat(70 * 1024));
  g(root, 'init', '-q');
  g(root, 'add', '.');
  g(root, 'commit', '-q', '-m', 'skills');
  return root;
}

describe('findSkillDirs', () => {
  it('finds SKILL.md folders at any shallow depth and not inside a skill', () => {
    const root = marketplace();
    const found = findSkillDirs(root).map((d) => path.relative(root, d).replace(/\\/g, '/'));
    expect(found).toContain('skills/' + names.good);
    expect(found).toContain('plugins/pack/skills/' + names.nested);
    expect(found.some((f) => f.startsWith('.git'))).toBe(false);
  });
});

describe('SkillService.importFromGit', () => {
  it('imports valid skills as pending, skips the rest with reasons, and removes the temp clone', async () => {
    const root = marketplace();
    const repos = new Repos(new Db(':memory:'));
    const svc = new SkillService(repos);
    svc.save(names.taken, 'mine, approved', 'My own approved instructions here.', { source: 'authored' });

    const cwds: string[] = [];
    const git: GitRunner = (args, opts) => { if (opts?.cwd) cwds.push(opts.cwd); return runGit(args, opts); };
    const r = await svc.importFromGit(pathToFileURL(root).href, git);

    expect(r.imported.map((s) => s.name).sort()).toEqual([names.good, names.nested].sort());
    for (const s of r.imported) expect(s).toMatchObject({ source: 'imported', reviewStatus: 'pending' });
    expect(fs.existsSync(path.join(SKILLS_DIR, names.good, 'template.md'))).toBe(true);

    const why = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
    expect(why['no-description']).toMatch(/description/);
    expect(why['Bad_Name']).toMatch(/invalid name/);
    expect(why[names.taken]).toMatch(/already in the pool/);
    expect(why['huge-one']).toMatch(/64 KB/);
    // The approved skill with the same name was not overwritten.
    expect(repos.getSkillByName(names.taken)).toMatchObject({ reviewStatus: 'approved', description: 'mine, approved' });

    expect(cwds.length).toBe(1);
    expect(fs.existsSync(cwds[0])).toBe(false);
  }, 30_000);

  it('a pending import is not given to a bot until approved', async () => {
    const root = marketplace();
    const repos = new Repos(new Db(':memory:'));
    const svc = new SkillService(repos);
    fs.rmSync(path.join(SKILLS_DIR, names.good), { recursive: true, force: true });
    const r = await svc.importFromGit(root); // a local folder is scanned in place, no clone
    const s = r.imported.find((x) => x.name === names.good)!;
    const bot = repos.createBot({ name: 'B', handle: uniq, title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    repos.setBotSkills(bot.id, [s.id]);
    expect(svc.materialize(bot.id, bot.handle)).toBeNull();
    repos.setSkillReview(s.id, 'approved');
    expect(svc.materialize(bot.id, bot.handle)).not.toBeNull();
    fs.rmSync(path.join(SKILLS_DIR, '..', 'bots', bot.id), { recursive: true, force: true });
  }, 30_000);

  it('refuses a source that would reach git as an option or a command', async () => {
    const svc = new SkillService(new Repos(new Db(':memory:')));
    await expect(svc.importFromGit('--upload-pack=calc')).rejects.toThrow();
    await expect(svc.importFromGit('ext::sh -c id')).rejects.toThrow(/not allowed/);
  });

  it('refuses a skill folder that carries a symbolic link', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-market-'));
    tmps.push(root);
    const dir = skill(root, 'skills/' + uniq + '-linky', 'name: ' + uniq + '-linky\ndescription: has a link');
    // The link points at an empty temp folder, never at anything that matters, and is removed in `finally`.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-linktarget-'));
    tmps.push(target);
    const link = path.join(dir, 'outside');
    try {
      fs.symlinkSync(target, link, 'junction');
    } catch {
      return; // no permission to create links here; nothing to test
    }
    try {
      const r = await new SkillService(new Repos(new Db(':memory:'))).importFromGit(root);
      expect(r.imported).toEqual([]);
      expect(r.skipped[0].reason).toMatch(/symbolic link/);
    } finally {
      try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
    }
  });
});
