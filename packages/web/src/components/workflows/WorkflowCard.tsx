// The person-only approval card a workflow's approval step posts. It sits on ActionCard like the other chat cards and
// shows in the chat of the workflow's room and in Needs you. Only these buttons answer it: the hub refuses a bot, a cta
// button and chat text, so there is no CtaButtons here and nothing the bot wrote is a button.
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { WorkflowApprovalCard } from '@pocketrocket/shared';
import { ActionCard, ActionCardActions, ActionCardHeader, Button, Field, Label, Textarea } from '../ui';
import { api } from '../../lib/api';
import { expiresIn, useWorkflows } from '../../lib/workflows';

export function WorkflowApprovalCardView({ card, className }: { card: WorkflowApprovalCard; className?: string }) {
  const dropCard = useWorkflows((s) => s.dropCard);
  const [mode, setMode] = useState<'idle' | 'sendback'>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const send = async (d: Parameters<typeof api.workflows.decide>[1]) => {
    setBusy(true);
    setError(null);
    try {
      await api.workflows.decide(card.runId, d);
      dropCard(card.runId, card.nodeId);
    } catch (e) {
      // 403 (not allowed from here), 409 (already answered or expired), or the hub's own words.
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const expired = card.expiresAt <= now;
  return (
    <ActionCard tone="warn" role="group" aria-label={'Approval needed: ' + card.title} className={className ?? 'w-full max-w-[640px]'}>
      <ActionCardHeader
        compact
        icon={<ShieldCheck size={15} aria-hidden className="shrink-0 text-warn" />}
        meta={<span className="ml-auto shrink-0 text-hint text-muted">{expiresIn(card.expiresAt, now)}</span>}
      >
        <span className="min-w-0 truncate font-medium">{card.workflowName}: {card.title}</span>
      </ActionCardHeader>
      <p className="px-4 pt-1.5 text-ui text-muted">The run is paused until you answer. This is what the step before produced.</p>
      <div className="mx-4 mb-3 mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card2 p-2.5 text-ui" tabIndex={0} aria-label="Draft to review">
        {card.draft || <span className="text-muted">The step before produced no text.</span>}
      </div>
      {mode === 'sendback' ? (
        <form
          className="flex flex-col gap-2 px-4 pb-4"
          onSubmit={(e) => { e.preventDefault(); if (note.trim()) void send({ decision: 'send_back', note: note.trim() }); }}
        >
          <Field>
            <Label hint="The bot redoes the step once with your note">Your note</Label>
            <Textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="What should change?" />
          </Field>
          {error && <p role="alert" className="text-hint text-bad">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" className="touch-target" disabled={busy || !note.trim()}>Send back</Button>
            <Button type="button" className="touch-target" disabled={busy} onClick={() => { setMode('idle'); setError(null); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <ActionCardActions>
          <Button size="sm" variant="primary" className="touch-target" disabled={busy || expired} onClick={() => void send({ decision: 'approve' })}>Approve</Button>
          <Button size="sm" variant="danger" className="touch-target" disabled={busy || expired} onClick={() => void send({ decision: 'reject' })}>Reject</Button>
          {card.canSendBack && <Button size="sm" className="touch-target" disabled={busy || expired} onClick={() => setMode('sendback')}>Send back with a note…</Button>}
          {!card.canSendBack && <span className="basis-full text-hint text-muted">Already sent back once. Approve or reject now.</span>}
          {expired && <span className="basis-full text-hint text-muted">This card expired. Run the workflow again.</span>}
          {error && <p role="alert" className="basis-full text-hint text-bad">{error}</p>}
        </ActionCardActions>
      )}
    </ActionCard>
  );
}

/** Open cards for one room, above the composer. Nothing renders when there are none. */
export function WorkflowCardsForRoom({ roomId }: { roomId: string }) {
  const cards = useWorkflows((s) => s.cards);
  const workflows = useWorkflows((s) => s.workflows);
  const mine = cards.filter((c) => workflows?.find((w) => w.id === c.workflowId)?.roomId === roomId);
  if (!mine.length) return null;
  return (
    <div className="mx-auto flex w-full max-w-[var(--page-max)] flex-col gap-2 px-4 pb-2">
      {mine.map((c) => <WorkflowApprovalCardView key={c.runId + c.nodeId} card={c} />)}
    </div>
  );
}
