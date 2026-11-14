import { z } from 'zod';
import type { CtaButton, FormAnswer, FormField } from './models.js';

/*
 * U4 forms and U5 calls to action. Everything a bot writes onto these cards is untrusted: the hub cleans it before
 * it is stored and the browser cleans it again before it is drawn (a stored row may predate a rule), and the card
 * draws it as plain text, never markdown or HTML. The limits live here so both sides agree.
 */

export const MAX_FORM_FIELDS = 8;
export const MAX_FORM_TITLE = 80;
export const MAX_FORM_DESCRIPTION = 300;
export const MAX_FIELD_ID = 32;
export const MAX_FIELD_LABEL = 80;
export const MAX_FIELD_HELP = 200;
/** A text answer is at most this long, whatever the bot asks for. */
export const MAX_TEXT_ANSWER = 500;
export const DEFAULT_TEXT_ANSWER = 200;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 10;
export const MAX_CHOICE_LENGTH = 60;
/** How long the owner has before a form is treated as unanswered. */
export const FORM_TIMEOUT_MS = 10 * 60_000;

export const MAX_CTA_BUTTONS = 3;
export const MAX_CTA_LABEL = 40;
export const MAX_CTA_SAY = 200;
export const MAX_CTA_HREF = 500;

/**
 * Strips what could hide or reorder text: control characters, zero-width and bidirectional override characters.
 * Newlines survive only when `multiline`. The result is trimmed and cut at `max` characters.
 */
export function cleanText(s: unknown, max: number, multiline = false): string {
  if (typeof s !== 'string') return '';
  const kept = s
    .replace(/\r\n?/g, '\n')
    .replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g : /[\u0000-\u001F\u007F-\u009F]/g, multiline ? '' : ' ')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '');
  const t = (multiline ? kept : kept.replace(/ {2,}/g, ' ')).trim();
  return Array.from(t).slice(0, max).join('');
}

/**
 * Lookalike letters that survive NFKC (Cyrillic and Greek that read as Latin), folded to Latin so "раssword" is
 * still caught. A short list, not the whole confusables table.
 */
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g',
  'ο': 'o', 'α': 'a', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'ε': 'e',
};

/** NFKC, then drop zero-width, soft-hyphen, bidi and combining marks, then fold the lookalikes above. */
function foldForScan(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF]/g, '')
    .replace(/\p{M}/gu, '')
    .replace(/[^\u0000-\u007F]/g, (ch) => CONFUSABLES[ch] ?? ch);
}

/** Words that mean the card is asking for a secret. Those go through the vault, never through a form. */
const SECRET_WORDS = /pass(word|code|phrase|wd)|\bpin\b|secret|api[\s_-]?key|\btokens?\b|private[\s_-]?key|seed[\s_-]?phrase|recovery[\s_-]?(code|phrase|key)|credit[\s_-]?card|card[\s_-]?number|\bcvv\b|\bcvc\b|\bssn\b|social[\s_-]?security|\b2[\s-]?fa\b|two[\s-]?factor|\botp\b|one[\s_-]?time[\s_-]?(code|password|pin)|(verification|verify|sign[\s_-]?in|log[\s_-]?in|security|auth(entication|enticator)?|confirmation|access)[\s_-]?(code|pin)s?\b|credentials?|bearer/i;
/**
 * Best effort only: a regex over normalised text cannot stop a determined bot (it can spell a request out in
 * words this list does not know). The real defence is that the owner reads the card and the vault exists; this
 * just refuses the obvious asks, including ones disguised with lookalike or invisible characters.
 */
export const looksLikeSecretRequest = (s: string): boolean => SECRET_WORDS.test(foldForScan(s));

