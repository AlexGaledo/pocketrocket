import { createHash } from 'node:crypto';
import { PC_ENTRY_TEXT_CAPS, type PcEntry } from '@pocketrocket/shared';
import { redact } from '../providers/redact.js';

/**
 * The hub's copy of the PC runner's compact-entry mapping (scripts/pc-runner/mirror.mjs `mapLine`), for the lines a Claude
 * Code turn appends to a moved session's file on the VPS (bridge P6). The entries are the same shape, so the app shows
 * one conversation. `SessionCompact.test.ts` runs both on the same lines and fails when they drift. Text is redacted with
 * the hub's `redact()` instead of the runner's scrub(); PcSessions redacts and caps again on the way in.
 */

const CAPS = { text: PC_ENTRY_TEXT_CAPS.user, toolUse: PC_ENTRY_TEXT_CAPS.tool_use, toolResult: PC_ENTRY_TEXT_CAPS.tool_result, summary: PC_ENTRY_TEXT_CAPS.summary };
const TOOL_NAMES_MAX = 5000;

export function scrubCap(text: unknown, max: number): string {
  const raw = typeof text === 'string' ? text : '';
  const head = raw.length > max * 3 ? raw.slice(0, max * 3) : raw;
  const clean = redact(head);
  const total = clean.length + (raw.length - head.length);
  if (total <= max) return clean;
  return `${clean.slice(0, max)} …[cut ${total - max} chars]`;
}

export function summarizeToolInput(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let s: string | undefined;
  for (const k of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path', 'skill']) {
    if (typeof i[k] === 'string' && i[k]) { s = i[k] as string; break; }
  }
  if (s === undefined) { try { s = JSON.stringify(i) ?? ''; } catch { s = ''; } }
  else if ((name === 'Grep' || name === 'Glob') && typeof i.path === 'string' && i.path && s !== i.path) s += ` in ${i.path}`;
  return scrubCap(s, CAPS.toolUse);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: string; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function userText(raw: string): string {
  const t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t) return '';
  if (/^<(local-command-caveat|local-command-stdout|local-command-stderr)>/.test(t)) return '';
  return t;
}

export interface CompactCtx {
  /** tool_use id -> tool name, filled by tool_use blocks and read by later tool_result blocks. */
  toolNames?: Map<string, string>;
  lineKey?: string | number;
  fallbackAt?: number;
}

/** One parsed JSONL line to 0..n entries. */
export function compactLine(o: unknown, ctx: CompactCtx = {}): PcEntry[] {
  if (!o || typeof o !== 'object') return [];
  const line = o as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const toolNames = ctx.toolNames ?? new Map<string, string>();
  const at = Date.parse(line.timestamp) || ctx.fallbackAt || 0;
  const base = typeof line.uuid === 'string' && line.uuid ? line.uuid : `L${ctx.lineKey ?? at}`;
  const out: PcEntry[] = [];
  const add = (e: Pick<PcEntry, 'kind' | 'text'> & Partial<PcEntry>) => {
    const entry: PcEntry = { uuid: out.length ? `${base}:${out.length}` : base, parentUuid: typeof line.parentUuid === 'string' ? line.parentUuid : null, at, ...e };
    if (line.isSidechain === true) entry.isSidechain = true;
    out.push(entry);
  };

  if (line.type === 'summary') {
    if (typeof line.summary !== 'string' || !line.summary.trim()) return [];
    const key = typeof line.leafUuid === 'string' && line.leafUuid ? line.leafUuid : createHash('sha1').update(line.summary).digest('hex').slice(0, 16);
    out.push({ uuid: `summary-${key}`, parentUuid: null, at, kind: 'summary', text: scrubCap(line.summary, CAPS.summary) });
    return out;
  }

  const content = line.message?.content;
  if (line.type === 'user') {
    if (line.isMeta === true) return [];
    if (line.isCompactSummary === true) {
      const t = blockText(content);
      return t.trim() ? [{ uuid: base, parentUuid: null, at, kind: 'summary', text: scrubCap(t, CAPS.summary) }] : [];
    }
    if (typeof content === 'string') {
      const t = userText(content);
      if (t) add({ kind: 'user', text: scrubCap(t, CAPS.text) });
      return out;
    }
    if (!Array.isArray(content)) return [];
    const texts: string[] = [];
    for (const b of content) {
      if (b?.type === 'tool_result') {
        const tool = typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) : undefined;
        add({ kind: 'tool_result', ...(tool ? { tool } : {}), text: scrubCap(blockText(b.content), CAPS.toolResult), isError: b.is_error === true });
      } else if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    const t = userText(texts.join('\n'));
    if (t) add({ kind: 'user', text: scrubCap(t, CAPS.text) });
    return out;
  }

  if (line.type === 'assistant') {
    if (!Array.isArray(content)) return [];
    if (line.message?.model === '<synthetic>') return [];
    const model = typeof line.message?.model === 'string' ? line.message.model : undefined;
    const extra = model ? { model } : {};
    let pending: string[] = [];
    const flush = () => {
      const t = pending.join('\n').trim();
      pending = [];
      if (t) add({ kind: 'assistant', text: scrubCap(t, CAPS.text), ...extra });
    };
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') pending.push(b.text);
      else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        flush();
        if (typeof b.id === 'string') {
          toolNames.set(b.id, b.name);
          if (toolNames.size > TOOL_NAMES_MAX) toolNames.delete(toolNames.keys().next().value as string);
        }
        add({ kind: 'tool_use', tool: b.name, text: summarizeToolInput(b.name, b.input), ...extra });
      }
    }
    flush();
    return out;
  }
  return [];
}

/**
 * The context size the last model call of a session file used (uncached input + cache reads + cache writes), read from the
 * tail of the file; null when no assistant line there reports usage.
 */
export function lastContextTokens(tail: string): number | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"usage"')) continue;
    try {
      const o = JSON.parse(l);
      const u = o?.type === 'assistant' ? o.message?.usage : null;
      if (u && typeof u === 'object') {
        const n = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
        if (n > 0) return n;
      }
    } catch { /* a cut first line of the tail */ }
  }
  return null;
}
