import type { FormField } from '@pocketrocket/shared';
import { MAX_FORM_FIELDS, cleanText, MAX_FIELD_LABEL, MAX_FIELD_HELP, MAX_CHOICES, MAX_CHOICE_LENGTH } from '@pocketrocket/shared';

/** The card's fields as drawn: cleaned again and capped, so a bad row cannot flood the chat. */
export function displayFields(fields: unknown): FormField[] {
  if (!Array.isArray(fields)) return [];
  const out: FormField[] = [];
  for (const f of fields.slice(0, MAX_FORM_FIELDS)) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const id = typeof r.id === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(r.id) ? r.id : '';
    const label = cleanText(r.label, MAX_FIELD_LABEL);
    if (!id || !label || out.some((x) => x.id === id)) continue;
    const help = cleanText(r.help, MAX_FIELD_HELP) || undefined;
    const base = { id, label, ...(help ? { help } : {}), required: r.required !== false };
    if (r.kind === 'yesno') out.push({ ...base, kind: 'yesno' });
    else if (r.kind === 'choice' && Array.isArray(r.choices)) {
      const choices = [...new Set((r.choices as unknown[]).slice(0, MAX_CHOICES).map((c) => cleanText(c, MAX_CHOICE_LENGTH)).filter(Boolean))];
      if (choices.length >= 2) out.push({ ...base, kind: 'choice', choices });
    } else if (r.kind === 'text') {
      const n = typeof r.maxLength === 'number' && r.maxLength > 0 ? Math.min(Math.floor(r.maxLength), 500) : 200;
      out.push({ ...base, kind: 'text', maxLength: n });
    }
  }
  return out;
}
