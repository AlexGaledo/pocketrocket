/**
 * Settings › Integrations (P4): connect GitHub, Google, Slack, ClickUp and Microsoft Teams so bots can use
 * them. Per provider the user either connects with their OWN OAuth app (client id + secret/tenant, PKCE and
 * a loopback redirect, or a device code on a server) or pastes a key/token. Defaults follow
 * docs/research/oauth-loopback.md: Google and Teams OAuth, Slack and ClickUp paste, GitHub both.
 *
 * Every credential stays in the hub's encrypted vault; this page only ever sees whether one is stored.
 * Account names are masked with `Private` (people screen-share). A connection is shared, but each bot has
 * to be switched on here before it gets the provider's tools.
 */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Bot, IntegrationInfo, IntegrationProvider, IntegrationsState, OAuthAppStatus, PendingConnect } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { Avatar, Badge, Button, Field, Input, Label, Switch, Tabs, TabsContent, TabsList, TabsTrigger, cn } from '../ui';
import { ApiKeyField } from './ApiKeyField';
import { Card, Group, InlineError, Private, SectionHeader, maskEmail } from './parts';

type Method = 'oauth' | 'token';

/** One step of the inline setup guide: plain text, links allowed. */
type Steps = (redirectUri: string) => ReactNode[];

interface ProviderMeta {
  name: string;
  /** What bots can do with it, one line. */
  blurb: string;
  methods: Method[];
  defaultMethod: Method;
  device?: boolean;
  /** Client secret: required for the browser flow, optional, or never used (public client). */
  secret: 'required' | 'optional' | 'none';
  tenant?: boolean;
  oauthSteps?: Steps;
  oauthNote?: string;
  tokenSteps?: Steps;
  token?: { label: string; placeholder: string };
  /** Why there is no OAuth option, when there is none. */
  noOauth?: string;
  /** Where the user revokes access at the provider (disconnecting here only forgets the token). */
  revokeUrl: string;
}

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded">
    {children}<ExternalLink size={11} aria-hidden />
  </a>
);
const C = ({ children }: { children: ReactNode }) => <code className="rounded bg-card2 [overflow-wrap:anywhere] px-1 py-px font-mono text-[11.5px] text-fg">{children}</code>;

