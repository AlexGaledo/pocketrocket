import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type { Bot, BotState } from '@pocketrocket/shared';

export function cn(...a: (string | false | null | undefined)[]) {
  return clsx(a);
}

const FieldIdContext = React.createContext<string | undefined>(undefined);

/** An explicit id always wins; otherwise the control inherits the surrounding `Field`'s. */
function useFieldId(explicit?: string) {
  const fieldId = React.useContext(FieldIdContext);
  return explicit ?? fieldId;
}

// ComponentProps (not ButtonHTMLAttributes) so `ref` is accepted: React 19 passes it through as a prop.
type BtnProps = React.ComponentProps<'button'> & { variant?: 'primary' | 'ghost' | 'danger' | 'outline'; size?: 'sm' | 'md' | 'icon' };
export function Button({ className, variant = 'outline', size = 'md', ...p }: BtnProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
        size === 'sm' && 'h-7 px-3 text-[12.5px]',
        size === 'md' && 'h-9 px-4 text-[13px]',
        size === 'icon' && 'h-8 w-8',
        variant === 'primary' && 'bg-ink text-ink-fg hover:opacity-90',
        variant === 'outline' && 'bg-card2 text-fg hover:brightness-95 dark:hover:brightness-110',
        variant === 'ghost' && 'text-muted hover:bg-card2 hover:text-fg',
        variant === 'danger' && 'bg-bad/10 text-bad hover:bg-bad/18',
        className,
      )}
      {...p}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  const id = useFieldId(p.id);
  return <input ref={ref} id={id} className={cn('h-9 w-full rounded-xl bg-card2 px-3 text-[13px] placeholder:text-dim focus:outline-none focus:ring-2 focus:ring-accent/50', className)} {...p} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  const id = useFieldId(p.id);
  return <textarea ref={ref} id={id} className={cn('w-full rounded-xl bg-card2 px-3 py-2 text-[13px] leading-relaxed placeholder:text-dim focus:outline-none focus:ring-2 focus:ring-accent/50 resize-y', className)} {...p} />;
});

export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useFieldId(p.id);
  return <select id={id} className={cn('h-9 w-full rounded-xl bg-card2 px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/50', className)} {...p} />;
}

/**
 * Wraps one caption + control. It mints an id so `Label` can be a real `<label for>` and the control
 * picks the same id up, without every call site having to invent one.
 */
export function Field({ className, children }: { className?: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <FieldIdContext.Provider value={id}>
      <div className={className}>{children}</div>
    </FieldIdContext.Provider>
  );
}

/**
 * Field caption. Sentence case, quiet; the hint sits at the end of the same line.
 *
 * Inside a `Field` it renders a real `<label for>`. With nothing to point at — a caption over a group of
 * toggle buttons, say — it renders a plain span, which `id` can then name via `aria-labelledby`.
 */
export function Label({ children, hint, htmlFor, id }: { children: React.ReactNode; hint?: string; htmlFor?: string; id?: string }) {
  const fieldId = React.useContext(FieldIdContext);
  const target = htmlFor ?? fieldId;
  const caption = 'text-[12.5px] font-medium text-fg';
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      {target
        ? <label id={id} htmlFor={target} className={caption}>{children}</label>
        : <span id={id} className={caption}>{children}</span>}
      {hint && <span className="truncate text-[11.5px] text-dim">{hint}</span>}
    </div>
  );
}

/**
 * The modal frame alone: overlay, centring, focus trap, Escape. `Dialog` below puts a title row and
 * padding inside it; a dialog with its own layout (Settings has a side nav) uses the shell directly
 * and renders `DialogTitle` itself.
 */
export function DialogShell({ open, onOpenChange, className, hasDescription, children }: { open: boolean; onOpenChange: (o: boolean) => void; className?: string; hasDescription?: boolean; children: React.ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] dark:bg-black/60" />
        <DialogPrimitive.Content
          // Radix warns unless a dialog either has a Description or opts out with an explicit undefined.
          {...(hasDescription ? {} : { 'aria-describedby': undefined })}
          // max-w keeps every dialog inside a phone-width window instead of running off the right edge.
          className={cn('fixed left-1/2 top-1/2 z-50 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 rounded-[24px] bg-panel shadow-[var(--shadow-lg)] focus:outline-none', className)}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function DialogTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <DialogPrimitive.Title className={cn('text-[17px] font-semibold tracking-tight', className)}>{children}</DialogPrimitive.Title>;
}

export function DialogCloseButton() {
  return (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" size="icon" aria-label="Close"><X size={16} /></Button>
    </DialogPrimitive.Close>
  );
}

export function Dialog({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} hasDescription={!!description} className={cn('max-h-[90vh] overflow-y-auto p-7', wide ? 'w-[720px]' : 'w-[520px]')}>
      <div className="mb-5 flex items-center justify-between">
        <DialogTitle>{title}</DialogTitle>
        <DialogCloseButton />
      </div>
      {description && <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>}
      {children}
    </DialogShell>
  );
}

/**
 * Keyboard for a `role="radio"` that is not a native input: Enter/Space select it, arrows move to the
 * previous/next radio in the same radiogroup and select that one, as a native radio group does. Pair it
 * with a roving tabindex (0 on the checked radio, -1 on the rest) so Tab enters the group once.
 */
