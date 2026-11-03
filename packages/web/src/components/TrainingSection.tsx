/**
 * Bot page, Memory tab, below the writing style: the per-bot training opt-in, its proposals, and Approve / Reject /
 * Undo. Nothing here changes the bot without one of those buttons. A paired phone can read it but not act.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Check, Undo2, X } from 'lucide-react';
import { TRAINING_PASS_BUDGET_USD, TRAINING_WEEKLY_CAP_USD, type TrainingDecision, type TrainingProposal, type TrainingState } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { Badge, Button, Label, Switch } from './ui';

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function Details({ p }: { p: TrainingProposal }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted">
      <dt className="text-dim">Why</dt><dd className="min-w-0 break-words">{p.reason}</dd>
      <dt className="text-dim">Read</dt><dd className="min-w-0 break-words">{p.evidenceSummary}</dd>
      <dt className="text-dim">Check</dt><dd className="min-w-0 break-words">{p.verifierNote || 'Passed'}</dd>
    </dl>
  );
}

export function TrainingSection({ botId }: { botId: string }) {
  const rev = useStore((s) => s.trainingRev[botId] ?? 0);
  const device = useStore((s) => s.device);
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<TrainingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');
  const labelId = useId();

  const load = useCallback(() => {
    api.training.get(botId).then(setState).catch(() => setState(null));
  }, [botId]);
  useEffect(load, [load, rev]);
  useEffect(() => setRefused(''), [botId]);

  if (!state) return null;
  const pending = state.proposals.filter((p) => p.status === 'pending');
  const approved = state.proposals.filter((p) => p.status === 'approved');
  const blocked = state.proposals.filter((p) => p.status === 'blocked');

  /** The hub's answer says what to do next, so a refusal stays beside the buttons. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setRefused('');
    try {
      await fn();
    } catch (e) {
      setRefused((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  const decide = (p: TrainingProposal, decision: TrainingDecision) => act(() => api.training.decide(botId, p.id, decision));
  const runNow = () => act(async () => toast((await api.training.run(botId)).message));
  const setEnabled = (on: boolean) => act(() => api.training.setEnabled(botId, on));

  return (
    <section aria-label="Training" className="flex flex-col gap-2 px-3 pb-3 text-hint">
      <div className="flex items-center gap-2">
        <Label>Training</Label>
        <span id={labelId} className="ml-auto text-muted">Learn from mistakes</span>
        <Switch aria-labelledby={labelId} checked={state.enabled} disabled={busy || !!device} onChange={(on) => void setEnabled(on)} />
      </div>
      <p className="text-dim">
        Weekly, Sunday 03:00. Suggests one rule at a time. You approve each. Max ${TRAINING_PASS_BUDGET_USD.toFixed(2)} a run and ${TRAINING_WEEKLY_CAP_USD.toFixed(2)} a week at API prices.
      </p>
      <div className="flex items-center justify-between gap-2 text-muted">
        <span>Last run: {state.lastRunAt ? fmtDate(state.lastRunAt) : 'never'}</span>
        {state.enabled && !device && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runNow()}>{busy ? 'Working…' : 'Run now'}</Button>}
      </div>
      {refused && <p role="alert" className="text-bad">{refused}</p>}

      {pending.length > 0 && (
        <ul aria-label="Proposals to review" className="flex flex-col gap-1">
          {pending.map((p) => (
            <li key={p.id} className="flex flex-col gap-1 rounded-lg border border-warn/40 bg-card2/60 p-2">
              <div className="break-words font-medium">{p.rule}</div>
              <Details p={p} />
              {!device && (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(p, 'reject')}><X size={13} className="text-bad" aria-hidden /> Reject</Button>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(p, 'approve')}><Check size={13} aria-hidden /> Approve</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {approved.length > 0 && (
        <ul aria-label="Approved lessons" className="flex flex-col gap-1">
          {approved.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-lg bg-card2/60 px-2 py-1">
              <Badge tone="ok">Approved</Badge>
              <span className="min-w-0 flex-1 break-words">{p.rule}</span>
              {!device && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(p, 'undo')}><Undo2 size={13} aria-hidden /> Undo</Button>}
            </li>
          ))}
        </ul>
      )}

      {blocked.length > 0 && (
        <details className="rounded-lg bg-card2/60 px-2 py-1">
          <summary className="cursor-pointer text-muted">Blocked ({blocked.length})</summary>
          <ul className="mt-1 flex flex-col gap-2">
            {blocked.map((p) => (
              <li key={p.id} className="flex flex-col gap-1">
                <div className="break-words">{p.rule}</div>
                <Details p={p} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
