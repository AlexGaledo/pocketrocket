import { describe, expect, it, vi } from 'vitest';
import type { Room, WorkflowApprovalCard, WorkflowNode, WorkflowRunSummary } from '@pocketrocket/shared';
import { linearOrder } from '@pocketrocket/shared';
import {
  canMove, dispatchWorkflowEvent, duplicateStep, expiresIn, graphOf, insertStep, moveStep, newStep, removeStep, starterGraph,
  stepsOf, updateStep, useWorkflows, validateDraft,
} from './workflows';
import { importChunk } from './lazyChunk';
import { selectInbox } from './inbox';

const room: Room = { id: 'r1', kind: 'group', name: 'Ops', memberIds: ['b1', 'b2'], coordinatorBotId: null, createdAt: 0 };
const start: WorkflowNode[] = starterGraph('b1').nodes;
const draft = (steps: WorkflowNode[], over = {}) => ({ name: 'Weekly', roomId: 'r1', budgetUsd: 2, graph: graphOf(steps), ...over });

describe('step editing', () => {
  it('starts from a graph the shared validator accepts', () => {
    expect(linearOrder(starterGraph('b1')).ok).toBe(true);
    expect(validateDraft(draft(start), room).ok).toBe(true);
  });
  it('rebuilds a chain of edges from the order, so every edit stays a single path', () => {
    const steps = insertStep(start, 2, newStep(start, 'approval', 'b1'));
    expect(steps.map((s) => s.id)).toEqual(['trigger-1', 'agent-1', 'approval-1', 'output-1']);
    const g = graphOf(steps);
    expect(g.edges).toEqual([{ from: 'trigger-1', to: 'agent-1' }, { from: 'agent-1', to: 'approval-1' }, { from: 'approval-1', to: 'output-1' }]);
    expect(linearOrder(g).ok).toBe(true);
  });
  it('never moves the trigger, or a step above it', () => {
    expect(canMove(start, 0, 1)).toBe(false);
    expect(canMove(start, 1, -1)).toBe(false);
    expect(moveStep(start, 1, -1)).toBe(start);
    expect(moveStep(start, 1, 1).map((s) => s.id)).toEqual(['trigger-1', 'output-1', 'agent-1']);
  });
  it('duplicates with a fresh id, and does not duplicate or delete the trigger', () => {
    const d = duplicateStep(start, 1);
    expect(d.map((s) => s.id)).toEqual(['trigger-1', 'agent-1', 'agent-2', 'output-1']);
    expect(duplicateStep(start, 0)).toBe(start);
    expect(removeStep(start, 0)).toBe(start);
    expect(removeStep(start, 1)).toHaveLength(2);
  });
  it('edits a step by id', () => {
    const next = updateStep(start, 'agent-1', { prompt: 'Summarise {{previous}}' });
    expect(next[1]).toMatchObject({ prompt: 'Summarise {{previous}}' });
    expect(start[1]).toMatchObject({ prompt: 'Describe what this step should do.' });
  });
  it('falls back to node order for a graph the validator refuses', () => {
    const bad = { nodes: start, edges: [] };
    expect(stepsOf(bad)).toEqual({ steps: start, ordered: false });
  });
});

describe('validateDraft', () => {
  it('names the step that needs fixing, and why', () => {
    const steps = insertStep(start, 2, newStep(start, 'agent', 'b2'));
    const p = validateDraft(draft(steps), room);
    expect(p.ok).toBe(false);
    expect(p.byNode['agent-2']).toEqual(['Write what the bot should do.']);
  });
  it('says when a bot is not in the chat', () => {
    const p = validateDraft(draft(updateStep(start, 'agent-1', { botId: 'zz' })), room);
    expect(p.byNode['agent-1']?.[0]).toContain('not in the chat');
  });
  it('shows the shared linearOrder error before save', () => {
    const steps = insertStep(start, 1, newStep(start, 'approval', 'b1'));
    const p = validateDraft(draft(steps), room);
    expect(p.general).toContain('An approval step needs a step before it to approve.');
  });
  it('checks name, chat and budget', () => {
    const p = validateDraft(draft(start, { name: ' ', budgetUsd: 0 }), undefined);
    expect(p.general).toEqual(expect.arrayContaining(['Give the workflow a name.', 'Pick the chat this workflow runs in.']));
    expect(p.general.some((g) => g.includes('budget'))).toBe(true);
  });
  it('wants a file name for a file output', () => {
    const p = validateDraft(draft(updateStep(start, 'output-1', { target: 'file' })), room);
    expect(p.byNode['output-1']).toEqual(['Say which file to save to.']);
  });
});

