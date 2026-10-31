import { useCallback, useEffect, useState } from 'react';
import { PanelRightClose, RefreshCw, Play, Trash2, Plus, Save, Check, X, History } from 'lucide-react';
import { MODELS, type Bot, type CauseKind, type ComputerStatus, type Routine, type RoutineRun, type Skill, type UsageGroup, type UsageRow } from '@pocketrocket/shared';
import { MONTHS, SCHEDULE_PRESETS, WEEKDAYS, cronToPreset, describeCron, presetToCron, zonedParts, type SchedulePreset, type ScheduleParts } from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom, type PanelTab } from '../store';
import { api } from '../lib/api';
import { isDesktopMode } from '../lib/auth';
import { Avatar, Badge, Button, Input, Label, Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, cn, fmtUsd } from './ui';
import { VoicePanel } from './VoicePanel';
import { SkillGitImport } from './SkillGitImport';
import { ControlBar, useControl } from './ComputerControl';

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
            <Select aria-label="Bot shown in this panel" className="h-8 flex-1 text-[12.5px]" value={bot.id} onChange={(e) => openPanel(panelTab, e.target.value)}>
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
          <TabsContent value="screen" className="h-full"><ScreenPane bot={bot} /></TabsContent>
          <TabsContent value="memory">{bot && <><MemoryTab botId={bot.id} /><VoicePanel botId={bot.id} /></>}</TabsContent>
          <TabsContent value="skills">{bot && <SkillsTab botId={bot.id} />}</TabsContent>
          <TabsContent value="routines"><RoutinesTab botId={bot?.id ?? null} /></TabsContent>
          <TabsContent value="usage"><UsageTab /></TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

