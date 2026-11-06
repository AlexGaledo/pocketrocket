import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How long the Claude Code CLI keeps session transcripts (`~/.claude/projects/**.jsonl`). Its default is 30
 * days: at startup the CLI deletes older transcripts, and a bot whose session file is gone can no longer
 * resume, so it forgets the conversation it was in. Ten years is "keep them"; the hub prunes nothing itself.
 */
export const SESSION_RETENTION_DAYS = 3650;

export type RetentionResult = 'created' | 'added' | 'kept' | 'lower' | 'skipped';

/**
 * Makes the OS user's Claude Code settings keep transcripts, for CLI runs the hub does not configure itself
 * (the owner running `claude` by hand, `claude update`). Bot turns already get the value as flag settings
 * (providers/claude.ts), which `settingSources: []` does not turn off.
 *
 * Idempotent and conservative: nothing happens without a `~/.claude` folder (the CLI was never used), an
 * unreadable or non-object settings file is left alone, and a value the owner set on purpose is kept even when
 * it is lower ('lower', so the caller can warn). Only a missing key is added.
 */
export function ensureCliRetention(claudeDir: string = path.join(os.homedir(), '.claude')): RetentionResult {
  if (!fs.existsSync(claudeDir)) return 'skipped';
  const file = path.join(claudeDir, 'settings.json');
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    /* no settings yet */
  }
  if (raw === null) {
    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: SESSION_RETENTION_DAYS }, null, 2) + '\n');
    return 'created';
  }
  let v: unknown;
  try {
    v = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return 'skipped';
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'skipped';
  const cur = (v as Record<string, unknown>).cleanupPeriodDays;
  if (typeof cur === 'number') return cur >= SESSION_RETENTION_DAYS ? 'kept' : 'lower';
  if (cur !== undefined) return 'skipped';
  fs.writeFileSync(file, JSON.stringify({ ...(v as Record<string, unknown>), cleanupPeriodDays: SESSION_RETENTION_DAYS }, null, 2) + '\n');
  return 'added';
}
