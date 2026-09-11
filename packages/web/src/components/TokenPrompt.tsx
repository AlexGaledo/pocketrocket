import { useEffect, useState } from 'react';
import { getNeedsToken, setToken, subscribeAuthFailure } from '../lib/auth';
import { reconnectWsNow } from '../lib/ws';
import { useStore } from '../store';
import { Button, Input } from './ui';

/**
 * The hub always requires a token now. When the API 401s or the WS upgrade gets refused (bad or
 * missing token), this small centered panel asks for it instead of leaving the app stuck on
 * "Connecting to the hub".
 */
export function TokenPrompt() {
  const [needsToken, setNeedsToken] = useState(getNeedsToken());
  const [value, setValue] = useState('');
  useEffect(() => subscribeAuthFailure(() => setNeedsToken(getNeedsToken())), []);

  if (!needsToken) return null;

  const submit = () => {
    const t = value.trim();
    if (!t) return;
    setToken(t);
    setNeedsToken(false);
    setValue('');
    reconnectWsNow();
    useStore.getState().refresh();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-ink/60 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="token-prompt-title" className="w-[380px] rounded-2xl bg-card p-5 text-[13px] shadow-[var(--shadow-lg)]">
        <div id="token-prompt-title" className="mb-1 text-[15px] font-semibold">Paste the hub token</div>
        <p className="mb-3 text-muted">
          The hub prints this as part of a URL like{' '}
          <span className="font-mono">http://127.0.0.1:7788/#token=&hellip;</span> when it starts, and stores the
          same value in <span className="font-mono">&lt;data&gt;/hub-token</span>.
        </p>
        <Input
          autoFocus
          aria-label="Hub token"
          placeholder="hub token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <Button className="mt-3 w-full" onClick={submit}>
          Connect
        </Button>
      </div>
    </div>
  );
}
