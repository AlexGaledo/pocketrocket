/**
 * Settings › Logins. Saved logins a bot can type into a page with `fill_credential`. A login is a name, the exact
 * site it belongs to, a username and a secret. The secret is write-only: it is sent to the hub when you save and is
 * never shown again (the field starts empty when you edit; leave it empty to keep the one saved). Every use asks you
 * on a card first, and only from a browser signed in with your password.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CredentialInfo } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api, ApiError } from '../../lib/api';
import { Button, EmptyState, Field, Input, Label, confirmAction } from '../ui';
import { Card, Group, InlineError, SectionHeader } from './parts';

interface Draft { id: string | null; name: string; origin: string; username: string; secret: string }
const BLANK: Draft = { id: null, name: '', origin: 'https://', username: '', secret: '' };

function lastUsed(ts: number | null): string {
  return ts ? 'last used ' + new Date(ts).toLocaleDateString() : 'never used';
}

export function CredentialsSection() {
  const signedIn = useStore((s) => s.signedIn);
  const [items, setItems] = useState<CredentialInfo[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.credentials.list().then((r) => setItems(r.credentials)).catch((e) => { setItems([]); setError((e as Error).message); });
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const { id, name, origin, username, secret } = draft;
      if (id) await api.credentials.update(id, { name, origin, username, ...(secret ? { secret } : {}) });
      else await api.credentials.create({ name, origin, username, secret });
      // Drop the secret from memory as soon as it is sent.
      setDraft(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: CredentialInfo) => {
    if (!(await confirmAction({ title: 'Delete "' + c.name + '"?', body: 'Bots can no longer sign in with it. The saved secret is erased.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.credentials.remove(c.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div>
      <SectionHeader title="Logins" description="Let a bot sign in to a site without ever seeing the password. It asks you every time." />
      {!signedIn && (
        <p className="mb-4 text-ui text-muted">Saving a login, and approving its use, needs a browser signed in with your password. Set one under Security first.</p>
      )}
      {error && <InlineError>{error}</InlineError>}

      <Group
        title="Saved logins"
        aside={!draft && <Button size="sm" onClick={() => { setError(''); setDraft({ ...BLANK }); }} disabled={!signedIn}><Plus size={14} aria-hidden /> Add login</Button>}
      >
        {items && items.length === 0 && !draft && <EmptyState icon={<KeyRound size={18} aria-hidden />} title="No saved logins">Add one, then tell a bot its name.</EmptyState>}
        <ul className="space-y-2">
          {(items ?? []).map((c) => (
            <li key={c.id}>
              <Card className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui text-fg">{c.name}</div>
                  <div className="truncate text-hint text-muted">{c.origin}{c.username ? ' · ' + c.username : ''} · secret saved · {lastUsed(c.lastUsedAt)}</div>
                </div>
                <Button size="icon" variant="ghost" aria-label={'Edit ' + c.name} disabled={!signedIn} onClick={() => { setError(''); setDraft({ id: c.id, name: c.name, origin: c.origin, username: c.username, secret: '' }); }}><Pencil size={14} aria-hidden /></Button>
                <Button size="icon" variant="ghost" aria-label={'Delete ' + c.name} disabled={!signedIn} onClick={() => remove(c)}><Trash2 size={14} aria-hidden /></Button>
              </Card>
            </li>
          ))}
        </ul>
      </Group>

      {draft && (
        <Group title={draft.id ? 'Edit login' : 'New login'}>
          <Card>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off">
              <Field>
                <Label hint="what you tell the bot">Name</Label>
                <Input value={draft.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} placeholder="github work" required />
              </Field>
              <Field>
                <Label hint="the only site it works on">Site</Label>
                <Input value={draft.origin} onChange={(e) => set({ origin: e.target.value })} placeholder="https://github.com" inputMode="url" required />
              </Field>
              <Field>
                <Label>Username</Label>
                <Input value={draft.username} maxLength={200} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
              </Field>
              <Field>
                <Label hint={draft.id ? 'leave empty to keep the saved one' : 'never shown again'}>Password or secret</Label>
                <Input type="password" value={draft.secret} maxLength={1024} onChange={(e) => set({ secret: e.target.value })} autoComplete="new-password" required={!draft.id} placeholder={draft.id ? '••••••••' : ''} />
              </Field>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={busy || !signedIn}>{busy ? 'Saving' : 'Save'}</Button>
              </div>
            </form>
          </Card>
        </Group>
      )}
    </div>
  );
}
