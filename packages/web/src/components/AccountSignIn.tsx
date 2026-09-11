/**
 * Sign-in for the optional PocketRocket account, shared by Settings › Account and the onboarding
 * "Create an account" step. It covers the two states before you are signed in:
 *   - signed out: an email field ("Email me a sign-in link"), plus Google/GitHub when the hub has them on
 *     (after either button, a local "finish in your browser" state with Cancel);
 *   - waiting (`account.pendingEmail` set): the code from the email, resend, or start over.
 * The signed-in and "accounts not available" views belong to the parent. Every answer goes through
 * `store.applyAccountResponse`, and the hub's `account.changed` event keeps state live, so this
 * component never guesses what the next state is — it renders whatever the store says.
 */
import { useId, useState, type FormEvent } from 'react';
import { Github } from 'lucide-react';
import { useStore } from '../store';
import { ApiError, api } from '../lib/api';
import { Button, Field, Input, Label } from './ui';
import { InlineError } from './settings/parts';

/** The emailed one-time code is 6 to 10 digits depending on the account project's settings. */
const CODE_MIN = 6;
const CODE_MAX = 10;

type OAuthProvider = 'google' | 'github';
const OAUTH_LABEL: Record<OAuthProvider, string> = { google: 'Google', github: 'GitHub' };

/**
 * Turns a failed call into a sentence for the user; the hub's own error text is already plain.
 * A 409 means our picture is out of date (already signed in, or sign-in not set up here), so the
 * account state is refetched and the view corrects itself.
 */
function messageOf(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) void useStore.getState().fetchAccount();
  if (err instanceof ApiError && err.status === 404) return "Sign-in isn't available right now. Try again later.";
  return err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.';
}

export function AccountSignIn({ autoFocus }: { /** Focus the email field on mount (onboarding). */ autoFocus?: boolean }) {
  const pendingEmail = useStore((s) => s.account.pendingEmail);
  // After "Use a different email" the code form unmounts; putting focus back in the email field keeps
  // keyboard and screen reader users from being dropped at the top of the page.
  const [focusEmail, setFocusEmail] = useState(!!autoFocus);
  return pendingEmail
    ? <CodeForm email={pendingEmail} onCancelled={() => setFocusEmail(true)} />
    : <EmailForm autoFocus={focusEmail} />;
}

function EmailForm({ autoFocus }: { autoFocus: boolean }) {
  const oauth = useStore((s) => s.account.oauth);
  const applyAccountResponse = useStore((s) => s.applyAccountResponse);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'link' | OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set while the Google/GitHub page is open in the browser. Local only: the hub keeps no pending state
  // for OAuth, and when the sign-in completes this whole form is replaced by the signed-in view.
  const [oauthWait, setOauthWait] = useState<{ provider: OAuthProvider; url: string } | null>(null);
  const errorId = useId();

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address || busy) return;
    setBusy('link');
    setError(null);
    try {
      applyAccountResponse(await api.account.magicLink(address));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const continueWith = async (provider: OAuthProvider) => {
    setBusy(provider);
    setError(null);
    try {
      const { url } = await api.account.oauth(provider);
      setOauthWait({ provider, url });
      // The provider's page runs in the browser; when it redirects back, the hub finishes the sign-in and
      // sends `account.changed`, which flips this view to signed in on its own.
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  if (oauthWait) {
    return (
      <div>
        {/* role="status" on the sentence only, so a screen reader announces it without reading the buttons. */}
        <p role="status" className="text-[13px] leading-relaxed text-fg">
          Finish signing in with {OAUTH_LABEL[oauthWait.provider]} in your browser. This page updates by itself.
        </p>
        <div className="-ml-3 mt-2 flex flex-wrap">
          {/* A real link as the fallback: window.open can be blocked, a click on a link can't. */}
          <a
            href={oauthWait.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center rounded-full px-3 text-[12.5px] font-medium text-accent hover:bg-card2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Open the sign-in page again
          </a>
          <Button size="sm" variant="ghost" autoFocus onClick={() => setOauthWait(null)}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <form onSubmit={sendLink} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field className="min-w-0 flex-1">
          <Label>Email</Label>
          <Input
            type="email"
            autoComplete="email"
            required
            autoFocus={autoFocus}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? errorId : undefined}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!email.trim() || busy !== null}>
          {busy === 'link' ? 'Sending…' : 'Email me a sign-in link'}
        </Button>
      </form>

      {(oauth.google || oauth.github) && (
        <>
          <div className="my-3 flex items-center gap-3 text-[11.5px] text-dim" aria-hidden>
            <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
          </div>
          {/* flex-1 only side by side: in a column it would set the height basis to 0 and squash the buttons. */}
          <div className="flex flex-col gap-2 sm:flex-row">
            {oauth.google && (
              <Button className="sm:flex-1" disabled={busy !== null} onClick={() => void continueWith('google')}>
                <GoogleMark />
                {busy === 'google' ? 'Opening…' : 'Continue with Google'}
              </Button>
            )}
            {oauth.github && (
              <Button className="sm:flex-1" disabled={busy !== null} onClick={() => void continueWith('github')}>
                <Github size={15} aria-hidden />
                {busy === 'github' ? 'Opening…' : 'Continue with GitHub'}
              </Button>
            )}
          </div>
        </>
      )}

      {error && <InlineError id={errorId}>{error}</InlineError>}
    </div>
  );
}

function CodeForm({ email, onCancelled }: { email: string; onCancelled: () => void }) {
  const applyAccountResponse = useStore((s) => s.applyAccountResponse);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'verify' | 'resend' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const errorId = useId();

  /** Runs one account call with the busy flag and inline error handled the same way every time. */
  const run = async (kind: 'verify' | 'resend' | 'cancel', call: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await call();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const codeComplete = code.length >= CODE_MIN && code.length <= CODE_MAX;

  // No auto-submit on the last digit: the code's length varies (6–10), so there is no "last" digit to
  // detect. Enter or the button submits.
  const verify = () => {
    if (!codeComplete) return;
    void run('verify', async () => applyAccountResponse(await api.account.verify(email, code)));
  };

  return (
    <div>
      <p className="text-[13px] leading-relaxed text-fg">
        Check <strong className="font-semibold">{email}</strong>. Click the link, or enter the code from the email.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); verify(); }} className="mt-3 flex items-end gap-2">
        <Field>
          <Label>Code</Label>
          <Input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            // Digits only; spaces and dashes a user pastes along with the code are dropped as they type.
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_MAX)); setError(null); }}
            placeholder="123456"
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            className="w-40 text-center font-mono text-[15px] tracking-[0.2em]"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!codeComplete || busy !== null}>
          {busy === 'verify' ? 'Checking…' : 'Sign in'}
        </Button>
      </form>
      <div className="-ml-3 mt-2 flex flex-wrap">
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('resend', async () => {
          applyAccountResponse(await api.account.magicLink(email));
          setNotice('Sent. Use the code from the newest email.');
        })}>
          {busy === 'resend' ? 'Sending…' : 'Resend email'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('cancel', async () => {
          applyAccountResponse(await api.account.cancel());
          onCancelled();
        })}>
          Use a different email
        </Button>
      </div>
      {notice && <p role="status" className="mt-1 text-[12px] text-ok">{notice}</p>}
      {error && <InlineError id={errorId}>{error}</InlineError>}
    </div>
  );
}

/** Google's four-colour "G". Brand marks aren't in lucide, and the official colours are the point. */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" width="15" height="15">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}
