/**
 * Settings › Tools. The outside MCP servers bots may use. The hub keeps them in data/mcp-servers.json; this is the
 * owner's list and editor. Tokens and environment values are write-only: the list shows that one is set, never what it
 * is. A server that runs a command needs a browser signed in with a password (the hub says so in its answer).
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useStore } from '../../store';
import { api, type McpServerRow } from '../../lib/api';
import { Badge, Banner, Button, EmptyState, Input, Label, Select, Skeleton, SkeletonGroup, Textarea, confirmAction } from '../ui';
import { Card, Group, SectionHeader } from './parts';

const APPROVE_LABEL: Record<McpServerRow['approve'], string> = { 'every-call': 'Ask every time', writes: 'Ask for changes only', none: 'Never ask' };
const CHECK_LABEL: Record<string, string> = {
  connected: 'Connected', 'auth-rejected': 'Token rejected', timeout: 'No answer', unreachable: 'Unreachable',
  'command-found': 'Program found', 'command-missing': 'Program not found', invalid: 'Not set up correctly',
};
const checkText = (r: string) => CHECK_LABEL[r] ?? (r.startsWith('http-') ? 'Server answered ' + r.slice(5) : r);

export function McpServersSection() {
  const [servers, setServers] = useState<McpServerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.mcpServers.list().then((r) => { setServers(r.servers); setError(null); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <SectionHeader title="Tools" description="Outside tool servers your bots can use. A change applies on the bot's next reply." />
      {error && <Banner tone="error" className="mb-4" action={<Button size="sm" onClick={load}>Retry</Button>}>{error}</Banner>}
      <Group title="Servers">
        {servers === null && !error && (
          <SkeletonGroup label="Loading servers…" className="space-y-2"><Skeleton className="h-16 w-full rounded-lg" /><Skeleton className="h-16 w-full rounded-lg" /></SkeletonGroup>
        )}
        {servers?.length === 0 && <EmptyState icon={<Plug size={18} />} title="No tool servers yet" className="py-6">Add one below to give bots more to work with.</EmptyState>}
        <div className="space-y-3">{servers?.map((s) => <ServerCard key={s.name} server={s} onChanged={load} />)}</div>
      </Group>
      <AddServer onAdded={load} />
    </>
  );
}

function ServerCard({ server: s, onChanged }: { server: McpServerRow; onChanged: () => void }) {
  const toast = useStore((st) => st.toast);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setProblem(null);
    try { await fn(); if (done) toast(done); onChanged(); } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmAction({ title: 'Remove ' + s.name + '?', body: 'Bots lose this tool on their next reply.', confirmLabel: 'Remove', danger: true }))) return;
    await run(() => api.mcpServers.remove(s.name), s.name + ' removed');
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className="font-mono text-ui font-semibold">{s.name}</span>
            <Badge tone={s.status === 'invalid' ? 'bad' : 'muted'}>{s.kind === 'http' ? 'Web address' : s.kind === 'stdio' ? 'Program' : 'Invalid'}</Badge></div>
          <div className="mt-0.5 break-all text-hint text-muted">{s.kind === 'http' ? s.url : s.command + (s.args?.length ? ' ' + s.args.join(' ') : '')}</div>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => void run(() => api.mcpServers.check(s.name))}><RefreshCw size={13} aria-hidden /> Check</Button>
          <Button size="sm" variant="danger" disabled={busy} aria-label={'Remove ' + s.name} onClick={() => void remove()}><Trash2 size={13} aria-hidden /></Button>
        </div>
      </div>
      {s.problems.length > 0 && <Banner tone="warn" className="mt-3">{s.problems.join('. ')}</Banner>}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-hint">
        <dt className="text-muted">Last check</dt>
        <dd>{s.lastCheck ? <><Badge tone={s.lastCheck.ok ? 'ok' : 'bad'}>{checkText(s.lastCheck.result)}</Badge></> : 'Not checked yet'}</dd>
        <dt className="text-muted">Used by</dt>
        <dd>{[...s.bots.map((b) => '@' + b), ...s.rooms].join(', ') || 'Nobody'}</dd>
        {s.envKeys && s.envKeys.length > 0 && (<><dt className="text-muted">Secrets set</dt><dd className="font-mono">{s.envKeys.join(', ')}</dd></>)}
        {s.argsMasked && (<><dt className="text-muted">Arguments</dt><dd>Some values are hidden</dd></>)}
      </dl>
      <div className="mt-3 max-w-xs">
        <Label htmlFor={'mcp-approve-' + s.name}>Approval</Label>
        <Select id={'mcp-approve-' + s.name} value={s.approve} disabled={busy} onChange={(e) => void run(() => api.mcpServers.patch(s.name, { approve: e.target.value as McpServerRow['approve'] }))}>
          {(Object.keys(APPROVE_LABEL) as McpServerRow['approve'][]).map((k) => <option key={k} value={k}>{APPROVE_LABEL[k]}</option>)}
        </Select>
      </div>
      {s.kind === 'http' && (
        <div className="mt-3">
          <Label htmlFor={'mcp-token-' + s.name} hint={s.tokenSet ? 'a token is saved' : 'none saved'}>Token</Label>
          <div className="flex flex-wrap gap-2">
            <Input id={'mcp-token-' + s.name} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.tokenSet ? 'Type a new token to replace it' : 'Paste a token'} className="min-w-48 flex-1" />
            <Button disabled={busy || !token} onClick={() => void run(async () => { await api.mcpServers.patch(s.name, { token }); setToken(''); }, 'Token saved')}><KeyRound size={13} aria-hidden /> Save token</Button>
            {s.tokenSet && <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.mcpServers.patch(s.name, { token: null }), 'Token cleared')}>Clear</Button>}
          </div>
          <p className="mt-1 text-hint text-dim">Tokens are saved but never shown again.</p>
        </div>
      )}
      {problem && <Banner tone="error" className="mt-3">{problem}</Banner>}
    </Card>
  );
}

function AddServer({ onAdded }: { onAdded: () => void }) {
  const toast = useStore((s) => s.toast);
  const bots = useStore((s) => s.bots);
  const [kind, setKind] = useState<'http' | 'stdio'>('http');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [botIds, setBotIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const handles = botIds.map((id) => bots.find((b) => b.id === id)?.handle).filter((h): h is string => !!h);
      let envObj: Record<string, string> | undefined;
      if (kind === 'stdio' && env.trim()) {
        envObj = {};
        for (const line of env.split('\n').map((l) => l.trim()).filter(Boolean)) {
          const i = line.indexOf('=');
          if (i < 1) throw new Error('Write each secret as NAME=value, one per line');
          envObj[line.slice(0, i).trim()] = line.slice(i + 1);
        }
      }
      await api.mcpServers.add({
        name: name.trim(), bots: handles,
        ...(kind === 'http' ? { url: url.trim(), ...(token ? { token } : {}) } : { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), ...(envObj ? { env: envObj } : {}) }),
      });
      toast(name.trim() + ' added');
      setName(''); setUrl(''); setToken(''); setCommand(''); setArgs(''); setEnv(''); setBotIds([]);
      onAdded();
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Group title="Add a server">
      <Card>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><Label htmlFor="mcp-name" hint="lowercase letters and dashes">Name</Label><Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="notes" className="font-mono" /></div>
            <div><Label htmlFor="mcp-kind">Type</Label>
              <Select id="mcp-kind" value={kind} onChange={(e) => setKind(e.target.value as 'http' | 'stdio')}>
                <option value="http">Web address</option><option value="stdio">Program on this computer</option>
              </Select></div>
          </div>
          {kind === 'http' ? (
            <>
              <div><Label htmlFor="mcp-url">Address</Label><Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></div>
              <div><Label htmlFor="mcp-new-token" hint="saved, never shown again">Token (optional)</Label><Input id="mcp-new-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></div>
            </>
          ) : (
            <>
              <div><Label htmlFor="mcp-command">Program</Label><Input id="mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" /></div>
              <div><Label htmlFor="mcp-args" hint="one per line">Arguments</Label><Textarea id="mcp-args" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono" /></div>
              <div><Label htmlFor="mcp-env" hint="NAME=value, one per line. Saved, never shown again">Secrets</Label><Textarea id="mcp-env" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} className="font-mono" autoComplete="off" /></div>
              <Banner tone="info">A program runs with your keys, so adding one needs a browser signed in with your password.</Banner>
            </>
          )}
          <fieldset>
            <legend className="mb-1 text-label text-fg">Bots that may use it</legend>
            <div className="flex flex-wrap gap-1.5">
              {bots.map((b) => {
                const on = botIds.includes(b.id);
                return <button key={b.id} type="button" aria-pressed={on} onClick={() => setBotIds(on ? botIds.filter((x) => x !== b.id) : [...botIds, b.id])}
                  className={'rounded-xs border px-2 py-1 text-hint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' + (on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-card text-muted')}>{b.name}</button>;
              })}
            </div>
          </fieldset>
          {problem && <Banner tone="error">{problem}</Banner>}
          <Button variant="primary" disabled={busy || !name.trim() || botIds.length === 0 || (kind === 'http' ? !url.trim() : !command.trim())} onClick={() => void submit()}>
            <Plus size={14} aria-hidden /> Add server
          </Button>
        </div>
      </Card>
    </Group>
  );
}
