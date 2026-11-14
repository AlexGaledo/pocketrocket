/**
 * One contract for every refusal text the model reads (B1). A bot that gets a vague "no" retries it, loops, or
 * works around the gate, so each message has three parts:
 *
 *   1. the outcome   what happened ("The user declined this change.")
 *   2. no retry      an explicit "Do not retry it"
 *   3. the way on    what to do instead ("say so in the room", "use your own computer")
 *
 * Only wording lives here. Which calls are refused, and when, stays with the callers.
 */
export type DenyKind =
  /** A person (or an approval rule they set) said no. */
  | 'declined'
  /** The card went unanswered. */
  | 'timeout'
  /** Refused by a standing rule, not a person answering a card. */
  | 'not_allowed'
  /** Cannot be done here: nothing could ask, or the target is not reachable. */
  | 'unavailable'
  /** The feature is switched off. */
  | 'off'
  /** The global read-only approvals setting. */
  | 'readonly';

export interface DenyOpts {
  /** What was refused, as a noun phrase: "this change", "this outside tool call". Default "this action". */
  subject?: string;
  /** What the bot does instead, a lowercase sentence fragment: "say so in the room". */
  alt?: string;
  /** Extra outcome detail, a lowercase fragment: "nothing was sent", "the change was not made". */
  note?: string;
}

export const DEFAULT_ALT = 'choose another approach or say so in the room';
export const NO_RETRY = 'Do not retry it';

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const stop = (s: string) => s.trim().replace(/[.;:,\s]+$/, '');

function outcome(kind: DenyKind, subject: string, note: string | undefined): string {
  const n = note ? stop(note) : '';
  switch (kind) {
    case 'declined':
      return 'The user declined ' + subject + '.' + (n ? ' ' + cap(n) + '.' : '');
    case 'timeout':
      return 'No response from the user within 10 minutes; ' + (n || subject + ' was not allowed') + '.';
    case 'not_allowed':
      return cap(subject) + ' is not allowed' + (n ? ': ' + n : '') + '.';
    case 'unavailable':
      return cap(subject) + ' cannot be done here' + (n ? ': ' + n : '') + '.';
    case 'off':
      return cap(subject) + ' is turned off' + (n ? ': ' + n : '') + '.';
    case 'readonly':
      return 'Read-only mode: ' + subject + ' is refused' + (n ? ' (' + n + ')' : '') + '.';
  }
}

/** The refusal text for a bot: outcome, "Do not retry it", and what to do instead. */
export function denyMessage(kind: DenyKind, opts: DenyOpts = {}): string {
  const subject = opts.subject ?? 'this action';
  const alt = stop(opts.alt ?? DEFAULT_ALT);
  return outcome(kind, subject, opts.note) + ' ' + NO_RETRY + '; ' + alt + '.';
}

/** Every kind, for tests that must cover them all. */
export const DENY_KINDS: readonly DenyKind[] = ['declined', 'timeout', 'not_allowed', 'unavailable', 'off', 'readonly'];
