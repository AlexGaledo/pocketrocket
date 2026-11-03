/**
 * Settings › Account: the name bots call you (works with or without an account) and the optional
 * PocketRocket account. Which account view shows comes straight from `store.account`:
 * not available on this setup → one quiet line; signed out or waiting for a code → <AccountSignIn>;
 * signed in → who you are, your plan and "Sign out".
 */
import { useEffect, useMemo, useState } from 'react';
import type { AccountUser, Plan } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { Badge, Button, Field, Input, Label, Select } from '../ui';
import { AccountSignIn } from '../AccountSignIn';
import { Card, Group, InlineError, SectionHeader } from './parts';

/** settings.userName is capped at 40 characters by the hub's schema. */
const MAX_NAME_LENGTH = 40;

const PLAN_LABEL: Record<Plan, string> = { free: 'Free', pro: 'Pro' };

export function AccountSection() {
  const account = useStore((s) => s.account);

  return (
    <>
      <SectionHeader title="Account" />

      <Group>
        <Card>
          <NameField />
          <div className="mt-4"><TimezoneField /></div>
        </Card>
      </Group>

      <Group title="PocketRocket account">
        <Card>
          {!account.enabled ? (
            <p className="text-ui text-muted">Sign-in unavailable. Everything still works.</p>
          ) : account.signedIn && account.user ? (
            <SignedIn user={account.user} />
          ) : (
            <>
              {!account.pendingEmail && (
                <p className="mb-3 text-ui leading-relaxed text-muted">
                  Optional. Everything works without an account.
                </p>
              )}
              <AccountSignIn />
            </>
          )}
        </Card>
      </Group>
    </>
  );
}

/** Saves on blur or Enter, the way a native preferences window does; an empty name snaps back. */
function NameField() {
  const userName = useStore((s) => s.settings.userName);
  const updateSettings = useStore((s) => s.updateSettings);
  const [name, setName] = useState(userName);
  // Follow changes made elsewhere (another window, onboarding) while this field isn't being edited.
  useEffect(() => setName(userName), [userName]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return setName(userName);
    if (trimmed !== userName) void updateSettings({ userName: trimmed });
  };

  return (
    <Field>
      <Label hint="What your bots call you">Your name</Label>
      <Input
        value={name}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="nickname"
        placeholder="Your name"
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
      />
    </Field>
  );
}

function SignedIn({ user }: { user: AccountUser }) {
  const applyAccountResponse = useStore((s) => s.applyAccountResponse);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = (user.displayName || user.email).trim().charAt(0).toUpperCase() || '?';

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      applyAccountResponse(await api.account.signOut());
    } catch (err) {
      setError((err as Error).message || "Couldn't sign out. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink text-title-sm text-ink-fg">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          {user.displayName && <div className="truncate text-ui font-medium">{user.displayName}</div>}
          <div className={user.displayName ? 'truncate text-ui text-muted' : 'truncate text-ui font-medium'}>{user.email}</div>
        </div>
        <Badge tone={user.plan === 'free' ? 'muted' : 'accent'}>{PLAN_LABEL[user.plan] ?? user.plan}</Badge>
        <Button size="sm" disabled={busy} onClick={() => void signOut()}>{busy ? 'Signing out…' : 'Sign out'}</Button>
      </div>
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}

/**
 * P3: settings.timezone. Routines are scheduled on this clock and the Routines tab shows times in it. The hub
 * starts it at its own system zone, which on a VPS is usually UTC, so offer this device's zone in one click.
 */
function TimezoneField() {
  const timezone = useStore((s) => s.settings.timezone);
  const updateSettings = useStore((s) => s.updateSettings);
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = useMemo(() => {
    let list: string[] = [];
    try {
      list = Intl.supportedValuesOf('timeZone');
    } catch {
      /* older engine: the current value and UTC are still offered */
    }
    for (const z of [here, 'UTC', timezone]) if (z && !list.includes(z)) list = [z, ...list];
    return list;
  }, [here, timezone]);

  return (
    <Field>
      <Label hint="Schedules use this time zone">Time zone</Label>
      <Select value={timezone} onChange={(e) => void updateSettings({ timezone: e.target.value })}>
        {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
      </Select>
      {here && here !== timezone && (
        <Button size="sm" variant="ghost" className="mt-1 self-start" onClick={() => void updateSettings({ timezone: here })}>
          Use this device's zone ({here.replace(/_/g, ' ')})
        </Button>
      )}
    </Field>
  );
}
