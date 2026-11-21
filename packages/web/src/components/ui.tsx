import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { clsx } from 'clsx';
import { CircleAlert, Hash, Info, TriangleAlert, X } from 'lucide-react';
import { isBotCharacterKey, isBotIconKey, isMediaRef } from '@pocketrocket/shared';
import { AutoCharacter, BotCharacter } from '../lib/botCharacter';
import type { Bot, BotState, Room } from '@pocketrocket/shared';
import { botIcon } from '../lib/botIcon';
import { useMediaUrl } from '../lib/media';
import { useNewLayout } from '../lib/newLayout';

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
        // Press feedback: a small, quick scale (Emil). Off under reduced motion; colours still change.
        'transition-[transform,opacity,background-color,color,filter] duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100',
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
      {/* Wraps under itself rather than being cut off when the caption is long or the dialog narrow. */}
      {hint && <span className="min-w-0 text-right text-hint text-dim">{hint}</span>}
    </div>
  );
}

/**
 * The modal frame alone: overlay, centring, focus trap, Escape. `Dialog` below puts a title row and
 * padding inside it; a dialog with its own layout (Settings has a side nav) uses the shell directly
 * and renders `DialogTitle` itself.
 */
/** `stacked` raises a dialog over another open one, so its overlay dims the dialog underneath too. */
/**
 * New layout: `pr-sheet` makes the dialog a sheet pulled up from the bottom on a phone-width window (index.css), the
 * native place for it under a thumb. Same content, focus trap, Escape and focus return; no added motion.
 */
