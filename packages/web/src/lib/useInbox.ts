import { useMemo } from 'react';
import { useStore } from '../store';
import { selectInbox, type InboxItem } from './inbox';
import { useWorkflows } from './workflows';

/** The Needs you inbox, recomputed when any of its sources change. */
export function useInbox(): InboxItem[] {
  const openApprovals = useStore((s) => s.openApprovals);
  const messages = useStore((s) => s.messages);
  const control = useStore((s) => s.control);
  const skills = useStore((s) => s.inboxSkills);
  const cards = useWorkflows((s) => s.cards);
  const workflows = useWorkflows((s) => s.workflows);
  const workflowCards = useMemo(() => cards.map((card) => ({ card, roomId: workflows?.find((w) => w.id === card.workflowId)?.roomId ?? null })), [cards, workflows]);
  return useMemo(() => selectInbox({ openApprovals, messages, control, skills, workflowCards }), [openApprovals, messages, control, skills, workflowCards]);
}
