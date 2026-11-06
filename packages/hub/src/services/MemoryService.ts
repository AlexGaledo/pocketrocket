import fs from 'node:fs';
import path from 'node:path';
import { botHome } from '../config.js';
import { events } from '../events.js';
import { isInside } from '../permissions/pathRules.js';

/**
 * Hard ceiling on a bot's memory.md.
 *
 * Memory is injected into the system prompt on *every* turn, and the prompt tells bots to record
 * anything durable they learn — so an append-happy bot would otherwise grow the file forever and
 * make every later turn more expensive. 8 KB is roughly 2k tokens: room for a page of real notes,
 * small enough that memory never becomes the dominant cost of a turn.
 */
export const MAX_MEMORY_BYTES = 8 * 1024;

/** Left in place of the dropped notes, so the bot can see its memory was trimmed. */
export const TRIM_NOTE = '<!-- older notes were trimmed to keep this file small -->';

/**
 * Trim to the newest whole lines that fit. Newest wins: memory is appended to, so the tail holds the
 * recent material and dropping from the top loses the stalest notes first. Lines are never split.
 */
export function capMemory(text: string, limit: number = MAX_MEMORY_BYTES): { text: string; trimmed: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, trimmed: false };

  const lines = text.split('\n');
  const budget = limit - Buffer.byteLength(TRIM_NOTE + '\n', 'utf8');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(lines[i] + '\n', 'utf8');
    if (used + cost > budget) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  // A single line longer than the whole budget would leave `kept` empty; hard-cut it so the write
  // still lands under the ceiling instead of writing nothing.
  if (!kept.length) kept.push(Buffer.from(lines[lines.length - 1], 'utf8').subarray(-budget).toString('utf8'));

  return { text: TRIM_NOTE + '\n' + kept.join('\n'), trimmed: true };
}

export class MemoryService {
  file(botId: string) {
    return path.join(botHome(botId), 'memory.md');
  }
  identityFile(botId: string) {
    return path.join(botHome(botId), 'CLAUDE.md');
  }
  ensureHome(botId: string) {
    fs.mkdirSync(botHome(botId), { recursive: true });
  }
  /** Deletes the bot's private home (memory, identity, plugin). Used by every bot-delete path. */
  removeHome(botId: string) {
    fs.rmSync(botHome(botId), { recursive: true, force: true });
  }
  read(botId: string): string {
    try {
      return fs.readFileSync(this.file(botId), 'utf8');
    } catch {
      return '';
    }
  }
  readIdentity(botId: string): string {
    try {
      return fs.readFileSync(this.identityFile(botId), 'utf8');
    } catch {
      return '';
    }
  }
  writeIdentity(botId: string, text: string) {
    this.ensureHome(botId);
    fs.writeFileSync(this.identityFile(botId), text);
  }
  /** Returns true when older notes had to be dropped to fit under {@link MAX_MEMORY_BYTES}. */
  write(botId: string, text: string): boolean {
    const capped = capMemory(text);
    this.ensureHome(botId);
    fs.writeFileSync(this.file(botId), capped.text);
    events.emitEvent({ type: 'memory.updated', botId, text: capped.text });
    return capped.trimmed;
  }
  /** Copy of memory.md from before AutoMemory replaced it with a merged version; only the newest is kept. */
  backupFile(botId: string) {
    return this.file(botId) + '.bak';
  }
  backup(botId: string, text: string) {
    this.ensureHome(botId);
    fs.writeFileSync(this.backupFile(botId), text);
  }
  append(botId: string, text: string): boolean {
    const cur = this.read(botId);
    return this.write(botId, (cur ? cur.replace(/\s+$/, '') + '\n' : '') + text.trim() + '\n');
  }
  patch(botId: string, find: string, replace: string): boolean {
    const cur = this.read(botId);
    if (!cur.includes(find)) return false;
    this.write(botId, cur.replace(find, replace));
    return true;
  }

  // ---- P7: voice.md (style notes, briefly in the prompt) ----
  voiceFile(botId: string) {
    return path.join(botHome(botId), 'voice.md');
  }
  readVoice(botId: string): string {
    try {
      return fs.readFileSync(this.voiceFile(botId), 'utf8');
    } catch {
      return '';
    }
  }
  /** Capped at {@link MAX_VOICE_BYTES}, oldest lines first, like memory. Returns true when it had to trim. */
  writeVoice(botId: string, text: string): boolean {
    const capped = capMemory(text, MAX_VOICE_BYTES);
    this.ensureHome(botId);
    fs.writeFileSync(this.voiceFile(botId), capped.text);
    events.emitEvent({ type: 'voice.updated', botId });
    return capped.trimmed;
  }

