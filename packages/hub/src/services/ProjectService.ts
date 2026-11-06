import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BotInputSchema, type Bot, type Room } from '@pocketrocket/shared';
import type { Db, Row } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import type { MemoryService } from './MemoryService.js';
import { DEV_TEAM_TEMPLATE, cloneDescription, templateRecord } from './devTeamTemplate.js';

export interface Project {
  slug: string;
  name: string;
  dir: string;
  memberIds: string[];
  roomId: string | null;
  templateVersion: number | null;
  createdAt: number;
}
export interface ProjectHit { project: string; path: string; status: string; updated: string | null; reviewExpired: boolean; snippet: string }
export interface LintIssue { kind: 'no-current' | 'expired' | 'undated' | 'duplicate' | 'tiny'; path: string; detail: string }

export class ProjectError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const TEXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml']);
const MAX_FILE_BYTES = 2_000_000;
const CHUNK_CHARS = 1200;
const TINY_CHARS = 80;
const STOP = new Set('a an the is are was were be of to in on for and or what which who how when where why do does did i we our my it its this that these those with at by from as ang ng sa na ba yung mga si ni kay para ano paano saan bakit kailan sino ko mo natin namin ito iyon po ha lang din rin may meron'.split(' '));

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** The small header a project file may carry. Everything is optional; a file without one still gets searched. */
export function parseFrontmatter(text: string): { status: string; updated: string | null; reviewBy: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = (k: string) => (m ? new RegExp('^' + k + ':\\s*(.+?)\\s*$', 'm').exec(m[1])?.[1] ?? null : null);
  return { status: (field('status') ?? 'current').toLowerCase(), updated: field('updated'), reviewBy: field('review_by') };
}