const PROVIDERS: Record<IntegrationProvider, ProviderMeta> = {
  github: {
    name: 'GitHub',
    blurb: 'Search and read issues and pull requests, read notifications, open issues and comment.',
    methods: ['oauth', 'token'], defaultMethod: 'oauth', device: true, secret: 'required',
    oauthSteps: (uri) => [
      <>Create an OAuth app: <A href="https://github.com/settings/applications/new">GitHub → New OAuth App</A>. Homepage <C>http://127.0.0.1</C>.</>,
      <>Authorization callback URL: <C>{uri}</C></>,
      <>On a server, also tick <strong>Enable Device Flow</strong> and use “Sign in with a code”.</>,
      <>Paste the Client ID, and a client secret you generate on the same page.</>,
    ],
    tokenSteps: () => [
      <>Create a <A href="https://github.com/settings/tokens/new?scopes=repo,notifications&description=PocketRocket%20Crew">classic token</A> with the <C>repo</C> and <C>notifications</C> scopes.</>,
      <>A fine-grained token works for repositories but <strong>cannot read notifications</strong>.</>,
    ],
    token: { label: 'Personal access token', placeholder: 'ghp_… or github_pat_…' },
    revokeUrl: 'https://github.com/settings/applications',
  },
  google: {
    name: 'Google',
    blurb: 'Gmail search, read and send; Calendar list and create; Drive search and read.',
    methods: ['oauth'], defaultMethod: 'oauth', secret: 'optional',
    oauthSteps: () => [
      <>In <A href="https://console.cloud.google.com/apis/library">Google Cloud</A>, enable the Gmail, Calendar and Drive APIs in a project of yours.</>,
      <>Set up the <A href="https://console.cloud.google.com/auth/overview">consent screen</A> (External), then <strong>publish it to production</strong>: in testing mode access ends after 7 days.</>,
      <>Under <A href="https://console.cloud.google.com/apis/credentials">Credentials</A>, create an OAuth client ID of type <strong>Desktop app</strong>. It accepts this computer's address without registering it.</>,
      <>Paste the client ID and secret. Google warns that the app is unverified once; it is your own app.</>,
    ],
    noOauth: 'Google has no key you can paste for Gmail, Calendar or Drive.',
    revokeUrl: 'https://myaccount.google.com/permissions',
  },
  slack: {
    name: 'Slack',
    blurb: 'List channels, read history and post messages as your Slack app.',
    methods: ['token'], defaultMethod: 'token', secret: 'none',
    tokenSteps: () => [
      <>Create an app at <A href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</A> (from scratch).</>,
      <>Under OAuth &amp; Permissions add bot scopes <C>channels:read</C> <C>groups:read</C> <C>channels:history</C> <C>groups:history</C> <C>im:history</C> <C>users:read</C> <C>chat:write</C>, install it, and copy the <strong>Bot User OAuth Token</strong>.</>,
      <>Optional, for live triggers later: turn on Socket Mode and create an app-level token with <C>connections:write</C>.</>,
      <>Invite the app to each channel it should read: <C>/invite @your-app</C>.</>,
    ],
    token: { label: 'Bot token', placeholder: 'xoxb-…' },
    noOauth: 'Slack only signs in bots over an HTTPS address, so it connects with tokens instead.',
    revokeUrl: 'https://api.slack.com/apps',
  },
  clickup: {
    name: 'ClickUp',
    blurb: 'List and search tasks, read them, create tasks and comment.',
    methods: ['token', 'oauth'], defaultMethod: 'token', secret: 'required',
    tokenSteps: () => [
      <>In ClickUp open <A href="https://app.clickup.com/settings/apps">Settings → Apps</A> and generate an API token.</>,
      <>Paste it here. It acts as you in every workspace you belong to.</>,
    ],
    oauthSteps: (uri) => [
      <>Create an app under ClickUp Settings → Integrations → ClickUp API, with redirect URL <C>{uri}</C>.</>,
      <>Paste its client ID and secret.</>,
    ],
    oauthNote: 'ClickUp may refuse an address on this computer as a redirect. If it does, paste a token instead.',
    token: { label: 'API token', placeholder: 'pk_…' },
    revokeUrl: 'https://app.clickup.com/settings/apps',
  },
  teams: {
    name: 'Microsoft Teams',
    blurb: 'List your chats, read them and send chat messages as you.',
    methods: ['oauth'], defaultMethod: 'oauth', device: true, secret: 'none', tenant: true,
    oauthSteps: () => [
      <>Register an app in <A href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">Microsoft Entra → App registrations</A>.</>,
      <>Authentication → add a <strong>Mobile and desktop</strong> platform with redirect <C>http://localhost/oauth/callback/teams</C>, and turn on <strong>Allow public client flows</strong>.</>,
      <>API permissions → Microsoft Graph, delegated: <C>Chat.ReadWrite</C> <C>ChatMessage.Send</C> <C>User.Read</C> <C>offline_access</C>.</>,
      <>Paste the Application (client) ID and the Directory (tenant) ID. No secret.</>,
    ],
    oauthNote: 'Channel messages need an admin to consent and are not included; chats are.',
    noOauth: 'Microsoft has no key you can paste for reading Teams.',
    revokeUrl: 'https://myapps.microsoft.com',
  },
};
const ORDER: IntegrationProvider[] = ['github', 'google', 'slack', 'clickup', 'teams'];

/** `alex@example.com` → `a•••@example.com`; `Acme · crewbot` → `A•••`. */
function maskAccount(label: string): string {
  if (label.includes('@')) return maskEmail(label);
  return (Array.from(label)[0] ?? '') + '•••';
}

const errText = (e: unknown, fallback: string) => (e as Error)?.message || fallback;

