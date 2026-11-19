// U3: "Needs you", one list of everything waiting on the user across every bot and room. Rows come from
// lib/inbox.ts; the primary action opens the room (or the bot's Skills tab), and a plain approval can be answered
// here with the same store action the card uses.
import { useEffect, useState } from 'react';
import { ArrowRight, ClipboardList, Gauge, Hand, Inbox, Monitor, Sparkles, ShieldQuestion, Workflow as WorkflowIcon } from 'lucide-react';
import { useStore, botById } from '../store';
import { fmtAge, type InboxItem } from '../lib/inbox';
import { cardWords } from '../lib/approvalWords';
import { fmtInput } from './WorkLine';
import { useInbox } from '../lib/useInbox';
import { ActionCard, Avatar, Button, EmptyState, Skeleton, SkeletonGroup, cn } from './ui';
import { PageBody } from './FleetPages';
import { PageHeader, useNewPages } from './PageHeader';
import { groupByProject } from '../lib/inboxGroups';
import { WorkflowApprovalCardView } from './workflows/WorkflowCard';
import { FailoverCardView } from './FailoverCard';

const KIND_ICON = { approval: ShieldQuestion, takeover: Monitor, skill: Sparkles, form: ClipboardList, workflow: WorkflowIcon, failover: Gauge } as const;

export function InboxPage() {
  const items = useInbox();
  const ready = useStore((s) => s.helloReceived && s.inboxSkills !== null);
  const fresh = useNewPages();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <PageHeader title="Needs you" sub={items.length ? items.length + ' waiting, all bots' : 'Approvals, screen requests and reviews, all bots'} />
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
          fresh ? <GroupedRows items={items} now={now} /> : (
            <ul className="space-y-2 pt-2" aria-label="Waiting on you">
              {items.map((it) => <Row key={it.key} item={it} now={now} />)}
            </ul>
          )
        )}
      </PageBody>
    </>
  );
}

function Row({ item: it, now, fresh }: { item: InboxItem; now: number; fresh?: boolean }) {
  // A workflow approval is answered right here, on its card: nothing else (a bot, a button, chat text) can answer it.
  if (it.workflowCard) return <li><WorkflowApprovalCardView card={it.workflowCard} className="w-full" /></li>;
  // A limit card likewise: only its own buttons answer it, so the row is the card.
  if (it.failoverCard) return <li><FailoverCardView card={it.failoverCard} className="w-full" /></li>;
  return <InboxRow item={it} now={now} fresh={fresh} />;
}

/**
 * New layout: the rows under the project whose room they wait in, projects in the sidebar's order and "Other rooms"
 * last. With no project involved it is the plain list, as there is nothing to group.
 */
function GroupedRows({ items, now }: { items: InboxItem[]; now: number }) {
  const projects = useStore((s) => s.projects);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const closePage = useStore((s) => s.closePage);
  const groups = groupByProject(items, projects);
  if (!groups.some((g) => g.project)) {
    return <ul className="space-y-2 pt-2" aria-label="Waiting on you">{items.map((it) => <Row key={it.key} item={it} now={now} fresh />)}</ul>;
  }
  return (
    <div className="space-y-6 pt-2">
      {groups.map((g) => {
        const id = 'needs-' + (g.project ? 'p-' + g.project.slug : 'other');
        const roomId = g.project?.roomId;
        return (
          <section key={id} aria-labelledby={id}>
            <div className="mb-2 flex min-h-8 items-center gap-2 pl-1">
              <h2 id={id} className="min-w-0 break-words text-ui font-medium text-fg">{g.project ? g.project.name : 'Other rooms'}</h2>
              <span aria-hidden className="shrink-0 font-mono text-hint text-dim">{g.items.length}</span>
              {roomId && (
                <Button size="sm" variant="ghost" className="ml-auto shrink-0" aria-label={'Open project ' + g.project!.name} onClick={() => { closePage(); setActiveRoom(roomId); }}>
                  Open project <ArrowRight size={13} aria-hidden />
                </Button>
              )}
            </div>
            <ul className="space-y-2">{g.items.map((it) => <Row key={it.key} item={it} now={now} fresh />)}</ul>
          </section>
        );
      })}
    </div>
  );
}

function InboxRow({ item, now, fresh }: { item: InboxItem; now: number; fresh?: boolean }) {
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

  const body = (
    <>
      <div className="flex items-start gap-3">
        {bot ? <Avatar bot={bot} size={34} /> : <span aria-hidden className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-card2 text-muted"><Icon size={16} /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 text-ui font-medium', fresh ? 'break-words' : 'truncate')}>
              {bot ? bot.name : item.kind === 'skill' ? 'A skill' : 'A bot'}
              {room && room.kind === 'group' && <span className="font-normal text-muted"> in {room.name}</span>}
            </span>
            {age && <span className="shrink-0 text-hint tabular-nums text-muted">{age === 'just now' ? age : age + ' ago'}</span>}
          </div>
          <div className={cn('flex items-center gap-1.5 text-ui', fresh ? 'text-needs' : 'text-warn')}>
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
    </>
  );
  // New layout: the card with the needs edge, like the overview's cards (docs/specs/toki-ui.md).
  return fresh
    ? <li><ActionCard edge="needs" className="bg-card p-3">{body}</ActionCard></li>
    : <li className="rounded-2xl bg-card p-3 ring-1 ring-line">{body}</li>;
}
