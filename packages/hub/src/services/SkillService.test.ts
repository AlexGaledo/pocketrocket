import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SkillService, resolveSkillDir } from './SkillService.js';
import { SKILLS_DIR, botPluginDir } from '../config.js';

/** Audit 2026-09-09, B11: the skill pool is not bot-writable and its names are not path fragments. */

function repos() {
  return new Repos(new Db(':memory:'));
}

describe('resolveSkillDir', () => {
  it('rejects every name that is not a plain kebab-case token', () => {
    for (const bad of [
      '../../etc', '..', '.', 'a/b', 'a\\b', '/abs', 'C:\\Windows', 'UPPER', 'has space', '',
      'x', 'ends-with-'.padEnd(60, 'x'), '-leading',
    ]) {
      expect(() => resolveSkillDir(bad), bad).toThrow();
    }
  });
  it('accepts a normal name and resolves it directly under SKILLS_DIR', () => {
    expect(resolveSkillDir('my-skill')).toBe(path.join(SKILLS_DIR, 'my-skill'));
    expect(resolveSkillDir('a1')).toBe(path.join(SKILLS_DIR, 'a1'));
  });
});

describe('SkillService.importFromUser', () => {
  it('refuses a traversing name instead of overwriting an arbitrary directory', () => {
    const s = new SkillService(repos());
    // The audit's path: POST /api/skills/import took `names[]` straight into cpSync(force:true).
    expect(() => s.importFromUser('../../../evil')).toThrow(/Invalid skill name/);
    expect(() => s.importFromUser('..\\..\\evil')).toThrow(/Invalid skill name/);
  });
});

describe('SkillService.save', () => {
  it('validates the name before touching the filesystem', () => {
    const s = new SkillService(repos());
    expect(() => s.save('../escape', 'd', 'body long enough', { source: 'authored' })).toThrow(/Invalid skill name/);
    expect(fs.existsSync(path.join(SKILLS_DIR, '..', 'escape'))).toBe(false);
  });
});

describe('SkillService.materialize', () => {
  it('copies skills into the bot plugin dir instead of junctioning the shared pool', () => {
    const r = repos();
    const svc = new SkillService(r);
    const bot = r.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const skill = svc.save('copy-me', 'a test skill', 'Step one. Step two. Step three.', { source: 'authored' });
    r.setBotSkills(bot.id, [skill.id]);

    const plugin = svc.materialize(bot.id, bot.handle);
    expect(plugin).toBe(botPluginDir(bot.id));
    const materialized = path.join(plugin!, 'skills', 'copy-me');

    // The crux: it is a real directory, not a link back into the shared pool.
    expect(fs.lstatSync(materialized).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(materialized, 'SKILL.md'), 'utf8')).toContain('Step one');

    // A bot writing through its own plugin dir cannot reach the pool copy.
    fs.writeFileSync(path.join(materialized, 'SKILL.md'), 'REWRITTEN BY A BOT');
    expect(fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8')).toContain('Step one');

    // Re-materializing restores the approved content from the pool.
    svc.materialize(bot.id, bot.handle);
    expect(fs.readFileSync(path.join(materialized, 'SKILL.md'), 'utf8')).toContain('Step one');

    svc.remove(skill.id);
    fs.rmSync(botPluginDir(bot.id), { recursive: true, force: true });
  });

  it('leaves only approved skills in the plugin dir', () => {
    const r = repos();
    const svc = new SkillService(r);
    const bot = r.createBot({ name: 'Nova', handle: 'nova2', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const pending = svc.save('pending-one', 'written by a bot', 'Do the thing carefully.', { source: 'bot', createdByBot: bot.id });
    r.setBotSkills(bot.id, [pending.id]);
    expect(svc.materialize(bot.id, bot.handle)).toBe(null);
    svc.remove(pending.id);
  });
});

describe('SkillService.remove', () => {
  it('will not recursively delete a path outside the pool', () => {
    const r = repos();
    const svc = new SkillService(r);
    const victim = path.join(SKILLS_DIR, '..', 'do-not-delete-me');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
    const s = r.upsertSkill({ name: 'bogus', description: '', path: victim, source: 'imported', reviewStatus: 'approved', createdByBot: null });
    svc.remove(s.id);
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
    expect(r.getSkill(s.id)).toBeUndefined();
    fs.rmSync(victim, { recursive: true, force: true });
  });
});
