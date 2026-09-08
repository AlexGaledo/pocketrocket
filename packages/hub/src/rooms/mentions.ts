import type { Bot } from '@claudebot/shared';

/** Parse @handle mentions (case-insensitive) in `text` matching `members`. Unique, in order, excluding `selfId`. */
export function parseMentions(text: string, members: Bot[], selfId?: string): Bot[] {
  const byHandle = new Map(members.map((b) => [b.handle.toLowerCase(), b]));
  const seen = new Set<string>();
  const out: Bot[] = [];
  const re = /(^|[^\w@])@([a-z0-9_-]{2,24})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const b = byHandle.get(m[2].toLowerCase());
    if (!b || b.id === selfId || seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}
