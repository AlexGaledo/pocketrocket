// The header of every page that lies over the chat (Needs you, Tasks, PC sessions, Automations, Usage, a workflow,
// a bot). The back arrow, the title and the actions sit where they always have. In the new layout
// (docs/specs/toki-ui.md, W9) the title takes the page-title size and a page may add a leading picture, a badge
// beside the title and an underline tab strip under the row. In the classic layout it is today's header, unchanged.
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useStore } from '../store';
import { useLayout } from '../lib/layout';
import { Button, Tooltip } from './ui';

/**
 * True when the restyled pages are drawn: the "New layout" switch is on and this is not a paired phone, which keeps
 * the classic app (the same rule as the sidebar).
 */
export function useNewPages(): boolean {
  const device = useStore((s) => s.device);
  return useLayout() === 'toki' && !device;
}

export function PageHeader({ title, sub, actions, leading, titleAside, tabs }: {
  title: string;
  sub: string;
  actions?: ReactNode;
  /** New layout: a picture before the title (a bot's avatar). */
  leading?: ReactNode;
  /** New layout: a badge or two right after the title. */
  titleAside?: ReactNode;
  /** New layout: an underline tab strip under the title row (`TabsList variant="underline"`). It brings its own padding, to line up with `PageBody`. */
  tabs?: ReactNode;
}) {
  const closePage = useStore((s) => s.closePage);
  const fresh = useNewPages();
  const back = <Tooltip content="Back to chat"><Button variant="ghost" size="icon" aria-label="Back to chat" onClick={closePage}><ArrowLeft size={16} /></Button></Tooltip>;
  if (!fresh) {
    return (
      <header className="flex h-14 shrink-0 items-center gap-3 px-5 max-md:pl-14">
        {back}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body font-semibold">{title}</h1>
          <div className="truncate text-hint text-muted">{sub}</div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
      </header>
    );
  }
  return (
    <header className="shrink-0">
      {/* Wraps on a narrow pane: back, picture and title stay together (at least 16rem) and the actions move to a
          row of their own, right aligned, rather than squeezing the title. On a wide pane it is one row, as before. */}
      <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 max-md:pl-14">
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-3">
          {back}
          {leading}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {/* Wraps rather than cut off: a long bot or workflow name on a phone stays readable. */}
              <h1 className="min-w-0 break-words text-title">{title}</h1>
              {titleAside}
            </div>
            {/* The subline wraps rather than cut off on a phone; it is one short phrase on every page. */}
            <p className="text-hint text-muted">{sub}</p>
          </div>
        </div>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-3">{actions}</div>}
      </div>
      {tabs}
    </header>
  );
}
