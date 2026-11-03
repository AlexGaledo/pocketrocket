// The fleet pages: Automations and Usage across every bot. They cover the chat in the main pane; the chat stays
// mounted behind them, so a draft and the scroll position are still there on the way back. RoutinesSection is also
// the Automations tab of the Bot page, filtered to that bot.
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, History, Play, Plus, Trash2 } from 'lucide-react';
import { MODELS, type CauseKind, type Routine, type RoutineRun, type UsageGroup, type UsageRow } from '@pocketrocket/shared';
import { MONTHS, SCHEDULE_PRESETS, WEEKDAYS, cronToPreset, describeCron, presetToCron, zonedParts, type SchedulePreset, type ScheduleParts } from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom } from '../store';
import { api } from '../lib/api';
import { Avatar, Button, Input, Label, Select, Textarea, cn, fmtUsd } from './ui';
import { TriggersSection } from './TriggersSection';

/** The scrolling column under a page's header, as wide as the chat column. */
export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
      <div className="mx-auto w-full max-w-[var(--page-max)]">{children}</div>
    </div>
  );
}

function FleetHeader({ title, sub }: { title: string; sub: string }) {
  const closePage = useStore((s) => s.closePage);
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 px-5">
      <Button variant="ghost" size="icon" title="Back to chat" aria-label="Back to chat" onClick={closePage}><ArrowLeft size={16} /></Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-body font-semibold">{title}</h1>
        <div className="truncate text-hint text-muted">{sub}</div>
      </div>
    </header>
  );
}

export function AutomationsPage() {
  return (
    <>
      <FleetHeader title="Automations" sub="Schedules and triggers, all bots" />
      <PageBody><RoutinesSection botId={null} /><TriggersSection botId={null} /></PageBody>
    </>
  );
}

