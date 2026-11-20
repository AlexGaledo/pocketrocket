// One step, drawn once. The Steps list row and the canvas node both render this, so the two views cannot drift.
// Status is always a Badge with words. Warn colour appears only while a step waits for the person; an approval step
// at rest is neutral.
import type { ReactNode } from 'react';
import { Bot as BotIcon, FileOutput, MoreHorizontal, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import type { WorkflowNode, WorkflowNodeKind, WorkflowStepResult } from '@pocketrocket/shared';
import { Avatar, Badge, Button, Menu, MenuContent, MenuItem, MenuSeparator, cn, fmtUsd } from '../ui';
import { KIND_LABEL, STEP_STATUS_LABEL, STEP_STATUS_TONE, canDelete, canDuplicate, canMove, describeStep, type StepContext } from '../../lib/workflows';

const KIND_ICON: Record<WorkflowNodeKind, LucideIcon> = { trigger: Zap, agent: BotIcon, approval: ShieldCheck, output: FileOutput };

/** What the menu on a step can do. Everything is by step id so both views pass the same handlers. */
export interface StepOps {
  onEdit: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onInsertAfter: (id: string, kind: 'agent' | 'approval' | 'output') => void;
}

/** "Running" shimmers with the existing `.chip-running` (still under reduced motion); the rest are plain Badges. */
export function StepStatus({ status }: { status: WorkflowStepResult['status'] }) {
  if (status === 'running') {
    return <span className="chip-running inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-hint text-accent">{STEP_STATUS_LABEL.running}</span>;
  }
  return <Badge tone={STEP_STATUS_TONE[status]}>{STEP_STATUS_LABEL[status]}</Badge>;
}

export function StepCard({ step, index, total, ctx, result, selected, problems, compact, actions, className }: {
  step: WorkflowNode;
  index: number;
  total: number;
  ctx: StepContext;
  result?: WorkflowStepResult;
  selected?: boolean;
  problems?: string[];
  /** Canvas node: a fixed height, one line of detail. */
  compact?: boolean;
  actions?: ReactNode;
  className?: string;
}) {
  const Icon = KIND_ICON[step.kind];
  const { title, detail } = describeStep(step, ctx);
  const bot = step.kind === 'agent' ? ctx.bots.find((b) => b.id === step.botId) : undefined;
  const waiting = result?.status === 'waiting';
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg bg-card p-3 text-left',
        selected ? 'ring-2 ring-accent' : cn('ring-1', waiting ? 'ring-warn/60' : problems?.length ? 'ring-bad/50' : 'ring-line'),
        compact && 'h-[104px] overflow-hidden',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-hint text-muted">
        <Icon size={13} aria-hidden className={cn('shrink-0', waiting && 'text-warn')} />
        <span className="min-w-0 flex-1 truncate">Step {index + 1} of {total} · {KIND_LABEL[step.kind]}</span>
        {result && <StepStatus status={result.status} />}
        {actions}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {bot && <span aria-hidden className="shrink-0"><Avatar bot={bot} size={20} /></span>}
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{title}</span>
        {result && result.costUsd > 0 && <span className="shrink-0 font-mono text-hint text-muted">{fmtUsd(result.costUsd)}</span>}
      </div>
      {/* An excerpt on the card; the whole text is in the hover text and in the step's editor. */}
      <p className={cn('text-hint text-muted', compact ? 'line-clamp-1' : 'line-clamp-2 whitespace-pre-wrap break-words')} title={typeof detail === 'string' ? detail : undefined}>{detail}</p>
      {!compact && problems?.map((p) => <p key={p} className="text-hint text-bad">{p}</p>)}
      {compact && !!problems?.length && <p className="truncate text-hint text-bad">{problems[0]}</p>}
    </div>
  );
}

/** Edit, move, duplicate, delete, and add a step after this one. The trigger can only be edited or have steps added after it. */
export function StepMenu({ steps, index, ops, label }: { steps: WorkflowNode[]; index: number; ops: StepOps; label: string }) {
  const step = steps[index];
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button size="icon" variant="ghost" aria-label={'Options for ' + label} className="-my-1.5 -mr-1.5 h-7 w-7 shrink-0"><MoreHorizontal size={14} aria-hidden /></Button>
      </Menu.Trigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => ops.onEdit(step.id)}>Edit</MenuItem>
        {canMove(steps, index, -1) && <MenuItem onSelect={() => ops.onMove(step.id, -1)}>Move up</MenuItem>}
        {canMove(steps, index, 1) && <MenuItem onSelect={() => ops.onMove(step.id, 1)}>Move down</MenuItem>}
        {canDuplicate(steps, index) && <MenuItem onSelect={() => ops.onDuplicate(step.id)}>Duplicate</MenuItem>}
        <MenuSeparator />
        <MenuItem onSelect={() => ops.onInsertAfter(step.id, 'agent')}>Add a bot step after</MenuItem>
        {index >= 1 && <MenuItem onSelect={() => ops.onInsertAfter(step.id, 'approval')}>Add an approval after</MenuItem>}
        <MenuItem onSelect={() => ops.onInsertAfter(step.id, 'output')}>Add an output after</MenuItem>
        {canDelete(steps, index) && (
          <>
            <MenuSeparator />
            <MenuItem className="text-bad" onSelect={() => ops.onDelete(step.id)}>Delete…</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu.Root>
  );
}
