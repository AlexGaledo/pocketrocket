// U3: "Needs you", one list of everything waiting on the user across every bot and room. Rows come from
// lib/inbox.ts; the primary action opens the room (or the bot's Skills tab), and a plain approval can be answered
// here with the same store action the card uses.
import { useEffect, useState } from 'react';
import { ClipboardList, Hand, Inbox, Monitor, Sparkles, ShieldQuestion, Workflow as WorkflowIcon } from 'lucide-react';
import { useStore, botById } from '../store';
import { fmtAge, type InboxItem } from '../lib/inbox';
import { cardWords } from '../lib/approvalWords';
import { fmtInput } from './WorkLine';
import { useInbox } from '../lib/useInbox';
import { Avatar, Button, EmptyState, Skeleton, SkeletonGroup } from './ui';
import { FleetHeader, PageBody } from './FleetPages';
import { WorkflowApprovalCardView } from './workflows/WorkflowCard';

const KIND_ICON = { approval: ShieldQuestion, takeover: Monitor, skill: Sparkles, form: ClipboardList, workflow: WorkflowIcon } as const;

export function InboxPage() {
  const items = useInbox();
  const ready = useStore((s) => s.helloReceived && s.inboxSkills !== null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <FleetHeader title="Needs you" sub={items.length ? items.length + ' waiting, all bots' : 'Approvals, screen requests and reviews, all bots'} />
      <PageBody>
        {!ready && items.length === 0 ? (
          <SkeletonGroup label="Loading" className="space-y-2 pt-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-2xl" />)}
          </SkeletonGroup>
        ) : items.length === 0 ? (
          <EmptyState icon={<Inbox size={18} />} title="Nothing needs you" as="h2">
            When a bot asks for approval, needs you on its screen or proposes a skill, it shows up here.
          </EmptyState>
        ) : (
          <ul className="space-y-2 pt-2" aria-label="Waiting on you">
            {items.map((it) => it.workflowCard
              // A workflow approval is answered right here, on its card: nothing else (a bot, a button, chat text) can answer it.
              ? <li key={it.key}><WorkflowApprovalCardView card={it.workflowCard} className="w-full" /></li>
              : <InboxRow key={it.key} item={it} now={now} />)}
          </ul>
        )}
      </PageBody>
    </>
  );
}

function InboxRow({ item, now }: { item: InboxItem; now: number }) {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const error = useStore((s) => (item.approvalId ? s.approvalErrors[item.approvalId] : undefined));
  const decide = useStore((s) => s.decide);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const closePage = useStore((s) => s.closePage);
  const openPage = useStore((s) => s.openPage);
  const bot = botById(bots, item.botId);
  const room = rooms.find((r) => r.id === item.roomId);
  const Icon = KIND_ICON[item.kind];
  const age = fmtAge(item.since, now);
  // A skill belongs to the bot that proposed it; a pool skill nobody proposed opens on the first bot.
  const skillBot = item.kind === 'skill' ? (bot ?? bots[0]) : undefined;

  const open = () => {
    if (item.roomId) {
      closePage();
      setActiveRoom(item.roomId);
    } else if (skillBot) openPage({ kind: 'bot', botId: skillBot.id, tab: 'skills' });
  };
  // Context only: the tool and a one-line summary, from the same formatting the card uses. Approving needs the card.
  const words = item.approval ? cardWords(item.approval) : null;
  const summary = item.approval ? (words ? words.main : fmtInput(item.approval.toolInput)).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  const canOpen = !!item.roomId || !!skillBot;
  const openLabel = item.kind === 'skill' ? 'Review' : 'Open';

  return (
    <li className="rounded-2xl bg-card p-3 ring-1 ring-line">
      <div className="flex items-start gap-3">
        {bot ? <Avatar bot={bot} size={34} /> : <span aria-hidden className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-card2 text-muted"><Icon size={16} /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-ui font-medium">
              {bot ? bot.name : item.kind === 'skill' ? 'A skill' : 'A bot'}
              {room && room.kind === 'group' && <span className="font-normal text-muted"> in {room.name}</span>}
            </span>
            {age && <span className="shrink-0 text-hint tabular-nums text-muted">{age === 'just now' ? age : age + ' ago'}</span>}
          </div>
          <div className="flex items-center gap-1.5 text-ui text-warn">
            {item.kind === 'takeover' ? <Hand size={12} aria-hidden /> : <Icon size={12} aria-hidden />}
            <span className="min-w-0">{item.title}</span>
          </div>
          {item.approval && <p className="mt-0.5 truncate text-hint text-muted" title={summary}><span className="font-mono">{item.approval.toolName}</span>{summary && ' \u00b7 ' + summary}</p>}
          {item.detail && <p className="mt-0.5 line-clamp-2 text-hint text-muted">{item.detail}</p>}
          {error && <p role="alert" className="mt-1 text-hint text-bad">{error}</p>}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
        {item.approvalId && item.canDeny && <Button size="sm" variant="danger" onClick={() => decide(item.approvalId!, 'deny')}>Deny</Button>}
        {canOpen && <Button size="sm" variant="primary" onClick={open}>{item.kind === 'approval' ? 'Review' : openLabel}</Button>}
      </div>
    </li>
  );
}
