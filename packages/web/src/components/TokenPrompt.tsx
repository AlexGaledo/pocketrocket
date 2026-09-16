import { useEffect, useState } from 'react';
import { getNeedsToken, setToken, subscribeAuthFailure } from '../lib/auth';
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

  // The token is tried before it is kept: the panel stays up saying "Checking…", and a wrong one gets an
  // answer here instead of closing the panel only for it to pop back a few seconds later.
  const submit = async () => {
    const t = value.trim();
    if (!t || checking) return;
    setChecking(true);
    setError(null);
    const probe = await probeHub(t);
    setChecking(false);
    if (probe.result === 'auth') return setError("That token didn't work. Check you copied all of it.");
    if (probe.result === 'rateLimited') {
      return setError('The hub is refusing sign-in attempts for now after too many tries. Wait ' + Math.ceil(probe.retryInMs / 1000) + ' seconds and try again.');
    }
    if (probe.result === 'unreachable') return setError("Couldn't reach the hub to check the token. " + probe.detail);
    setToken(t);
    setNeedsToken(false);
    setValue('');
    reconnectWsNow();
    void useStore.getState().refresh().catch(() => undefined);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="token-prompt-title" className="w-[380px] max-w-full rounded-2xl bg-card p-5 text-[13px] shadow-[var(--shadow-lg)]">
        <div id="token-prompt-title" className="mb-1 text-[15px] font-semibold">Paste the hub token</div>
        <p className="mb-3 text-muted">
          The hub prints this as part of a URL like{' '}
          <span className="font-mono">http://127.0.0.1:7788/#token=&hellip;</span> when it starts, and stores the
          same value in <span className="font-mono">&lt;data&gt;/hub-token</span>.
        </p>
        <Input
          autoFocus
          aria-label="Hub token"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'token-prompt-error' : undefined}
          placeholder="hub token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        {error && (
          <p id="token-prompt-error" role="alert" className="mt-2 text-[12.5px] text-bad">
            {error}
          </p>
        )}
        <Button className="mt-3 w-full" onClick={() => void submit()} disabled={checking || !value.trim()}>
          {checking ? 'Checking…' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}
