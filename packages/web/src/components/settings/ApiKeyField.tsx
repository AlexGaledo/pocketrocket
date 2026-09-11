/**
 * One API key input (Settings › Claude). The hub never sends a saved key back, only whether one is
 * set, so the field is always empty: typing and pressing Save replaces the key, Remove clears it.
 */
import { useId, useState, type FormEvent } from 'react';
import type { SecretsStatus } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { Badge, Button, Field, Input, Label } from '../ui';
import { InlineError } from './parts';

/** Plain names for the keys we know, so the UI never shows an environment variable name. */
const KNOWN_KEYS: Record<string, { label: string; description: string; placeholder: string }> = {
  ANTHROPIC_API_KEY: {
    label: 'Claude API key',
    description: "Only needed if you don't use a Claude subscription.",
    placeholder: 'sk-ant-…',
  },
};

export function ApiKeyField({ keyName, isSet, onSaved }: {
  /** The secret's name as the hub knows it, e.g. "ANTHROPIC_API_KEY". */
  keyName: string;
  /** Whether a value is stored right now. */
  isSet: boolean;
  /** Gets the hub's fresh "which keys are set" answer after a save or remove. */
  onSaved: (status: SecretsStatus['keys']) => void;
}) {
  const known = KNOWN_KEYS[keyName];
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const errorId = useId();

  const write = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const status = await api.secrets.update({ [keyName]: value });
      onSaved(status.keys);
      setDraft('');
    } catch (err) {
      setError((err as Error).message || "Couldn't save the key. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) void write(draft.trim());
  };

  return (
    <Field>
      <Label>{known?.label ?? keyName}</Label>
      <p id={descriptionId} className="-mt-1 mb-2 text-[12px] text-muted">
        {known?.description ?? 'Optional.'}{' '}
        {isSet && <Badge tone="ok">Saved</Badge>}
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 basis-56"
          placeholder={isSet ? 'Paste a new key to replace the saved one' : (known?.placeholder ?? 'Not set')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
        />
        <Button type="submit" disabled={!draft.trim() || busy}>{busy && draft ? 'Saving…' : 'Save'}</Button>
        {isSet && <Button variant="ghost" disabled={busy} onClick={() => void write('')}>Remove</Button>}
      </form>
      {error && <InlineError id={errorId}>{error}</InlineError>}
    </Field>
  );
}
