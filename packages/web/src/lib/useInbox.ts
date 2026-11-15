import { useMemo } from 'react';
import { useStore } from '../store';
import { selectInbox, type InboxItem } from './inbox';

/** The Needs you inbox, recomputed when any of its sources change. */
export function useInbox(): InboxItem[] {
  const openApprovals = useStore((s) => s.openApprovals);
  const messages = useStore((s) => s.messages);
  const control = useStore((s) => s.control);
  const skills = useStore((s) => s.inboxSkills);
  return useMemo(() => selectInbox({ openApprovals, messages, control, skills }), [openApprovals, messages, control, skills]);
}