export function IntegrationsSection() {
  const [state, setState] = useState<IntegrationsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.integrations.get());
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e, "Couldn't load integrations."));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // While a sign-in is under way the hub finishes it on its own (browser callback or device code); check
  // back every two seconds until nothing is pending, and whenever the window regains focus.
  const waiting = !!state?.pending.length;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [waiting, refresh]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return (
    <>
      <SectionHeader
        title="Integrations"
        description="Connect accounts your bots can use. Tokens stay encrypted on this computer and never reach a bot; sending or posting always asks you first."
      />
      {loadError && <InlineError>{loadError}</InlineError>}
      {state && ORDER.map((p) => (
        <ProviderGroup
          key={p}
          provider={p}
          conn={state.connections.find((c) => c.provider === p)}
          app={state.apps[p]}
          pending={state.pending.find((x) => x.provider === p)}
          redirectUri={state.redirectUris[p]}
          onChange={refresh}
        />
      ))}
    </>
  );
}

function StatusBadge({ conn }: { conn?: IntegrationInfo }) {
  if (!conn) return <Badge>Not connected</Badge>;
  if (conn.status === 'connected') return <Badge tone="ok">Connected</Badge>;
  if (conn.status === 'expired') return <Badge tone="warn">Reconnect needed</Badge>;
  return <Badge tone="bad">Error</Badge>;
}

function ProviderGroup({ provider, conn, app, pending, redirectUri, onChange }: {
  provider: IntegrationProvider;
  conn?: IntegrationInfo;
  app: OAuthAppStatus;
  pending?: PendingConnect;
  redirectUri: string;
  onChange: () => Promise<void>;
}) {
  const meta = PROVIDERS[provider];
  const [reconnecting, setReconnecting] = useState(false);
  const showConnect = !conn || reconnecting || conn.status === 'expired';
  // A finished sign-in closes the reconnect form.
  const connUpdated = conn?.updatedAt;
  useEffect(() => setReconnecting(false), [connUpdated]);

  return (
    <Group title={meta.name} aside={<StatusBadge conn={conn} />}>
      <Card>
        <p className="mb-3 text-[12.5px] leading-relaxed text-muted">{meta.blurb}</p>
        {conn && <Connected provider={provider} conn={conn} onChange={onChange} onReconnect={() => setReconnecting((r) => !r)} reconnecting={reconnecting} />}
        {showConnect && (
          <div className={cn(conn && 'mt-4 border-t border-line pt-4')}>
            <ConnectForms provider={provider} app={app} pending={pending} redirectUri={redirectUri} onChange={onChange} />
          </div>
        )}
      </Card>
    </Group>
  );
}

function ConnectForms({ provider, app, pending, redirectUri, onChange }: {
  provider: IntegrationProvider; app: OAuthAppStatus; pending?: PendingConnect; redirectUri: string; onChange: () => Promise<void>;
}) {
  const meta = PROVIDERS[provider];
  const [method, setMethod] = useState<Method>(meta.defaultMethod);
  const both = meta.methods.length > 1;
  const form = (m: Method) => m === 'oauth'
    ? <OAuthConnect provider={provider} app={app} pending={pending} redirectUri={redirectUri} onChange={onChange} />
    : <TokenConnect provider={provider} onChange={onChange} />;
  if (!both) {
    return (
      <div>
        {form(meta.defaultMethod)}
        {meta.noOauth && <p className="mt-3 text-[12px] text-muted">{meta.noOauth}</p>}
      </div>
    );
  }
  return (
    <Tabs value={method} onValueChange={(v) => setMethod(v as Method)}>
      <div className="-mx-3 -mt-2 mb-1 max-w-sm">
        <TabsList>
          {meta.methods.map((m) => <TabsTrigger key={m} value={m}>{m === 'oauth' ? 'Connect with OAuth' : 'Paste a token'}</TabsTrigger>)}
        </TabsList>
      </div>
      {meta.methods.map((m) => <TabsContent key={m} value={m} className="focus:outline-none">{form(m)}</TabsContent>)}
    </Tabs>
  );
}

function SetupSteps({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="mb-3 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-fg marker:text-dim">
      {steps.map((s, i) => <li key={i}>{s}</li>)}
    </ol>
  );
}

