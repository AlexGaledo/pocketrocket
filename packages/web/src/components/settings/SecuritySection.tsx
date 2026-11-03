/**
 * Settings › Security: the owner's password, which browsers are signed in, and the activity log. The server
 * token keeps working for the desktop app and scripts, and resets a forgotten password.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry, UserSessionInfo } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { reconnectWsNow } from '../../lib/ws';
import { useStore } from '../../store';
import { Badge, Button, Field, Input, Label } from '../ui';
import { Card, Group, InlineError, SectionHeader } from './parts';

const ACTOR: Record<AuditEntry['actorKind'], string> = {
  session: 'You, signed in',
  'hub-token': 'You, server token',
  device: 'Paired device',
  bot: 'Bot',
  anonymous: 'Unknown',
};

/** `bot.memory.updated` reads as "Bot memory updated". */
function actionLabel(action: string): string {
  const words = action.replace(/^auth\./, '').replace(/^bot_tool\./, 'bot tool: ').replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function browserName(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const name = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? name + ' on ' + os : name;
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SecuritySection() {
  const toast = useStore((s) => s.toast);
  const [sessions, setSessions] = useState<UserSessionInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [passwordSet, setPasswordSet] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await api.auth.sessions();
    setSessions(s.sessions);
    setCurrent(s.current);
    setPasswordSet(s.passwordSet);
    const a = await api.audit({ limit: 50 });
    setEntries(a.entries);
    setMore(a.entries.length === 50);
  }, []);
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.auth.setPassword(password, current ? oldPassword : undefined);
      setPassword('');
      setOldPassword('');
      toast(passwordSet ? 'Password changed.' : 'Password set.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const signOut = async () => {
    try {
      await api.auth.logout();
      // Without another credential the socket closes and the sign-in screen comes up.
      reconnectWsNow();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const loadMore = async () => {
    const before = entries[entries.length - 1]?.id;
    const a = await api.audit({ limit: 50, before });
    setEntries((cur) => [...cur, ...a.entries]);
    setMore(a.entries.length === 50);
  };

  const needsCurrent = passwordSet && !!current;
  return (
    <>
      <SectionHeader title="Security" description="Sign-in and a record of changes." />

      <Group title="Password">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {needsCurrent && (
            <Field>
              <Label htmlFor="security-current">Current password</Label>
              <Input id="security-current" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
            </Field>
          )}
          <Field>
            <Label htmlFor="security-new">{passwordSet ? 'New password' : 'Password'}</Label>
            <Input id="security-new" type="password" autoComplete="new-password" aria-describedby="security-hint" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p id="security-hint" className="mt-1 text-hint text-muted">At least 10 characters. Forgot it? The server token can set a new one.</p>
          </Field>
          {error && <InlineError>{error}</InlineError>}
          <div>
            <Button type="submit" disabled={saving || password.length < 10 || (needsCurrent && !oldPassword)}>
              {saving ? 'Saving…' : passwordSet ? 'Change password' : 'Set password'}
            </Button>
          </div>
        </form>
      </Group>

      <Group
        title="Signed-in browsers"
        aside={sessions.some((s) => !s.current) ? <Button variant="ghost" onClick={() => void act(() => api.auth.revokeOthers())}>Sign out others</Button> : undefined}
      >
        <Card>
          {sessions.length === 0 && <p className="px-3 py-2.5 text-ui text-muted">None. This window uses the server token.</p>}
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-ui">
                  <span className="truncate">{browserName(s.userAgent)}</span>
                  {s.current && <Badge tone="ok">This one</Badge>}
                </div>
                <div className="text-hint text-muted">Last seen {when(s.lastSeenAt)}</div>
              </div>
              {s.current
                ? <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
                : <Button variant="ghost" onClick={() => void act(() => api.auth.revoke(s.id))}>Sign out</Button>}
            </div>
          ))}
        </Card>
      </Group>

      <Group title="Activity">
        <Card>
          {entries.length === 0 && <p className="px-3 py-2.5 text-ui text-muted">Nothing yet.</p>}
          {entries.map((e) => (
            <div key={e.id} className="px-3 py-2">
              <div className="text-ui">{actionLabel(e.action)}{e.detail ? <span className="text-muted"> · {e.detail}</span> : null}</div>
              <div className="text-hint text-muted">{[ACTOR[e.actorKind], e.actorKind === 'bot' ? e.actorId : null, e.target, e.ip, when(e.at)].filter(Boolean).join(' · ')}</div>
            </div>
          ))}
        </Card>
        {more && <Button variant="ghost" className="mt-2" onClick={() => void loadMore().catch((e: Error) => toast(e.message, true))}>Show more</Button>}
      </Group>
    </>
  );
}