export function DialogShell({ open, onOpenChange, className, hasDescription, role, stacked, children }: { open: boolean; onOpenChange: (o: boolean) => void; className?: string; hasDescription?: boolean; role?: 'dialog' | 'alertdialog'; stacked?: boolean; children: React.ReactNode }) {
  const sheet = useNewLayout();
  // Our dialogs open from the store, not a Radix Trigger, so Radix's own focus return has nothing to go back to and
  // lands on <body>. Remember what had focus when the dialog opened and go back there on close, if it is still on
  // the page (a menu item that opened the dialog is gone by then; its menu already put focus on the menu button).
  const returnTo = React.useRef<HTMLElement | null>(null);
  if (open && !returnTo.current && typeof document !== 'undefined') returnTo.current = document.activeElement as HTMLElement | null;
  const onCloseAutoFocus = (e: Event) => {
    const el = returnTo.current;
    returnTo.current = null;
    if (el && el.isConnected && el !== document.body) { e.preventDefault(); el.focus({ preventScroll: true }); }
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn('pr-scrim fixed inset-0 bg-scrim backdrop-blur-[2px]', stacked ? 'z-[51]' : 'z-40')} />
        <DialogPrimitive.Content
          // Radix warns unless a dialog either has a Description or opts out with an explicit undefined.
          {...(hasDescription ? {} : { 'aria-describedby': undefined })}
          {...(role ? { role } : {})}
          onCloseAutoFocus={onCloseAutoFocus}
          // max-w keeps every dialog inside a phone-width window instead of running off the right edge.
          className={cn('fixed left-1/2 top-1/2 max-w-[calc(100vw-1.5rem)]', stacked ? 'z-[52]' : 'z-50', 'pr-dialog -translate-x-1/2 -translate-y-1/2 rounded-xl bg-panel shadow-[var(--shadow-lg)] focus:outline-none', className, sheet && 'pr-sheet')}
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
type TabsVariant = 'segmented' | 'underline';
const TabsVariantContext = React.createContext<TabsVariant>('segmented');
/**
 * Segmented control, like a native toolbar. `underline` is the quieter strip for a header (Chat | Map): plain labels
 * with a 2px accent bar under the chosen one; the caller places it, so it brings no margin of its own.
 */
export function TabsList({ children, variant = 'segmented', className }: { children: React.ReactNode; variant?: TabsVariant; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const lastActive = React.useRef<Element | null>(null);
  // In a narrow pane the strip scrolls, so bring the chosen tab into view. Only when it changes: this runs on
  // every parent render, and must not undo the user's own scrolling.
  React.useEffect(() => {
    const active = ref.current?.querySelector('[data-state="active"]') ?? null;
    if (active && active !== lastActive.current) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    lastActive.current = active;
  });
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List ref={ref} className={cn(variant === 'underline' ? 'flex gap-5 overflow-x-auto' : 'mx-3 my-2 flex gap-0.5 overflow-x-auto rounded-md bg-card2 p-0.5', className)}>{children}</TabsPrimitive.List>
    </TabsVariantContext.Provider>
  );
}
/**
 * `id` and `controls`: for tabs whose panels live outside the Tabs root (the project header's Chat | Map), so the tab
 * points at the real panel instead of a TabsContent that is never drawn.
 */
export function TabsTrigger({ value, children, id, controls }: { value: string; children: React.ReactNode; id?: string; controls?: string }) {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      value={value}
      {...(id ? { id } : {})}
      {...(controls ? { 'aria-controls': controls } : {})}
      className={variant === 'underline'
        ? 'relative shrink-0 whitespace-nowrap py-2 text-ui text-muted hover:text-fg focus-visible:rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent'
        : 'flex-1 shrink-0 whitespace-nowrap rounded-sm px-1.5 py-1.5 text-label text-muted hover:text-fg data-[state=active]:bg-panel data-[state=active]:text-fg data-[state=active]:shadow-[var(--shadow-sm)]'}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}
export const TabsContent = TabsPrimitive.Content;

export const Menu = MenuPrimitive;
/** Stays in Radix's default modal mode: a click inside the screen's iframe never reaches this page, so a non-modal menu would stay open over it. */
export function MenuContent({ className, ...p }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return <MenuPrimitive.Content collisionPadding={8} sideOffset={4} className={cn('pr-pop z-[55] max-h-[70dvh] overflow-y-auto rounded-lg bg-panel p-1.5 shadow-[var(--shadow-overlay)] ring-1 ring-line focus:outline-none', className)} {...p} />;
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

/** `needs` looks like `warn` but names the role: a count of things waiting on the owner (docs/specs/toki-ui.md). */
export function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'needs' | 'bad' | 'accent' }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-hint',
        tone === 'muted' && 'bg-card2 text-muted',
        tone === 'ok' && 'bg-ok/12 text-ok',
        tone === 'warn' && 'bg-warn/12 text-warn',
        tone === 'needs' && 'bg-needs/12 text-needs',
        tone === 'bad' && 'bg-bad/12 text-bad',
        tone === 'accent' && 'bg-accent/12 text-accent',
      )}
    >
      {children}
    </span>
  );
}

/**
 * How full something is: a plan window now, the context window later. A 6 px bar with the percentage and `detail`
 * (a reset time) always written out, so colour is never the only cue. The fill is the accent below 80 %, warn from
 * 80 %, bad at the limit (`atLimit`, or 100 %). Screen readers get `role="meter"` and one sentence:
 * "Claude 5-hour limit 82%, resets 14:00".
 */
