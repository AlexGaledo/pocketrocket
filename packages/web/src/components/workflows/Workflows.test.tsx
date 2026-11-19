import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot, WorkflowApprovalCard, WorkflowNode, WorkflowStepResult } from '@pocketrocket/shared';
import { starterGraph } from '../../lib/workflows';

let StepsList: typeof import('./StepsList').StepsList;
let WorkflowApprovalCardView: typeof import('./WorkflowCard').WorkflowApprovalCardView;
beforeAll(async () => {
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  ({ StepsList } = await import('./StepsList'));
  ({ WorkflowApprovalCardView } = await import('./WorkflowCard'));
}, 60000);

const bot = { id: 'b1', name: 'Ada', handle: 'ada', avatar: '' } as Bot;
const ctx = { bots: [bot], routines: [], triggers: [] };
const steps: WorkflowNode[] = starterGraph('b1').nodes;
const noop = () => undefined;
const ops = { onEdit: noop, onMove: noop, onDuplicate: noop, onDelete: noop, onInsertAfter: noop };
const res = (nodeId: string, status: WorkflowStepResult['status'], costUsd = 0): [string, WorkflowStepResult] => [nodeId, { nodeId, status, output: null, costUsd, startedAt: 1, endedAt: null }];

describe('StepsList', () => {
  const html = (results: Map<string, WorkflowStepResult>, readOnly = false) =>
    renderToStaticMarkup(<StepsList steps={steps} ctx={ctx} results={results} selectedId={null} problems={{}} ops={ops} readOnly={readOnly} />);
  it('is an ordered list that says which step of how many', () => {
    const h = html(new Map());
    expect(h).toContain('<ol');
    expect(h).toContain('Step 1 of 3');
    expect(h).toContain('Step 3 of 3');
    expect(h).toContain('Ada');
  });
  it('shows each step status in words, with its cost', () => {
    const h = html(new Map([res('trigger-1', 'done'), res('agent-1', 'running', 0.0042), res('output-1', 'pending')]));
    expect(h).toContain('Done');
    expect(h).toContain('Running');
    expect(h).toContain('chip-running');
    expect(h).toContain('$0.0042');
    expect(h).toContain('Not started');
  });
  it('marks only a waiting step with the warn ring', () => {
    expect(html(new Map([res('agent-1', 'waiting')]))).toContain('ring-warn/60');
    expect(html(new Map())).not.toContain('ring-warn');
  });
  it('offers Details, not Edit or a menu, when read only', () => {
    const h = html(new Map(), true);
    expect(h).toContain('Details of step 2');
    expect(h).not.toContain('Options for');
  });
});

describe('WorkflowApprovalCardView', () => {
  const card: WorkflowApprovalCard = { runId: 'run1', workflowId: 'w1', workflowName: 'Weekly', nodeId: 'approval-1', title: 'Send the report?', draft: 'Dear team <b>hi</b>', canSendBack: true, expiresAt: Date.now() + 3_600_000 * 5 };
  it('offers Approve, Reject and Send back, and shows the draft as plain text', () => {
    const h = renderToStaticMarkup(<WorkflowApprovalCardView card={card} />);
    expect(h).toContain('Approve');
    expect(h).toContain('Reject');
    expect(h).toContain('Send back with a note');
    expect(h).toContain('Dear team &lt;b&gt;hi&lt;/b&gt;');
    expect(h).toContain('Send the report?');
  });
  it('drops Send back after the one allowed send-back', () => {
    const h = renderToStaticMarkup(<WorkflowApprovalCardView card={{ ...card, canSendBack: false }} />);
    expect(h).not.toContain('Send back with a note');
    expect(h).toContain('Already sent back once');
  });
});