export const FormFieldInputSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'id is lowercase letters, digits and _').describe('Short key your answer comes back under, e.g. "domain"'),
  type: z.enum(['text', 'choice', 'yesno']),
  label: z.string().min(1).max(MAX_FIELD_LABEL),
  help: z.string().max(MAX_FIELD_HELP).optional(),
  required: z.boolean().optional().describe('Default true'),
  choices: z.array(z.string().min(1).max(MAX_CHOICE_LENGTH)).min(MIN_CHOICES).max(MAX_CHOICES).optional().describe('For type "choice": the options'),
  max_length: z.number().int().min(1).max(MAX_TEXT_ANSWER).optional().describe('For type "text": longest answer, default ' + DEFAULT_TEXT_ANSWER),
});
export const FormInputShape = {
  title: z.string().min(1).max(MAX_FORM_TITLE),
  description: z.string().max(MAX_FORM_DESCRIPTION).optional(),
  fields: z.array(FormFieldInputSchema).min(1).max(MAX_FORM_FIELDS),
};

export type Built<T> = { ok: true; value: T } | { ok: false; error: string };

/** Checks and cleans a bot's form. Errors are written for the bot to read and fix. */
export function buildForm(input: unknown): Built<{ title: string; description?: string; fields: FormField[] }> {
  const parsed = z.object(FormInputShape).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid form: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ') };
  const f = parsed.data;
  const title = cleanText(f.title, MAX_FORM_TITLE);
  if (!title) return { ok: false, error: 'Invalid form: title is empty' };
  const description = f.description ? cleanText(f.description, MAX_FORM_DESCRIPTION, true) : undefined;
  const seen = new Set<string>();
  const fields: FormField[] = [];
  for (const raw of f.fields) {
    if (seen.has(raw.id)) return { ok: false, error: 'Invalid form: field id "' + raw.id + '" is used twice' };
    seen.add(raw.id);
    const label = cleanText(raw.label, MAX_FIELD_LABEL);
    if (!label) return { ok: false, error: 'Invalid form: field "' + raw.id + '" has an empty label' };
    const help = raw.help ? cleanText(raw.help, MAX_FIELD_HELP) || undefined : undefined;
    const required = raw.required ?? true;
    const base = { id: raw.id, label, ...(help ? { help } : {}), required };
    if (raw.type === 'choice') {
      const choices = [...new Set((raw.choices ?? []).map((c) => cleanText(c, MAX_CHOICE_LENGTH)).filter(Boolean))];
      if (choices.length < MIN_CHOICES) return { ok: false, error: 'Invalid form: field "' + raw.id + '" needs at least ' + MIN_CHOICES + ' different choices' };
      fields.push({ ...base, kind: 'choice', choices });
    } else if (raw.type === 'yesno') {
      fields.push({ ...base, kind: 'yesno' });
    } else {
      fields.push({ ...base, kind: 'text', maxLength: Math.min(raw.max_length ?? DEFAULT_TEXT_ANSWER, MAX_TEXT_ANSWER) });
    }
  }
  const asked = [title, description ?? '', ...fields.flatMap((x) => [x.label, x.help ?? '', ...(x.kind === 'choice' ? x.choices : [])])].join('\n');
  if (looksLikeSecretRequest(asked)) {
    return { ok: false, error: 'Forms cannot ask for passwords, keys, tokens, codes or other secrets. Ask the user to put it where you cannot read it (the credentials vault or the machine itself), or say so in the room.' };
  }
  return { ok: true, value: { title, ...(description ? { description } : {}), fields } };
}

export const FormAnswersSchema = z.record(z.string().max(MAX_FIELD_ID), z.union([z.string().max(MAX_TEXT_ANSWER * 4), z.boolean()])).refine((r) => Object.keys(r).length <= MAX_FORM_FIELDS, 'too many answers');

/** Checks what the owner sent against the stored fields. Unknown ids, wrong types, long or missing values are refused. */
export function validateAnswers(fields: FormField[], answers: Record<string, FormAnswer>): Built<Record<string, FormAnswer>> {
  const known = new Set(fields.map((f) => f.id));
  for (const k of Object.keys(answers)) if (!known.has(k)) return { ok: false, error: 'Unknown field: ' + k.slice(0, 40) };
  const out: Record<string, FormAnswer> = {};
  for (const f of fields) {
    const v = answers[f.id];
    const need = { ok: false as const, error: '"' + f.label + '" needs an answer' };
    if (f.kind === 'yesno') {
      if (v === undefined) { if (f.required) return need; continue; }
      if (typeof v !== 'boolean') return { ok: false, error: '"' + f.label + '" must be yes or no' };
      out[f.id] = v;
      continue;
    }
    if (v === undefined) { if (f.required) return need; continue; }
    if (typeof v !== 'string') return { ok: false, error: '"' + f.label + '" must be text' };
    if (f.kind === 'text') {
      const t = cleanText(v, f.maxLength + 1, true);
      if (Array.from(t).length > f.maxLength) return { ok: false, error: '"' + f.label + '" is longer than ' + f.maxLength + ' characters' };
      if (!t) { if (f.required) return need; continue; }
      out[f.id] = t;
    } else {
      if (!v) { if (f.required) return need; continue; }
      if (!f.choices.includes(v)) return { ok: false, error: '"' + f.label + '": not one of the choices' };
      out[f.id] = v;
    }
  }
  return { ok: true, value: out };
}

