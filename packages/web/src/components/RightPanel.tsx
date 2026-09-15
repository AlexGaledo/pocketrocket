import { useEffect, useState } from 'react';
import { PanelRightClose, RefreshCw, Play, Trash2, Plus, Save, Check, X } from 'lucide-react';
import type { Routine, RoutineRun, Skill, UsageRow } from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom, type PanelTab } from '../store';
import { api } from '../lib/api';
import { Avatar, Badge, Button, Input, Label, Select, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, cn, fmtUsd } from './ui';

export function RightPanel() {
  const bots = useStore((s) => s.bots);
  const botStates = useStore((s) => s.botStates);
  const panelTab = useStore((s) => s.panelTab);
  const panelBotId = useStore((s) => s.panelBotId);
  const openPanel = useStore((s) => s.openPanel);
  const closePanel = useStore((s) => s.closePanel);
  const room = useStore(selectActiveRoom);
  const bot = botById(bots, panelBotId) ?? bots[0];

  return (
    <aside className="panel flex w-[340px] shrink-0 flex-col overflow-hidden">
      <div className="flex h-12 items-center gap-2 px-3 pt-1">
        {bot ? (
          <>
            <Avatar bot={bot} state={botStates[bot.id]} size={28} />
            <Select className="h-8 flex-1 text-[12.5px]" value={bot.id} onChange={(e) => openPanel(panelTab, e.target.value)}>
              {(room ? bots.filter((b) => room.memberIds.includes(b.id)).concat(bots.filter((b) => !room.memberIds.includes(b.id))) : bots).map((b) => (
                <option key={b.id} value={b.id}>{b.avatar} {b.name}{room && !room.memberIds.includes(b.id) ? ' (not in room)' : ''}</option>
              ))}
            </Select>
          </>
        ) : (
          <span className="flex-1 text-sm text-muted">No bot</span>
        )}
        <Button variant="ghost" size="icon" onClick={closePanel} title="Close panel"><PanelRightClose size={16} /></Button>
      </div>
      <Tabs value={panelTab} onValueChange={(v) => openPanel(v as PanelTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="screen">Screen</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="routines">Routines</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabsContent value="screen" className="h-full"><ScreenTab /></TabsContent>
          <TabsContent value="memory">{bot && <MemoryTab botId={bot.id} />}</TabsContent>
          <TabsContent value="skills">{bot && <SkillsTab botId={bot.id} />}</TabsContent>
          <TabsContent value="routines"><RoutinesTab botId={bot?.id ?? null} /></TabsContent>
          <TabsContent value="usage"><UsageTab /></TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

function ScreenTab() {
  const [st, setSt] = useState<{ screen: boolean; cdp: boolean; url: string } | null>(null);
  const [src, setSrc] = useState('');
  const [nonce, setNonce] = useState(0);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () => api.screen().then((s) => alive && setSt(s)).catch(() => alive && setSt({ screen: false, cdp: false, url: '' }));
    tick();
    const id = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  // An iframe cannot send an Authorization header, so the hub token used to ride this URL. Instead each
  // viewer load spends the token on a single-use ticket, which /screen/session trades for an httpOnly
  // cookie scoped to /screen — the token never enters an iframe src or a popup URL.
  useEffect(() => {
    if (!st?.screen) { setSrc(''); return; }
    let alive = true;
    api.screenTicket().then((t) => alive && setSrc(t.url)).catch(() => alive && setSrc(''));
    return () => { alive = false; };
  }, [st?.screen, nonce]);
  const popOut = async () => {
    // Ticket first, then open: the desktop app hands new windows to the default browser by URL, so a blank
    // window that is pointed somewhere afterwards never gets anywhere. The click's user activation outlives
    // the round-trip in browsers, so the popup is still allowed.
    try { window.open((await api.screenTicket()).url, '_blank', 'width=1320,height=880'); } catch { /* hub unreachable */ }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className={cn('h-2 w-2 rounded-full', st?.screen ? 'bg-ok' : 'bg-bad')} />
        <span className="flex-1 text-muted">{st === null ? 'checking…' : st.screen ? 'Computer screen live' + (st.cdp ? ' · bots can drive it' : ' · CDP down') : 'Screen not running'}</span>
        <Button size="sm" variant="ghost" title="Reload viewer" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={13} /></Button>
        <Button size="sm" variant="ghost" title="Bigger" onClick={() => setWide(!wide)}>{wide ? 'Fit' : 'Wide'}</Button>
        {st?.screen && <Button size="sm" onClick={popOut}>Pop out</Button>}
      </div>
      {st?.screen ? (
        <div className={cn('relative min-h-0 flex-1 bg-black', wide && 'overflow-auto')}>
          {src && <iframe key={nonce} title="Computer screen" src={src} className={cn('block border-0', wide ? 'h-[800px] w-[1280px]' : 'h-full w-full')} allow="clipboard-read; clipboard-write" />}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-2 p-4 text-xs text-muted">
          <p className="font-medium text-fg">No virtual screen on this computer.</p>
          <p>On the VPS the screen is a service: <code className="font-mono">systemctl status pocketrocket-screen</code>. Set it up with <code className="font-mono">bash deploy/setup-vps.sh</code>.</p>
          <p>When it runs you get a live Chromium here: log into your accounts once, then give bots the <span className="font-mono">Browser</span> tool and they work inside that same logged-in browser while you watch.</p>
        </div>
      )}
      {st?.screen && (
        <div className="px-3 py-2 text-[11px] text-dim">
          Click inside to use the desktop. Desktop folder = shared workspace; settings persist in <span className="font-mono">data/desktop-home</span>, logins in <span className="font-mono">data/browser-profile</span>. Bots with <span className="font-mono">Browser</span> drive this Chrome; bots with <span className="font-mono">Desktop</span> can see and click the whole screen.
        </div>
      )}
    </div>
  );
}

function MemoryTab({ botId }: { botId: string }) {
  const live = useStore((s) => s.memory[botId]);
  const toast = useStore((s) => s.toast);
  const room = useStore(selectActiveRoom);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    api.bots.memory(botId).then((r) => { setText(r.text); setDirty(false); }).catch(() => undefined);
  }, [botId]);
  useEffect(() => {
    if (live !== undefined && !dirty) setText(live);
  }, [live, dirty]);
  const save = async () => {
    // On failure the edit stays dirty, so nothing the user typed is lost and Save stays available.
    try {
      await api.bots.setMemory(botId, text);
      setDirty(false);
      toast('Memory saved');
    } catch (e) {
      toast("Couldn't save memory: " + (e as Error).message, true);
    }
  };
  const reset = async () => {
    if (!room) return;
    if (!confirm('Reset this bot\'s conversation session in this room? Memory.md is kept; the SDK transcript for this room starts fresh.')) return;
    await api.bots.resetSession(botId, room.id);
    toast('Session reset for this room');
  };
  return (
    <div className="flex flex-col gap-2 p-3">
      <Label hint="only this bot sees it, on every turn">Memory</Label>
      <Textarea value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} rows={18} className="font-mono text-[12px]" placeholder="Empty. The bot writes here via update_memory, or you can edit directly." />
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={reset} title="Forget the SDK transcript for the active room"><RefreshCw size={13} /> Reset room session</Button>
        <Button size="sm" variant="primary" onClick={save} disabled={!dirty}><Save size={13} /> Save</Button>
      </div>
    </div>
  );
}

function SkillsTab({ botId }: { botId: string }) {
  const toast = useStore((s) => s.toast);
  const bots = useStore((s) => s.bots);
  const [pool, setPool] = useState<Skill[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [importable, setImportable] = useState<{ name: string; description: string }[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [view, setView] = useState<(Skill & { markdown: string }) | null>(null);
  const [nw, setNw] = useState({ name: '', description: '', markdown: '' });

  const load = async () => {
    try {
      const [p, a, i] = await Promise.all([api.skills.list(), api.bots.skills(botId), api.skills.importable()]);
      setPool(p); setAssigned(new Set(a)); setImportable(i);
    } catch (e) {
      toast("Couldn't load skills: " + (e as Error).message, true);
    }
  };
  useEffect(() => { void load(); }, [botId]);

  const toggle = async (id: string) => {
    const prev = assigned;
    const next = new Set(assigned);
    if (next.has(id)) next.delete(id); else next.add(id);
    setAssigned(next);
    try {
      await api.bots.setSkills(botId, [...next]);
    } catch (e) {
      // The checkbox flipped optimistically; put it back so it matches what the hub actually has.
      setAssigned(prev);
      toast("Couldn't update skills: " + (e as Error).message, true);
    }
  };
  const doImport = async (names: string[]) => {
    await api.skills.import(names);
    toast('Imported ' + names.length + ' skill' + (names.length === 1 ? '' : 's'));
    setShowImport(false);
    await load();
  };
  const review = async (s: Skill, status: 'approved' | 'pending') => { await api.skills.review(s.id, status); await load(); };
  const remove = async (s: Skill) => { if (confirm('Delete skill "' + s.name + '" from the pool?')) { await api.skills.remove(s.id); await load(); } };
  const createSkill = async () => {
    try { await api.skills.create(nw.name, nw.description, nw.markdown); setShowNew(false); setNw({ name: '', description: '', markdown: '' }); await load(); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <Label hint={assigned.size + " assigned to this bot"}>Skills</Label>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setShowNew(!showNew)}><Plus size={13} /> New</Button>
          <Button size="sm" variant="ghost" onClick={() => setShowImport(!showImport)} disabled={!importable.length} title={importable.length ? 'Import from ~/.claude/skills' : 'Nothing left to import'}>Import ({importable.length})</Button>
        </div>
      </div>

      {showNew && (
        <div className="flex flex-col gap-2 rounded-2xl bg-card2/60 p-2">
          <Input placeholder="name (kebab-case)" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
          <Input placeholder="description: when to use it" value={nw.description} onChange={(e) => setNw({ ...nw, description: e.target.value })} />
          <Textarea placeholder="Instructions (markdown)" rows={6} value={nw.markdown} onChange={(e) => setNw({ ...nw, markdown: e.target.value })} className="font-mono text-[12px]" />
          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button><Button size="sm" variant="primary" onClick={createSkill} disabled={!nw.name || !nw.markdown}>Create</Button></div>
        </div>
      )}
      {showImport && (
        <div className="max-h-64 overflow-y-auto rounded-2xl bg-card2/60 p-1">
          <div className="flex justify-end px-1 py-1"><Button size="sm" variant="ghost" onClick={() => doImport(importable.map((i) => i.name))}>Import all</Button></div>
          {importable.map((i) => (
            <div key={i.name} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-card2">
              <div className="min-w-0 flex-1"><div className="font-medium">{i.name}</div><div className="truncate text-muted">{i.description}</div></div>
              <Button size="sm" onClick={() => doImport([i.name])}>Import</Button>
            </div>
          ))}
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {pool.map((s) => (
          <li key={s.id} className={cn('rounded-2xl bg-card2/60 p-2 text-xs', s.reviewStatus === 'pending' && 'border-warn/40')}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={assigned.has(s.id)} onChange={() => toggle(s.id)} disabled={s.reviewStatus === 'pending'} title={s.reviewStatus === 'pending' ? 'Approve first' : 'Assign to this bot'} />
              <button className="min-w-0 flex-1 text-left" onClick={async () => setView(await api.skills.get(s.id))}>
                <div className="flex items-center gap-1.5"><span className="font-medium">{s.name}</span>
                  {s.source === 'bot' && <Badge tone={s.reviewStatus === 'pending' ? 'warn' : 'accent'}>{s.reviewStatus === 'pending' ? 'review' : 'by ' + (botById(bots, s.createdByBot)?.handle ?? 'bot')}</Badge>}
                  {s.source === 'imported' && <Badge>imported</Badge>}
                </div>
                <div className="truncate text-muted">{s.description}</div>
              </button>
              {s.reviewStatus === 'pending' ? (
                <>
                  <Button size="icon" variant="ghost" title="Approve" onClick={() => review(s, 'approved')}><Check size={13} className="text-ok" /></Button>
                  <Button size="icon" variant="ghost" title="Reject & delete" onClick={() => remove(s)}><X size={13} className="text-bad" /></Button>
                </>
              ) : (
                <Button size="icon" variant="ghost" title="Delete from pool" onClick={() => remove(s)}><Trash2 size={13} /></Button>
              )}
            </div>
          </li>
        ))}
        {!pool.length && <li className="py-4 text-center text-xs text-dim">Pool is empty. Import your skills or create one.</li>}
      </ul>

      {view && (
        <div className="rounded-2xl bg-card2/60 p-2">
          <div className="mb-1 flex items-center justify-between text-xs"><span className="font-medium">{view.name}/SKILL.md</span><Button size="sm" variant="ghost" onClick={() => setView(null)}>Close</Button></div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{view.markdown}</pre>
        </div>
      )}
    </div>
  );
}

function RoutinesTab({ botId }: { botId: string | null }) {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const toast = useStore((s) => s.toast);
  const room = useStore(selectActiveRoom);
  const [list, setList] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<Record<string, RoutineRun[]>>({});
  const [form, setForm] = useState<{ open: boolean; id?: string; botId: string; roomId: string; name: string; cron: string; prompt: string }>({ open: false, botId: botId ?? '', roomId: room?.id ?? '', name: '', cron: '0 9 * * 1-5', prompt: '' });
  const load = async () => setList(await api.routines.list());
  useEffect(() => { void load(); }, []);

  const save = async () => {
    try {
      const body = { botId: form.botId, roomId: form.roomId, name: form.name, cron: form.cron, prompt: form.prompt, enabled: true };
      if (form.id) await api.routines.update(form.id, body); else await api.routines.create(body);
      setForm({ ...form, open: false, id: undefined, name: '', prompt: '' });
      await load();
    } catch (e) { toast((e as Error).message, true); }
  };
  const toggle = async (r: Routine) => { await api.routines.update(r.id, { enabled: !r.enabled }); await load(); };
  const remove = async (r: Routine) => { if (confirm('Delete routine "' + r.name + '"?')) { await api.routines.remove(r.id); await load(); } };
  const run = async (r: Routine) => { await api.routines.run(r.id); toast('Routine fired'); setTimeout(() => api.routines.runs(r.id).then((x) => setRuns({ ...runs, [r.id]: x })), 500); };
  const showRuns = async (r: Routine) => setRuns({ ...runs, [r.id]: runs[r.id] ? undefined as never : await api.routines.runs(r.id) });

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <Label hint="cron, VPS local time">Routines</Label>
        <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, open: !form.open, id: undefined, botId: botId ?? bots[0]?.id ?? '', roomId: room?.id ?? rooms[0]?.id ?? '' })}><Plus size={13} /> New</Button>
      </div>
      {form.open && (
        <div className="flex flex-col gap-2 rounded-2xl bg-card2/60 p-2">
          <Input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Select value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })}>{bots.map((b) => <option key={b.id} value={b.id}>{b.avatar} {b.name}</option>)}</Select>
            <Select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.kind === 'group' ? '# ' : ''}{r.name}</option>)}</Select>
          </div>
          <Input placeholder="cron: m h dom mon dow" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} className="font-mono" />
          <Textarea placeholder="Prompt the bot receives when the routine fires" rows={4} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setForm({ ...form, open: false })}>Cancel</Button><Button size="sm" variant="primary" onClick={save} disabled={!form.name || !form.prompt || !form.botId || !form.roomId}>{form.id ? 'Save' : 'Create'}</Button></div>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {list.map((r) => {
          const b = botById(bots, r.botId);
          const rm = rooms.find((x) => x.id === r.roomId);
          return (
            <li key={r.id} className={cn('rounded-2xl bg-card2/60 p-2 text-xs', !r.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} title="Enabled" />
                <button className="min-w-0 flex-1 text-left" onClick={() => setForm({ open: true, id: r.id, botId: r.botId, roomId: r.roomId, name: r.name, cron: r.cron, prompt: r.prompt })}>
                  <div className="font-medium">{r.name} <span className="font-mono text-muted">{r.cron}</span></div>
                  <div className="truncate text-muted">{b?.avatar} @{b?.handle} in {rm?.name}{r.nextRunAt ? ' · next ' + new Date(r.nextRunAt).toLocaleString() : ''}</div>
                </button>
                <Button size="icon" variant="ghost" title="Run now" onClick={() => run(r)}><Play size={13} /></Button>
                <Button size="icon" variant="ghost" title="Runs" onClick={() => showRuns(r)}><RefreshCw size={13} /></Button>
                <Button size="icon" variant="ghost" title="Delete" onClick={() => remove(r)}><Trash2 size={13} /></Button>
              </div>
              {runs[r.id] && (
                <ul className="mt-2 pt-1 text-[11px] text-muted">
                  {runs[r.id].map((x) => <li key={x.id}>{new Date(x.startedAt).toLocaleString()} · <span className={x.status === 'error' ? 'text-bad' : x.status === 'success' ? 'text-ok' : ''}>{x.status}</span>{x.costUsd != null ? ' · ' + fmtUsd(x.costUsd) : ''}</li>)}
                  {!runs[r.id].length && <li>No runs yet.</li>}
                </ul>
              )}
            </li>
          );
        })}
        {!list.length && <li className="py-4 text-center text-xs text-dim">No routines. Schedule a bot to wake up on its own.</li>}
      </ul>
    </div>
  );
}

