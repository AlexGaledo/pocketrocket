// The run view: which run is on show (the newest unless you pick one), per-step status and cost on the canvas and the
// list, cancel, retry the failed step, and the history. Live: a `workflow.run` event for the run on show refetches it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkflowNode, WorkflowRun, WorkflowRunSummary, WorkflowStepResult } from '@pocketrocket/shared';
import { Badge, Button, confirmAction, fmtUsd } from '../ui';
import { api } from '../../lib/api';
import { RUN_STATUS_LABEL, RUN_STATUS_TONE, describeStep, runIsOpen, useWorkflows, type StepContext } from '../../lib/workflows';

export interface RunView {
  history: WorkflowRunSummary[];
  run: WorkflowRun | null;
  viewId: string | null;
  setViewId: (id: string | null) => void;
  results: Map<string, WorkflowStepResult>;
  reload: () => void;
}

/** History plus the run on show, kept live. `viewId` null follows the newest run, so Run now shows its own progress at once. */
export function useRunView(workflowId: string): RunView {
  const live = useWorkflows((s) => s.runs);
  const lastRun = useWorkflows((s) => s.workflows?.find((w) => w.id === workflowId)?.lastRun ?? null);
  const [history, setHistory] = useState<WorkflowRunSummary[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Any change to this workflow's newest run (a step moved, a status changed) refreshes the list.
  const lastKey = lastRun ? lastRun.id + lastRun.status + lastRun.nodeId + lastRun.costUsd + (lastRun.endedAt ?? '') : '';
  useEffect(() => {
    let off = false;
    api.workflows.runs(workflowId).then((h) => { if (!off) setHistory(h); }).catch(() => { if (!off) setHistory([]); });
    return () => { off = true; };
  }, [workflowId, lastKey, tick]);

  const viewId = picked ?? history[0]?.id ?? lastRun?.id ?? null;
  const seen = viewId ? live[viewId] : undefined;
  const seenKey = seen ? seen.status + seen.nodeId + seen.costUsd + (seen.endedAt ?? '') : '';
  useEffect(() => {
    if (!viewId) { setRun(null); return; }
    let off = false;
    api.workflows.getRun(viewId).then((r) => { if (!off) setRun(r); }).catch(() => { if (!off) setRun(null); });
    return () => { off = true; };
  }, [viewId, seenKey, tick]);

  const results = useMemo(() => new Map((run?.steps ?? []).map((s) => [s.nodeId, s])), [run]);
  return { history, run, viewId, setViewId: setPicked, results, reload };
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const took = (r: WorkflowRunSummary) => (r.endedAt ? Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000)) + 's' : null);

export function RunPanel({ view, steps, ctx, canManage }: { view: RunView; steps: WorkflowNode[]; ctx: StepContext; canManage: boolean }) {
  const { run, history, viewId } = view;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = run?.status === 'error' ? run.steps.find((s) => s.status === 'failed') : undefined;
  const failedStep = failed ? steps.find((s) => s.id === failed.nodeId) : undefined;
  const isNewest = !!run && history[0]?.id === run.id;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); view.reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!run || !(await confirmAction({ title: 'Cancel this run?', body: 'Steps that are done stay done. The run stops where it is.', confirmLabel: 'Cancel run', cancelLabel: 'Keep running', danger: true }))) return;
    await act(() => api.workflows.cancel(run.id));
  };

  return (
    <section aria-label="Runs" className="flex flex-col gap-2 rounded-lg bg-card2/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-label text-fg">{isNewest || !run ? 'Latest run' : 'Earlier run'}</h2>
        {run && <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>}
        {run && <span className="text-hint text-muted">{when(run.startedAt)}{took(run) ? ' · ' + took(run) : ''} · <span className="font-mono">{fmtUsd(run.costUsd)}</span>{run.manual ? ' · Run now' : ''}</span>}
        <span className="flex-1" />
        {canManage && run && runIsOpen(run) && <Button size="sm" variant="danger" disabled={busy} onClick={() => void cancel()}>Cancel run</Button>}
        {canManage && run && failedStep && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => api.workflows.retry(run.id))}>
            Retry {describeStep(failedStep, ctx).title}
          </Button>
        )}
      </div>
      {!run && <p className="text-ui text-muted">{viewId ? 'Loading the run…' : 'No runs yet. Press Run now to try it.'}</p>}
      {run?.status === 'error' && run.error && <p role="status" className="text-ui text-bad">{run.error}</p>}
      {run?.status === 'waiting' && <p role="status" className="text-ui text-warn">Waiting for your answer on the approval card.</p>}
      {error && <p role="alert" className="text-hint text-bad">{error}</p>}
      {history.length > 1 && (
        <div>
          <h3 className="mb-1 text-hint text-muted">History</h3>
          <ul className="flex flex-col gap-0.5">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  type="button" aria-pressed={h.id === viewId} onClick={() => view.setViewId(h.id === history[0].id ? null : h.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-hint hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-pressed:bg-active"
                >
                  <span className="min-w-0 flex-1 truncate text-muted">{when(h.startedAt)}{h.manual ? ' · Run now' : ''}</span>
                  <Badge tone={RUN_STATUS_TONE[h.status]}>{RUN_STATUS_LABEL[h.status]}</Badge>
                  <span className="w-14 shrink-0 text-right font-mono text-muted">{fmtUsd(h.costUsd)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