/** An http(s) link that is safe to show and open: no credentials in it, and the host it goes to is returned to be shown. */
export function safeHref(raw: unknown): { href: string; host: string } | null {
  if (typeof raw !== 'string' || raw.length > MAX_CTA_HREF || /[\s\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  return { href: u.href, host: u.host };
}

export const CtaInputSchema = z.object({
  label: z.string().min(1).max(MAX_CTA_LABEL).describe('The button text'),
  say: z.string().min(1).max(MAX_CTA_SAY).optional().describe('What clicking sends as the owner\'s own chat message. It is shown under the button before they click'),
  href: z.string().max(MAX_CTA_HREF).optional().describe('Or an http(s) link to open in a new tab. Give exactly one of say / href'),
});

/**
 * `say` is sent as the owner's own message, so it must not be able to wake other bots as the owner: every
 * @mention is removed (fullwidth ＠ too, via NFKC) and the gap closed.
 */
export function cleanSay(raw: unknown, max: number): string {
  const t = cleanText(raw, MAX_CTA_SAY * 2).normalize('NFKC').replace(/@+[\w.-]*/g, '').replace(/ {2,}/g, ' ');
  return cleanText(t, max);
}

/** Checks and cleans a bot's buttons. `say` text is sent as the owner's own message, so it is shown on the card. */
export function buildCta(input: unknown): Built<CtaButton[]> {
  const parsed = z.array(CtaInputSchema).min(1).max(MAX_CTA_BUTTONS).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid cta: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ') };
  const out: CtaButton[] = [];
  for (const b of parsed.data) {
    const label = cleanText(b.label, MAX_CTA_LABEL);
    if (!label) return { ok: false, error: 'Invalid cta: a button has an empty label' };
    if ((b.say === undefined) === (b.href === undefined)) return { ok: false, error: 'Invalid cta: "' + label + '" needs exactly one of say or href' };
    if (b.href !== undefined) {
      const h = safeHref(b.href);
      if (!h) return { ok: false, error: 'Invalid cta: "' + label + '" link must be a plain http or https address with no login in it' };
      out.push({ label, href: h.href });
    } else {
      const say = cleanSay(b.say, MAX_CTA_SAY);
      if (!say) return { ok: false, error: 'Invalid cta: "' + label + '" has nothing to say (@mentions are removed from what a button says)' };
      out.push({ label, say });
    }
  }
  return { ok: true, value: out };
}

/** What the browser draws: the stored buttons, cleaned again, at most the cap, links that fail the check dropped. */
export function displayCta(payload: unknown): Array<CtaButton & { host?: string }> {
  const list = (payload as { cta?: unknown } | null)?.cta;
  if (!Array.isArray(list)) return [];
  const out: Array<CtaButton & { host?: string }> = [];
  for (const b of list.slice(0, MAX_CTA_BUTTONS)) {
    if (!b || typeof b !== 'object') continue;
    const { label: l, say: s, href: h } = b as Record<string, unknown>;
    const label = cleanText(l, MAX_CTA_LABEL);
    if (!label) continue;
    if (typeof h === 'string' && s === undefined) {
      const ok = safeHref(h);
      if (ok) out.push({ label, href: ok.href, host: ok.host });
    } else if (typeof s === 'string' && h === undefined) {
      const say = cleanSay(s, MAX_CTA_SAY);
      if (say) out.push({ label, say });
    }
  }
  return out;
}
