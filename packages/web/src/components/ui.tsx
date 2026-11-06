import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { clsx } from 'clsx';
import { Hash, X } from 'lucide-react';
import { isBotCharacterKey, isBotIconKey, isMediaRef } from '@pocketrocket/shared';
import { AutoCharacter, BotCharacter } from '../lib/botCharacter';
import type { Bot, BotState, Room } from '@pocketrocket/shared';
import { botIcon } from '../lib/botIcon';
import { useMediaUrl } from '../lib/media';

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
        'inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
        size === 'sm' && 'h-7 px-2.5 text-ui',
        size === 'md' && 'h-8 px-3 text-ui',
        // A finger needs more than a pointer: icon buttons grow to 40px on touch screens.
        size === 'icon' && 'h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10',
        variant === 'primary' && 'bg-ink text-ink-fg hover:opacity-90',
        variant === 'outline' && 'bg-card2 text-fg hover:brightness-95 dark:hover:brightness-110',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-fg',
        variant === 'danger' && 'bg-bad/10 text-bad hover:bg-bad/15',
        className,
      )}
      {...p}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  const id = useFieldId(p.id);
  return <input ref={ref} id={id} className={cn('h-9 w-full rounded-md bg-card2 px-3 placeholder:text-dim focus:outline-none focus:ring-2 focus:ring-accent', className)} {...p} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  const id = useFieldId(p.id);
  return <textarea ref={ref} id={id} className={cn('w-full rounded-md bg-card2 px-3 py-2 leading-relaxed placeholder:text-dim focus:outline-none focus:ring-2 focus:ring-accent resize-y', className)} {...p} />;
});

export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useFieldId(p.id);
  return <select id={id} className={cn('h-9 w-full rounded-md bg-card2 px-2.5 focus:outline-none focus:ring-2 focus:ring-accent', className)} {...p} />;
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
  const caption = 'text-label text-fg';
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      {target
        ? <label id={id} htmlFor={target} className={caption}>{children}</label>
        : <span id={id} className={caption}>{children}</span>}
      {hint && <span className="truncate text-hint text-dim">{hint}</span>}
    </div>
  );
}

/**
 * The modal frame alone: overlay, centring, focus trap, Escape. `Dialog` below puts a title row and
 * padding inside it; a dialog with its own layout (Settings has a side nav) uses the shell directly
 * and renders `DialogTitle` itself.
 */
/** `stacked` raises a dialog over another open one, so its overlay dims the dialog underneath too. */
export function DialogShell({ open, onOpenChange, className, hasDescription, role, stacked, children }: { open: boolean; onOpenChange: (o: boolean) => void; className?: string; hasDescription?: boolean; role?: 'dialog' | 'alertdialog'; stacked?: boolean; children: React.ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn('fixed inset-0 bg-black/30 backdrop-blur-[2px] dark:bg-black/60', stacked ? 'z-[51]' : 'z-40')} />
        <DialogPrimitive.Content
          // Radix warns unless a dialog either has a Description or opts out with an explicit undefined.
          {...(hasDescription ? {} : { 'aria-describedby': undefined })}
          {...(role ? { role } : {})}
          // max-w keeps every dialog inside a phone-width window instead of running off the right edge.
          className={cn('fixed left-1/2 top-1/2 max-w-[calc(100vw-1.5rem)]', stacked ? 'z-[52]' : 'z-50', '-translate-x-1/2 -translate-y-1/2 rounded-xl bg-panel shadow-[var(--shadow-lg)] focus:outline-none', className)}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function DialogTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <DialogPrimitive.Title className={cn('text-title-sm', className)}>{children}</DialogPrimitive.Title>;
}

/** The dialog's description, read out with its title. Pair it with `hasDescription` on DialogShell. */
export function DialogDescription({ className, children }: { className?: string; children: React.ReactNode }) {
  return <DialogPrimitive.Description className={className}>{children}</DialogPrimitive.Description>;
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
    <DialogShell open={open} onOpenChange={onOpenChange} hasDescription={!!description} className={cn('max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain p-7', wide ? 'w-[720px]' : 'w-[520px]')}>
      <div className="mb-5 flex items-center justify-between">
        <DialogTitle>{title}</DialogTitle>
        <DialogCloseButton />
      </div>
      {description && <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>}
      {children}
    </DialogShell>
  );
}

export interface ConfirmOptions {
  /** The question, as the dialog's title: "Delete Scout?" */
  title: string;
  /** What happens, and what doesn't: "Chat history stays." */
  body?: React.ReactNode;
  /** A verb for what the button does ("Delete"), never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the confirm button uses the danger style. */
  danger?: boolean;
}