function UsageTab() {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const live = useStore((s) => s.usage);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [health, setHealth] = useState<{ apiKeySource?: string; claudeExe: string; ok: boolean; error?: string; version?: string } | null>(null);
  useEffect(() => {
    api.usage().then((u) => setRows(u.rows));
    api.health().then(setHealth).catch(() => undefined);
  }, [live]);
  const total = rows.reduce((a, r) => a + r.costUsd, 0);
  const byBot = bots.map((b) => ({ b, cost: rows.filter((r) => r.botId === b.id).reduce((a, r) => a + r.costUsd, 0), turns: rows.filter((r) => r.botId === b.id).reduce((a, r) => a + r.turns, 0) }));
  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="rounded-2xl bg-card2/60 p-3">
        <div className="text-[12px] font-medium text-muted">Estimated usage, all time</div>
        <div className="text-2xl font-semibold">≈{fmtUsd(total)}</div><div className="mt-1 text-[11.5px] text-dim">API list-price equivalent. Your subscription is not billed per token; this shows how much of your plan limits the bots consume and feeds the runaway caps.</div>
        <div className="text-muted">{rows.reduce((a, r) => a + r.turns, 0)} turns</div>
      </div>
      <Label>By bot</Label>
      <ul className="flex flex-col gap-1">
        {byBot.map(({ b, cost, turns }) => (
          <li key={b.id} className="flex items-center gap-2 rounded-2xl bg-card2/60 px-2 py-1.5">
            <span>{b.avatar}</span><span className="flex-1 font-medium">{b.name}</span><span className="text-muted">{turns} turns</span><span className="font-mono">{fmtUsd(cost)}</span>
          </li>
        ))}
      </ul>
      <Label>By room</Label>
      <ul className="flex flex-col gap-1">
        {rooms.map((r) => {
          const c = rows.filter((x) => x.roomId === r.id).reduce((a, x) => a + x.costUsd, 0);
          return <li key={r.id} className="flex items-center gap-2 rounded-2xl bg-card2/60 px-2 py-1.5"><span className="flex-1">{r.kind === 'group' ? '# ' : ''}{r.name}</span><span className="font-mono">{fmtUsd(c)}</span></li>;
        })}
      </ul>
      {health && (
        <div className="rounded-2xl bg-card2/60 p-2 text-[11px] text-muted">
          <div className="mb-1 text-[12px] font-medium text-muted">Hub</div>
          <div>claude: <span className="font-mono" title={health.claudeExe}>{health.claudeExe.split(/[\\/]/).pop()}{health.version ? ` · ${health.version}` : ''}</span> {health.ok ? <Badge tone="ok">found</Badge> : <Badge tone="bad">missing</Badge>}</div>
          <div>auth: {health.apiKeySource ?? '(known after first turn)'}</div>
        </div>
      )}
    </div>
  );
}