  // ---- P7: notes/ (searched on demand, never in the prompt) ----
  notesDir(botId: string) {
    return path.join(botHome(botId), 'notes');
  }
  /** Note files (`*.md`) in the bot's notes folder, newest first, at most {@link MAX_NOTE_FILES}. */
  listNotes(botId: string): { name: string; bytes: number; mtime: number }[] {
    const dir = this.notesDir(botId);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      return [];
    }
    const out: { name: string; bytes: number; mtime: number }[] = [];
    for (const name of names) {
      try {
        const st = fs.lstatSync(path.join(dir, name));
        if (st.isFile()) out.push({ name, bytes: st.size, mtime: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_NOTE_FILES);
  }
  /**
   * Write (or append to) `notes/<slug>.md`. The title becomes a kebab-case file name, so a bot cannot aim a
   * note anywhere but its own notes folder. Each note is capped at {@link MAX_NOTE_BYTES}.
   */
  writeNote(botId: string, title: string, text: string, mode: 'replace' | 'append' = 'replace'): { file: string; trimmed: boolean } {
    const dir = this.notesDir(botId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, noteSlug(title) + '.md');
    if (!isInside(file, [dir])) throw new Error('Invalid note title');
    const exists = fs.existsSync(file);
    if (!exists && this.listNotes(botId).length >= MAX_NOTE_FILES) {
      throw new Error('Notes folder is full (' + MAX_NOTE_FILES + ' notes); merge or delete some first');
    }
    let body = mode === 'append' && exists
      ? fs.readFileSync(file, 'utf8').replace(/\s+$/, '') + '\n\n' + text.trim() + '\n'
      : text.trim() + '\n';
    let trimmed = false;
    if (Buffer.byteLength(body, 'utf8') > MAX_NOTE_BYTES) {
      body = Buffer.from(body, 'utf8').subarray(0, MAX_NOTE_BYTES).toString('utf8');
      trimmed = true;
    }
    fs.writeFileSync(file, body);
    return { file, trimmed };
  }
  /**
   * Case-insensitive term search over the notes. Every term must appear in a note (body or file name) for it
   * to match; hits rank by how often the terms occur (a file-name hit counts extra) and carry a few lines.
   */
  searchNotes(botId: string, query: string, limit = 8): NoteHit[] {
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2))].slice(0, 12);
    if (!terms.length) return [];
    const dir = this.notesDir(botId);
    const hits: NoteHit[] = [];
    for (const n of this.listNotes(botId)) {
      let body = '';
      try {
        body = fs.readFileSync(path.join(dir, n.name), 'utf8').slice(0, MAX_NOTE_BYTES);
      } catch {
        continue;
      }
      const lower = body.toLowerCase();
      const name = n.name.toLowerCase();
      if (!terms.every((t) => lower.includes(t) || name.includes(t))) continue;
      let score = 0;
      for (const t of terms) {
        score += lower.split(t).length - 1;
        if (name.includes(t)) score += 5;
      }
      const lines = body
        .split('\n')
        .filter((l) => terms.some((t) => l.toLowerCase().includes(t)))
        .slice(0, 3)
        .map((l) => l.trim().slice(0, 200));
      hits.push({ file: path.join(dir, n.name), name: n.name, score, lines });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 20)));
  }
}

// ---- P7 limits ----
/**
 * voice.md rides the prompt on every turn next to memory, so it stays far smaller: 1 KB is a dozen short
 * style rules ("no emoji", "lead with the answer"), enough to sound like someone without costing a turn.
 */
export const MAX_VOICE_BYTES = 1024;
/** One note file. Notes are read on demand, so this only bounds a single search and a single Read. */
export const MAX_NOTE_BYTES = 32 * 1024;
/** Notes per bot; search reads them all, so this bounds a search too. */
export const MAX_NOTE_FILES = 500;

export interface NoteHit {
  /** Absolute path, so the bot can Read the whole note. */
  file: string;
  name: string;
  score: number;
  /** Up to three matching lines, each at most 200 chars. */
  lines: string[];
}

/** `"Q3 Launch / Plan!"` -> `q3-launch-plan`. Never empty, never a path. */
export function noteSlug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'note';
}
