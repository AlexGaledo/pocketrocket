// One workflow: a page over the chat like the other fleet pages. FleetHeader (name, Enabled, Run now), a Canvas | Steps
// switch remembered per viewer, an inspector for the selected step (a 320px column at lg, a Dialog below), and the run
// view. The Steps list is the accessible and phone view; both views edit the same draft and nothing is sent until Save.
import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import type { Routine, Trigger, WorkflowNode } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { getItem, setItem } from '../../lib/persist';
import { importChunk } from '../../lib/lazyChunk';
import { useMediaQuery } from '../../lib/useMediaQuery';
import {
  duplicateStep, graphOf, insertStep, moveStep, newStep, removeStep, stepsOf, updateStep, validateDraft,
  RUN_STATUS_LABEL, runIsOpen, useWorkflows, type StepContext,
} from '../../lib/workflows';
import { Banner, Button, Dialog, EmptyState, Field, Input, Label, Select, Skeleton, SkeletonGroup, Switch, Tabs, TabsContent, TabsList, TabsTrigger, confirmAction } from '../ui';
import { FleetHeader } from '../FleetPages';
import type { StepOps } from './StepCard';
import { AddStepMenu, StepsList } from './StepsList';
import { InspectorBody, InspectorColumn, confirmDeleteStep } from './Inspector';
import { RunPanel, useRunView } from './RunPanel';
import { WorkflowApprovalCardView } from './WorkflowCard';

// ---------- the lazy canvas ----------

/** True while the draft has changes, so a stale-chunk reload (which would drop them) is not attempted. */
let hasUnsaved = false;
const WorkflowCanvas = lazy(() => importChunk(() => import('./WorkflowCanvas'), () => !hasUnsaved));

/** The canvas chunk failed to load (offline, or a stale build): say so and point at Steps, which needs no chunk. */
class CanvasBoundary extends Component<{ children: ReactNode; onUseSteps: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Banner tone="warn" title="The canvas did not load" action={<Button size="sm" onClick={() => location.reload()}>Reload</Button>}>
        {hasUnsaved ? 'Save your changes first, then reload. ' : ''}Steps shows the same workflow as a list.{' '}
        <button type="button" className="rounded-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={this.props.onUseSteps}>Open Steps</button>
      </Banner>
    );
  }
}

// ---------- measuring ----------

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width || 1000);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

type View = 'canvas' | 'steps';
const VIEW_KEY = 'pocketrocket.workflow-view';
const readView = (): View | null => { const v = getItem(VIEW_KEY); return v === 'canvas' || v === 'steps' ? v : null; };

interface Draft { name: string; roomId: string; budgetUsd: number; steps: WorkflowNode[] }

