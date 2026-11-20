/**
 * Escalation on a repeated computer failure.
 *
 * When a bot's computer or browser is down, the bot reports the symptom but almost never asks anyone to fix it
 * (fleet evals 2026-11-20: 0/6 and 1/6 runs named a fixer; two rewrites of the skill text did not move it). The
 * hub sees these failures itself, so it raises them: on the 2nd identical failure for one bot within
 * REPEAT_WINDOW_MS it posts one note in the room naming who can fix it and the one action that does.
 */

import { SUPPORT_HANDLE } from '../services/SeedBots.js';

export const REPEAT_WINDOW_MS = 10 * 60_000;
/** After a note, the same bot and error stay quiet this long, so a bot retrying in a loop does not flood the room. */
export const REPEAT_COOLDOWN_MS = 30 * 60_000;

export type FailureKind = 'browser' | 'computer';

/**
 * The refused address when a browser tool could not reach the bot's browser (`ECONNREFUSED 127.0.0.1:9414`), else
 * null. Only the browser tools: a refused connection in a shell or fetch is about some other service.
 */
export function browserRefusal(toolName: string, output: string): string | null {
  if (!toolName.startsWith('mcp__browser__')) return null;
  const m = /ECONNREFUSED\s+([\w.[\]:-]+:\d+)/.exec(output);
  return m ? 'ECONNREFUSED ' + m[1] : null;
}

/**
 * Whether a start failure means the computer itself is broken. Capacity answers (every slot or place taken, low
 * memory, full disk) clear up on their own or need a different fix, so they are not escalated as a restart.
 */
export function brokenStart(reason: string): boolean {
  return /could not start|did not come up/i.test(reason);
}

export class RepeatFailureWatch {
  private seen = new Map<string, number[]>();
  private noted = new Map<string, number>();
  private windowMs: number;
  private cooldownMs: number;
  private now: () => number;

  constructor(o: { windowMs?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.windowMs = o.windowMs ?? REPEAT_WINDOW_MS;
    this.cooldownMs = o.cooldownMs ?? REPEAT_COOLDOWN_MS;
    this.now = o.now ?? Date.now;
  }

  /** Records one failure. True exactly when this one should be escalated (2nd within the window, not in cooldown). */
  record(botId: string, signature: string): boolean {
    const key = botId + '\n' + signature;
    const t = this.now();
    const hits = (this.seen.get(key) ?? []).filter((at) => t - at < this.windowMs);
    hits.push(t);
    this.seen.set(key, hits);
    if (hits.length < 2) return false;
    const last = this.noted.get(key);
    if (last !== undefined && t - last < this.cooldownMs) return false;
    this.noted.set(key, t);
    this.seen.delete(key);
    return true;
  }

  /** The bot's browser answered again: earlier failures no longer count towards a note. Cooldowns stay. */
  clear(botId: string) {
    for (const key of [...this.seen.keys()]) if (key.startsWith(botId + '\n')) this.seen.delete(key);
  }
}

/** The room note. `support` is false when this hub has no @pocketrocket-support bot: then it is addressed to the owner. */
export function escalationNote(o: { handle: string; kind: FailureKind; error: string; support: boolean }): string {
  const who = o.support ? '@' + SUPPORT_HANDLE : 'Owner';
  const what = o.kind === 'browser' ? 'browser' : 'computer';
  return who + ': @' + o.handle + "'s " + what + ' failed twice in a row with the same error (' + o.error + '). ' +
    'It needs a restart, which the bot cannot do itself: open @' + o.handle + "'s Screen tab and press Wake " +
    '(the hub restarts a computer whose browser stopped answering). Retrying from the bot will not fix it.';
}