export function radioKeyDown(e: React.KeyboardEvent<HTMLElement>, onSelect: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onSelect();
    return;
  }
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const group = e.currentTarget.closest('[role="radiogroup"]') ?? e.currentTarget.parentElement;
  const radios = Array.from(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
  const next = radios[(radios.indexOf(e.currentTarget) + step + radios.length) % radios.length];
  next?.focus();
  next?.click();
}

/** The dot inside a radio card. Decorative: the card itself carries role="radio" and aria-checked. */
export function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1', checked ? 'bg-ink ring-ink' : 'ring-dim')}>
      {checked && <span className="h-1.5 w-1.5 rounded-full bg-ink-fg" />}
    </span>
  );
}

/**
 * One choice in a radiogroup, drawn as a card with a title and a line of explanation. Put several inside
 * an element with role="radiogroup" and an accessible name. `disabled` keeps the card readable (and the
 * checked one focusable) but ignores selection.
 */
export function RadioCard({ checked, onSelect, disabled, title, badge, children }: { checked: boolean; onSelect: () => void; disabled?: boolean; title: React.ReactNode; badge?: React.ReactNode; children?: React.ReactNode }) {
  const select = () => { if (!disabled) onSelect(); };
  // The title names the radio and the explanation describes it; otherwise a screen reader would read
  // the whole card as one long name.
  const titleId = React.useId();
  const descriptionId = React.useId();
  return (
    <div
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-labelledby={titleId}
      aria-describedby={children ? descriptionId : undefined}
      tabIndex={checked ? 0 : -1}
      onClick={select}
      onKeyDown={(e) => radioKeyDown(e, select)}
      className={cn(
        'rounded-2xl p-3.5 ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        checked ? 'bg-accent/8 ring-accent/50' : 'bg-card2/40 ring-line',
        disabled ? 'cursor-default' : 'cursor-pointer',
        !checked && !disabled && 'hover:bg-card2/70',
        !checked && disabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <RadioDot checked={checked} />
        <span id={titleId} className="text-[13.5px] font-medium">{title}</span>
        {badge}
      </div>
      {children && <div id={descriptionId} className="mt-1 pl-6 text-[12.5px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

/** On/off toggle. Name it with `aria-labelledby` (or `aria-label`) pointing at its caption. */
export function Switch({ checked, onChange, className, ...aria }: { checked: boolean; onChange: (next: boolean) => void; className?: string; 'aria-labelledby'?: string; 'aria-label'?: string; 'aria-describedby'?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      {...aria}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
        checked ? 'bg-ink' : 'bg-card2 ring-1 ring-inset ring-line',
        className,
      )}
    >
      {/* left-0 matters: without it the knob starts from the button's centred content position. */}
      <span aria-hidden className={cn('absolute left-0 top-0.5 h-5 w-5 rounded-full bg-panel shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

export const Tabs = TabsPrimitive.Root;
/** Segmented control, like a native toolbar. */
export function TabsList({ children }: { children: React.ReactNode }) {
  return <TabsPrimitive.List className="mx-3 my-2 flex gap-0.5 rounded-full bg-card2 p-0.5">{children}</TabsPrimitive.List>;
}
export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Trigger value={value} className="flex-1 rounded-full px-2 py-1.5 text-[12.5px] font-medium text-muted hover:text-fg data-[state=active]:bg-panel data-[state=active]:text-fg data-[state=active]:shadow-[var(--shadow)]">
      {children}
    </TabsPrimitive.Trigger>
  );
}
export const TabsContent = TabsPrimitive.Content;

export const STATE_LABEL: Record<BotState, string> = {
  idle: 'Idle', thinking: 'Thinking', working: 'Working', waiting: 'Waiting on a teammate', blocked: 'Needs your approval', done: 'Done', error: 'Stopped with an error',
};

export function Avatar({ bot, state, size = 36 }: { bot: Pick<Bot, 'avatar' | 'name'>; state?: BotState; size?: number }) {
  const cls = state && state !== 'idle' ? 'state-' + state : '';
  return (
    <div
      role="img"
      aria-label={bot.name + (state ? ' · ' + STATE_LABEL[state] : '')}
      className={cn('relative flex shrink-0 select-none items-center justify-center rounded-full bg-card2', cls)}
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      title={bot.name + (state ? ' · ' + STATE_LABEL[state] : '')}
    >
      <span aria-hidden className="leading-none">{bot.avatar || '🤖'}</span>
    </div>
  );
}

export function UserAvatar({ size = 36 }: { size?: number }) {
  return (
    <div aria-hidden className="flex shrink-0 items-center justify-center rounded-full bg-ink font-semibold text-ink-fg" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      A
    </div>
  );
}

export function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'bad' | 'accent' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'muted' && 'bg-card2 text-muted',
        tone === 'ok' && 'bg-ok/12 text-ok',
        tone === 'warn' && 'bg-warn/12 text-warn',
        tone === 'bad' && 'bg-bad/12 text-bad',
        tone === 'accent' && 'bg-accent/12 text-accent',
      )}
    >
      {children}
    </span>
  );
}

export function fmtUsd(n: number) {
  return '$' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
}
export function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
