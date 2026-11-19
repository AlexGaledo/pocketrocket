/**
 * The new layout's view of "where am I" (docs/specs/toki-ui.md, W5/W6): whether the layout is on for this browser,
 * the project whose room is open, and that project's parsed current.md.
 */
import { useEffect } from 'react';
import type { ProjectOverview } from '@pocketrocket/shared';
import { useStore } from '../store';
import { useLayout } from './layout';
import { projectOfRoom } from './projects';
import type { ProjectInfo } from './api';

/** The new layout is on here. A paired phone always keeps the classic one. */
export function useToki(): boolean {
  const layout = useLayout();
  const device = useStore((s) => s.device);
  return layout === 'toki' && !device;
}

/** The project whose group chat is open, in the new layout only. */
export function useActiveProject(): ProjectInfo | null {
  const toki = useToki();
  const project = useStore((s) => projectOfRoom(s.projects, s.activeRoomId));
  return toki ? project : null;
}

/**
 * A project's overview, fetched the first time it is asked for and refreshed by the store after each turn in its room.
 * `undefined` while loading, `null` when the hub had none to give.
 */
export function useOverview(slug: string | null | undefined): ProjectOverview | null | undefined {
  const overview = useStore((s) => (slug ? s.overviews[slug] : undefined));
  const known = useStore((s) => !!slug && slug in s.overviews);
  const load = useStore((s) => s.loadOverview);
  useEffect(() => {
    if (slug && !known) void load(slug);
  }, [slug, known, load]);
  return slug ? overview : null;
}

/**
 * Brings a card in the open chat into view: the chat may still be loading, so it looks for a short while. The
 * transcript marks each card with `data-msg`.
 */
export function revealMessage(messageId: string, tries = 40): void {
  const step = (left: number) => {
    const el = document.querySelector('[data-msg="' + CSS.escape(messageId) + '"]')?.firstElementChild;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return;
    }
    if (left > 0) setTimeout(() => step(left - 1), 50);
  };
  requestAnimationFrame(() => step(tries));
}
