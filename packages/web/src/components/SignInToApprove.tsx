/**
 * The approve side of a card only a password-signed-in browser may allow (run_on_pc, `signInRequired`). The hub
 * token and a paired phone may still deny it; the card keeps its Deny button. Signing in sets the session
 * cookie, and the socket is reconnected so the hub's next `hello` says `signedIn` and the card offers Allow.
 */
import { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { reconnectWsNow } from '../lib/ws';
import { useStore } from '../store';
import { Button, Dialog, Field, Input, Label } from './ui';
import { InlineError } from './settings/parts';

/** Whether the owner has a password yet. Asked again when a dialog closes, since Settings is where it gets set. */
function usePasswordSet(): boolean | null {
  const dialogOpen = useStore((s) => s.dialog !== null);
  const [set, setSet] = useState<boolean | null>(null);
  useEffect(() => {
    if (dialogOpen) return;
    let live = true;
    api.auth.status().then((r) => { if (live) setSet(r.passwordSet); }, () => undefined);
    return () => { live = false; };
  }, [dialogOpen]);
  return set;
}

export function SignInToApprove() {
  const passwordSet = usePasswordSet();
  const openDialog = useStore((s) => s.openDialog);
  const [open, setOpen] = useState(false);
  if (passwordSet === null) return null;
  if (!passwordSet) {
    return (
      <>
        <Button size="sm" variant="primary" className="touch-target" onClick={() => openDialog({ kind: 'settings', section: 'security' })}>
          Open Security settings
        </Button>
        {/* Below the row: the flex row wraps, and Deny stays next to this button. */}
        <span className="order-last basis-full text-hint text-muted">Set a password in Settings → Security first. Only a browser signed in with it can approve a job on your PC.</span>
      </>
    );
  }
  return (
    <>
      <Button size="sm" variant="primary" className="touch-target" onClick={() => setOpen(true)}>
        <KeyRound size={13} aria-hidden /> Sign in to approve
      </Button>
      <span className="order-last basis-full text-hint text-muted">Approving a job on your PC needs this browser signed in with your password.</span>
      {open && <SignInDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SignInDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.login(password);
      setPassword('');
      // The hub reads the session from the socket's upgrade request, so only a new socket carries it.
      reconnectWsNow();
      onClose();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError(status === 429 ? 'Too many tries. Wait a minute.' : status === 403 ? 'Wrong password.' : (e as Error).message);
      setBusy(false);
      input.current?.select();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Sign in to approve" description="Enter your PocketRocket password to approve jobs on your PC.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-ui leading-relaxed text-muted">A job on your PC needs this browser to be signed in with your password. The server token is not enough.</p>
        <Field>
          <Label htmlFor="approve-password">Password</Label>
          <Input
            ref={input}
            id="approve-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? 'approve-error' : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <InlineError id="approve-error">{error}</InlineError>}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!password || busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