function OAuthConnect({ provider, app, pending, redirectUri, onChange }: {
  provider: IntegrationProvider; app: OAuthAppStatus; pending?: PendingConnect; redirectUri: string; onChange: () => Promise<void>;
}) {
  const meta = PROVIDERS[provider];
  const [clientId, setClientId] = useState(app.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState(app.tenant ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => setClientId(app.clientId ?? ''), [app.clientId]);
  useEffect(() => setTenant(app.tenant ?? ''), [app.tenant]);

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError(errText(e, fallback));
    } finally {
      setBusy(false);
    }
  };
  const saveApp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.integrations.setApp(provider, { clientId: clientId.trim(), clientSecret: secret.trim() || undefined, tenant: meta.tenant ? tenant.trim() || undefined : undefined });
      setSecret('');
    }, "Couldn't save the app.");
  };
  const connect = () => void run(async () => {
    const { url } = await api.integrations.startOAuth(provider);
    setOpenUrl(url);
    window.open(url, '_blank', 'noopener');
  }, "Couldn't start the sign-in.");
  const device = () => void run(() => api.integrations.startDevice(provider), "Couldn't get a sign-in code.");
  const cancel = () => void run(async () => { setOpenUrl(null); await api.integrations.cancel(provider); }, "Couldn't cancel.");

  if (pending && !pending.error) {
    return (
      <div>
        {pending.kind === 'device' ? (
          <p role="status" className="text-[13px] leading-relaxed text-fg">
            Open <A href={pending.verificationUri ?? '#'}>{pending.verificationUri?.replace(/^https?:\/\//, '')}</A> on any device and enter{' '}
            <span className="select-all rounded-lg bg-card2 px-2 py-0.5 font-mono text-[14px] font-semibold tracking-wider">{pending.userCode}</span>.
            This page updates by itself.
          </p>
        ) : (
          <p role="status" className="text-[13px] leading-relaxed text-fg">Finish signing in to {meta.name} in your browser. This page updates by itself.</p>
        )}
        <div className="-ml-3 mt-2 flex flex-wrap">
          {pending.kind === 'browser' && openUrl && <a href={openUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center rounded-full px-3 text-[12.5px] font-medium text-accent hover:bg-card2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">Open the sign-in page again</a>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>Cancel</Button>
        </div>
        {error && <InlineError>{error}</InlineError>}
      </div>
    );
  }

  const canBrowser = app.configured && (meta.secret !== 'required' || app.hasSecret);
  return (
    <div>
      {meta.oauthSteps && <SetupSteps steps={meta.oauthSteps(redirectUri)} />}
      {meta.oauthNote && <p className="mb-3 text-[12px] text-muted">{meta.oauthNote}</p>}
      <form onSubmit={saveApp} className="grid gap-3 sm:grid-cols-2">
        <Field>
          <Label>{meta.tenant ? 'Application (client) ID' : 'Client ID'}</Label>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        {meta.secret !== 'none' && (
          <Field>
            <Label hint={meta.secret === 'optional' ? 'Optional for Desktop apps' : undefined}>Client secret</Label>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder={app.hasSecret ? 'Saved. Paste a new one to replace it' : ''} />
          </Field>
        )}
        {meta.tenant && (
          <Field>
            <Label hint="or organizations / common">Directory (tenant) ID</Label>
            <Input value={tenant} onChange={(e) => setTenant(e.target.value)} autoComplete="off" spellCheck={false} placeholder="common" />
          </Field>
        )}
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy || clientId.trim().length < 4} aria-describedby={error ? errorId : undefined}>{app.configured ? 'Update app' : 'Save app'}</Button>
          {app.configured && <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => api.integrations.removeApp(provider), "Couldn't remove the app.")}>Remove app</Button>}
        </div>
      </form>
      {app.configured && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy || !canBrowser} onClick={connect}>Connect with OAuth</Button>
          {meta.device && <Button disabled={busy} onClick={device}>Sign in with a code</Button>}
          {meta.device && <span className="text-[12px] text-muted">Use a code when PocketRocket runs on a server.</span>}
        </div>
      )}
      {pending?.error && <InlineError>{pending.error}</InlineError>}
      {error && <InlineError id={errorId}>{error}</InlineError>}
    </div>
  );
}

