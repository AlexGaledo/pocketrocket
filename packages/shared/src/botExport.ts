import { z } from 'zod';
import { BOT_ICON_KEYS, type Bot } from './models.js';
import { MAX_BOT_DESCRIPTION_CHARS } from './protocol.js';

/**
 * U10: a bot as a file you can hand to someone. The file holds what makes the bot *that bot* (its name, role,
 * picture, skills and, if asked, its memory notes) and nothing about this machine or this account: no tokens, keys,
 * logins, approval rules, tool permissions, budgets, rooms, folders or paths. Importing always makes a NEW bot.
 *
 * Every object is strict: a field this version does not know is an error, not something to ignore, so a file cannot
 * smuggle settings in next to the ones that are checked.
 */
export const BOT_EXPORT_FORMAT = 'pocketrocket.bot';
export const BOT_EXPORT_VERSION = 1;
/** The biggest file the hub will make or take. Matches the REST body cap. */
export const MAX_BOT_EXPORT_BYTES = 1024 * 1024;
export const MAX_EXPORT_SKILLS = 20;
export const MAX_EXPORT_SKILL_BYTES = 64 * 1024;
/** Same cap as a bot's own memory.md. */
export const MAX_EXPORT_MEMORY_BYTES = 8 * 1024;

const withinBytes = (max: number) => (s: string) => new TextEncoder().encode(s).length <= max;

export const BotExportSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'skill names use lowercase letters, digits and dashes'),
  description: z.string().min(1).max(300),
  markdown: z.string().refine(withinBytes(MAX_EXPORT_SKILL_BYTES), 'a skill is over 64 KB'),
}).strict();

export const BotExportSchema = z.object({
  format: z.literal(BOT_EXPORT_FORMAT),
  version: z.literal(BOT_EXPORT_VERSION),
  exportedAt: z.number().int().nonnegative().optional(),
  bot: z.object({
    name: z.string().min(1).max(40),
    handle: z.string().regex(/^[a-z0-9_-]{2,24}$/),
    title: z.string().max(80).default(''),
    /** The bot's instructions. */
    description: z.string().max(MAX_BOT_DESCRIPTION_CHARS).default(''),
    /** A built-in icon key, or '' for the automatic one. A picture upload is a file on one machine, so it never travels. */
    avatar: z.enum([...BOT_ICON_KEYS, '']).default(''),
  }).strict(),
  skills: z.array(BotExportSkillSchema).max(MAX_EXPORT_SKILLS).default([]),
  /** Optional memory notes. Only present when the owner chose to include them. */
  memory: z.string().refine(withinBytes(MAX_EXPORT_MEMORY_BYTES), 'memory is over 8 KB').optional(),
}).strict();
export type BotExport = z.infer<typeof BotExportSchema>;

/** What GET /api/bots/:id/export answers. `redactions` counts secrets and paths taken out of the text. */
export interface BotExportResult {
  file: BotExport;
  redactions: number;
}

/** What POST /api/bots/import answers. */
export interface BotImportResult {
  bot: Bot;
  /** True when the handle in the file was taken and the new bot got another one. */
  handleRenamed: boolean;
  /** The skills that arrived, all waiting for review, with their final names. */
  skills: { name: string; renamed: boolean }[];
  memoryImported: boolean;
}