/** `marker`: a tick on the bar at `value` percent (e.g. where a session rotates); its `label` is read after the value. */
/** `size="thin"`: a 3 px bar, for a quiet row of meters (the sidebar's foot). */
export function Meter({ label, value, detail, atLimit, marker, size = 'md', className }: { label: string; value: number; detail?: string | null; atLimit?: boolean; marker?: { value: number; label: string }; size?: 'md' | 'thin'; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const full = atLimit || pct >= 100;
  const fill = full ? 'bg-bad' : pct >= 80 ? 'bg-warn' : 'bg-accent';
  const text = pct + '%' + (detail ? ', ' + detail : '') + (marker ? '; ' + marker.label : '');
  const tick = marker ? Math.max(0, Math.min(100, marker.value)) : null;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={label + ' ' + text} className={cn('flex flex-col gap-1.5', className)}>
      <div aria-hidden className="flex items-baseline justify-between gap-3 text-hint">
        <span className="min-w-0 truncate font-medium text-fg">{label}</span>
        <span className="shrink-0 text-muted">
          <span className={cn('font-mono', full && 'font-semibold text-fg')}>{pct}%</span>
          {detail && <> · {detail}</>}
        </span>
      </div>
      <div aria-hidden className={cn('relative overflow-hidden rounded-full bg-line', size === 'thin' ? 'h-[3px]' : 'h-1.5')}>
        <div className={cn('h-full rounded-full', fill)} style={{ width: pct + '%' }} />
        {tick != null && <div data-meter-marker title={marker!.label} className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-muted" style={{ left: tick + '%' }} />}
      </div>
    </div>
  );
}

export function fmtUsd(n: number) {
  return '$' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
}
export function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const BANNER_TONE = {
  info: { icon: Info, box: 'bg-accent/10 ring-accent/25', glyph: 'text-accent' },
  warn: { icon: TriangleAlert, box: 'bg-warn/10 ring-warn/30', glyph: 'text-warn' },
  error: { icon: CircleAlert, box: 'bg-bad/10 ring-bad/30', glyph: 'text-bad' },
} as const;

/**
 * An inline notice that stays in the layout (unlike a toast). Text is always --fg on a faint tint, so contrast
 * does not depend on the tone; the tone shows in the icon and ring. `error` is an assertive live region
 * (role="alert"), `info` and `warn` are polite (role="status"). Pass `role` to override.
 */
export function Banner({ tone = 'info', title, children, action, onDismiss, dismissLabel = 'Dismiss', role, className }: {
  tone?: 'info' | 'warn' | 'error';
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: 'status' | 'alert' | 'none';
  className?: string;
}) {
  const t = BANNER_TONE[tone];
  const Icon = t.icon;
  return (
    <div role={role === 'none' ? undefined : (role ?? (tone === 'error' ? 'alert' : 'status'))} className={cn('flex items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1', t.box, className)}>
      <Icon size={16} aria-hidden className={cn('mt-0.5 shrink-0', t.glyph)} />
      <div className="min-w-0 flex-1 text-ui text-fg">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(!!title && 'mt-0.5 text-muted')}>{children}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      {onDismiss && (
        <Button size="icon" variant="ghost" aria-label={dismissLabel} onClick={onDismiss} className="-my-1 -mr-1.5 shrink-0">
          <X size={14} aria-hidden />
        </Button>
      )}
    </div>
  );
}

const ACTION_RING = { quiet: 'ring-line', warn: 'ring-warn/60', 'warn-soft': 'ring-warn/40', danger: 'ring-bad/40' } as const;

/**
 * The shell of a card in the chat that waits for a person: approval, takeover, form, workflow approval. `tone` is
 * the ring: `warn` while it needs you (`warn-soft` for the lighter tool approval), `danger` for a risky one, `quiet`
 * once answered. `ActionCardHeader` and `ActionCardActions` carry the shared padding.
 */
/**
 * `edge` adds a 3 px left border: `needs` while the card waits on the owner, `done` (a hairline colour) once answered.
 * For the overview and Needs-you cards, which sit in a list rather than in the transcript.
 */
export function ActionCard({ tone = 'quiet', edge, className, children, ...p }: React.ComponentProps<'div'> & { tone?: keyof typeof ACTION_RING; edge?: 'needs' | 'done' }) {
  return <div {...p} className={cn('overflow-hidden rounded-lg ring-1', ACTION_RING[tone], edge && 'border-l-[3px]', edge === 'needs' && 'border-needs', edge === 'done' && 'border-line', className)}>{children}</div>;
}

/** The title row. `compact` is the one-line tool-approval header (icon first); the default wraps and reads as body text. */
export function ActionCardHeader({ icon, meta, compact, children }: { icon?: React.ReactNode; meta?: React.ReactNode; compact?: boolean; children: React.ReactNode }) {
  return compact ? (
    <div className="flex items-center gap-2 px-4 pt-3 text-ui">{icon}{children}{meta}</div>
  ) : (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1 px-4 pt-3 text-body">{icon}{children}{meta}</div>
  );
}

