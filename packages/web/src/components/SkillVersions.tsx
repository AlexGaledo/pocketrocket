// P6: a skill's version history (with a line diff), Approve / Reject per pending version, a correction box, and
// the per-bot opt-in for post-run reflection. Nothing here changes a skill without an explicit Approve.
import { useCallback, useEffect, useId, useState } from 'react';
import type { Skill, SkillReflectionConfig, SkillVersion, SkillVersionDetail } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { Badge, Button, Select, Switch, Textarea, cn } from './ui';

const ORIGIN: Record<SkillVersion['origin'], string> = {
  demo: 'from a demo', correction: 'your correction', reflection: 'skill fix', bot: 'bot edit',
};
const fmtDate = (t: number) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

export function SkillVersionsPanel({ skill, onChanged }: { skill: Skill; onChanged: () => void }) {
  const toast = useStore((s) => s.toast);
  const skillsRev = useStore((s) => s.skillsRev);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [open, setOpen] = useState<SkillVersionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState('');
  const fixId = useId();

  const load = useCallback(async () => {
    try { setVersions(await api.skillVersions.list(skill.id)); } catch { /* keep the last list */ }
  }, [skill.id]);
  useEffect(() => { void load(); }, [load, skillsRev]);

  const toggle = async (v: SkillVersion) => {
    if (open?.id === v.id) { setOpen(null); return; }
    try { setOpen(await api.skillVersions.get(skill.id, v.id)); } catch (e) { toast((e as Error).message, true); }
  };
  const decide = async (v: SkillVersion, decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api.skillVersions.decide(skill.id, v.id, decision);
      toast(decision === 'approve' ? 'Version ' + v.version + ' is live.' : 'Version ' + v.version + ' rejected.');
      setOpen(null);
      await load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const correct = async () => {
    setBusy(true);
    try {
      const v = await api.skillVersions.correct(skill.id, fix.trim());
      toast('Version ' + v.version + ' proposed. Review it below.');
      setFix('');
      await load();
      setOpen(await api.skillVersions.get(skill.id, v.id));
    } catch (e) {
      toast("Couldn't propose a fix: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-line pt-2 text-hint">
      <div className="flex items-center gap-2">
        <span className="font-medium">Versions</span>
        <Badge>live v{skill.version ?? 1}</Badge>
      </div>
      {versions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {versions.map((v) => (
            <li key={v.id} className="rounded-md bg-card p-1.5">
              <div className="flex items-center gap-2">
                <button type="button" className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-expanded={open?.id === v.id} onClick={() => void toggle(v)}>
                  <span className="font-medium">v{v.version}</span>
                  <span className="text-muted"> · {ORIGIN[v.origin]} · {fmtDate(v.createdAt)}</span>
                  {v.note && <span className="block truncate text-dim">{v.note}</span>}
                </button>
                <Badge tone={v.status === 'pending' ? 'warn' : v.status === 'approved' ? 'ok' : 'muted'}>{v.status === 'pending' ? 'review' : v.status}</Badge>
              </div>
              {open?.id === v.id && (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {open.stale && <p className="text-warn">Live skill changed. Approving overwrites it.</p>}
                  <DiffView diff={open.diff} />
                  {v.status === 'pending' && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void decide(v, 'reject')} disabled={busy}>Reject</Button>
                      <Button size="sm" variant="primary" onClick={() => void decide(v, 'approve')} disabled={busy}>Approve v{v.version}</Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={fixId} className="text-muted">Correct this skill</label>
      <Textarea id={fixId} rows={2} value={fix} maxLength={2000} placeholder='e.g. "no, use the Export button"' onChange={(e) => setFix(e.target.value)} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-dim">You review it first. Max $0.25.</span>
        <Button size="sm" onClick={() => void correct()} disabled={busy || fix.trim().length < 3}>{busy ? 'Working…' : 'Propose fix'}</Button>
      </div>
    </div>
  );
}

/** A unified line diff. Colour is never the only cue: every changed line keeps its + / − sign. */
function DiffView({ diff }: { diff: SkillVersionDetail['diff'] }) {
  if (!diff.some((l) => l.op !== ' ')) return <p className="text-dim">No changes.</p>;
  return (
    <pre className="max-h-72 overflow-auto rounded-sm bg-card2/70 p-1.5 font-mono text-hint leading-snug" aria-label="Changes in this version">
      {diff.map((l, i) => (
        <div key={i} className={cn('whitespace-pre-wrap', l.op === '+' && 'bg-ok/12 text-ok', l.op === '-' && 'bg-bad/12 text-bad', l.op === ' ' && 'text-muted')}>
          <span aria-hidden className="select-none">{l.op === ' ' ? '  ' : l.op === '+' ? '+ ' : '− '}</span>
          <span className="sr-only">{l.op === '+' ? 'added: ' : l.op === '-' ? 'removed: ' : ''}</span>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

const EVERY = [3, 5, 10, 20];

/** Per-bot opt-in: after every N runs of one of its skills, a cheap pass may propose a fix (pending review). */
export function ReflectionSetting({ botId }: { botId: string }) {
  const toast = useStore((s) => s.toast);
  const [cfg, setCfg] = useState<SkillReflectionConfig | null>(null);
  const labelId = useId();
  const everyId = useId();
  useEffect(() => {
    let alive = true;
    api.skillVersions.reflection(botId).then((c) => alive && setCfg(c)).catch(() => alive && setCfg(null));
    return () => { alive = false; };
  }, [botId]);
  if (!cfg) return null;
  const save = async (patch: Partial<Omit<SkillReflectionConfig, 'botId'>>) => {
    const prev = cfg;
    setCfg({ ...cfg, ...patch });
    try { setCfg(await api.skillVersions.setReflection(botId, patch)); } catch (e) { setCfg(prev); toast((e as Error).message, true); }
  };
  const every = EVERY.includes(cfg.every) ? EVERY : [...EVERY, cfg.every].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-card2/60 p-2 text-hint">
      <div className="flex items-center gap-2">
        <span id={labelId} className="flex-1 font-medium">Suggest skill fixes after runs</span>
        <Switch aria-labelledby={labelId} checked={cfg.enabled} onChange={(on) => void save({ enabled: on })} />
      </div>
      <div className="flex items-center gap-2 text-muted">
        <label htmlFor={everyId}>Every</label>
        <Select id={everyId} className="h-7 w-20 text-hint" value={cfg.every} disabled={!cfg.enabled} onChange={(e) => void save({ every: Number(e.target.value) })}>
          {every.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
        <span>runs. Max ${cfg.dailyCapUsd.toFixed(2)} a day at API prices. You review each.</span>
      </div>
    </div>
  );
}
