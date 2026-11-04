/*
 * Bots read a room as lines of `#seq [author]: text`, and the hub alone writes that prefix. Message text goes inside
 * those lines, and it can come from another bot, a forwarded email or a web page, so text must not be able to look like
 * a line of its own, least of all one from the owner, whose messages bots act on.
 */

const LABEL = '[^\\]\\n\\r]{0,100}';
/** `#12 [anyone]` anywhere: the full prefix only the hub writes. */
const FULL_PREFIX = new RegExp('#\\d+[ \\t]+\\[(' + LABEL + ')\\]', 'g');
/** `[anyone]:` opening a line. */
const LINE_PREFIX = new RegExp('^[ \\t]*\\[(' + LABEL + ')\\][ \\t]*:', 'gm');
/** `[anyone (owner)]` anywhere, with or without the colon. */
const OWNER_TAG = new RegExp('\\[(' + LABEL + '\\(owner\\)[ \\t]*)\\]', 'gi');

/** Rewrites anything in `text` that reads like a transcript tag, keeping the words: `[Shiroo (owner)]:` to `(quoted) Shiroo (owner):`. */
export function quoteTags(text: string): string {
  return text
    .replace(FULL_PREFIX, '(quoted) $1')
    .replace(LINE_PREFIX, '(quoted) $1:')
    .replace(OWNER_TAG, '(quoted) $1');
}