const run = (over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({ id: 'run1', workflowId: 'w1', status: 'running', nodeId: 'agent-1', costUsd: 0.1, startedAt: 10, endedAt: null, manual: true, ...over });
const card = (over: Partial<WorkflowApprovalCard> = {}): WorkflowApprovalCard => ({ runId: 'run1', workflowId: 'w1', workflowName: 'Weekly', nodeId: 'approval-1', title: 'Send it?', draft: 'Hello', canSendBack: true, expiresAt: 100_000_000, ...over });

describe('live events', () => {
  it('ignores events that are not workflow events', () => {
    expect(dispatchWorkflowEvent({ type: 'pc_session_updated' })).toBe(false);
    expect(dispatchWorkflowEvent(null)).toBe(false);
  });
  it('replaces the cards, and keeps the newest run on its workflow in the list', () => {
    useWorkflows.setState({ workflows: [{ id: 'w1', name: 'Weekly', enabled: true, roomId: 'r1', graph: starterGraph('b1'), budgetUsd: 2, createdAt: 0, updatedAt: 0, lastRun: null }] });
    expect(dispatchWorkflowEvent({ type: 'workflow.cards', cards: [card()] })).toBe(true);
    expect(useWorkflows.getState().cards).toHaveLength(1);
    dispatchWorkflowEvent({ type: 'workflow.run', run: run({ status: 'waiting' }) });
    expect(useWorkflows.getState().workflows?.[0].lastRun?.status).toBe('waiting');
    expect(useWorkflows.getState().runs.run1.status).toBe('waiting');
    // An older run must not displace the newest.
    dispatchWorkflowEvent({ type: 'workflow.run', run: run({ id: 'old', startedAt: 1, status: 'success' }) });
    expect(useWorkflows.getState().workflows?.[0].lastRun?.id).toBe('run1');
  });
  it('drops a card once it is answered', () => {
    useWorkflows.setState({ cards: [card(), card({ nodeId: 'approval-2' })] });
    useWorkflows.getState().dropCard('run1', 'approval-1');
    expect(useWorkflows.getState().cards.map((c) => c.nodeId)).toEqual(['approval-2']);
  });
});

describe('Needs you', () => {
  it('lists a workflow approval with its card, and no approval id a bot-style Deny could use', () => {
    const items = selectInbox({ openApprovals: [], messages: {}, control: {}, skills: null, workflowCards: [{ card: card(), roomId: 'r1' }] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'workflow', roomId: 'r1', workflowCard: { runId: 'run1' } });
    expect(items[0].approvalId).toBeUndefined();
    expect(items[0].canDeny).toBeUndefined();
  });
});

describe('expiresIn', () => {
  it('says how long is left in plain words', () => {
    expect(expiresIn(1000, 2000)).toBe('Expired');
    expect(expiresIn(60_000 * 40, 0)).toBe('40 min left');
    expect(expiresIn(3_600_000 * 23, 0)).toBe('23 h left');
  });
});

describe('importChunk', () => {
  const store = new Map<string, string>();
  const stub = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  vi.stubGlobal('sessionStorage', stub);
  vi.stubGlobal('localStorage', stub);
  it('reloads once on a failed import, then gives up so a real outage shows an error', async () => {
    store.clear();
    const reload = vi.fn();
    void importChunk(() => Promise.reject(new Error('Failed to fetch dynamically imported module')), () => true, reload);
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(importChunk(() => Promise.reject(new Error('still gone')), () => true, reload)).rejects.toThrow('still gone');
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('does not reload while there are unsaved edits', async () => {
    store.clear();
    const reload = vi.fn();
    await expect(importChunk(() => Promise.reject(new Error('gone')), () => false, reload)).rejects.toThrow('gone');
    expect(reload).not.toHaveBeenCalled();
  });
  it('clears the flag after a good load', async () => {
    store.set('pocketrocket.chunk-reloaded', '1');
    await importChunk(() => Promise.resolve(1));
    expect(store.has('pocketrocket.chunk-reloaded')).toBe(false);
  });
});
