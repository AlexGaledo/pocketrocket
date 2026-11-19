// The third section of Automations: every workflow, newest activity visible, each opening its own page.
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useStore, selectActiveRoom } from '../../store';
import { api } from '../../lib/api';
import { RUN_STATUS_LABEL, RUN_STATUS_TONE, refreshWorkflows, starterGraph, useWorkflows } from '../../lib/workflows';
import { Badge, Button, Label, Switch, cn, fmtUsd } from '../ui';

export function WorkflowsSection() {
  const workflows = useWorkflows((s) => s.workflows);
  const error = useWorkflows((s) => s.error);
  const rooms = useStore((s) => s.rooms);
  const room = useStore(selectActiveRoom);
  const device = useStore((s) => s.device);
  const toast = useStore((s) => s.toast);
  const openPage = useStore((s) => s.openPage);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (workflows === null) void refreshWorkflows(); }, [workflows]);

  // A starter that is already valid (run on demand, one bot step, post to the chat), so the page opens ready to edit.
  const create = async () => {
    const home = room && room.memberIds.length ? room : rooms.find((r) => r.memberIds.length);
    if (!home) { toast('Add a bot to a chat first. A workflow runs in a chat.', true); return; }
    setBusy(true);
    try {
      const w = await api.workflows.create({ name: 'New workflow', enabled: false, roomId: home.id, graph: starterGraph(home.memberIds[0]), budgetUsd: 2 });
      await useWorkflows.getState().loadWorkflows();
      openPage({ kind: 'workflow', id: w.id });
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const setEnabled = async (id: string, enabled: boolean) => {
    try { await api.workflows.update(id, { enabled }); } catch (e) { toast((e as Error).message, true); }
    await useWorkflows.getState().loadWorkflows();
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <Label hint="steps with your approval">Workflows</Label>
        {!device && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void create()}><Plus size={13} aria-hidden /> New workflow</Button>}
      </div>
      <ul className="flex flex-col gap-1" aria-label="Workflows">
        {(workflows ?? []).map((w) => {
          const rm = rooms.find((r) => r.id === w.roomId);
          const steps = w.graph.nodes.length - 1;
          return (
            <li key={w.id} className={cn('flex items-center gap-2 rounded-lg bg-card2/60 p-2 text-hint', !w.enabled && 'opacity-60')}>
              {!device && <Switch checked={w.enabled} onChange={(v) => void setEnabled(w.id, v)} aria-label={'Workflow ' + w.name + ' enabled'} />}
              <button
                type="button"
                className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => openPage({ kind: 'workflow', id: w.id })}
              >
                <div className="truncate text-ui font-medium">{w.name}</div>
                <div className="truncate text-muted">{rm ? (rm.kind === 'group' ? '# ' : '') + rm.name : 'No chat'} · {steps} {steps === 1 ? 'step' : 'steps'}{w.lastRun ? ' · ' + fmtUsd(w.lastRun.costUsd) + ' last run' : ''}</div>
              </button>
              {w.lastRun ? <Badge tone={RUN_STATUS_TONE[w.lastRun.status]}>{RUN_STATUS_LABEL[w.lastRun.status]}</Badge> : <Badge>Never run</Badge>}
            </li>
          );
        })}
        {workflows !== null && !workflows.length && <li className="py-4 text-center text-hint text-dim">{error ? 'Could not load workflows. ' + error : 'No workflows. Chain bot steps with your approval in between.'}</li>}
      </ul>
    </div>
  );
}
