import type { ApprovalPayload } from '@pocketrocket/shared';

/** Tools whose subject is one path. Glob and Grep are left out: the hub folds their search pattern into the subject. */
const SINGLE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * The narrow pattern for a card, or null when it has none. Follows the hub's approvalSubject, which answers `*`
 * for every other tool and for an empty subject. Sending no pattern lets the hub derive that same subject, so
 * this must return null wherever the hub would land on `*`. A subject ending in * is also null, because the
 * hub would read it as a prefix match rather than the exact call the user approved.
 */
export function suggestPattern(p: ApprovalPayload): string | null {
  const i = (p.toolInput ?? {}) as Record<string, unknown>;
  const subject = p.toolName === 'Bash' ? str(i.command)
    : p.toolName === 'request_approval' ? str(i.command) || str(i.action)
    : p.toolName === 'WebFetch' ? str(i.url)
    : p.toolName === 'WebSearch' ? str(i.query)
    : SINGLE_PATH_TOOLS.has(p.toolName) ? str(i.file_path) || str(i.path) || str(i.notebook_path)
    : '';
  return subject && !subject.endsWith('*') ? subject : null;
}

/**
 * The starting pattern for "Always allow": wide enough that the bot's next, slightly different call still
 * matches (a bot rewrites its commands every run, so the exact text almost never repeats). The hub matches a
 * trailing * as a prefix and never lets an allow rule cover a command it flags as dangerous.
 *  - a command: its program, `find *`; a script that starts with `cd <dir>` keeps that folder, `cd /srv/app*`
 *  - a file: its folder, `/srv/app/notes/*`
 *  - a web page: its site, `https://example.com/*`
 * Falls back to the exact subject, or null when the hub would use `*` anyway.
 */
export function broadPattern(p: ApprovalPayload): string | null {
  const exact = suggestPattern(p);
  if (!exact) return null;
  if (p.toolName === 'Bash' || p.toolName === 'request_approval') {
    const words = exact.split('\n')[0].trim().split(/\s+/);
    if (words[0] === 'cd' && words[1]) return 'cd ' + words[1] + '*';
    return words.length > 1 ? words[0] + ' *' : exact;
  }
  if (p.toolName === 'WebFetch') {
    try { return new URL(exact).origin + '/*'; } catch { return exact; }
  }
  if (SINGLE_PATH_TOOLS.has(p.toolName)) {
    const cut = Math.max(exact.lastIndexOf('/'), exact.lastIndexOf('\\'));
    return cut > 0 ? exact.slice(0, cut + 1) + '*' : exact;
  }
  return exact;
}
