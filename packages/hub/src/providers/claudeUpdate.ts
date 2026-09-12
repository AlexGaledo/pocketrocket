import { execFile } from 'node:child_process';
import { CLAUDE_EXE } from '../config.js';
import { childEnv } from './env.js';

// New models require a minimum CLI version. The CLI rejects the first request with
// "API Error: 400 Claude Code 2.1.227 does not support this model; version 2.1.251 or newer is required."
const OUTDATED_RE = /does not support this model; version \S+ or newer is required/i;

export function isOutdatedCliError(text: string | undefined): boolean {
  return !!text && OUTDATED_RE.test(text);
}

export interface CliUpdateResult {
  ok: boolean;
  output: string;
}

// Several bots can hit the error at once: they share one `claude update`, and a fresh result is reused
// for a short while instead of re-running the updater for every failing turn.
const REUSE_MS = 2 * 60_000;
let inflight: Promise<CliUpdateResult> | null = null;
let last: { at: number; result: CliUpdateResult } | null = null;

/** Run `claude update` against CLAUDE_EXE (native or npm install; the CLI picks the right method). */
export function updateClaudeCli(): Promise<CliUpdateResult> {
  if (inflight) return inflight;
  if (last && Date.now() - last.at < REUSE_MS) return Promise.resolve(last.result);
  inflight = new Promise<CliUpdateResult>((resolve) => {
    const child = execFile(
      CLAUDE_EXE, ['update'],
      { timeout: 180_000, windowsHide: true, env: childEnv('claude') },
      (err, stdout, stderr) => resolve({ ok: !err, output: (String(stdout) + '\n' + String(stderr)).trim() }),
    );
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
  }).then((result) => {
    last = { at: Date.now(), result };
    inflight = null;
    if (process.env.POCKETROCKET_DEBUG) console.log('[claude update]', result.ok ? 'ok' : 'failed', result.output);
    return result;
  });
  return inflight;
}
