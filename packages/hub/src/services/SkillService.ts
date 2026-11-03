import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Skill, SkillGitImportResult } from '@pocketrocket/shared';
import { SKILLS_DIR, USER_SKILLS_DIR, botPluginDir } from '../config.js';
import { isInside } from '../permissions/pathRules.js';
import type { Repos } from '../db/repos.js';
import { parseGitSource, runGit, type GitRunner } from './git.js';
// P6: skill versions
import type { SkillVersion, SkillVersionDetail, SkillVersionOrigin } from '@pocketrocket/shared';
import { SkillVersionsRepo } from '../db/skillVersions.js';
import { events } from '../events.js';
import { lineDiff } from './lineDiff.js';

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

export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: out.name, description: out.description };
}

/**
 * P8: true when a SKILL.md's frontmatter asks for the strongest model (`model: opus`, or a full Opus id). The
 * model router runs a turn that invokes such a skill on Opus when the bot's model is `auto`.
 */
export function skillWantsOpus(md: string): boolean {
  const m = md.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  const line = m[1].split(/\r?\n/).map((l) => l.match(/^model:\s*(.*)$/)).find(Boolean);
  return !!line && /opus/i.test(line[1]);
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
    // P6: a bot never rewrites a skill that is already in the pool; its text becomes a pending version instead.
    const existing = opts.source === 'bot' ? this.repos.getSkillByName(name) : undefined;
    if (existing) {
      this.proposeVersion(existing.id, markdown, { origin: 'bot', note: '', createdByBot: opts.createdByBot ?? null, description });
      return this.repos.getSkill(existing.id)!;
    }
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

  /**
   * P7 (7.4): import skills from a git repo (a local "marketplace"). A URL is shallow-cloned into a temp
   * folder that is always removed afterwards; an absolute local folder is scanned in place. Every valid skill
   * is copied into the pool as `imported` + **pending**: nothing from a repo reaches a bot until the user
   * approves it. Names already in the pool are skipped, never overwritten.
   */
  async importFromGit(source: string, git: GitRunner = runGit): Promise<SkillGitImportResult> {
    const src = parseGitSource(source);
    if (typeof src === 'string') throw new Error(src);
    let tmp: string | null = null;
    try {
      let root = src.value;
      if (src.kind === 'url') {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-skills-'));
        root = path.join(tmp, 'repo');
        await git(['clone', '--depth', '1', '--single-branch', '--no-tags', '--', src.value, root], { cwd: tmp });
      }
      const imported: Skill[] = [];
      const skipped: { name: string; reason: string }[] = [];
      const pool = new Set(this.repos.listSkills().map((s) => s.name));
      for (const dir of findSkillDirs(root)) {
        const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
        const fm = parseFrontmatter(md);
        const name = fm.name && SKILL_NAME_RE.test(fm.name) ? fm.name : path.basename(dir);
        const bad = checkSkillDir(dir, name, md, fm);
        if (bad) { skipped.push({ name, reason: bad }); continue; }
        if (pool.has(name)) { skipped.push({ name, reason: 'already in the pool' }); continue; }
        if (imported.length >= MAX_GIT_SKILLS) { skipped.push({ name, reason: 'import limit (' + MAX_GIT_SKILLS + ') reached' }); continue; }
        const dest = resolveSkillDir(name);
        fs.cpSync(dir, dest, { recursive: true, force: true, dereference: false, filter: (p) => path.basename(p) !== '.git' });
        pool.add(name);
        imported.push(this.repos.upsertSkill({
          name, description: (fm.description ?? '').slice(0, 300), path: dest, source: 'imported', reviewStatus: 'pending', createdByBot: null,
        }));
      }
      return { imported, skipped };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
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
    // P6: its candidate versions go with it.
    if (!s.parentId) {
      this.versionsRepo.deleteAll(id);
      const vdir = path.join(SKILLS_DIR, VERSIONS_DIR, s.name);
      if (SKILL_NAME_RE.test(s.name) && isInside(vdir, [SKILLS_DIR])) fs.rmSync(vdir, { recursive: true, force: true });
    }
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
    const skills = ids.map((id) => this.repos.getSkill(id)).filter((s): s is Skill => !!s && s.reviewStatus === 'approved' && !s.parentId);
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

  /** P8: names of this bot's approved skills that declare `model: opus` (see skillWantsOpus). */
  opusSkillNames(botId: string): string[] {
    return this.repos
      .botSkillIds(botId)
      .map((id) => this.repos.getSkill(id))
      .filter((s): s is Skill => !!s && s.reviewStatus === 'approved')
      .filter((s) => skillWantsOpus(this.readMarkdown(s)))
      .map((s) => s.name);
  }

  // ---- P6: skill versions (corrections, reflection, re-taught demos). Never applied without the user. ----
  private _versions?: SkillVersionsRepo;
  get versionsRepo(): SkillVersionsRepo {
    return (this._versions ??= new SkillVersionsRepo(this.repos.db));
  }

  /**
   * Proposes `markdown` as the next version of pool skill `skillId`. It is stored next to the pool
   * (`<SKILLS_DIR>/.versions/<name>/v<n>/`) with a snapshot of the live SKILL.md it revises, and starts
   * pending; the live skill, and every bot using it, are untouched until the user approves it.
   */
  proposeVersion(skillId: string, markdown: string, o: { origin: SkillVersionOrigin; note?: string; createdByBot?: string | null; description?: string }): SkillVersion {
    const live = this.repos.getSkill(skillId);
    if (!live || live.parentId) throw new Error('Skill not found');
    const fm = parseFrontmatter(markdown);
    const description = (fm.description || o.description || live.description).replace(/\s+/g, ' ').trim().slice(0, 300);
    const md = withFrontmatter(markdown, live.name, description);
    if (Buffer.byteLength(md, 'utf8') > MAX_SKILL_MD_BYTES) throw new Error('SKILL.md is larger than 64 KB');
    const base = this.readMarkdown(live);
    if (md.trim() === base.trim()) throw new Error('The proposal is the same as the live version');
    const repo = this.versionsRepo;
    if (repo.pendingCount(live.id) >= MAX_PENDING_VERSIONS) throw new Error('"' + live.name + '" already has ' + MAX_PENDING_VERSIONS + ' versions waiting for review');
    const version = repo.nextVersion(live.id);
    const dir = versionDir(live.name, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
    fs.writeFileSync(path.join(dir, 'BASE.md'), base);
    const v = repo.insert({
      skillId: live.id, skillName: live.name, version, path: dir, description, origin: o.origin,
      note: (o.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500), createdByBot: o.createdByBot ?? null,
    });
    events.emitEvent({ type: 'skills.changed', skillId: live.id });
    return v;
  }

  listVersions(skillId: string): SkillVersion[] {
    return this.versionsRepo.list(skillId);
  }

  versionDetail(skillId: string, versionId: string): SkillVersionDetail | null {
    const v = this.versionsRepo.get(versionId);
    const live = this.repos.getSkill(skillId);
    if (!v || !live || v.skillId !== live.id || !isInside(v.path, [SKILLS_DIR])) return null;
    const read = (f: string) => { try { return fs.readFileSync(path.join(v.path, f), 'utf8'); } catch { return ''; } };
    const markdown = read('SKILL.md');
    const base = read('BASE.md');
    const { path: _p, ...pub } = v;
    return { ...pub, markdown, base, diff: lineDiff(base, markdown), stale: v.status === 'pending' && this.readMarkdown(live).trim() !== base.trim() };
  }

  /**
   * The user's answer to a pending version. Approve: its SKILL.md replaces the live one (the skill's other
   * files stay), the skill becomes that version and approved, and every bot using it gets it from its next turn.
   * Reject: it stays in the history as rejected.
   */
  decideVersion(skillId: string, versionId: string, decision: 'approve' | 'reject'): { skill: Skill; version: SkillVersion } {
    const v = this.versionsRepo.get(versionId);
    const live = this.repos.getSkill(skillId);
    if (!v || !live || v.skillId !== live.id) throw new Error('Version not found');
    if (v.status !== 'pending') throw new Error('Version ' + v.version + ' was already ' + v.status);
    if (decision === 'approve') {
      if (!isInside(v.path, [SKILLS_DIR])) throw new Error('Version path escapes the skill pool');
      const md = fs.readFileSync(path.join(v.path, 'SKILL.md'), 'utf8');
      const dir = resolveSkillDir(live.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
      this.versionsRepo.setLive(live.id, v.version, parseFrontmatter(md).description || live.description);
      this.versionsRepo.decide(v.id, 'approved');
      for (const b of this.repos.listBots()) if (this.repos.botSkillIds(b.id).includes(live.id)) this.materialize(b.id, b.handle);
    } else {
      this.versionsRepo.decide(v.id, 'rejected');
    }
    events.emitEvent({ type: 'skills.changed', skillId: live.id });
    return { skill: this.repos.getSkill(live.id)!, version: this.versionsRepo.get(v.id)! };
  }

  /**
   * A demonstrated or distilled skill: a new pool skill through the bot-authored flow (pending review), or,
   * when the name is already taken, a pending version of that skill.
   */
  proposeSkill(name: string, description: string, markdown: string, o: { origin: SkillVersionOrigin; createdByBot: string | null; note?: string }): { skill: Skill; version: SkillVersion | null } {
    const existing = this.repos.getSkillByName(name);
    if (existing && !existing.parentId) {
      const version = this.proposeVersion(existing.id, markdown, { origin: o.origin, note: o.note, createdByBot: o.createdByBot, description });
      return { skill: this.repos.getSkill(existing.id)!, version };
    }
    const md = withFrontmatter(markdown, name, description);
    if (Buffer.byteLength(md, 'utf8') > MAX_SKILL_MD_BYTES) throw new Error('SKILL.md is larger than 64 KB');
    const skill = this.save(name, description, md, { source: 'bot', createdByBot: o.createdByBot ?? undefined });
    events.emitEvent({ type: 'skills.changed', skillId: skill.id });
    return { skill, version: null };
  }
}

// ---- P7 (7.4): skill import from git ----
/** Skills one import may add. */
export const MAX_GIT_SKILLS = 50;
/** A SKILL.md larger than this is refused. */
export const MAX_SKILL_MD_BYTES = 64 * 1024;
/** A whole skill folder (SKILL.md plus its files) larger than this is refused. */
export const MAX_SKILL_DIR_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 200;
/** How deep below the repo root SKILL.md folders are looked for (skills/<n>, plugins/<p>/skills/<n>, ...). */
const SCAN_DEPTH = 4;

/** Folders under `root` (root included) that hold a SKILL.md, without following links or entering .git/node_modules. */
export function findSkillDirs(root: string): string[] {
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (++visited > 5000 || out.length > MAX_GIT_SKILLS * 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push(dir);
      return; // a skill's own subfolders are its resources, not more skills
    }
    if (depth >= SCAN_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

/** Why the skill folder at `dir` cannot be imported, or null when it can. */
export function checkSkillDir(dir: string, name: string, md: string, fm: { name?: string; description?: string }): string | null {
  if (!SKILL_NAME_RE.test(name)) return 'invalid name (lowercase letters, digits and dashes, 2-49 chars)';
  if (!fm.description) return 'SKILL.md has no description in its frontmatter';
  if (Buffer.byteLength(md, 'utf8') > MAX_SKILL_MD_BYTES) return 'SKILL.md is larger than 64 KB';
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      // A link could point anywhere on this machine; the copy would carry its target into the pool.
      if (st.isSymbolicLink()) return 'contains a symbolic link (' + path.relative(dir, p) + ')';
      if (st.isDirectory()) { stack.push(p); continue; }
      bytes += st.size;
      if (++files > MAX_SKILL_FILES) return 'more than ' + MAX_SKILL_FILES + ' files';
      if (bytes > MAX_SKILL_DIR_BYTES) return 'larger than 1 MB';
    }
  }
  return null;
}

// ---- P6: skill versions ----
/** Candidate versions one skill may have waiting at once. */
export const MAX_PENDING_VERSIONS = 10;
/** Under SKILLS_DIR; starts with a dot, so it can never be a skill name. */
const VERSIONS_DIR = '.versions';

function versionDir(name: string, version: number): string {
  if (!SKILL_NAME_RE.test(name) || !Number.isInteger(version) || version < 1) throw new Error('Invalid skill version');
  const root = path.join(SKILLS_DIR, VERSIONS_DIR);
  // A junction planted at .versions would carry the write anywhere.
  if (fs.existsSync(root) && !isInside(root, [SKILLS_DIR])) throw new Error('Skill versions folder escapes the skill pool');
  return path.join(root, name, 'v' + version);
}

/** `markdown` with frontmatter whose `name` is `name` (a version can never rename its skill). */
export function withFrontmatter(markdown: string, name: string, description: string): string {
  const body = markdown.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = body.match(/^---\s*\n([\s\S]*?)\n---[ \t]*\n?/);
  const desc = description.replace(/\s+/g, ' ').trim();
  if (!m) return '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n\n' + body.trimStart();
  const lines = m[1].split('\n').filter((l) => !/^name:/.test(l));
  if (!lines.some((l) => /^description:/.test(l))) lines.push('description: ' + desc);
  return '---\nname: ' + name + '\n' + lines.join('\n') + '\n---\n' + body.slice(m[0].length);
}
