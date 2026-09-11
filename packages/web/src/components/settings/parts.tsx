/**
 * Layout pieces shared by the Settings sections, so every section has the same rhythm: a header
 * (title + one plain sentence) followed by groups. A group is a quiet card with an optional caption.
 */
import type { ReactNode } from 'react';
import { cn } from '../ui';

/** Top of a section. The right padding keeps the title clear of the dialog's close button. */
export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-5 sm:pr-10">
      <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
    </header>
  );
}

/**
 * A block of related settings. `title` renders as a small caption above the card; `titleId` exposes it
 * so a control group inside can use it as its accessible name (aria-labelledby).
 */
export function Group({ title, titleId, aside, className, children }: { title?: string; titleId?: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('mb-6 last:mb-0', className)}>
      {title && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 id={titleId} className="text-[13px] font-semibold text-fg">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** The card surface a group's controls sit on. Matches the radio cards (bg-card2/40 + hairline). */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-2xl bg-card2/40 p-4 ring-1 ring-line', className)}>{children}</div>;
}

/** Inline error under a form. role="alert" so a screen reader announces it the moment it appears. */
export function InlineError({ id, children }: { id?: string; children: ReactNode }) {
  return <p id={id} role="alert" className="mt-2 text-[12px] leading-snug text-bad">{children}</p>;
}
