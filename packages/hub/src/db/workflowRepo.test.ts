import { describe, expect, it } from 'vitest';
import { WorkflowInputSchema, linearOrder, type WorkflowGraph, type WorkflowInput, type WorkflowStepResult } from '@pocketrocket/shared';
import { Db } from './db.js';
import { WorkflowRepo } from './workflowRepo.js';

const graph = (trigger: Record<string, unknown> = { manual: true }): WorkflowGraph => ({
  nodes: [
    { id: 't', kind: 'trigger', routineId: null, triggerId: null, manual: false, ...trigger },
    { id: 'a1', kind: 'agent', botId: 'bot1', prompt: 'Collect the issues. {{previous}}', ui: { x: 10, y: 20 } },
    { id: 'ap', kind: 'approval', title: 'Send it?' },
    { id: 'o', kind: 'output', target: 'room' },
  ],
  edges: [{ from: 't', to: 'a1' }, { from: 'a1', to: 'ap' }, { from: 'ap', to: 'o' }],
} as WorkflowGraph);
const input = (g = graph(), extra: Partial<WorkflowInput> = {}): WorkflowInput =>
  WorkflowInputSchema.parse({ name: 'Weekly', roomId: 'room1', graph: g, ...extra });
const steps = (g: WorkflowGraph): WorkflowStepResult[] =>
  g.nodes.map((n) => ({ nodeId: n.id, status: 'pending', output: null, costUsd: 0, startedAt: null, endedAt: null }));

describe('WorkflowRepo', () => {
  it('round-trips a workflow, ui coordinates included (stored, never read by the engine)', () => {
    let t = 1000;
    const repo = new WorkflowRepo(new Db(':memory:'), () => t++);
    const w = repo.create(input(graph({ manual: true })));
    expect(w).toMatchObject({ name: 'Weekly', enabled: true, roomId: 'room1', budgetUsd: 2, lastRun: null, createdAt: 1000, updatedAt: 1000 });
    expect(w.graph.nodes[1]).toMatchObject({ kind: 'agent', ui: { x: 10, y: 20 } });
    expect(repo.get(w.id)).toEqual(w);
    expect(repo.list()).toEqual([w]);
    expect(repo.get('nope')).toBeUndefined();
    expect(linearOrder(w.graph)).toMatchObject({ ok: true });

    const u = repo.update(w.id, { name: 'Monday digest', enabled: false, budgetUsd: 3 })!;
    expect(u).toMatchObject({ name: 'Monday digest', enabled: false, budgetUsd: 3, roomId: 'room1', updatedAt: 1001 });
    expect(u.graph).toEqual(w.graph);
    expect(repo.update('nope', { name: 'x' })).toBeUndefined();
  });

  it('files a workflow under the routine or trigger its trigger step names', () => {
    const repo = new WorkflowRepo(new Db(':memory:'));
    const byRoutine = repo.create(input(graph({ routineId: 'rt1', manual: false })));
    const byTrigger = repo.create(input(graph({ triggerId: 'tg1', manual: false })));
    const manual = repo.create(input(graph({ manual: true })));
    expect(repo.forRoutine('rt1').map((w) => w.id)).toEqual([byRoutine.id]);
    expect(repo.forTrigger('tg1').map((w) => w.id)).toEqual([byTrigger.id]);
    expect(repo.forRoutine('tg1')).toEqual([]);
    // Changing the trigger step moves it.
    repo.update(manual.id, { graph: graph({ routineId: 'rt1', manual: false }) });
    expect(repo.forRoutine('rt1').map((w) => w.id)).toEqual([byRoutine.id, manual.id]);
  });

  it('keeps runs with a snapshot of the graph, newest first, and finds the active one', () => {
    let t = 5000;
    const repo = new WorkflowRepo(new Db(':memory:'), () => t++);
    const w = repo.create(input());
    expect(repo.activeRun(w.id)).toBeUndefined();
    const r1 = repo.createRun({ workflowId: w.id, graph: w.graph, budgetUsd: w.budgetUsd, manual: true, steps: steps(w.graph), nodeId: 'a1' });
    expect(r1).toMatchObject({ status: 'running', nodeId: 'a1', manual: true, costUsd: 0, endedAt: null, causeId: null, budgetUsd: 2 });
    expect(r1.steps).toHaveLength(4);
    expect(repo.activeRun(w.id)?.id).toBe(r1.id);

    const done = repo.updateRun(r1.id, { status: 'success', costUsd: 0.4, endedAt: 6000, causeId: 'm1' })!;
    expect(done).toMatchObject({ status: 'success', costUsd: 0.4, endedAt: 6000, causeId: 'm1' });
    expect(repo.activeRun(w.id)).toBeUndefined();

    // Editing the workflow does not change a run that already started.
    repo.update(w.id, { graph: graph({ triggerId: 'tg9', manual: false }) });
    expect(repo.getRun(r1.id)!.graph).toEqual(w.graph);

    const r2 = repo.createRun({ workflowId: w.id, graph: w.graph, budgetUsd: 2, manual: false, steps: steps(w.graph), nodeId: 'a1' });
    repo.updateRun(r2.id, { status: 'waiting', expiresAt: 99 });
    expect(repo.listRuns(w.id).map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(repo.listRuns(w.id, 1)).toHaveLength(1);
    expect(repo.listRuns(w.id)[0]).not.toHaveProperty('steps');
    expect(repo.get(w.id)!.lastRun).toMatchObject({ id: r2.id, status: 'waiting' });
    expect(repo.runsWith('waiting').map((r) => r.id)).toEqual([r2.id]);
    expect(repo.runsWith('running', 'waiting').map((r) => r.id)).toEqual([r2.id]);
    expect(repo.getRun(r2.id)!.expiresAt).toBe(99);
  });

  it('deleting a workflow removes its runs', () => {
    const db = new Db(':memory:');
    const repo = new WorkflowRepo(db);
    const w = repo.create(input());
    repo.createRun({ workflowId: w.id, graph: w.graph, budgetUsd: 2, manual: false, steps: [], nodeId: null });
    repo.delete(w.id);
    expect(repo.get(w.id)).toBeUndefined();
    expect(db.get<{ n: number }>('SELECT count(*) n FROM workflow_runs')!.n).toBe(0);
  });
});
