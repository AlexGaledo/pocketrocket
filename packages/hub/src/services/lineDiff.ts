import type { DiffLine } from '@pocketrocket/shared';

/** Above this many lines on either side the diff gives up on alignment and shows old out, new in. */
const MAX_LINES = 2000;

/**
 * A plain line diff (longest common subsequence), for the Skills tab's version history. SKILL.md files are
 * small, so the O(n·m) table is fine; past {@link MAX_LINES} it falls back to "all removed, all added".
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..], flattened.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}
