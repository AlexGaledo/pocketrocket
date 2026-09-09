import fs from 'node:fs';
import path from 'node:path';
import { botHome } from '../config.js';
import { events } from '../events.js';

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
export function capMemory(text: string): { text: string; trimmed: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_MEMORY_BYTES) return { text, trimmed: false };

  const lines = text.split('\n');
  const budget = MAX_MEMORY_BYTES - Buffer.byteLength(TRIM_NOTE + '\n', 'utf8');
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
}
