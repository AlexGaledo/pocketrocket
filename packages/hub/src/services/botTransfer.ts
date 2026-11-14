import {
  BOT_EXPORT_FORMAT, BOT_EXPORT_VERSION, MAX_BOT_EXPORT_BYTES, MAX_EXPORT_MEMORY_BYTES, MAX_EXPORT_SKILL_BYTES, MAX_EXPORT_SKILLS,
  BotExportSchema, isBotIconKey,
  type Bot, type BotExport, type BotExportResult, type BotImportResult,
} from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import { redact } from '../providers/redact.js';
import type { MemoryService } from './MemoryService.js';
import type { SkillService } from './SkillService.js';

export class TransferError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Anything that names a place on this machine: `C:\Users\dana\...`, `/home/dana/...`, `/Users/dana/...`, a UNC share.
 * A path tells a stranger who you are and how your disk is laid out, and means nothing on their machine.
 */
const PATHS: RegExp[] = [
  /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'`<>|)\]]*/gi,
  /\\\\[A-Za-z0-9._$-]+\\[^\s"'`<>|)\]]*/g,
  /(?<![\w./-])\/(?:home|Users|root)\/[^\s"'`<>|)\]]*/g,
  /(?<![\w./-])~[\\/][^\s"'`<>|)\]]*/g,
];
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** `password: hunter2`, `api_key = abc`, `export TOKEN=abc` on one line. */
const ASSIGNED = /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|apikey|credential)[A-Za-z0-9_]*\s*[:=]\s*)(?!\[redacted\]|\[path\])["']?[^\s"']{6,}["']?/gi;

/** Takes secrets and machine paths out of free text that is about to leave this machine. Counts what it removed. */
export function scrubForExport(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = text.replace(PEM, () => { removed++; return '[redacted]'; });
  const before = out;
  out = redact(out);
  if (out !== before) removed++;
  out = out.replace(ASSIGNED, (_m, lead: string) => { removed++; return lead + '[redacted]'; });
  for (const re of PATHS) out = out.replace(re, () => { removed++; return '[path]'; });
  return { text: out, removed };
}

type Deps = { repos: Repos; memory: MemoryService; skills: SkillService };

/**
 * Builds the file for one bot. Free text is scrubbed (see {@link scrubForExport}); `redactions` says how many things
 * were removed so the owner knows to read the file before sharing it. Nothing is read from the vault, settings,
 * approval rules, integrations or the bot's tool list.
 */
export function exportBot(d: Deps, bot: Bot, opts: { includeMemory: boolean }): BotExportResult {
  let redactions = 0;
  const clean = (s: string): string => { const r = scrubForExport(s); redactions += r.removed; return r.text; };
  const skills: BotExport['skills'] = [];
  for (const id of d.repos.botSkillIds(bot.id)) {
    const s = d.repos.getSkill(id);
    if (!s || s.parentId || skills.length >= MAX_EXPORT_SKILLS) continue;
    const md = clean(d.skills.readMarkdown(s));
    if (!md.trim() || Buffer.byteLength(md, 'utf8') > MAX_EXPORT_SKILL_BYTES) continue;
    skills.push({ name: s.name, description: clean(s.description).slice(0, 300) || s.name, markdown: md });
  }
  const file: BotExport = {
    format: BOT_EXPORT_FORMAT,
    version: BOT_EXPORT_VERSION,
    exportedAt: Date.now(),
    bot: {
      name: bot.name, handle: bot.handle, title: clean(bot.title).slice(0, 80), description: clean(bot.description),
      avatar: isBotIconKey(bot.avatar) ? bot.avatar : '',
    },
    skills,
  };
  if (opts.includeMemory) {
    let mem = clean(d.memory.read(bot.id));
    while (Buffer.byteLength(mem, 'utf8') > MAX_EXPORT_MEMORY_BYTES) mem = mem.slice(Math.ceil(mem.length / 10));
    if (mem.trim()) file.memory = mem;
  }
  if (Buffer.byteLength(JSON.stringify(file), 'utf8') > MAX_BOT_EXPORT_BYTES) {
    throw new TransferError(413, 'This bot is too big to export (over 1 MB). Leave out the memory notes or remove some skills.');
  }
  // The file we make must pass the check we apply on the way in.
  if (!BotExportSchema.safeParse(file).success) throw new TransferError(500, 'Could not make a valid export file');
  return { file, redactions };
}

/** `handle`, or `handle-2`, `handle-3`... the first one free. */
export function freeHandle(taken: (h: string) => boolean, handle: string): string {
  if (!taken(handle)) return handle;
  for (let n = 2; n < 1000; n++) {
    const suffix = '-' + n;
    const h = handle.slice(0, 24 - suffix.length) + suffix;
    if (!taken(h)) return h;
  }
  throw new TransferError(409, 'Could not find a free handle');
}

/** An imported bot's instructions come from a stranger, so it starts without a shell or page fetching; the owner can switch them on later. */
export const IMPORT_DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch'] as const;

/**
 * Makes a NEW bot from a file that passes {@link BotExportSchema}. It never touches an existing bot, and never
 * replaces a skill that is already in the pool: a clash gets a new name. Skills arrive `imported` and `pending`, so
 * nothing from the file reaches a bot until the owner approves it on the Skills tab. The bot gets a minimal tool set (no Bash or
 * WebFetch), the default model and budget; a file cannot grant any of those.
 */
export function importBot(d: Deps, raw: unknown, opts: { includeMemory: boolean }): BotImportResult {
  const parsed = BotExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TransferError(400, 'Not a PocketRocket bot file: ' + parsed.error.issues.slice(0, 5).map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; '));
  }
  const f = parsed.data;
  const handle = freeHandle((h) => !!d.repos.getBotByHandle(h), f.bot.handle);
  const bot = d.repos.createBot({
    name: f.bot.name, handle, title: f.bot.title, description: f.bot.description, avatar: f.bot.avatar,
    model: 'claude-sonnet-5',
    allowedTools: [...IMPORT_DEFAULT_TOOLS],
    maxBudgetUsd: 2,
  });
  const createdSkillIds: string[] = [];
  try {
    d.memory.ensureHome(bot.id);
    d.memory.writeIdentity(bot.id, bot.description);
    const skills: BotImportResult['skills'] = [];
    const ids: string[] = [];
    for (const s of f.skills) {
      const made = d.skills.importPending(s.name, s.description, s.markdown);
      ids.push(made.skill.id);
      createdSkillIds.push(made.skill.id);
      skills.push({ name: made.skill.name, renamed: made.renamed });
    }
    if (ids.length) d.repos.setBotSkills(bot.id, ids);
    let memoryImported = false;
    if (opts.includeMemory && f.memory?.trim()) { d.memory.write(bot.id, f.memory); memoryImported = true; }
    return { bot, handleRenamed: handle !== f.bot.handle, skills, memoryImported };
  } catch (e) {
    // Skills made earlier in this same file go too, so a failed import leaves nothing behind in the pool.
    for (const id of createdSkillIds) {
      try { d.skills.remove(id); } catch { /* best effort: keep rolling back */ }
    }
    d.repos.deleteBot(bot.id);
    d.memory.removeHome(bot.id);
    throw e;
  }
}
