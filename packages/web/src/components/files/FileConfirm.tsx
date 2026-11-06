// A stand-in for the ConfirmDialog primitive that PR "ui-scroll-responsive" adds to ui.tsx. Same props, so once that
// lands this file goes and `useConfirm` becomes its `confirmAction`.
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button, DialogShell, DialogTitle } from '../ui';

export interface ConfirmOptions {
  /** The question, as the dialog's title: "Delete report.pdf?" */
  title: string;
  /** What happens, and what doesn't. */
  body?: React.ReactNode;
  /** A verb for what the button does ("Delete"), never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the confirm button uses the danger style. */
  danger?: boolean;
}

/** Cancel comes first and takes the initial focus, so a stray Enter never deletes anything. */
export function ConfirmDialog({ open, onOpenChange, onConfirm, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger }: ConfirmOptions & { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => void }) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} hasDescription={!!body} className="w-[420px] p-6">
      <DialogTitle>{title}</DialogTitle>
      {body && <DialogPrimitive.Description className="mt-2 text-ui leading-relaxed text-muted">{body}</DialogPrimitive.Description>}
      <div className="mt-6 flex justify-end gap-2">
        <DialogPrimitive.Close asChild><Button>{cancelLabel}</Button></DialogPrimitive.Close>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </DialogShell>
  );
}

/**
 * Ask, then act: `if (!(await ask({ title: 'Delete x?', confirmLabel: 'Delete', danger: true }))) return;`. Render
 * `element` once. A second question replaces the first, which counts as cancelled.
 */
export function useConfirm(): [React.ReactNode, (o: ConfirmOptions) => Promise<boolean>] {
  const [pending, setPending] = React.useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const ask = React.useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending((cur) => { cur?.resolve(false); return { ...o, resolve }; });
  }), []);
  // Unmounted mid-question (the panel closed): the answer is no.
  const ref = React.useRef(pending);
  ref.current = pending;
  React.useEffect(() => () => ref.current?.resolve(false), []);
  if (!pending) return [null, ask];
  const { resolve, ...options } = pending;
  const answer = (ok: boolean) => { resolve(ok); setPending(null); };
  return [<ConfirmDialog key="confirm" open {...options} onOpenChange={(o) => { if (!o) answer(false); }} onConfirm={() => answer(true)} />, ask];
}