export function WorkflowPage({ id }: { id: string }) {
  const workflows = useWorkflows((s) => s.workflows);
  const wf = workflows?.find((w) => w.id === id) ?? null;
  const loadWorkflows = useWorkflows((s) => s.loadWorkflows);
  const cards = useWorkflows((s) => s.cards);
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const device = useStore((s) => s.device);
  const toast = useStore((s) => s.toast);
  const closePage = useStore((s) => s.closePage);
  const rev = useStore((s) => s.routinesRev + s.triggersRev);
  const wide = useMediaQuery('(min-width: 1024px)');
  const [pageRef, pageW] = useWidth<HTMLDivElement>();
  const [mainRef, mainW] = useWidth<HTMLDivElement>();

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  useEffect(() => {
    void api.routines.list().then(setRoutines).catch(() => undefined);
    void api.triggers.get().then((t) => setTriggers(t.triggers)).catch(() => undefined);
  }, [rev]);
  const ctx: StepContext = useMemo(() => ({ bots, routines, triggers }), [bots, routines, triggers]);

  // The draft: what you are editing. It follows the saved workflow until you change something.
  const fromWf = useCallback((): Draft | null => (wf ? { name: wf.name, roomId: wf.roomId, budgetUsd: wf.budgetUsd, steps: stepsOf(wf.graph).steps } : null), [wf]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const saved = useMemo(() => fromWf(), [fromWf]);
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { hasUnsaved = dirty; return () => { hasUnsaved = false; }; }, [dirty]);
  const savedKey = wf ? wf.id + ':' + wf.updatedAt : '';
  useEffect(() => { if (saved && (!draft || !dirty)) setDraft(saved); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [savedKey]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pick, setPick] = useState<View | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const view = useRunView(id);

  const room = rooms.find((r) => r.id === draft?.roomId);
  const problems = useMemo(
    () => (draft ? validateDraft({ name: draft.name, roomId: draft.roomId, budgetUsd: draft.budgetUsd, graph: graphOf(draft.steps) }, room) : null),
    [draft, room],
  );

  const canManage = !device;
  const narrow = pageW < 640;
  // Below a 640px container Steps is the default and the canvas is read-only; the saved choice applies when there is room.
  const shown: View = pick ?? (narrow ? 'steps' : (readView() ?? 'canvas'));
  const choose = (v: View) => { setPick(v); setItem(VIEW_KEY, v); };
  const canvasReadOnly = narrow || !canManage;
  const vertical = mainW < 720;

  const steps = draft?.steps ?? [];
  const setSteps = (next: WorkflowNode[]) => setDraft((d) => (d ? { ...d, steps: next } : d));
  const defaultBot = (at: number): string => {
    const members = room?.memberIds ?? [];
    const before = steps.slice(0, at).reverse().find((s) => s.kind === 'agent');
    return (before?.kind === 'agent' && members.includes(before.botId) ? before.botId : members[0]) ?? '';
  };
  const add = (at: number, kind: 'agent' | 'approval' | 'output') => {
    if (steps.length >= 30) { toast('A workflow holds at most 30 steps.', true); return; }
    const n = newStep(steps, kind, defaultBot(at));
    setSteps(insertStep(steps, at, n));
    setSelectedId(n.id);
  };
  const ops: StepOps = {
    onEdit: setSelectedId,
    onMove: (sid, dir) => setSteps(moveStep(steps, steps.findIndex((s) => s.id === sid), dir)),
    onDuplicate: (sid) => {
      const i = steps.findIndex((s) => s.id === sid);
      const next = duplicateStep(steps, i);
      setSteps(next);
      if (next[i + 1]) setSelectedId(next[i + 1].id);
    },
    onDelete: async (sid) => {
      const i = steps.findIndex((s) => s.id === sid);
      if (i < 1 || !(await confirmDeleteStep('step ' + (i + 1)))) return;
      setSteps(removeStep(steps, i));
      setSelectedId((cur) => (cur === sid ? null : cur));
    },
    onInsertAfter: (sid, kind) => add(steps.findIndex((s) => s.id === sid) + 1, kind),
  };

  const save = async () => {
    if (!draft || !problems?.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.workflows.update(id, { name: draft.name.trim(), roomId: draft.roomId, budgetUsd: draft.budgetUsd, graph: graphOf(draft.steps) });
      await loadWorkflows();
      toast('Workflow saved');
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const setEnabled = async (enabled: boolean) => {
    try { await api.workflows.update(id, { enabled }); await loadWorkflows(); } catch (e) { toast((e as Error).message, true); }
  };
  const runNow = async () => {
    try { const r = await api.workflows.run(id); view.setViewId(null); view.reload(); toast('Run started'); void r; } catch (e) { toast((e as Error).message, true); }
  };
  const remove = async () => {
    if (!wf || !(await confirmAction({ title: 'Delete "' + wf.name + '"?', body: 'Its run history goes too.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.workflows.remove(id); await loadWorkflows(); closePage(); } catch (e) { toast((e as Error).message, true); }
  };

  if (workflows === null) {
    return (
      <>
        <FleetHeader title="Workflow" sub="Loading…" />
        <SkeletonGroup label="Loading the workflow" className="space-y-2 px-5 pt-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</SkeletonGroup>
      </>
    );
  }
  if (!wf || !draft || !problems) {
    return (
      <>
        <FleetHeader title="Workflow" sub="Not found" />
        <EmptyState title="This workflow is gone" as="h2" action={<Button onClick={closePage}>Back to chat</Button>}>It was deleted, or it never reached this device.</EmptyState>
      </>
    );
  }

  const selIndex = selectedId ? steps.findIndex((s) => s.id === selectedId) : -1;
  const inspector = selIndex >= 0 ? {
    steps, index: selIndex, room, ctx, ops, readOnly: !canManage, problems: problems.byNode[steps[selIndex].id] ?? [],
    onChange: (patch: Partial<WorkflowNode>) => setSteps(updateStep(steps, steps[selIndex].id, patch)),
  } : null;
  const open = runIsOpen(wf.lastRun);
  const myCards = cards.filter((c) => c.workflowId === id);
  const sub = (room ? (room.kind === 'group' ? '# ' : '') + room.name : 'No chat') + (wf.lastRun ? ' · ' + RUN_STATUS_LABEL[wf.lastRun.status] : ' · Never run');

  return (
    <>
      <FleetHeader
        title={wf.name}
        sub={sub}
        actions={canManage && (
          <>
            <label className="flex items-center gap-2 text-ui text-muted">
              <span id="wf-enabled">Enabled</span>
              <Switch checked={wf.enabled} onChange={(v) => void setEnabled(v)} aria-labelledby="wf-enabled" />
            </label>
            <Button variant="primary" disabled={dirty || open} title={dirty ? 'Save your changes first' : open ? 'A run is already going' : 'Run it now. This does real work.'} onClick={() => void runNow()}>Run now</Button>
          </>
        )}
      />
      <div ref={pageRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-6">
        <div className={`mx-auto flex w-full flex-col gap-3 p-3 ${inspector && wide ? 'max-w-[calc(var(--page-max)+336px)]' : 'max-w-[var(--page-max)]'}`}>
          {myCards.map((c) => <WorkflowApprovalCardView key={c.runId + c.nodeId} card={c} className="w-full" />)}

          {canManage && (
            <div className="grid grid-cols-1 gap-2 @lg:grid-cols-[1fr_1fr_8rem]">
              <Field><Label>Name</Label><Input value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoComplete="off" /></Field>
              <Field>
                <Label>Runs in</Label>
                <Select value={draft.roomId} onChange={(e) => setDraft({ ...draft, roomId: e.target.value })}>
                  {!room && <option value={draft.roomId}>A chat that is gone</option>}
                  {rooms.map((r) => <option key={r.id} value={r.id}>{r.kind === 'group' ? '# ' : ''}{r.name}</option>)}
                </Select>
              </Field>
              <Field>
                <Label hint="per run">Budget $</Label>
                <Input type="number" min={0.01} max={50} step={0.25} inputMode="decimal" value={draft.budgetUsd} onChange={(e) => setDraft({ ...draft, budgetUsd: Number(e.target.value) })} />
              </Field>
            </div>
          )}

          {(problems.general.length > 0 || saveError) && (
            <Banner tone="error" title={saveError ? 'The hub did not save it' : 'Fix this before saving'}>
              {saveError ? saveError : <ul className="list-disc pl-4">{problems.general.map((g) => <li key={g}>{g}</li>)}</ul>}
            </Banner>
          )}

          <div className="flex gap-4">
            <div ref={mainRef} className="flex min-w-0 flex-1 flex-col gap-3">
              <Tabs value={shown} onValueChange={(v) => choose(v as View)}>
                <div className="-mx-3 flex flex-wrap items-center gap-2">
                  <TabsList><TabsTrigger value="canvas">Canvas</TabsTrigger><TabsTrigger value="steps">Steps</TabsTrigger></TabsList>
                  <span className="flex-1" />
                  {canManage && <AddStepMenu onAdd={(k) => add(steps.length, k)} disabled={steps.length >= 30} />}
                </div>
                <TabsContent value="canvas" className="focus-visible:outline-none">
                  {shown === 'canvas' && (
                    <CanvasBoundary onUseSteps={() => choose('steps')}>
                      <Suspense fallback={<SkeletonGroup label="Loading the canvas"><Skeleton className="h-[340px] w-full rounded-lg" /></SkeletonGroup>}>
                        <WorkflowCanvas
                          steps={steps} ctx={ctx} results={view.results} selectedId={selectedId} problems={problems.byNode} ops={ops}
                          readOnly={canvasReadOnly} vertical={vertical} onInsert={add}
                        />
                      </Suspense>
                      {canvasReadOnly && <p className="mt-1.5 text-hint text-dim">{canManage ? 'The canvas is view-only on a narrow screen. Use Steps to edit.' : 'Editing workflows is desktop only.'}</p>}
                    </CanvasBoundary>
                  )}
                </TabsContent>
                <TabsContent value="steps" className="focus-visible:outline-none">
                  <StepsList steps={steps} ctx={ctx} results={view.results} selectedId={selectedId} problems={problems.byNode} ops={ops} readOnly={!canManage} />
                </TabsContent>
              </Tabs>
              <RunPanel view={view} steps={steps} ctx={ctx} canManage={canManage} />
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  {dirty && (
                    <>
                      <Button variant="primary" disabled={saving || !problems.ok} onClick={() => void save()}>Save changes</Button>
                      <Button disabled={saving} onClick={() => { setDraft(saved); setSaveError(null); setSelectedId(null); }}>Discard</Button>
                      <span role="status" className="text-hint text-muted">Unsaved changes</span>
                    </>
                  )}
                  <span className="flex-1" />
                  <Button variant="ghost" onClick={() => void remove()}><Trash2 size={13} aria-hidden /> Delete workflow</Button>
                </div>
              )}
            </div>
            {inspector && wide && <InspectorColumn {...inspector} onClose={() => setSelectedId(null)} />}
          </div>
        </div>
      </div>
      {inspector && !wide && (
        <Dialog open onOpenChange={(o) => { if (!o) setSelectedId(null); }} title={'Step ' + (inspector.index + 1)} description="Changes apply to the draft. Save the workflow to keep them." wide>
          <InspectorBody {...inspector} />
        </Dialog>
      )}
    </>
  );
}
