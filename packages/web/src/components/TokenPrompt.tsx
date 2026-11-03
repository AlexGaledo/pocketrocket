import { useEffect, useState } from 'react';
import { getNeedsToken, getPairError, redeemPairingCode, setToken, subscribeAuthFailure, wasUnpaired } from '../lib/auth';
import { probeHub, reconnectWsNow } from '../lib/ws';
import { useStore } from '../store';
import { Button, Input } from './ui';

/**
 * The hub always requires a token. When it rejects the one this page holds (lib/ws.ts has confirmed a real
 * 401, not a hub that is down or rate-limiting), this small centered panel asks for it instead of leaving
 * the app stuck on "Connecting to the hub".
 */
export function TokenPrompt() {
  const [needsToken, setNeedsToken] = useState(getNeedsToken());
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Null until the hub answers. With a password set, sign-in is the main way in and the token the fallback.
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  const [choice, setChoice] = useState<'password' | 'code' | null>(null);
  useEffect(() => subscribeAuthFailure(() => setNeedsToken(getNeedsToken())), []);
  useEffect(() => {
    if (!needsToken) return;
    // A hub that is restarting or rate limiting says nothing about the password, so keep asking.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const load = () => {
      fetch('/api/auth/status', { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<{ passwordSet?: boolean }>;
        })
        .then((j) => { if (!stopped) setPasswordSet(!!j.passwordSet); })
        .catch(() => { if (!stopped) timer = setTimeout(load, 5000); });
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [needsToken]);

  if (!needsToken) return null;
  // P9: a phone has no hub token to paste; it pairs.
  const pairingTrouble = wasUnpaired() || !!getPairError();
  const signIn = passwordSet === true && (choice ? choice === 'password' : !pairingTrouble);
  const pairing = pairingTrouble && !signIn;

  const submitPassword = async () => {
    if (!value || checking) return;
    setChecking(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: value }) });
      if (r.status === 429) return setError('Too many tries. Wait a minute.');
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return setError(j.error ?? "Couldn't sign in.");
      }
      setNeedsToken(false);
      setValue('');
      reconnectWsNow();
      void useStore.getState().refresh().catch(() => undefined);
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setChecking(false);
    }
  };

  // The token is tried before it is kept: the panel stays up saying "Checking…", and a wrong one gets an
  // answer here instead of closing the panel only for it to pop back a few seconds later.
  const submit = async () => {
    const t = value.trim();
    if (!t || checking) return;
    setChecking(true);
    setError(null);
    // P9: an 8-character pairing code (ABCD-EFGH) from the desktop's Settings › Devices pairs this browser.
    const code = t.replace(/[\s-]/g, '').toUpperCase();
    if (/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
      const ok = await redeemPairingCode(code);
      setChecking(false);
      if (!ok) return setError(getPairError());
      setNeedsToken(false);
      setValue('');
      reconnectWsNow();
      void useStore.getState().refresh().catch(() => undefined);
      return;
    }
    const probe = await probeHub(t);
    setChecking(false);
    if (probe.result === 'auth') return setError("Token rejected. Check you copied it all.");
    if (probe.result === 'rateLimited') {
      return setError('Too many tries. Wait ' + Math.ceil(probe.retryInMs / 1000) + ' seconds.');
    }
    if (probe.result === 'unreachable') return setError("Couldn't reach the server. " + probe.detail);
    setToken(t);
    setNeedsToken(false);
    setValue('');
    reconnectWsNow();
    void useStore.getState().refresh().catch(() => undefined);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="token-prompt-title" className="w-[380px] max-w-full rounded-lg bg-card p-5 text-ui shadow-[var(--shadow-lg)]">
        {signIn ? (
          <>
            <div id="token-prompt-title" className="mb-3 text-title-sm">Sign in</div>
          </>
        ) : pairing ? (
          <>
            <div id="token-prompt-title" className="mb-1 text-title-sm">{wasUnpaired() ? 'This device was unpaired' : "Couldn't pair this device"}</div>
            <p className="mb-3 text-muted">
              {getPairError() ?? ''} Re-pair from desktop: Settings › Devices.
            </p>
          </>
        ) : (
          <>
            <div id="token-prompt-title" className="mb-1 text-title-sm">Paste the server token</div>
            <p className="mb-3 text-muted" title="Saved in <data>/hub-token unless POCKETROCKET_TOKEN is set. Pairing codes come from Settings › Devices.">
              Shown in server startup output. Pairing codes work.
            </p>
          </>
        )}
        <Input
          autoFocus
          aria-label={signIn ? 'Password' : pairing ? 'Pairing code' : 'Server token'}
          type={signIn ? 'password' : 'text'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'token-prompt-error' : undefined}
          placeholder={signIn ? 'Password' : pairing ? 'ABCD-EFGH' : 'server token or pairing code'}
          autoCapitalize={pairing ? 'characters' : 'off'}
          autoComplete={signIn ? 'current-password' : 'off'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void (signIn ? submitPassword() : submit());
          }}
        />
        {error && (
          <p id="token-prompt-error" role="alert" className="mt-2 text-ui text-bad">
            {error}
          </p>
        )}
        <Button className="mt-3 w-full" onClick={() => void (signIn ? submitPassword() : submit())} disabled={checking || !value.trim()}>
          {checking ? 'Checking…' : signIn ? 'Sign in' : pairing ? 'Pair' : 'Connect'}
        </Button>
        {passwordSet && (
          <Button
            variant="ghost"
            className="mt-1 w-full"
            onClick={() => {
              setChoice(signIn ? 'code' : 'password');
              setValue('');
              setError(null);
            }}
          >
            {signIn ? 'Use server token or pairing code' : 'Use password'}
          </Button>
        )}
      </div>
    </div>
  );
}