/**
 * The in-app stand-in for `window.confirm`: a small alert dialog with Cancel and one action. Cancel comes first, so
 * it takes the initial focus and Enter on a stray keypress never deletes anything. Controlled; for a one-line
 * "ask, then act", `confirmAction()` below is shorter.
 */
export function ConfirmDialog({ open, onOpenChange, onConfirm, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger }: ConfirmOptions & { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => void }) {
  return (
    // Stacked: it is often asked from inside another dialog (a bot's settings), and must sit over that one.
    <DialogShell open={open} onOpenChange={onOpenChange} hasDescription={!!body} role="alertdialog" stacked className="w-[420px] p-6">
      <DialogTitle>{title}</DialogTitle>
      {body && <DialogPrimitive.Description className="mt-2 text-ui leading-relaxed text-muted">{body}</DialogPrimitive.Description>}
      <div className="mt-6 flex justify-end gap-2">
        <DialogPrimitive.Close asChild><Button>{cancelLabel}</Button></DialogPrimitive.Close>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </DialogShell>
  );
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };
let askConfirm: ((p: PendingConfirm) => void) | null = null;

/**
 * Ask, then act: `if (!(await confirmAction({ title: 'Delete Scout?', confirmLabel: 'Delete', danger: true }))) return;`
 * Resolves true on the action, false on Cancel, Escape or a click outside. Needs `<ConfirmHost />` mounted once
 * (App does); without it the answer is false, so nothing destructive runs unasked.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (askConfirm) askConfirm({ ...options, resolve });
    else resolve(false);
  });
}

/** Renders whatever `confirmAction()` is asking. Mount once, near the root. */
export function ConfirmHost() {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);
  React.useEffect(() => {
    // A second question replaces the first, which counts as cancelled.
    askConfirm = (next) => setPending((cur) => { cur?.resolve(false); return next; });
    return () => { askConfirm = null; };
  }, []);
  if (!pending) return null;
  const { resolve, ...options } = pending;
  const answer = (ok: boolean) => { resolve(ok); setPending(null); };
  return <ConfirmDialog open {...options} onOpenChange={(o) => { if (!o) answer(false); }} onConfirm={() => answer(true)} />;
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
        'rounded-lg p-3.5 ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        checked ? 'bg-accent/8 ring-accent/50' : 'bg-card2/40 ring-line',
        disabled ? 'cursor-default' : 'cursor-pointer',
        !checked && !disabled && 'hover:bg-hover',
        !checked && disabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <RadioDot checked={checked} />
        <span id={titleId} className="text-ui font-medium">{title}</span>
        {badge}
      </div>
      {children && <div id={descriptionId} className="mt-1 pl-6 text-ui leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

/** On/off toggle. Name it with `aria-labelledby` (or `aria-label`) pointing at its caption. */
export function Switch({ checked, onChange, className, disabled, ...aria }: { checked: boolean; onChange: (next: boolean) => void; className?: string; disabled?: boolean; 'aria-labelledby'?: string; 'aria-label'?: string; 'aria-describedby'?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      {...aria}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-10 shrink-0 rounded-full transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-default disabled:opacity-60',
        checked ? 'bg-ink' : 'bg-card2 ring-1 ring-inset ring-faint',
        className,
      )}
    >
      {/* left-0 matters: without it the knob starts from the button's centred content position. */}
      <span aria-hidden className={cn('absolute left-0 top-0.5 h-5 w-5 rounded-full bg-panel shadow-[var(--shadow-sm)] transition-transform motion-reduce:transition-none', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

export const Tabs = TabsPrimitive.Root;
/** Segmented control, like a native toolbar. */
export function TabsList({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const lastActive = React.useRef<Element | null>(null);
  // In a narrow pane the strip scrolls, so bring the chosen tab into view. Only when it changes: this runs on
  // every parent render, and must not undo the user's own scrolling.
  React.useEffect(() => {
    const active = ref.current?.querySelector('[data-state="active"]') ?? null;
    if (active && active !== lastActive.current) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    lastActive.current = active;
  });
  return <TabsPrimitive.List ref={ref} className="mx-3 my-2 flex gap-0.5 overflow-x-auto rounded-md bg-card2 p-0.5">{children}</TabsPrimitive.List>;
}
export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Trigger value={value} className="flex-1 shrink-0 whitespace-nowrap rounded-sm px-1.5 py-1.5 text-label text-muted hover:text-fg data-[state=active]:bg-panel data-[state=active]:text-fg data-[state=active]:shadow-[var(--shadow-sm)]">
      {children}
    </TabsPrimitive.Trigger>
  );
}
export const TabsContent = TabsPrimitive.Content;

export const Menu = MenuPrimitive;
/** Stays in Radix's default modal mode: a click inside the screen's iframe never reaches this page, so a non-modal menu would stay open over it. */
export function MenuContent({ className, ...p }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return <MenuPrimitive.Content collisionPadding={8} sideOffset={4} className={cn('z-[55] max-h-[70dvh] overflow-y-auto rounded-lg bg-panel p-1.5 shadow-[var(--shadow-overlay)] ring-1 ring-line focus:outline-none', className)} {...p} />;
}
export function MenuItem({ className, ...p }: React.ComponentProps<typeof MenuPrimitive.Item>) {
  return <MenuPrimitive.Item className={cn('flex cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-ui outline-none data-[highlighted]:bg-hover', className)} {...p} />;
}
export function MenuSeparator() {
  return <MenuPrimitive.Separator className="mx-0.5 my-1 h-px bg-line" />;
}

export const STATE_LABEL: Record<BotState, string> = {
  idle: 'Idle', thinking: 'Thinking', working: 'Working', waiting: 'Waiting on a bot', blocked: 'Needs you', done: 'Done', error: 'Stopped with an error',
};

/** `state` draws the ring. Pass `label` when the words differ from the hub's state (see lib/botStatus.ts). */
export function Avatar({ bot, state, label, size = 36 }: { bot: Pick<Bot, 'id' | 'avatar' | 'name'>; state?: BotState; label?: string; size?: number }) {
  const cls = state && state !== 'idle' ? 'state-' + state : '';
  const { Glyph, tint } = botIcon(bot);
  const said = bot.name + (label ? ' · ' + label : state ? ' · ' + STATE_LABEL[state] : '');
  const src = useMediaUrl(bot.avatar);
  return (
    <div
      role="img"
      aria-label={said}
      className={cn('relative flex shrink-0 select-none items-center justify-center rounded-full text-fg', cls)}
      style={{ width: size, height: size, background: isMediaRef(bot.avatar) || (isBotIconKey(bot.avatar) && !isBotCharacterKey(bot.avatar)) ? tint : undefined }}
      title={said}
    >
      {isBotCharacterKey(bot.avatar)
        ? <BotCharacter character={bot.avatar} size={size} />
        : !isMediaRef(bot.avatar) && !isBotIconKey(bot.avatar)
          ? <AutoCharacter id={bot.id} size={size} />
          : <Face src={src}><Glyph aria-hidden size={Math.round(size * 0.5)} strokeWidth={1.75} /></Face>}
    </div>
  );
}

/** An uploaded picture filling its circle, or `children` while there is none or if it will not decode. */
function Face({ src, children }: { src: string | null; children: React.ReactNode }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (!src || broken === src) return <>{children}</>;
  return <img src={src} alt="" draggable={false} onError={() => setBroken(src)} className="h-full w-full rounded-full object-cover" />;
}

/** Your picture, or your initial on a neutral tint. Pass `settings.userName`; an empty name shows "Y" (you). */
export function UserAvatar({ name, avatar, size = 36 }: { name: string; avatar?: string; size?: number }) {
  const initial = (Array.from(name.trim())[0] ?? 'Y').toUpperCase();
  const src = useMediaUrl(avatar);
  return (
    <div aria-hidden className="flex shrink-0 select-none items-center justify-center rounded-full bg-card2 font-semibold text-fg ring-1 ring-line" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      <Face src={src}>{initial}</Face>
    </div>
  );
}

/** A group chat's picture or icon, or the plain group mark. `className` colors the mark; the room's name sits beside this. */
export function RoomAvatar({ room, size = 34, className }: { room: Pick<Room, 'id' | 'avatar'>; size?: number; className?: string }) {
  const src = useMediaUrl(room.avatar);
  const key = isBotIconKey(room.avatar) ? room.avatar : null;
  const { Glyph, tint } = botIcon({ id: room.id, avatar: key ?? '' });
  return (
    <span aria-hidden className={cn('flex shrink-0 select-none items-center justify-center rounded-full', !key && 'bg-card2', key ? 'text-fg' : className ?? 'text-muted')} style={{ width: size, height: size, background: key ? tint : undefined }}>
      {isBotCharacterKey(key)
        ? <BotCharacter character={key} size={size} />
        : <Face src={src}>{key ? <Glyph size={Math.round(size * 0.5)} strokeWidth={1.75} /> : <Hash size={Math.round(size * 0.45)} />}</Face>}
    </span>
  );
}

export function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'bad' | 'accent' }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-hint',
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
