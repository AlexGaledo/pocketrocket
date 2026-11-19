import type { ProjectOverview } from '@pocketrocket/shared';

/** Longest single line kept; a bot-written paragraph in a bullet is cut here. */
const MAX_LINE = 200;
const MAX_WAITING = 20;

export const EMPTY_OVERVIEW: ProjectOverview = { updated: null, plan: null, next: null, done: [], waiting: [] };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/;
/** A top-level bullet (at most one space of indent), so nested detail lines are not read as items. */
const BULLET = /^ ?(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;

const clip = (s: string) => {
  const t = s.trim();
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 1) + '…' : t;
};

/**
 * A project's state from its `current.md`, with no AI turn (Toki UI spec, B3). Plain rules over the text: checkboxes
 * for the plan, and bullets under the "Next", "Done"/"Shipped" and "Waiting on me/owner/you" headings. Code fences are
 * skipped. Returns text only; the web shows it as plain text.
 */
export function parseProjectOverview(md: string): ProjectOverview {
  const text = md.replace(/^\uFEFF/, '');
  // The same front matter rule as ProjectService.parseFrontmatter (not imported: ProjectService imports this file).
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const updated = front ? (/^updated:\s*(.+?)\s*$/m.exec(front[1])?.[1] ?? null) : null;
  const body = front ? text.slice(front[0].length) : text;
  let done = 0;
  let total = 0;
  let stage: string | null = null;
  let stageFound = false;
  let lastH2: string | null = null;
  let section: 'next' | 'done' | 'waiting' | null = null;
  let next: string | null = null;
  const doneItems: string[] = [];
  const waiting: string[] = [];
  let fence = false;

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h) {
      const title = h[2].trim();
      if (h[1].length === 2) lastH2 = clip(title);
      section = /^next\b/i.test(title) ? 'next'
        : /^(done|shipped)\b/i.test(title) ? 'done'
        : /^waiting on (me|owner|you)\b/i.test(title) ? 'waiting'
        : null;
      continue;
    }
    const box = BOX.exec(line);
    if (box) {
      total++;
      if (box[1] !== ' ') done++;
      else if (!stageFound) { stageFound = true; stage = lastH2; }
    }
    if (!section) continue;
    const b = BULLET.exec(line);
    if (!b || !b[1].trim()) continue;
    const item = clip(b[1]);
    if (section === 'next') { if (next === null) next = item; }
    else if (section === 'done') doneItems.push(item);
    else if (waiting.length < MAX_WAITING) waiting.push(item);
  }

  return {
    updated,
    plan: total ? { done, total, stage } : null,
    next,
    done: doneItems.slice(-3),
    waiting,
  };
}