/** The button row at the foot of an open card; wraps on a phone, targets grow to 44px through `.touch-target`. */
export function ActionCardActions({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex flex-wrap gap-2 px-4 pb-4', className)}>{children}</div>;
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;
/**
 * Anchored panel for small forms and detail (a menu is for commands, a dialog is for tasks). Non-modal:
 * Escape and an outside click close it, focus moves in on open and back to the trigger on close. It is
 * portaled, so it never shifts the layout; z-[65] puts it above dialogs (50) and onboarding (60).
 */
export function PopoverContent({ className, ...p }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        collisionPadding={8}
        sideOffset={6}
        className={cn('pr-pop z-[65] w-72 max-w-[calc(100vw-1rem)] rounded-xl bg-panel p-3 text-ui text-fg shadow-[var(--shadow-overlay)] ring-1 ring-line focus:outline-none', className)}
        {...p}
      />
    </PopoverPrimitive.Portal>
  );
}

/** Wrap a group of tooltips once (App level) so moving between neighbours skips the open delay. Optional: `Tooltip` works alone. */
export const TooltipProvider = TooltipPrimitive.Provider;
/**
 * A short, non-interactive label for a control that shows on hover and on keyboard focus (not on touch) and
 * closes on Escape or blur. It is a description, not a name: an icon-only button still needs `aria-label`.
 * `content` must be plain text; put anything interactive in a Popover. There is no enter or exit animation,
 * so nothing changes under prefers-reduced-motion, and the bubble is portaled so it cannot shift layout.
 */
export function Tooltip({ content, children, side = 'top', delay = 400 }: { content: React.ReactNode; children: React.ReactElement; side?: 'top' | 'right' | 'bottom' | 'left'; delay?: number }) {
  if (content == null || content === false || content === '') return children;
  return (
    <TooltipPrimitive.Provider delayDuration={delay} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content side={side} sideOffset={6} collisionPadding={8} className="z-[70] max-w-[min(20rem,calc(100vw-1rem))] rounded-md bg-ink px-2 py-1 text-hint text-ink-fg shadow-[var(--shadow-overlay)]">
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/** A key cap for shortcut hints: `<Kbd>Esc</Kbd>`, or `<Kbd>Ctrl</Kbd> <Kbd>K</Kbd>` for a chord. Plain `<kbd>`, so screen readers say the text. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex min-w-5 items-center justify-center rounded-xs bg-card2 px-1.5 py-px font-mono text-hint text-muted ring-1 ring-line', className)}>{children}</kbd>;
}

/** Placeholder for a list or pane with nothing in it. `icon` is decorative (hidden from assistive tech); `title` carries the meaning. */
/** `size="lg"`: the dialog-title size, for an empty state that fills a whole pane (no chat open). */
export function EmptyState({ icon, title, children, action, as: Title = 'div', size = 'md', className }: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  as?: 'div' | 'h2' | 'h3' | 'h4';
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-1 px-6 py-10 text-center', className)}>
      {icon && <div aria-hidden className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-card2 text-muted">{icon}</div>}
      <Title className={cn(size === 'lg' ? 'text-title-sm' : 'text-ui font-semibold', 'text-fg')}>{title}</Title>
      {children && <p className="max-w-[40ch] text-ui text-muted">{children}</p>}
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * A section's heading row in a list (the sidebar's "Projects", an overview section): quiet label, optional count, and
 * an optional control at the end. `as` picks the heading level; the default is a plain div.
 */
export function SectionLabel({ children, count, aside, as: Tag = 'div', id, className }: {
  children: React.ReactNode;
  count?: number;
  aside?: React.ReactNode;
  as?: 'div' | 'h2' | 'h3' | 'h4';
  id?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-6 items-center gap-1.5 px-3 text-label text-dim', className)}>
      <Tag id={id} className="min-w-0 truncate text-label">{children}</Tag>
      {count != null && <span className="font-mono text-hint">{count}</span>}
      {aside && <span className="ml-auto flex shrink-0 items-center">{aside}</span>}
    </div>
  );
}

/**
 * A 28 px pill naming one thing: a map node, a room. `leading` is an avatar or dot; `onRemove` adds an × whose
 * accessible name is "Remove <label>". Plain text only, never a link.
 */
export function Chip({ children, label, leading, onRemove, className }: {
  children: React.ReactNode;
  /** What the remove button says it removes; defaults to the text when that is a string. */
  label?: string;
  leading?: React.ReactNode;
  onRemove?: () => void;
  className?: string;
}) {
  const name = label ?? (typeof children === 'string' ? children : 'item');
  return (
    <span className={cn('inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 rounded-full bg-card2 text-label text-fg', leading ? 'pl-1' : 'pl-2.5', onRemove ? 'pr-1' : 'pr-2.5', className)}>
      {leading}
      <span className="min-w-0 truncate">{children}</span>
      {onRemove && (
        <button type="button" aria-label={'Remove ' + name} onClick={onRemove} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** Where a project's plan stands: `done` of `total` boxes ticked, under the heading `stage`. Null means no plan yet. */
export interface StagePlan { done: number; total: number; stage: string | null }

/**
 * A project's progress as a row of small bars (done, current, next), then the stage and `done/total`, or "No plan
 * yet". The bars are a picture of the numbers, which are always written out; screen readers get one sentence.
 */
/** `wrap`: the stage name may wrap under a narrow header instead of being cut off. */
export function StagePips({ plan, pips = 5, wrap = false, className }: { plan: StagePlan | null; pips?: number; wrap?: boolean; className?: string }) {
  if (!plan || plan.total <= 0) return <span className={cn('text-hint text-dim', className)}>No plan yet</span>;
  const done = Math.max(0, Math.min(plan.total, plan.done));
  const filled = done >= plan.total ? pips : Math.min(pips - 1, Math.floor((done / plan.total) * pips));
  const said = (plan.stage ? plan.stage + ', ' : '') + done + ' of ' + plan.total + ' done';
  return (
    <span role="img" aria-label={said} className={cn('inline-flex min-w-0 items-center gap-2 text-hint text-muted', className)}>
      <span aria-hidden className="flex shrink-0 gap-[3px]">
        {Array.from({ length: pips }, (_, i) => (
          <span key={i} className={cn('h-1 w-3.5 rounded-full', i < filled ? 'bg-line2' : i === filled ? 'bg-accent' : 'bg-line')} />
        ))}
      </span>
      <span aria-hidden className={wrap ? 'min-w-0 [overflow-wrap:anywhere]' : 'min-w-0 truncate'}>
        {plan.stage && <>{plan.stage} · </>}<span className="font-mono">{done}/{plan.total}</span>
      </span>
    </span>
  );
}

/**
 * A 40 px square icon button for a rail (the overview's icons). `label` is its accessible name and tooltip; `pressed`
 * marks the open pane; `count` shows in the corner, in the needs colour when `needs` (things waiting on the owner).
 */
export function IconRailButton({ icon, label, pressed, count, needs, onClick }: {
  icon: React.ReactNode;
  label: string;
  pressed?: boolean;
  count?: number;
  needs?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label} side="left">
      <button
        type="button"
        aria-label={count ? label + ', ' + count : label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn('relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', pressed && 'bg-active text-fg')}
      >
        {icon}
        {!!count && (
          <span aria-hidden className={cn('absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-center font-mono text-hint leading-4', needs ? 'bg-needs text-on-fill' : 'bg-card2 text-muted ring-1 ring-line')}>{count}</span>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * One loading placeholder shape: size and radius come from `className` (`h-3 w-24`, `h-8 w-8 rounded-full`).
 * Pulses only when motion is allowed. Hidden from assistive tech; wrap a group in `SkeletonGroup` to announce loading once.
 */
export function Skeleton({ className, ...p }: React.ComponentProps<'span'>) {
  return <span aria-hidden className={cn('block rounded-full bg-card2 motion-safe:animate-pulse', className)} {...p} />;
}
/** The accessible shell for a set of Skeletons: a polite status with a visually hidden label. */
export function SkeletonGroup({ label = 'Loading…', className, children }: { label?: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden>{children}</div>
    </div>
  );
}
