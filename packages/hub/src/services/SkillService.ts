import fs from 'node:fs';
import path from 'node:path';
import type { Skill } from '@pocketrocket/shared';
import { SKILLS_DIR, USER_SKILLS_DIR, botPluginDir } from '../config.js';
import { isInside } from '../permissions/pathRules.js';
import type { Repos } from '../db/repos.js';

/** The only shape a skill directory name may take. Anchored, so `../../etc` and `a/b` are both rejected. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

/**
 * Resolve `<SKILLS_DIR>/<name>` and refuse anything that is not actually under SKILLS_DIR
 * (audit 2026-09-09, B11). `POST /api/skills/import` took an unvalidated `names[]` straight into
 * `cpSync(force: true)`, which — reachable through the CSRF hole in B1 — was an arbitrary directory
 * overwrite. The name regex alone would do it; the isInside check is the belt to that pair of braces,
 * and also catches a junction planted at `<SKILLS_DIR>/<name>` pointing somewhere else.
 */
export function resolveSkillDir(name: string): string {
  if (!SKILL_NAME_RE.test(name)) throw new Error('Invalid skill name (lowercase letters, digits and dashes, 2-49 chars)');
  const dir = path.join(SKILLS_DIR, name);
  if (path.dirname(path.resolve(dir)) !== path.resolve(SKILLS_DIR)) throw new Error('Invalid skill name');
  if (fs.existsSync(dir) && !isInside(dir, [SKILLS_DIR])) throw new Error('Skill path escapes the skill pool: ' + name);
  return dir;
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: out.name, description: out.description };
}

export class SkillService {
  constructor(private repos: Repos) {}

  /** Skills in ~/.claude/skills not yet in the pool. */
  listImportable(): { name: string; description: string }[] {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    const pool = new Set(this.repos.listSkills().map((s) => s.name));
    const out: { name: string; description: string }[] = [];
    for (const d of dirs) {
      if (pool.has(d)) continue;
      const f = path.join(USER_SKILLS_DIR, d, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      out.push({ name: d, description: parseFrontmatter(fs.readFileSync(f, 'utf8')).description ?? '' });
    }
    return out;
  }

  importFromUser(name: string): Skill {
    const dest = resolveSkillDir(name);
    const src = path.join(USER_SKILLS_DIR, name);
    if (!isInside(src, [USER_SKILLS_DIR])) throw new Error('Invalid skill name');
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('No SKILL.md in ' + src);
    fs.cpSync(src, dest, { recursive: true, force: true });
    const fm = parseFrontmatter(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'));
    return this.repos.upsertSkill({ name, description: fm.description ?? '', path: dest, source: 'imported', reviewStatus: 'approved', createdByBot: null });
  }

  save(name: string, description: string, markdown: string, opts: { source: 'authored' | 'bot'; createdByBot?: string }): Skill {
    const dir = resolveSkillDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const body = markdown.trimStart().startsWith('---')
      ? markdown
      : '---\nname: ' + name + '\ndescription: ' + description.replace(/\n/g, ' ') + '\n---\n\n' + markdown;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
    return this.repos.upsertSkill({
      name, description, path: dir, source: opts.source,
      reviewStatus: opts.source === 'bot' ? 'pending' : 'approved', createdByBot: opts.createdByBot ?? null,
    });
  }

  readMarkdown(skill: Skill): string {
    try {
      return fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8');
    } catch {
      return '';
    }
  }

  remove(id: string) {
    const s = this.repos.getSkill(id);
    if (!s) return;
    // Never recursively delete a path the DB row claims but that does not actually live in the pool.
    if (isInside(s.path, [SKILLS_DIR])) {
      try {
        fs.rmSync(s.path, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    this.repos.deleteSkill(id);
  }

  /**
   * Materialize bots/<id>/plugin with a **copy** of each assigned, approved skill. Returns the plugin dir,
   * or null when the bot has no skills.
   *
   * This used to junction the shared pool directory into the bot's home (audit 2026-09-09, B11). A bot writes
   * freely inside its own home, so a write through the junction edited the human-approved skill in the pool —
   * and every other bot using it. Skills are a SKILL.md plus a few small files, so copying is cheap and the
   * pool becomes read-only from a bot's point of view. The copy is refreshed on every turn, so an approval or
   * an edit in the UI still reaches the bot immediately.
   */
  materialize(botId: string, botHandle: string): string | null {
    const ids = this.repos.botSkillIds(botId);
    const skills = ids.map((id) => this.repos.getSkill(id)).filter((s): s is Skill => !!s && s.reviewStatus === 'approved');
    const plugin = botPluginDir(botId);
    const skillsDir = path.join(plugin, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const e of fs.readdirSync(skillsDir)) {
        const p = path.join(skillsDir, e);
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink()) fs.unlinkSync(p);
          else fs.rmSync(p, { recursive: true, force: true });
        } catch {
          try { fs.rmdirSync(p); } catch { /* ignore */ }
        }
      }
    }
    if (!skills.length) return null;
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'bot-' + botHandle, version: '0.1.0', description: 'Skills assigned to @' + botHandle }, null, 2),
    );
    for (const s of skills) {
      if (!isInside(s.path, [SKILLS_DIR])) continue;
      const dest = path.join(skillsDir, s.name);
      if (!isInside(dest, [skillsDir])) continue;
      try {
        fs.cpSync(s.path, dest, { recursive: true, force: true, dereference: true });
      } catch {
        /* a skill that will not copy is simply not offered to the bot */
      }
    }
    return plugin;
  }
}
