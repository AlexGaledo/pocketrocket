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
  useEffect(() => subscribeAuthFailure(() => setNeedsToken(getNeedsToken())), []);

  if (!needsToken) return null;
  // P9: a phone has no hub token to paste; it pairs.
  const pairing = wasUnpaired() || !!getPairError();

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
        {pairing ? (
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
          aria-label={pairing ? 'Pairing code' : 'Server token'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'token-prompt-error' : undefined}
          placeholder={pairing ? 'ABCD-EFGH' : 'server token or pairing code'}
          autoCapitalize={pairing ? 'characters' : 'off'}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        {error && (
          <p id="token-prompt-error" role="alert" className="mt-2 text-ui text-bad">
            {error}
          </p>
        )}
        <Button className="mt-3 w-full" onClick={() => void submit()} disabled={checking || !value.trim()}>
          {checking ? 'Checking…' : pairing ? 'Pair' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}
