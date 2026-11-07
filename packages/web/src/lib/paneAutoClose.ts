/**
 * What a side pane should do when the window crosses its inline breakpoint. Shrinking past it closes an open
 * pane rather than dropping a drawer over the chat; growing back reopens it, but only if that close was ours.
 * The user opening the drawer in between takes over, so a close they make afterwards sticks.
 * No imports, so `node --test` can load it straight from source (packages/web/test).
 */
export interface PaneAuto {
  inline: boolean;
  /** Closed by a shrink, not by the user, and not touched since. */
  autoClosed: boolean;
}

export type PaneAct = 'close' | 'open' | null;

export function paneAutoStep(prev: PaneAuto, inline: boolean, open: boolean): { next: PaneAuto; act: PaneAct } {
  if (prev.inline && !inline && open) return { next: { inline, autoClosed: true }, act: 'close' };
  if (!prev.inline && inline && prev.autoClosed && !open) return { next: { inline, autoClosed: false }, act: 'open' };
  return { next: { inline, autoClosed: prev.autoClosed && !open }, act: null };
}
