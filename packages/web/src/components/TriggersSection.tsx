import { useEffect, useState } from 'react';
import { History, Play, Plus, Trash2, Zap } from 'lucide-react';
import {
  TRIGGER_FILTERS, TRIGGER_SOURCE_LABEL, TRIGGER_SOURCE_PROVIDER,
  type IntegrationsState, type Trigger, type TriggerFire, type TriggerSource, type TriggersState,
} from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom } from '../store';
import { api } from '../lib/api';
import { Button, Input, Label, Select, Textarea, cn, fmtUsd } from './ui';

/**
 * P5: the Triggers half of Automations (the fleet page, and the Bot page filtered to one bot). A trigger wakes a bot in a room when an outside event arrives
 * (GitHub, Gmail, Calendar, Drive, Slack, ClickUp, Teams). The hub polls (Slack pushes over Socket Mode), so
 * only connected providers are offered. Trigger turns always ask before acting, even with approvals bypassed.
 */

type Form = {
  open: boolean; id?: string; name: string; source: TriggerSource | ''; filter: Record<string, string>;
  botId: string; roomId: string; prompt: string; maxPerHour: number; budgetUsd: number; enabled: boolean;
};

const DEFAULT_PROMPT = 'New event: {{event.title}} from {{event.from}}. Decide whether anything needs doing.';
const BASE_PLACEHOLDERS = ['title', 'from', 'text', 'url'];