function chunk(text: string): string[] {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const out: string[] = [];
  let buf = '';
  for (const para of body.split(/\n\s*\n/)) {
    if (buf && buf.length + para.length > CHUNK_CHARS) { out.push(buf); buf = ''; }
    if (para.length > CHUNK_CHARS * 2) {
      for (let i = 0; i < para.length; i += CHUNK_CHARS) out.push(para.slice(i, i + CHUNK_CHARS));
      continue;
    }
    buf += (buf ? '\n\n' : '') + para;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * Project folders: plain files on disk are the truth, and a bot works in a project's folder when the owner lists it
 * as a member and it is replying in the project's room (rooms/roomFiles.ts). The search index is only a copy, rebuilt from the files whenever they change.
 */
export class ProjectService {
  constructor(private deps: { db: Db; repos: Repos; memory: MemoryService; root: string; now?: () => number }) {}

  private get db() { return this.deps.db; }
  private now() { return (this.deps.now ?? Date.now)(); }
  get root() { return this.deps.root; }
  dirOf(slug: string) { return path.join(this.deps.root, slug); }

  private toProject(r: Row): Project {
    const slug = r.slug as string;
    return {
      slug,
      name: r.name as string,
      dir: this.dirOf(slug),
      memberIds: this.db.all('SELECT bot_id FROM project_members WHERE slug=? ORDER BY bot_id', slug).map((m) => m.bot_id as string),
      roomId: (r.room_id as string | null) ?? null,
      templateVersion: (r.template_version as number | null) ?? null,
      createdAt: Number(r.created_at),
    };
  }
  list(): Project[] {
    return this.db.all('SELECT * FROM projects ORDER BY name').map((r) => this.toProject(r));
  }
  get(slug: string): Project | undefined {
    const r = this.db.get('SELECT * FROM projects WHERE slug=?', slug);
    return r ? this.toProject(r) : undefined;
  }
  need(slug: string): Project {
    const p = this.get(slug);
    if (!p) throw new ProjectError(404, 'No project called ' + slug);
    return p;
  }
  /** The project whose group chat this room is, if any. */
  forRoom(roomId: string): Project | undefined {
    const r = this.db.get('SELECT * FROM projects WHERE room_id=? ORDER BY created_at LIMIT 1', roomId);
    return r ? this.toProject(r) : undefined;
  }
  knownSlugs(): string[] {
    return this.db.all('SELECT slug FROM projects').map((r) => r.slug as string);
  }

  /** Never overwrites a folder that is already there, so a project can adopt existing files. */
  create(input: { name: string; team?: boolean; memberIds?: string[] }): { project: Project; bots: Bot[]; room: Room | null } {
    const slug = slugify(input.name);
    if (!slug) throw new ProjectError(400, 'A project name needs letters or numbers');
    if (this.get(slug)) throw new ProjectError(409, 'There is already a project called ' + slug);
    const members = input.memberIds ?? [];
    for (const id of members) if (!this.deps.repos.getBot(id)) throw new ProjectError(400, 'Unknown bot id: ' + id);

    const name = input.name.trim();
    const dir = this.dirOf(slug);
    // Check the whole team can be made before anything is created, so a refusal leaves nothing behind.
    const plan = input.team ? this.planTeam(slug, name, dir) : [];

    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    const current = path.join(dir, 'current.md');
    if (!fs.existsSync(current)) {
      const today = new Date(this.now()).toISOString().slice(0, 10);
      fs.writeFileSync(current, '---\nstatus: current\nupdated: ' + today + '\n---\n\n# ' + name + '\n\nWhat is true now. Move anything outdated to archive/.\n');
    }
    const bots = plan.map((p) => {
      const bot = this.deps.repos.createBot(p.input);
      this.deps.memory.ensureHome(bot.id);
      this.deps.memory.writeIdentity(bot.id, bot.description);
      if (p.skillIds.length) this.deps.repos.setBotSkills(bot.id, p.skillIds);
      return bot;
    });
    if (bots.length) {
      const today = new Date(this.now()).toISOString().slice(0, 10);
      const skills = Object.fromEntries(plan.map((p) => [p.input.handle, p.skillIds.map((id) => this.deps.repos.getSkill(id)?.name ?? id)]));
      const record = path.join(dir, 'TEMPLATE.md');
      if (!fs.existsSync(record)) fs.writeFileSync(record, templateRecord(name, today, skills));
    }
    const coordinator = bots[plan.findIndex((p) => p.coordinator)]?.id ?? null;
    const room = bots.length
      ? this.deps.repos.createRoom({ kind: 'group', name, memberIds: bots.map((b) => b.id), coordinatorBotId: coordinator }) as Room
      : null;

    this.db.run(
      'INSERT INTO projects (slug,name,room_id,template_version,created_at) VALUES (?,?,?,?,?)',
      slug, name, room?.id ?? null, input.team ? DEV_TEAM_TEMPLATE.version : null, this.now(),
    );
    this.setMembers(slug, [...members, ...bots.map((b) => b.id)]);
    return { project: this.need(slug), bots, room };
  }

  private planTeam(slug: string, name: string, dir: string) {
    const pool = this.deps.repos.listSkills();
    const required = DEV_TEAM_TEMPLATE.skills.map((skillName) => {
      const skill = pool.find((s) => s.name === skillName);
      if (!skill) throw new ProjectError(409, 'The dev team template needs the skill ' + skillName + ', which does not exist');
      return skill.id;
    });
    return DEV_TEAM_TEMPLATE.roles.map((role) => {
      const source = this.deps.repos.getBotByHandle(role.source);
      if (!source) throw new ProjectError(409, 'The dev team template needs the bot @' + role.source + ', which does not exist');
      const handle = slug.slice(0, 15).replace(/-+$/, '') + '-' + role.suffix;
      if (this.deps.repos.getBotByHandle(handle)) throw new ProjectError(409, 'Handle already taken: ' + handle);
      const parsed = BotInputSchema.safeParse({
        name: source.name,
        handle,
        title: name,
        description: cloneDescription(source.description, name, dir),
        avatar: source.avatar,
        model: source.model,
        allowedTools: source.allowedTools,
        maxBudgetUsd: source.maxBudgetUsd,
      });
      if (!parsed.success) throw new ProjectError(400, 'Cannot clone @' + role.source + ': ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
      return { input: parsed.data, coordinator: role.coordinator, skillIds: [...new Set([...this.deps.repos.botSkillIds(source.id), ...required])] };
    });
  }

  setMembers(slug: string, botIds: string[]) {
    this.need(slug);
    for (const id of botIds) if (!this.deps.repos.getBot(id)) throw new ProjectError(400, 'Unknown bot id: ' + id);
    this.db.run('DELETE FROM project_members WHERE slug=?', slug);
    for (const id of new Set(botIds)) this.db.run('INSERT INTO project_members (slug,bot_id) VALUES (?,?)', slug, id);
  }
  /** Bots that were deleted lose their place. */
  pruneMembers(liveBotIds: string[]) {
    const live = new Set(liveBotIds);
    for (const r of this.db.all('SELECT DISTINCT bot_id FROM project_members')) {
      if (!live.has(r.bot_id as string)) this.db.run('DELETE FROM project_members WHERE bot_id=?', r.bot_id as string);
    }
  }
  /** Forgets the project and its access. The folder stays on disk, since files may matter more than the record. */
  remove(slug: string) {
    this.need(slug);
    this.db.run('DELETE FROM project_members WHERE slug=?', slug);
    this.db.run('DELETE FROM project_files WHERE slug=?', slug);
    this.db.run('DELETE FROM project_fts WHERE slug=?', slug);
    this.db.run('DELETE FROM projects WHERE slug=?', slug);
  }

  /** Writes reviewed text into the project as a file. A later import of the same title replaces it. */
  saveImport(slug: string, input: { source: string; title: string; body: string; date?: string; dateApproximate?: boolean }): string {
    this.need(slug);
    const safe = input.title.replace(/[^\p{L}\p{N} ._-]+/gu, '-').replace(/\s+/g, ' ').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 120) || 'untitled';
    const rel = path.join('imports', input.source, safe.endsWith('.md') ? safe : safe + '.md');
    const file = path.join(this.dirOf(slug), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const updated = input.date ?? new Date(this.now()).toISOString().slice(0, 10);
    const head = ['---', 'status: current', 'updated: ' + updated, ...(input.dateApproximate ? ['updated_is_approximate: true'] : []), 'source: ' + input.source, '---', '', ''].join('\n');
    fs.writeFileSync(file, head + input.body);
    return rel.replaceAll('\\', '/');
  }

  private walk(slug: string): { rel: string; abs: string; mtime: number; size: number }[] {
    const out: { rel: string; abs: string; mtime: number; size: number }[] = [];
    const dir = this.dirOf(slug);
    const visit = (d: string) => {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) visit(abs);
        else if (e.isFile() && TEXT.has(path.extname(e.name).toLowerCase())) {
          const s = fs.statSync(abs);
          if (s.size <= MAX_FILE_BYTES) out.push({ rel: path.relative(dir, abs).replaceAll('\\', '/'), abs, mtime: s.mtimeMs, size: s.size });
        }
      }
    };
    visit(dir);
    return out;
  }

  /** Brings the index up to date with the files. Only changed files are read again. */
  private sync(slug: string) {
    const files = this.walk(slug);
    const seen = new Set(files.map((f) => f.rel));
    const old = new Map(this.db.all('SELECT path,mtime,size FROM project_files WHERE slug=?', slug).map((r) => [r.path as string, r]));
    for (const p of old.keys()) {
      if (!seen.has(p)) {
        this.db.run('DELETE FROM project_files WHERE slug=? AND path=?', slug, p);
        this.db.run('DELETE FROM project_fts WHERE slug=? AND path=?', slug, p);
      }
    }
    for (const f of files) {
      const prev = old.get(f.rel);
      if (prev && Number(prev.mtime) === f.mtime && Number(prev.size) === f.size) continue;
      const text = fs.readFileSync(f.abs, 'utf8');
      const meta = parseFrontmatter(text);
      this.db.run('DELETE FROM project_fts WHERE slug=? AND path=?', slug, f.rel);
      for (const c of chunk(text)) this.db.run('INSERT INTO project_fts (slug,path,text) VALUES (?,?,?)', slug, f.rel, c);
      this.db.run(
        'INSERT INTO project_files (slug,path,mtime,size,status,updated,review_by) VALUES (?,?,?,?,?,?,?) ' +
          'ON CONFLICT(slug,path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,status=excluded.status,updated=excluded.updated,review_by=excluded.review_by',
        slug, f.rel, f.mtime, f.size, meta.status, meta.updated, meta.reviewBy,
      );
    }
  }

  /**
   * Keyword search, with no AI turn. Outdated files are skipped unless asked for, current.md comes first, and every
   * hit carries its date. A search that finds nothing is logged: enough of those is the evidence for adding embeddings.
   */
  search(slugs: readonly string[], query: string, opts: { includeArchived?: boolean; limit?: number } = {}): ProjectHit[] {
    if (!slugs.length) return [];
    for (const s of slugs) this.sync(s);
    const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const marks = slugs.map(() => '?').join(',');
    const rows = words.length
      ? this.db.all(
          'SELECT f.slug AS slug, f.path AS path, f.text AS text, m.status AS status, m.updated AS updated, m.review_by AS review_by, bm25(project_fts) AS score ' +
            'FROM project_fts f JOIN project_files m ON m.slug=f.slug AND m.path=f.path ' +
            'WHERE project_fts MATCH ? AND f.slug IN (' + marks + ')' +
            (opts.includeArchived ? '' : " AND m.status NOT IN ('archived','superseded') AND m.path NOT LIKE 'archive/%'") +
            ' ORDER BY score LIMIT 50',
          words.map((w) => '"' + w + '"').join(' OR '), ...slugs,
        )
      : [];
    if (!rows.length) {
      this.db.run('INSERT INTO project_search_misses (at,projects,query) VALUES (?,?,?)', this.now(), slugs.join(','), query.slice(0, 200));
      return [];
    }
    const isCurrent = (r: Row) => r.path === 'current.md';
    const ranked = [...rows.filter(isCurrent), ...rows.filter((r) => !isCurrent(r))].slice(0, opts.limit ?? 5);
    return ranked.map((r) => {
      const body = r.text as string;
      const at = Math.max(0, Math.min(...words.map((w) => { const i = body.toLowerCase().indexOf(w); return i < 0 ? Infinity : i; })) - 100);
      return {
        project: r.slug as string,
        path: r.path as string,
        status: r.status as string,
        updated: (r.updated as string | null) ?? null,
        reviewExpired: !!r.review_by && (r.review_by as string) < today,
        snippet: body.slice(Number.isFinite(at) ? at : 0, (Number.isFinite(at) ? at : 0) + 400),
      };
    });
  }

  /** What has gone stale or messy. Plain rules with no AI, so it costs nothing to run and it deletes nothing. */
  lint(slug: string): { issues: LintIssue[]; recentMisses: string[] } {
    this.need(slug);
    this.sync(slug);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const issues: LintIssue[] = [];
    const files = this.walk(slug).filter((f) => !f.rel.startsWith('archive/'));
    if (!files.some((f) => f.rel === 'current.md')) issues.push({ kind: 'no-current', path: 'current.md', detail: 'This project has no current.md.' });
    const hashes = new Map<string, string>();
    for (const f of files) {
      const text = fs.readFileSync(f.abs, 'utf8');
      const meta = parseFrontmatter(text);
      if (meta.status === 'archived' || meta.status === 'superseded') continue;
      if (meta.reviewBy && meta.reviewBy < today) issues.push({ kind: 'expired', path: f.rel, detail: 'Review was due ' + meta.reviewBy + '.' });
      if (!meta.updated) issues.push({ kind: 'undated', path: f.rel, detail: 'No updated date.' });
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      if (body.length < TINY_CHARS) issues.push({ kind: 'tiny', path: f.rel, detail: 'Under ' + TINY_CHARS + ' characters.' });
      const h = createHash('sha256').update(body).digest('hex');
      const twin = hashes.get(h);
      if (twin) issues.push({ kind: 'duplicate', path: f.rel, detail: 'Same text as ' + twin + '.' });
      else hashes.set(h, f.rel);
    }
    const recentMisses = this.db.all("SELECT query FROM project_search_misses WHERE ',' || projects || ',' LIKE ? ORDER BY at DESC LIMIT 20", '%,' + slug + ',%').map((r) => r.query as string);
    return { issues, recentMisses };
  }
}
