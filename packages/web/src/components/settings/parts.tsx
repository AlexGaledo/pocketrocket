/**
 * Layout pieces shared by the Settings sections, so every section has the same rhythm: a header
 * (title + one plain sentence) followed by groups. A group is a quiet card with an optional caption.
 * Plus `Private`, for the two facts this dialog knows that nobody screen-sharing it means to publish.
 */
import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
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

/**
 * A path with the home directory folded back to `~`, so the machine's user name stays off the screen:
 * `C:\Users\dana\.local\bin\claude.exe` reads `~\.local\bin\claude.exe`. A path that is not under a home
 * directory we recognise shrinks to its file name, which never carries a user name at all.
 */
export function shortPath(path: string): string {
  const home = /^(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[^\\/]+/;
  if (home.test(path)) return path.replace(home, '~');
  return path.split(/[\\/]/).pop() || path;
}

/** `dana@example.com` → `d•••@example.com`: enough to recognise your own address, not to copy it down. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return email[0] + '•••' + email.slice(at);
}

/**
 * One fact that is true but private — where the CLI lives, which account is signed in. It shows the
 * shortened form, reveals the whole thing on a deliberate press, and copies it on another, so the full
 * value is never just sitting there in a screenshot or a shared screen.
 */
export function Private({ value, display, label, className }: { value: string; display: string; label: string; className?: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const RevealIcon = shown ? EyeOff : Eye;
  const button = 'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 align-middle', className)}>
      <span className="min-w-0 break-all font-mono">{shown ? value : display}</span>
      <button type="button" className={button} aria-label={(shown ? 'Hide the full ' : 'Show the full ') + label} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
        <RevealIcon size={13} aria-hidden />
      </button>
      <button
        type="button"
        className={button}
        aria-label={'Copy the full ' + label}
        onClick={() => {
          // Clipboard access can be refused (an insecure origin, a denied permission); the button simply
          // does not confirm then, and the reveal button is still there to read the value off the screen.
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => undefined);
        }}
      >
        {copied ? <Check size={13} aria-hidden className="text-ok" /> : <Copy size={13} aria-hidden />}
      </button>
      {/* Announced only when it changes, so a screen reader confirms the copy without narrating the value. */}
      <span role="status" className="sr-only">{copied ? 'Copied' : ''}</span>
    </span>
  );
}

/** Inline error under a form. role="alert" so a screen reader announces it the moment it appears. */
export function InlineError({ id, children }: { id?: string; children: ReactNode }) {
  return <p id={id} role="alert" className="mt-2 text-[12px] leading-snug text-bad">{children}</p>;
}