function ScreenTab({ bot }: { bot?: Bot }) {
  const [st, setSt] = useState<{ screen: boolean; cdp: boolean; url: string } | null>(null);
  // P2: a new ticket when control changes, so the viewer switches between view-only and interactive.
  const ctl = useControl(bot?.id);
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
  }, [st?.screen, nonce, ctl.control]);
  const popOut = async () => {
    // Ticket first, then open: the desktop app hands new windows to the default browser by URL, so a blank
    // window that is pointed somewhere afterwards never gets anywhere. The click's user activation outlives
    // the round-trip in browsers, so the popup is still allowed.
    try { window.open((await api.screenTicket()).url, '_blank', 'width=1320,height=880'); } catch { /* hub unreachable */ }
  };
  // The desktop app always talks to a hub on this same computer, where no virtual screen exists by design.
  // Server setup steps and a red "down" dot would read as a fault there, so it gets a neutral note instead.
  const local = isDesktopMode();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className={cn('h-2 w-2 rounded-full', st?.screen ? 'bg-ok' : local ? 'bg-dim' : 'bg-bad')} />
        <span className="flex-1 text-muted">{st === null ? 'checking…' : st.screen ? 'Computer screen live' + (st.cdp ? ' · bots can drive it' : ' · CDP down') : local ? 'No virtual screen' : 'Screen not running'}</span>
        <Button size="sm" variant="ghost" title="Reload viewer" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={13} /></Button>
        <Button size="sm" variant="ghost" title="Bigger" onClick={() => setWide(!wide)}>{wide ? 'Fit' : 'Wide'}</Button>
        {st?.screen && <Button size="sm" onClick={popOut}>Pop out</Button>}
      </div>
      {st?.screen && bot && <div className="px-3 pb-2"><ControlBar bot={bot} /></div>}
      {st?.screen ? (
        <div className={cn('relative min-h-0 flex-1 bg-black', wide && 'overflow-auto')}>
          {src && <iframe key={nonce} title="Computer screen" src={src} className={cn('block border-0', wide ? 'h-[800px] w-[1280px]' : 'h-full w-full')} allow="clipboard-read; clipboard-write" />}
        </div>
      ) : local ? (
        <div className="flex flex-1 flex-col gap-2 p-4 text-xs text-muted">
          <p className="font-medium text-fg">Screen is available when PocketRocket Crew runs on a server.</p>
          <p>A server hub runs a live Chromium you can watch here: log into your accounts once, and bots with the <span className="font-mono">Browser</span> tool work inside that same logged-in browser.</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-2 p-4 text-xs text-muted">
          <p className="font-medium text-fg">No virtual screen on this computer.</p>
          <p>On the VPS the screen is a service: <code className="font-mono">systemctl status pocketrocket-crew-screen</code>. Set it up with <code className="font-mono">bash deploy/setup-vps.sh</code>.</p>
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
  const [showGit, setShowGit] = useState(false);
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
          <Button size="sm" variant="ghost" onClick={() => setShowGit(!showGit)} aria-expanded={showGit} title="Import skills from a git repo; they start pending review">From git</Button>
        </div>
      </div>
      {showGit && <SkillGitImport onDone={load} onClose={() => setShowGit(false)} />}

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
          <li key={s.id} className={cn('rounded-2xl bg-card2/60 p-2 text-xs', s.reviewStatus === 'pending' && 'border border-warn/40')}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={assigned.has(s.id)} onChange={() => toggle(s.id)} disabled={s.reviewStatus === 'pending'} aria-label={'Assign ' + s.name + ' to this bot'} title={s.reviewStatus === 'pending' ? 'Approve first' : 'Assign to this bot'} />
              <button className="min-w-0 flex-1 text-left" onClick={async () => setView(await api.skills.get(s.id))}>
                <div className="flex items-center gap-1.5"><span className="font-medium">{s.name}</span>
                  {s.source === 'bot' && <Badge tone={s.reviewStatus === 'pending' ? 'warn' : 'accent'}>{s.reviewStatus === 'pending' ? 'review' : 'by ' + (botById(bots, s.createdByBot)?.handle ?? 'bot')}</Badge>}
                  {s.source === 'imported' && (s.reviewStatus === 'pending' ? <Badge tone="warn">review</Badge> : <Badge>imported</Badge>)}
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

/** P3: a routine is edited as a preset plus a time; raw cron lives under "Advanced". Times read in settings.timezone. */
type RoutineForm = { open: boolean; id?: string; botId: string; roomId: string; name: string; prompt: string } & ScheduleParts;

const PRESET_LABEL: Record<SchedulePreset, string> = {
  once: 'Once', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year', custom: 'Custom (cron)',
};

/** An instant as the clock reads in `tz`: "2 Nov 2026, 09:00". */
function fmtIn(ms: number, tz: string) {
  return new Date(ms).toLocaleString(undefined, { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function scheduleLabel(r: Routine, tz: string) {
  return r.onceAt !== null ? 'Once, ' + fmtIn(r.onceAt, tz) : describeCron(r.cron);
}

function RoutinesTab({ botId }: { botId: string | null }) {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const toast = useStore((s) => s.toast);
  const tz = useStore((s) => s.settings.timezone);
  const rev = useStore((s) => s.routinesRev);
  const room = useStore(selectActiveRoom);
  const [list, setList] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<Record<string, RoutineRun[] | undefined>>({});
  const [advanced, setAdvanced] = useState(false);
  const blank = (): RoutineForm => ({
    open: false, botId: botId ?? bots[0]?.id ?? '', roomId: room?.id ?? rooms[0]?.id ?? '', name: '', prompt: '',
    preset: 'weekdays', time: '09:00', date: zonedParts(Date.now() + 86_400_000, tz).date, weekday: 1, monthDay: 1, month: 1, cron: '0 9 * * 1-5',
  });
  const [form, setForm] = useState<RoutineForm>(blank);
  const set = (patch: Partial<RoutineForm>) => setForm((f) => ({ ...f, ...patch }));

  // Refetch on routines.changed / routine.fired (a bot scheduled something, a run started), and any open history.
  useEffect(() => {
    void api.routines.list().then(setList);
    for (const id of Object.keys(runs)) if (runs[id]) void api.routines.runs(id).then((x) => setRuns((r) => ({ ...r, [id]: x })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
  const load = async () => setList(await api.routines.list());

  const openNew = () => {
    setAdvanced(false);
    setForm(form.open && !form.id ? { ...form, open: false } : { ...blank(), open: true });
  };
  const openEdit = (r: Routine) => {
    const base = { ...blank(), open: true, id: r.id, botId: r.botId, roomId: r.roomId, name: r.name, prompt: r.prompt };
    const sched = r.onceAt !== null ? { preset: 'once' as const, ...zonedParts(r.onceAt, tz) } : { ...cronToPreset(r.cron), cron: r.cron };
    setAdvanced(sched.preset === 'custom');
    setForm({ ...base, ...sched });
  };

  const save = async () => {
    try {
      const schedule = form.preset === 'once' ? { cron: '', onceAt: form.date + 'T' + form.time } : { cron: presetToCron(form), onceAt: null };
      const body = { botId: form.botId, roomId: form.roomId, name: form.name, prompt: form.prompt, enabled: true, ...schedule };
      if (form.id) await api.routines.update(form.id, body); else await api.routines.create(body);
      setForm({ ...blank(), open: false });
      await load();
    } catch (e) { toast((e as Error).message, true); }
  };
  const toggle = async (r: Routine) => {
    try { await api.routines.update(r.id, { enabled: !r.enabled }); } catch (e) { toast((e as Error).message, true); }
    await load();
  };
  const remove = async (r: Routine) => { if (confirm('Delete routine "' + r.name + '"?')) { await api.routines.remove(r.id); await load(); } };
  const run = async (r: Routine) => { await api.routines.run(r.id); toast('Routine fired'); };
  const toggleRuns = async (r: Routine) => {
    if (runs[r.id]) return setRuns((x) => ({ ...x, [r.id]: undefined }));
    const x = await api.routines.runs(r.id);
    setRuns((cur) => ({ ...cur, [r.id]: x }));
  };

  const rawCron = form.preset === 'custom' ? form.cron : presetToCron(form);
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const valid = !!form.name && !!form.prompt && !!form.botId && !!form.roomId &&
    (form.preset === 'once' ? !!form.date && !!form.time : form.preset === 'custom' ? form.cron.trim().split(/\s+/).length >= 5 : !!form.time);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <Label hint={'times in ' + tz}>Routines</Label>
        <Button size="sm" variant="ghost" onClick={openNew}><Plus size={13} /> New</Button>
      </div>
      {form.open && (
        <div className="flex flex-col gap-2 rounded-2xl bg-card2/60 p-2">
          <Input placeholder="Name" aria-label="Routine name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Bot" value={form.botId} onChange={(e) => set({ botId: e.target.value })}>{bots.map((b) => <option key={b.id} value={b.id}>{b.avatar} {b.name}</option>)}</Select>
            <Select aria-label="Room" value={form.roomId} onChange={(e) => set({ roomId: e.target.value })}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.kind === 'group' ? '# ' : ''}{r.name}</option>)}</Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select
              aria-label="Repeats"
              value={form.preset}
              onChange={(e) => {
                const preset = e.target.value as SchedulePreset;
                set(preset === 'custom' ? { preset, cron: rawCron || form.cron } : { preset });
                if (preset === 'custom') setAdvanced(true);
              }}
            >
              {SCHEDULE_PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
            </Select>
            {form.preset !== 'custom' && (
              <Input type="time" aria-label="Time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
            )}
          </div>
          {form.preset === 'once' && (
            <Input type="date" aria-label="Date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
          )}
          {form.preset === 'weekly' && (
            <Select aria-label="Day of the week" value={form.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>on {d}</option>)}
            </Select>
          )}
          {(form.preset === 'monthly' || form.preset === 'yearly') && (
            <div className={cn('grid gap-2', form.preset === 'yearly' && 'grid-cols-2')}>
              {form.preset === 'yearly' && (
                <Select aria-label="Month" value={form.month} onChange={(e) => set({ month: Number(e.target.value) })}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </Select>
              )}
              <Select aria-label="Day of the month" value={form.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })}>
                {days.map((d) => <option key={d} value={d}>day {d}</option>)}
              </Select>
            </div>
          )}
          {form.preset === 'monthly' && form.monthDay > 28 && (
            <p className="px-1 text-[11px] text-muted">Months without day {form.monthDay} are skipped.</p>
          )}
          <div>
            <button
              type="button"
              className="rounded-full px-1 text-[11px] text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? 'Hide advanced' : 'Advanced'}
            </button>
            {advanced && (
              <Input
                className="mt-1 font-mono"
                aria-label="Cron pattern (minute hour day-of-month month day-of-week)"
                placeholder="m h dom mon dow"
                disabled={form.preset === 'once'}
                value={form.preset === 'once' ? '' : rawCron}
                onChange={(e) => set({ preset: 'custom', cron: e.target.value })}
              />
            )}
          </div>
          <p className="px-1 text-[11px] text-dim">Times are in {tz}. Change the zone in Settings › Account.</p>
          <Textarea placeholder="Prompt the bot receives when the routine fires" aria-label="Prompt" rows={4} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => set({ open: false })}>Cancel</Button><Button size="sm" variant="primary" onClick={save} disabled={!valid}>{form.id ? 'Save' : 'Create'}</Button></div>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {list.map((r) => {
          const b = botById(bots, r.botId);
          const rm = rooms.find((x) => x.id === r.roomId);
          const history = runs[r.id];
          return (
            <li key={r.id} className={cn('rounded-2xl bg-card2/60 p-2 text-xs', !r.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} aria-label={'Routine ' + r.name + ' enabled'} title="Enabled" />
                <button className="min-w-0 flex-1 text-left" onClick={() => openEdit(r)}>
                  <div className="font-medium">{r.name}</div>
                  <div className="truncate text-muted">{scheduleLabel(r, tz)}</div>
                  <div className="truncate text-muted">{b?.avatar} @{b?.handle} in {rm?.name}{r.nextRunAt ? ' · next ' + fmtIn(r.nextRunAt, tz) : ''}</div>
                </button>
                <Button size="icon" variant="ghost" title="Run now" aria-label={'Run ' + r.name + ' now'} onClick={() => run(r)}><Play size={13} /></Button>
                <Button size="icon" variant="ghost" title="Run history" aria-label={'Run history for ' + r.name} aria-pressed={!!history} onClick={() => toggleRuns(r)}><History size={13} /></Button>
                <Button size="icon" variant="ghost" title="Delete" aria-label={'Delete ' + r.name} onClick={() => remove(r)}><Trash2 size={13} /></Button>
              </div>
              {history && (
                <ul className="mt-2 pt-1 text-[11px] text-muted">
                  {history.map((x) => (
                    <li key={x.id}>
                      {fmtIn(x.startedAt, tz)} · <span className={x.status === 'error' ? 'text-bad' : x.status === 'success' ? 'text-ok' : ''}>{x.status}</span>
                      {x.endedAt ? ' · ' + Math.max(1, Math.round((x.endedAt - x.startedAt) / 1000)) + 's' : ''}
                      {x.costUsd != null ? ' · ' + fmtUsd(x.costUsd) : ''}
                    </li>
                  ))}
                  {!history.length && <li>No runs yet.</li>}
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
  const [split, setSplit] = useState<{ byModel: UsageGroup[]; byCause: UsageGroup[] }>({ byModel: [], byCause: [] });
  const [health, setHealth] = useState<{ apiKeySource?: string; ok: boolean; error?: string; version?: string } | null>(null);
  useEffect(() => {
    api.usage().then((u) => { setRows(u.rows); setSplit({ byModel: u.byModel ?? [], byCause: u.byCause ?? [] }); });
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
      <UsageSplit split={split} />
      {health && (
        <div className="rounded-2xl bg-card2/60 p-2 text-[11px] text-muted">
          <div className="mb-1 text-[12px] font-medium text-muted">Hub</div>
          {/* Where the CLI lives is not on health any more (it spells out the home directory), and the
              version this endpoint reports is the hub's, so it gets its own line rather than trailing
              the CLI as if it were `claude --version`. */}
          <div>claude: {health.ok ? <Badge tone="ok">found</Badge> : <Badge tone="bad">missing</Badge>}</div>
          {health.version && <div>version: <span className="font-mono">{health.version}</span></div>}
          <div>auth: {health.apiKeySource ?? '(known after first turn)'}</div>
        </div>
      )}
    </div>
  );
}

// ---------- P8: usage by model and by cause ----------
const CAUSE_LABEL: Record<CauseKind, string> = {
  user: 'Your messages',
  bot: 'Bot hand-offs',
  routine: 'Routines',
  trigger: 'Triggers',
  memory: 'Auto-memory',
  reflection: 'Skill reflection',
};

/**
 * Where the spend went: which models ran, and what started the turns. Routines, triggers and auto-memory get
 * their own rows so automation cost is visible next to chat cost. '' is spend recorded before the hub kept this.
 */
function UsageSplit({ split }: { split: { byModel: UsageGroup[]; byCause: UsageGroup[] } }) {
  const providers = useStore((s) => s.providers);
  const modelLabel = (id: string) =>
    !id ? 'Not recorded' : (providers?.providers.flatMap((p) => p.models).find((m) => m.id === id)?.label ?? MODELS.find((m) => m.id === id)?.label ?? id);
  const causeLabel = (k: string) => (k ? CAUSE_LABEL[k as CauseKind] ?? k : 'Not recorded');
  const section = (title: string, groups: UsageGroup[], label: (k: string) => string, mono: boolean) => {
    if (!groups.length) return null;
    const total = groups.reduce((a, g) => a + g.costUsd, 0);
    return (
      <>
        <Label>{title}</Label>
        <ul className="flex flex-col gap-1">
          {groups.map((g) => (
            <li key={g.key || '-'} className="flex items-center gap-2 rounded-2xl bg-card2/60 px-2 py-1.5">
              <span className={cn('min-w-0 flex-1 truncate', mono && g.key ? 'font-mono text-[11.5px]' : 'font-medium', !g.key && 'text-muted')}>{label(g.key)}</span>
              <span className="text-muted">{g.turns} turns</span>
              {total > 0 && <span className="w-9 text-right text-dim">{Math.round((g.costUsd / total) * 100)}%</span>}
              <span className="font-mono">{fmtUsd(g.costUsd)}</span>
            </li>
          ))}
        </ul>
      </>
    );
  };
  return (
    <>
      {section('By model', split.byModel, modelLabel, true)}
      {section('By what started it', split.byCause, causeLabel, false)}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
// P1: per-bot computers. The Screen tab follows the panel's bot. On a hub without per-bot computers (the
// desktop app, or a server with them off) it is the shared ScreenTab above, unchanged.

/** Whether this hub has per-bot computers. A hub-wide fact, so it is asked once per page load. */
let perBotHub: boolean | null = null;

function ScreenPane({ bot }: { bot?: Bot }) {
  const [perBot, setPerBot] = useState<boolean | null>(perBotHub);
  useEffect(() => {
    if (perBotHub !== null || !bot) return;
    let alive = true;
    api.screen(bot.id)
      .then((s) => { perBotHub = !!s.computer?.perBot; if (alive) setPerBot(perBotHub); })
      .catch(() => alive && setPerBot(false));
    return () => { alive = false; };
  }, [bot]);
  if (perBot === null && bot) return <div className="px-3 py-2 text-xs text-muted">checking…</div>;
  return perBot && bot ? <BotScreen key={bot.id} bot={bot} /> : <ScreenTab bot={bot} />;
}

const gbText = (b: number) => (b / 1024 ** 3).toFixed(1) + ' GB';

function BotScreen({ bot }: { bot: Bot }) {
  const toast = useStore((s) => s.toast);
  const [info, setInfo] = useState<{ screen: boolean; cdp: boolean; computer: ComputerStatus } | null>(null);
  const [waking, setWaking] = useState(false);
  const [src, setSrc] = useState('');
  const [nonce, setNonce] = useState(0);
  const [wide, setWide] = useState(false);
  const c = info?.computer;
  const state = waking && c?.state === 'asleep' ? 'starting' : c?.state;
  const live = state === 'live' && !!info?.screen;
  // P2: a new ticket when control changes, so the viewer switches between view-only and interactive.
  const ctl = useControl(bot.id);

  const refresh = useCallback(async () => {
    try {
      const s = await api.screen(bot.id);
      if (s.computer) setInfo({ screen: s.screen, cdp: s.cdp, computer: s.computer });
    } catch { /* hub unreachable: keep the last state */ }
  }, [bot.id]);
  // Poll faster while a start is in flight, so "starting" turns into the live screen promptly.
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, state === 'starting' ? 1500 : 10000);
    return () => clearInterval(id);
  }, [refresh, state]);
  // Same ticket scheme as the shared screen, scoped to this bot: the cookie it buys opens no other screen.
  useEffect(() => {
    if (!live) { setSrc(''); return; }
    let alive = true;
    api.screenTicket(bot.id).then((t) => alive && setSrc(t.url)).catch(() => alive && setSrc(''));
    return () => { alive = false; };
  }, [live, nonce, bot.id, ctl.control]);

  const wake = async () => {
    setWaking(true);
    try {
      const s = await api.computers.wake(bot.id);
      if (s.reason && s.state === 'asleep') toast("Couldn't wake " + bot.name + "'s computer: " + s.reason, true);
    } catch (e) {
      toast("Couldn't wake " + bot.name + "'s computer: " + (e as Error).message, true);
    } finally {
      setWaking(false);
      void refresh();
    }
  };
  const setKeepAwake = async (on: boolean) => {
    try {
      const s = await api.computers.keepAwake(bot.id, on);
      setInfo((cur) => (cur ? { ...cur, computer: s } : cur));
    } catch (e) {
      toast("Couldn't change Keep awake: " + (e as Error).message, true);
    }
  };
  const popOut = async () => {
    try { window.open((await api.screenTicket(bot.id)).url, '_blank', 'width=1320,height=880'); } catch { /* hub unreachable */ }
  };

  const used = c && c.quotaBytes > 0 ? c.diskBytes / c.quotaBytes : 0;
  const label = state === undefined ? 'checking…' : state === 'live' ? (info?.screen ? 'Live' + (info.cdp ? '' : ' · browser not answering') : 'Live · connecting') : state === 'starting' ? 'Starting…' : 'Asleep';
  const hasTools = bot.allowedTools.includes('Browser') || bot.allowedTools.includes('Desktop');
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span aria-hidden className={cn('h-2 w-2 rounded-full', state === 'live' ? 'bg-ok' : state === 'starting' ? 'bg-warn' : 'bg-dim')} />
        <span className="flex-1 text-muted" role="status" aria-live="polite">{bot.name}'s computer: {label}</span>
        {c && c.slot !== null && (
          <Badge tone={used >= 1 ? 'bad' : used >= 0.8 ? 'warn' : 'muted'}>
            <span title="Disk used by this computer (soft quota)">{gbText(c.diskBytes)} / {gbText(c.quotaBytes)}</span>
          </Badge>
        )}
        {live && (
          <>
            <Button size="sm" variant="ghost" title="Reload viewer" aria-label="Reload viewer" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={13} /></Button>
            <Button size="sm" variant="ghost" title="Bigger" onClick={() => setWide(!wide)}>{wide ? 'Fit' : 'Wide'}</Button>
            <Button size="sm" onClick={popOut}>Pop out</Button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 pb-2 text-xs">
        {state !== 'live' && (
          <Button size="sm" onClick={wake} disabled={state === 'starting' || state === undefined}>{state === 'starting' ? 'Waking…' : 'Wake'}</Button>
        )}
        <span id="keep-awake-label" className="ml-auto text-muted">Keep awake</span>
        <Switch aria-labelledby="keep-awake-label" checked={!!c?.keepAwake} onChange={(on) => void setKeepAwake(on)} />
      </div>
      <div className="px-3 pb-2"><ControlBar bot={bot} /></div>
      {live ? (
        <div className={cn('relative min-h-0 flex-1 bg-black', wide && 'overflow-auto')}>
          {src && <iframe key={nonce} title={bot.name + "'s computer screen"} src={src} className={cn('block border-0', wide ? 'h-[800px] w-[1280px]' : 'h-full w-full')} allow="clipboard-read; clipboard-write" />}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-2 p-4 text-xs text-muted">
          {state === 'starting' ? (
            <p className="font-medium text-fg">Starting {bot.name}'s computer. This takes a few seconds.</p>
          ) : (
            <>
              <p className="font-medium text-fg">{bot.name}'s computer is asleep.</p>
              <p>{hasTools
                ? 'It wakes by itself when ' + bot.name + ' uses the Browser or Desktop tool, or press Wake to log into accounts for it. It goes back to sleep after a while with nothing to do; its disk and logins are kept.'
                : bot.name + ' has no Browser or Desktop tool, so it does not use this computer on its own. You can still wake it, for example to log into accounts before you give it those tools.'}</p>
            </>
          )}
          {c?.reason && state !== 'live' && <p className="text-bad">{c.reason}</p>}
          {used >= 0.8 && <p className="text-warn">The disk is {Math.round(used * 100)}% full. At 100% the computer will not start.</p>}
        </div>
      )}
      <div className="px-3 py-2 text-[11px] text-dim">
        Each bot has its own screen, Chromium profile and disk; its desktop links the shared workspace as <span className="font-mono">~/Shared</span>. They are separate, not private: every bot runs as the same user on the server, so a bot with shell access can read another bot's files and logins.
      </div>
    </div>
  );
}
