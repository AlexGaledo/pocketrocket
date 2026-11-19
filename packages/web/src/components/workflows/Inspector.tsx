// The editor for the selected step: a 320px column beside the list at lg and up, a Dialog below (see WorkflowPage).
// It edits the draft only; nothing is sent until Save.
import { X } from 'lucide-react';
import type { Room, WorkflowNode } from '@pocketrocket/shared';
import { Button, Field, Input, Label, Select, Textarea, confirmAction } from '../ui';
import { KIND_LABEL, canDelete, canDuplicate, canMove, type StepContext } from '../../lib/workflows';
import type { StepOps } from './StepCard';

type Patch = Partial<WorkflowNode>;

export interface InspectorProps {
  steps: WorkflowNode[];
  index: number;
  room: Room | undefined;
  ctx: StepContext;
  problems: string[];
  ops: StepOps;
  readOnly: boolean;
  onChange: (patch: Patch) => void;
}

export function InspectorBody({ steps, index, room, ctx, problems, ops, readOnly, onChange }: InspectorProps) {
  const step = steps[index];
  if (!step) return null;
  const members = ctx.bots.filter((b) => room?.memberIds.includes(b.id));
  const trigger = step.kind === 'trigger' ? step : null;
  const source = trigger ? (trigger.routineId ? 'routine' : trigger.triggerId ? 'trigger' : 'manual') : null;
  const dis = readOnly;
  return (
    <div className="flex flex-col gap-3">
      {problems.map((p) => <p key={p} role="alert" className="text-ui text-bad">{p}</p>)}

      {trigger && (
        <>
          <Field>
            <Label>Starts</Label>
            <Select
              disabled={dis} value={source ?? 'manual'}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v === 'routine' ? { routineId: ctx.routines[0]?.id ?? null, triggerId: null, manual: false } as Patch
                  : v === 'trigger' ? { triggerId: ctx.triggers[0]?.id ?? null, routineId: null, manual: false } as Patch
                    : { routineId: null, triggerId: null, manual: true } as Patch);
              }}
            >
              <option value="manual">Only when I press Run now</option>
              <option value="routine">On a schedule</option>
              <option value="trigger">When an event arrives</option>
            </Select>
          </Field>
          {source === 'routine' && (
            <Field>
              <Label hint={ctx.routines.length ? undefined : 'None yet'}>Schedule</Label>
              <Select disabled={dis} value={trigger?.routineId ?? ''} onChange={(e) => onChange({ routineId: e.target.value || null } as Patch)}>
                {!trigger?.routineId && <option value="">Choose a schedule…</option>}
                {ctx.routines.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
              <p className="mt-1 text-hint text-dim">Make schedules under Automations. When this one fires it starts the workflow.</p>
            </Field>
          )}
          {source === 'trigger' && (
            <Field>
              <Label hint={ctx.triggers.length ? undefined : 'None yet'}>Trigger</Label>
              <Select disabled={dis} value={trigger?.triggerId ?? ''} onChange={(e) => onChange({ triggerId: e.target.value || null } as Patch)}>
                {!trigger?.triggerId && <option value="">Choose a trigger…</option>}
                {ctx.triggers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          )}
        </>
      )}

      {step.kind === 'agent' && (
        <>
          <Field>
            <Label>Bot</Label>
            <Select disabled={dis} value={step.botId} onChange={(e) => onChange({ botId: e.target.value } as Patch)}>
              {!members.some((b) => b.id === step.botId) && <option value={step.botId}>{ctx.bots.find((b) => b.id === step.botId)?.name ?? 'A bot that is gone'} (not in this chat)</option>}
              {members.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
          <Field>
            <Label hint={step.prompt.length + '/8000'}>What should it do?</Label>
            <Textarea disabled={dis} rows={7} maxLength={8000} value={step.prompt} onChange={(e) => onChange({ prompt: e.target.value } as Patch)} placeholder="Write the instructions for this step." />
            <p className="mt-1 text-hint text-dim">
              Type <span className="font-mono text-muted">{'{{previous}}'}</span> to use the text from the step before. The bot gets it as quoted data, not as instructions.
            </p>
          </Field>
        </>
      )}

      {step.kind === 'approval' && (
        <Field>
          <Label hint={step.title.length + '/200'}>Title</Label>
          <Input disabled={dis} maxLength={200} value={step.title} onChange={(e) => onChange({ title: e.target.value } as Patch)} autoComplete="off" />
          <p className="mt-1 text-hint text-dim">The run stops here and shows you the step before. You can approve, reject, or send it back once with a note. Only you can answer, not a bot.</p>
        </Field>
      )}

      {step.kind === 'output' && (
        <>
          <Field>
            <Label>Send the result to</Label>
            <Select disabled={dis} value={step.target} onChange={(e) => onChange({ target: e.target.value as 'room' | 'file' } as Patch)}>
              <option value="room">The chat</option>
              <option value="file">A file</option>
            </Select>
          </Field>
          {step.target === 'file' && (
            <Field>
              <Label hint="in the chat's files">File name</Label>
              <Input disabled={dis} className="font-mono" maxLength={300} value={step.path ?? ''} onChange={(e) => onChange({ path: e.target.value } as Patch)} placeholder="reports/weekly.md" autoComplete="off" />
            </Field>
          )}
        </>
      )}

      {!dis && step.kind !== 'trigger' && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button size="sm" disabled={!canMove(steps, index, -1)} onClick={() => ops.onMove(step.id, -1)}>Move up</Button>
          <Button size="sm" disabled={!canMove(steps, index, 1)} onClick={() => ops.onMove(step.id, 1)}>Move down</Button>
          <Button size="sm" disabled={!canDuplicate(steps, index)} onClick={() => ops.onDuplicate(step.id)}>Duplicate</Button>
          <Button size="sm" variant="danger" disabled={!canDelete(steps, index)} onClick={() => ops.onDelete(step.id)}>Delete…</Button>
        </div>
      )}
    </div>
  );
}

/** The column at lg and up. */
export function InspectorColumn({ onClose, ...p }: InspectorProps & { onClose: () => void }) {
  const step = p.steps[p.index];
  return (
    <aside aria-label="Step settings" className="w-[320px] shrink-0 self-start rounded-lg bg-card p-3 ring-1 ring-line">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-ui font-semibold">Step {p.index + 1}: {step ? KIND_LABEL[step.kind] : ''}</h2>
        <Button size="icon" variant="ghost" aria-label="Close step settings" onClick={onClose}><X size={14} aria-hidden /></Button>
      </div>
      <InspectorBody {...p} />
    </aside>
  );
}

/** The confirm both views use before a step goes. */
export function confirmDeleteStep(name: string): Promise<boolean> {
  return confirmAction({ title: 'Delete ' + name + '?', body: 'The steps around it join up. Save to keep the change.', confirmLabel: 'Delete', danger: true });
}