export function UsagePage() {
  return (
    <>
      <FleetHeader title="Usage" sub="All bots and chats" />
      <PageBody><UsageSection /></PageBody>
    </>
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

/** Every bot's schedules, or one bot's when `botId` is set (which also starts a new schedule on that bot). */
export function RoutinesSection({ botId }: { botId: string | null }) {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const toast = useStore((s) => s.toast);
  const tz = useStore((s) => s.settings.timezone);
  const rev = useStore((s) => s.routinesRev);
  const room = useStore(selectActiveRoom);
  const [all, setAll] = useState<Routine[]>([]);
  const list = botId ? all.filter((r) => r.botId === botId) : all;
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
    void api.routines.list().then(setAll);
    for (const id of Object.keys(runs)) if (runs[id]) void api.routines.runs(id).then((x) => setRuns((r) => ({ ...r, [id]: x })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
  const load = async () => setAll(await api.routines.list());

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
  const remove = async (r: Routine) => { if (confirm('Delete schedule "' + r.name + '"?')) { await api.routines.remove(r.id); await load(); } };
  const run = async (r: Routine) => { await api.routines.run(r.id); toast('Schedule started'); };
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
        <Label hint={'times in ' + tz}>Schedules</Label>
        <Button size="sm" variant="ghost" onClick={openNew}><Plus size={13} /> New</Button>
      </div>
      {form.open && (
        <div className="flex flex-col gap-2 rounded-lg bg-card2/60 p-2">
          <Input placeholder="Name" aria-label="Schedule name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
            <Select aria-label="Bot" value={form.botId} onChange={(e) => set({ botId: e.target.value })}>{bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
            <Select aria-label="Chat" value={form.roomId} onChange={(e) => set({ roomId: e.target.value })}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.kind === 'group' ? '# ' : ''}{r.name}</option>)}</Select>
          </div>
          <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
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
            <p className="px-1 text-hint text-muted">Months without day {form.monthDay} are skipped.</p>
          )}
          <div>
            <button
              type="button"
              className="rounded-sm px-1 text-hint text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
          <Textarea placeholder="What should the bot do?" aria-label="Prompt" rows={4} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => set({ open: false })}>Cancel</Button><Button size="sm" variant="primary" onClick={save} disabled={!valid}>{form.id ? 'Save' : 'Create'}</Button></div>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {list.map((r) => {
          const b = botById(bots, r.botId);
          const rm = rooms.find((x) => x.id === r.roomId);
          const history = runs[r.id];
          return (
            <li key={r.id} className={cn('rounded-lg bg-card2/60 p-2 text-hint', !r.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} aria-label={'Schedule ' + r.name + ' enabled'} title="Enabled" />
                <button className="min-w-0 flex-1 text-left" onClick={() => openEdit(r)}>
                  <div className="truncate font-medium">{r.name}</div>
                  <div className="truncate text-muted">{scheduleLabel(r, tz)}</div>
                  <div className="truncate text-muted">@{b?.handle} in {rm?.name}{r.nextRunAt ? ' · next ' + fmtIn(r.nextRunAt, tz) : ''}{r.lastRunAt ? ' · last ' + fmtIn(r.lastRunAt, tz) : ''}</div>
                </button>
                <Button size="icon" variant="ghost" title="Run now. This does real work." aria-label={'Run ' + r.name + ' now'} onClick={() => run(r)}><Play size={13} /></Button>
                <Button size="icon" variant="ghost" title="Run history" aria-label={'Run history for ' + r.name} aria-pressed={!!history} onClick={() => toggleRuns(r)}><History size={13} /></Button>
                <Button size="icon" variant="ghost" title="Delete" aria-label={'Delete ' + r.name} onClick={() => remove(r)}><Trash2 size={13} /></Button>
              </div>
              {history && (
                <ul className="mt-2 pt-1 text-hint text-muted">
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
        {!list.length && <li className="py-4 text-center text-hint text-dim">No schedules. Run a bot on a timer.</li>}
      </ul>
    </div>
  );
}

function UsageSection() {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const live = useStore((s) => s.usage);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [split, setSplit] = useState<{ byModel: UsageGroup[]; byCause: UsageGroup[] }>({ byModel: [], byCause: [] });
  useEffect(() => {
    api.usage().then((u) => { setRows(u.rows); setSplit({ byModel: u.byModel ?? [], byCause: u.byCause ?? [] }); });
  }, [live]);
  const total = rows.reduce((a, r) => a + r.costUsd, 0);
  const byBot = bots.map((b) => ({ b, cost: rows.filter((r) => r.botId === b.id).reduce((a, r) => a + r.costUsd, 0), turns: rows.filter((r) => r.botId === b.id).reduce((a, r) => a + r.turns, 0) }));
  return (
    <div className="flex flex-col gap-3 p-3 text-hint">
      <div className="rounded-lg bg-card2/60 p-3">
        <div className="text-label text-muted">Estimated usage, all time</div>
        <div className="text-title">≈{fmtUsd(total)}</div><div className="mt-1 text-hint text-dim">API-price estimate. Claude plans aren't charged this.</div>
        <div className="text-muted">{rows.reduce((a, r) => a + r.turns, 0)} replies</div>
      </div>
      <Label>By bot</Label>
      <ul className="flex flex-col gap-1">
        {byBot.map(({ b, cost, turns }) => (
          <li key={b.id} className="flex items-center gap-2 rounded-lg bg-card2/60 px-2 py-1.5">
            <span aria-hidden className="shrink-0"><Avatar bot={b} size={20} /></span><span className="min-w-0 flex-1 truncate font-medium">{b.name}</span><span className="shrink-0 text-muted">{turns} replies</span><span className="shrink-0 font-mono">{fmtUsd(cost)}</span>
          </li>
        ))}
      </ul>
      <Label>By chat</Label>
      <ul className="flex flex-col gap-1">
        {rooms.map((r) => {
          const c = rows.filter((x) => x.roomId === r.id).reduce((a, x) => a + x.costUsd, 0);
          return <li key={r.id} className="flex items-center gap-2 rounded-lg bg-card2/60 px-2 py-1.5"><span className="min-w-0 flex-1 truncate">{r.kind === 'group' ? '# ' : ''}{r.name}</span><span className="shrink-0 font-mono">{fmtUsd(c)}</span></li>;
        })}
      </ul>
      <UsageSplit split={split} />
    </div>
  );
}

// ---------- P8: usage by model and by cause ----------
const CAUSE_LABEL: Record<CauseKind, string> = {
  user: 'Your messages',
  bot: 'Passed between bots',
  routine: 'Schedules',
  trigger: 'Triggers',
  training: 'Training',
  memory: 'Auto-memory',
  reflection: 'Skill fixes',
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
            <li key={g.key || '-'} className="flex items-center gap-2 rounded-lg bg-card2/60 px-2 py-1.5">
              <span className={cn('min-w-0 flex-1 truncate', mono && g.key ? 'font-mono text-hint' : 'font-medium', !g.key && 'text-muted')}>{label(g.key)}</span>
              <span className="text-muted">{g.turns} replies</span>
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