function TokenConnect({ provider, onChange }: { provider: IntegrationProvider; onChange: () => Promise<void> }) {
  const meta = PROVIDERS[provider];
  return (
    <div>
      {meta.tokenSteps && <SetupSteps steps={meta.tokenSteps('')} />}
      <ApiKeyField
        keyName={'integration:' + provider}
        isSet={false}
        label={meta.token!.label}
        description="Checked with the provider before it is saved."
        placeholder={meta.token!.placeholder}
        saveLabel="Connect"
        onSave={async (v) => {
          await api.integrations.connectToken(provider, { token: v });
          await onChange();
        }}
      />
    </div>
  );
}

function Connected({ provider, conn, onChange, onReconnect, reconnecting }: {
  provider: IntegrationProvider; conn: IntegrationInfo; onChange: () => Promise<void>; onReconnect: () => void; reconnecting: boolean;
}) {
  const meta = PROVIDERS[provider];
  const bots = useStore((s) => s.bots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const grantsId = useId();

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError(errText(e, fallback));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (bot: Bot, on: boolean) => {
    const next = on ? [...conn.botIds, bot.id] : conn.botIds.filter((id) => id !== bot.id);
    void run(() => api.integrations.setGrants(conn.id, next), "Couldn't change that bot's access.");
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="text-muted">Account</span>
        {conn.accountLabel ? <Private value={conn.accountLabel} display={maskAccount(conn.accountLabel)} label={meta.name + ' account name'} /> : <span className="text-muted">unknown</span>}
        <Badge>{conn.method === 'oauth' ? 'OAuth' : 'Token'}</Badge>
      </div>
      {conn.warnings.map((w) => <p key={w} className="mt-2 text-[12px] leading-snug text-warn">{w}</p>)}
      {conn.status !== 'connected' && conn.lastError && <p className="mt-2 text-[12px] leading-snug text-bad">{conn.lastError}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void run(() => api.integrations.test(conn.id), "Couldn't test the connection.")}>{busy ? 'Checking…' : 'Test connection'}</Button>
        {conn.status === 'connected' && <Button size="sm" variant="ghost" disabled={busy} aria-expanded={reconnecting} onClick={onReconnect}>{reconnecting ? 'Keep this connection' : 'Reconnect'}</Button>}
        {!confirming && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</Button>}
      </div>
      {confirming && (
        <div role="group" aria-label={'Disconnect ' + meta.name} className="mt-3 rounded-2xl bg-bad/5 p-3 ring-1 ring-bad/20">
          <p className="text-[12.5px] leading-relaxed text-fg">
            Bots lose access and the token is deleted from this computer. To revoke it at {meta.name} too, use <A href={meta.revokeUrl}>{meta.name}'s settings</A>.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.integrations.disconnect(conn.id), "Couldn't disconnect.")}>Disconnect</Button>
            <Button size="sm" variant="ghost" autoFocus disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {provider === 'slack' && conn.method === 'token' && (
        <div className="mt-4">
          <ApiKeyField
            keyName="integration:slack-app"
            isSet={!!conn.hasAppToken}
            removable={false}
            label="App-level token (optional)"
            description="For live Slack triggers (Socket Mode). Needs connections:write."
            placeholder="xapp-…"
            onSave={async (v) => {
              if (!v) return;
              await api.integrations.connectToken('slack', { appToken: v });
              await onChange();
            }}
          />
        </div>
      )}

      <div className="mt-4">
        <p id={grantsId} className="mb-1 text-[12.5px] font-medium text-fg">Bots that may use it</p>
        <p className="mb-2 text-[12px] text-muted">A bot that is off here does not get any {meta.name} tools.</p>
        {bots.length ? (
          <ul aria-labelledby={grantsId} className="divide-y divide-line">
            {bots.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2">
                <Avatar bot={b} size={24} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{b.name}</span>
                <Switch checked={conn.botIds.includes(b.id)} aria-label={b.name + ' may use ' + meta.name} onChange={(on) => toggle(b, on)} />
              </li>
            ))}
          </ul>
        ) : <p className="text-[12.5px] text-muted">No bots yet.</p>}
      </div>
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}