function when(ms: number, tz: string) {
  return new Date(ms).toLocaleString(undefined, { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  return Math.round(s / 3600) + ' h ago';
}
function filterSummary(t: Trigger) {
  const parts = Object.entries(t.filter).map(([k, v]) => k + ': ' + v);
  return parts.length ? parts.join(' · ') : 'every event';
}
const STATUS_TONE: Record<TriggerFire['status'], string> = { success: 'text-ok', error: 'text-bad', skipped: 'text-warn', running: 'text-accent' };

export function TriggersSection({ botId }: { botId: string | null }) {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const toast = useStore((s) => s.toast);
  const tz = useStore((s) => s.settings.timezone);
  const rev = useStore((s) => s.triggersRev);
  const room = useStore(selectActiveRoom);
  const [state, setState] = useState<TriggersState | null>(null);
  const [integ, setInteg] = useState<IntegrationsState | null>(null);
  const [fires, setFires] = useState<Record<string, TriggerFire[] | undefined>>({});
  const blank = (): Form => ({
    open: false, name: '', source: state?.available[0] ?? '', filter: {}, botId: botId ?? bots[0]?.id ?? '',
    roomId: room?.id ?? rooms[0]?.id ?? '', prompt: DEFAULT_PROMPT, maxPerHour: 6, budgetUsd: 2, enabled: true,
  });
  const [form, setForm] = useState<Form>(blank);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const load = async () => {
    try {
      const [s, i] = await Promise.all([api.triggers.get(), api.integrations.get().catch(() => null)]);
      setState(s);
      setInteg(i);
    } catch (e) { toast((e as Error).message, true); }
  };
  // Refetch on triggers.changed / trigger.fired / integrations.changed, and refresh any open history.
  useEffect(() => {
    void load();
    for (const id of Object.keys(fires)) if (fires[id]) void api.triggers.fires(id).then((x) => setFires((f) => ({ ...f, [id]: x }))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  const available = state?.available ?? [];
  const sources: TriggerSource[] = form.source && !available.includes(form.source) ? [form.source, ...available] : available;
  const conn = form.source ? integ?.connections.find((c) => c.provider === TRIGGER_SOURCE_PROVIDER[form.source as TriggerSource]) : undefined;
  const formBot = botById(bots, form.botId);
  const noAccess = !!conn && !!formBot && !conn.botIds.includes(formBot.id);
  const fields = form.source ? TRIGGER_FILTERS[form.source] : [];
  const missingRequired = fields.some((f) => f.required && !form.filter[f.key]?.trim());
  const valid = !!form.name.trim() && !!form.source && !!form.botId && !!form.roomId && !!form.prompt.trim() && !missingRequired;

  const openNew = () => setForm(form.open && !form.id ? { ...form, open: false } : { ...blank(), open: true });
  const openEdit = (t: Trigger) => setForm({
    open: true, id: t.id, name: t.name, source: t.source, filter: { ...t.filter }, botId: t.botId, roomId: t.roomId,
    prompt: t.prompt, maxPerHour: t.maxPerHour, budgetUsd: t.budgetUsd, enabled: t.enabled,
  });
  const save = async () => {
    if (!form.source) return;
    const body = {
      name: form.name.trim(), source: form.source, filter: form.filter, botId: form.botId, roomId: form.roomId,
      prompt: form.prompt, maxPerHour: form.maxPerHour, budgetUsd: form.budgetUsd, enabled: form.enabled,
    };
    try {
      if (form.id) await api.triggers.update(form.id, body); else await api.triggers.create(body);
      setForm({ ...blank(), open: false });
      await load();
    } catch (e) { toast((e as Error).message, true); }
  };
  const toggle = async (t: Trigger) => {
    try { await api.triggers.update(t.id, { enabled: !t.enabled }); } catch (e) { toast((e as Error).message, true); }
    await load();
  };
  const remove = async (t: Trigger) => {
    if (!confirm('Delete trigger "' + t.name + '"?')) return;
    try { await api.triggers.remove(t.id); } catch (e) { toast((e as Error).message, true); }
    await load();
  };
  const test = async (t: Trigger) => {
    try {
      const f = await api.triggers.test(t.id);
      toast(f.status === 'skipped' ? 'Not run: ' + (f.note ?? 'skipped') : 'Sample event sent to @' + (botById(bots, t.botId)?.handle ?? 'bot'), f.status === 'skipped');
      setFires((x) => (x[t.id] ? x : { ...x, [t.id]: [] }));
    } catch (e) { toast((e as Error).message, true); }
  };
  const toggleFires = async (t: Trigger) => {
    if (fires[t.id]) return setFires((x) => ({ ...x, [t.id]: undefined }));
    try {
      const x = await api.triggers.fires(t.id);
      setFires((cur) => ({ ...cur, [t.id]: x }));
    } catch (e) { toast((e as Error).message, true); }
  };
  const insert = (key: string) => set({ prompt: form.prompt + (form.prompt.endsWith(' ') || !form.prompt ? '' : ' ') + '{{event.' + key + '}}' });

  const list = (state?.triggers ?? []).filter((t) => !botId || t.botId === botId);
  const pollFor = (t: Trigger) => {
    const key = t.source === 'github.repo' ? 'github.repo:' + (t.filter.repo ?? '').trim()
      : t.source === 'calendar' ? 'calendar:' + (t.filter.calendar?.trim() || 'primary')
      : t.source === 'clickup' ? 'clickup:' + (t.filter.workspace?.trim() ?? '') : t.source;
    return state?.polls.find((p) => p.key === key);
  };

  return (
    <div className="flex flex-col gap-3 p-3 pt-1">
      <div className="flex items-center justify-between">
        <Label hint="outside events">Triggers</Label>
        <Button size="sm" variant="ghost" onClick={openNew} disabled={!available.length && !form.open}><Plus size={13} /> New</Button>
      </div>
      {!available.length && !list.length && (
        <p className="rounded-lg bg-card2/60 px-3 py-3 text-center text-hint text-dim">
          Connect an app in Connections first.
        </p>
      )}
      {form.open && (
        <div className="flex flex-col gap-2 rounded-lg bg-card2/60 p-2">
          <Input placeholder="Name" aria-label="Trigger name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          <Select
            aria-label="Source"
            value={form.source}
            onChange={(e) => set({ source: e.target.value as TriggerSource, filter: {} })}
          >
            {!form.source && <option value="">Choose a source</option>}
            {sources.map((s) => <option key={s} value={s}>{TRIGGER_SOURCE_LABEL[s]}{available.includes(s) ? '' : ' (not connected)'}</option>)}
          </Select>
          {fields.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-hint text-muted">Only when… (empty = any; commas = or)</span>
              {fields.map((f) => (
                <Input
                  key={f.key}
                  aria-label={f.label + (f.required ? ' (required)' : '')}
                  placeholder={f.label + ': ' + f.placeholder + (f.required ? ' (required)' : '')}
                  value={form.filter[f.key] ?? ''}
                  onChange={(e) => set({ filter: { ...form.filter, [f.key]: e.target.value } })}
                />
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Bot" value={form.botId} onChange={(e) => set({ botId: e.target.value })}>{bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
            <Select aria-label="Chat" value={form.roomId} onChange={(e) => set({ roomId: e.target.value })}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.kind === 'group' ? '# ' : ''}{r.name}</option>)}</Select>
          </div>
          {noAccess && (
            <p className="px-1 text-hint text-warn">
              @{formBot!.handle} can't use this. Allow in Connections.
            </p>
          )}
          <Textarea placeholder="What should the bot do?" aria-label="Prompt" rows={4} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          <div className="flex flex-wrap items-center gap-1 px-1" role="group" aria-label="Insert an event field">
            {[...BASE_PLACEHOLDERS, ...fields.map((f) => f.key).filter((k) => !BASE_PLACEHOLDERS.includes(k))].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => insert(k)}
                className="rounded-xs bg-card px-2 py-0.5 font-mono text-hint text-muted ring-1 ring-line hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {'{{event.' + k + '}}'}
              </button>
            ))}
          </div>
          <p className="px-1 text-hint text-dim">
            Event text is untrusted. Changes always ask first.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-hint text-muted">
              Most per hour
              <Input type="number" min={1} max={60} value={form.maxPerHour} onChange={(e) => set({ maxPerHour: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} />
            </label>
            <label className="flex flex-col gap-1 text-hint text-muted">
              Usage limit per day (API-price USD)
              <Input type="number" min={0.05} max={100} step={0.05} value={form.budgetUsd} onChange={(e) => set({ budgetUsd: Math.max(0.05, Math.min(100, Number(e.target.value) || 0.05)) })} />
            </label>
          </div>
          <label className="flex items-center gap-2 px-1 text-hint">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
          </label>
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => set({ open: false })}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={save} disabled={!valid}>{form.id ? 'Save' : 'Create'}</Button>
          </div>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {list.map((t) => {
          const b = botById(bots, t.botId);
          const rm = rooms.find((x) => x.id === t.roomId);
          const st = state?.stats[t.id];
          const poll = pollFor(t);
          const history = fires[t.id];
          const connected = available.includes(t.source);
          return (
            <li key={t.id} className={cn('rounded-lg bg-card2/60 p-2 text-hint', !t.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={t.enabled} onChange={() => toggle(t)} aria-label={'Trigger ' + t.name + ' enabled'} title="Enabled" />
                <button className="min-w-0 flex-1 text-left" onClick={() => openEdit(t)}>
                  <div className="flex items-center gap-1 font-medium"><Zap size={11} className="shrink-0 text-accent" />{t.name}</div>
                  <div className="truncate text-muted">{TRIGGER_SOURCE_LABEL[t.source]} · {filterSummary(t)}</div>
                  <div className="truncate text-muted">@{b?.handle} in {rm?.name}</div>
                  {st && (
                    <div className="truncate text-dim">
                      {st.firesLastHour}/{t.maxPerHour} this hour · {fmtUsd(st.spentLastDayUsd)} of {fmtUsd(t.budgetUsd)} today
                    </div>
                  )}
                  {!connected && <div className="truncate text-warn">Not connected. Reconnect in Connections.</div>}
                  {connected && poll?.lastError && <div className="line-clamp-2 text-bad">{poll.lastError}</div>}
                  {connected && poll && !poll.lastError && poll.lastPolledAt && (
                    <div className="truncate text-dim">{t.source === 'slack' ? 'Listening' : 'Checked ' + ago(poll.lastPolledAt)}</div>
                  )}
                </button>
                <Button size="icon" variant="ghost" title="Send a sample event" aria-label={'Send a sample event to ' + t.name} onClick={() => test(t)}><Play size={13} /></Button>
                <Button size="icon" variant="ghost" title="Recent runs" aria-label={'Recent runs of ' + t.name} aria-pressed={!!history} onClick={() => toggleFires(t)}><History size={13} /></Button>
                <Button size="icon" variant="ghost" title="Delete" aria-label={'Delete ' + t.name} onClick={() => remove(t)}><Trash2 size={13} /></Button>
              </div>
              {history && (
                <ul className="mt-2 flex flex-col gap-0.5 pt-1 text-hint text-muted">
                  {history.map((x) => (
                    <li key={x.id} className="truncate" title={x.note ?? x.title}>
                      {when(x.startedAt, tz)} · <span className={STATUS_TONE[x.status]}>{x.status}</span>
                      {x.test ? ' · sample' : ''}
                      {x.costUsd != null ? ' · ' + fmtUsd(x.costUsd) : ''}
                      {x.title ? ' · ' + x.title : ''}
                      {x.note ? ' · ' + x.note : ''}
                    </li>
                  ))}
                  {!history.length && <li>No runs yet.</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
