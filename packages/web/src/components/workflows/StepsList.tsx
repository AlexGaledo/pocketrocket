// The Steps view: an ordered list, always available, and the accessible and phone view of the same graph the canvas
// draws. Rows are the shared StepCard; a finished step's output folds out under it.
import { Plus } from 'lucide-react';
import type { WorkflowNode, WorkflowStepResult } from '@pocketrocket/shared';
import { Button, Menu, MenuContent, MenuItem } from '../ui';
import { describeStep, type StepContext } from '../../lib/workflows';
import { StepCard, StepMenu, type StepOps } from './StepCard';

/** What a step produced in the run being viewed: its output, the notes you steered in, and a send-back. */
export function StepOutput({ result }: { result: WorkflowStepResult }) {
  const steers = result.steers ?? [];
  if (!result.output && !steers.length && !result.sentBackNote) return null;
  return (
    <details className="mt-1 px-1 text-hint text-muted">
      <summary className="cursor-pointer select-none rounded-xs py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Output and notes</summary>
      {result.sentBackNote && <p className="mt-1 whitespace-pre-wrap break-words">You sent this back: {result.sentBackNote}</p>}
      {steers.map((s) => <p key={s.at} className="mt-1 whitespace-pre-wrap break-words">You steered: {s.text}</p>)}
      {result.output && <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card2 p-2.5 font-sans text-ui text-fg">{result.output}</pre>}
    </details>
  );
}

export function AddStepMenu({ onAdd, disabled }: { onAdd: (kind: 'agent' | 'approval' | 'output') => void; disabled?: boolean }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button size="sm" disabled={disabled}><Plus size={13} aria-hidden /> Add step</Button>
      </Menu.Trigger>
      <MenuContent align="start">
        <MenuItem onSelect={() => onAdd('agent')}>A bot does something</MenuItem>
        <MenuItem onSelect={() => onAdd('approval')}>You approve</MenuItem>
        <MenuItem onSelect={() => onAdd('output')}>Output</MenuItem>
      </MenuContent>
    </Menu.Root>
  );
}

export function StepsList({ steps, ctx, results, selectedId, problems, ops, readOnly }: {
  steps: WorkflowNode[];
  ctx: StepContext;
  results: Map<string, WorkflowStepResult>;
  selectedId: string | null;
  problems: Record<string, string[]>;
  ops: StepOps;
  readOnly: boolean;
}) {
  return (
    <ol aria-label="Workflow steps" className="flex flex-col gap-2">
      {steps.map((s, i) => {
        const label = 'step ' + (i + 1) + ', ' + describeStep(s, ctx).title;
        const result = results.get(s.id);
        return (
          <li key={s.id}>
            <StepCard
              step={s} index={i} total={steps.length} ctx={ctx} result={result} selected={s.id === selectedId} problems={problems[s.id]}
              actions={(
                <>
                  <Button size="sm" variant="ghost" className="-my-1.5 h-7" aria-label={(readOnly ? 'Details of ' : 'Edit ') + label} onClick={() => ops.onEdit(s.id)}>{readOnly ? 'Details' : 'Edit'}</Button>
                  {!readOnly && <StepMenu steps={steps} index={i} ops={ops} label={label} />}
                </>
              )}
            />
            {result && <StepOutput result={result} />}
          </li>
        );
      })}
    </ol>
  );
}
