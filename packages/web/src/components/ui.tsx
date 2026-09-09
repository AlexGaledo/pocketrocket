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

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'outline'; size?: 'sm' | 'md' | 'icon' };
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

export function Dialog({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] dark:bg-black/60" />
        <DialogPrimitive.Content
          // Radix warns unless a dialog either has a Description or opts out with an explicit undefined.
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[24px] bg-panel p-7 shadow-[var(--shadow-lg)] focus:outline-none', wide ? 'w-[720px]' : 'w-[520px]')}
        >
          <div className="mb-5 flex items-center justify-between">
            <DialogPrimitive.Title className="text-[17px] font-semibold tracking-tight">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close"><X size={16} /></Button>
            </DialogPrimitive.Close>
          </div>
          {description && <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
