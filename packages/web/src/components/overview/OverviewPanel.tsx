// New layout (docs/specs/toki-ui.md, W6): the right panel's overview for the open chat. Needs you, then Bots, then
// Next, Rooms and Done behind icons; or, folded, a 56 px rail of the same icons with their counts. In a room with no
// project only Needs you and Bots show. Approving is never offered here: Review opens the chat's own card.
import { useEffect, useState } from 'react';
import { ArrowRight, Bot as BotIcon, CheckCheck, ClipboardList, Gauge, Hash, Inbox, Monitor, PanelRightClose, PanelRightOpen, ShieldQuestion, Sparkles, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { ApprovalPayload, Bot, Room } from '@pocketrocket/shared';
import { useStore, botById, selectActiveRoom } from '../../store';
import { fmtAge, type InboxItem } from '../../lib/inbox';
import { useInbox } from '../../lib/useInbox';
import { avatarStatus, STATUS_LABEL, useBotStatus, type BotStatus } from '../../lib/botStatus';
import { cardWords } from '../../lib/approvalWords';
import { projectOfRoom } from '../../lib/projects';
import { revealMessage, useOverview } from '../../lib/useProject';
import type { ProjectInfo } from '../../lib/api';
import { ActionCard, ActionCardActions, ActionCardHeader, Avatar, Badge, Button, IconRailButton, SectionLabel, Tooltip, cn } from '../ui';
import { WorkflowApprovalCardView } from '../workflows/WorkflowCard';
import { FailoverCardView } from '../FailoverCard';
import { fmtInput } from '../WorkLine';

type Pane = 'next' | 'rooms' | 'done';
const PANES: { id: Pane; label: string; icon: React.ReactNode }[] = [
  { id: 'next', label: 'Next', icon: <ArrowRight size={17} aria-hidden /> },
  { id: 'rooms', label: 'Rooms', icon: <Hash size={17} aria-hidden /> },
  { id: 'done', label: 'Done', icon: <CheckCheck size={17} aria-hidden /> },
];

const KIND_ICON = { approval: ShieldQuestion, takeover: Monitor, skill: Sparkles, form: ClipboardList, workflow: WorkflowIcon, failover: Gauge } as const;

/** `inline`: beside the chat. Otherwise it covers the window (a phone), and has a close button instead of a rail. */
export function OverviewPanel({ inline }: { inline: boolean }) {
  const room = useStore(selectActiveRoom);
  const project = useStore((s) => projectOfRoom(s.projects, s.activeRoomId));
  const rail = useStore((s) => s.overviewRail) && inline;
  const setRail = useStore((s) => s.setOverviewRail);
  const closePanel = useStore((s) => s.closePanel);
  const items = useInbox().filter((i) => !!room && i.roomId === room.id);
  const members = useMembersOf(room, project);
  const { statusOf } = useBotStatus();
  const [showPaused, setShowPaused] = useState(false);
  // Next, Rooms or Done, opened below the icons. A new chat starts with none open.
  const [pane, setPane] = useState<Pane | null>(null);
  useEffect(() => setPane(null), [room?.id]);

  const live = members.filter((b) => statusOf(b.id) !== 'paused');
  const paused = members.length - live.length;
  const shown = showPaused ? members : live;
  const label = project ? project.name + ' overview' : 'Overview';

  if (rail) {
    const unfold = (p: Pane | null) => { setPane(p); setRail(false); };
    return (
      <aside aria-label={label} className="panel flex w-full flex-col items-center gap-1.5 overflow-y-auto overflow-x-clip py-2">
        <IconRailButton icon={<PanelRightOpen size={17} aria-hidden />} label="Show overview" onClick={() => unfold(null)} />
        <span aria-hidden className="my-1 h-px w-6 bg-line" />
        <IconRailButton icon={<Inbox size={17} aria-hidden />} label="Needs you" count={items.length} needs onClick={() => unfold(null)} />
        <IconRailButton icon={<BotIcon size={17} aria-hidden />} label="Bots" count={live.length} onClick={() => unfold(null)} />
        {project && (
          <>
            <span aria-hidden className="my-1 h-px w-6 bg-line" />
            {PANES.map((p) => <IconRailButton key={p.id} icon={p.icon} label={p.label} onClick={() => unfold(p.id)} />)}
          </>
        )}
      </aside>
    );
  }

  return (
    <aside aria-label={label} className="panel flex w-full min-w-0 flex-col overflow-clip">
      <div className="flex h-14 shrink-0 items-center gap-2 pl-1 pr-3">
        <SectionLabel as="h2" className="min-w-0 flex-1 text-muted" aside={items.length > 0 && <Badge tone="needs">{items.length}<span className="sr-only"> waiting</span></Badge>}>Needs you</SectionLabel>
        {inline ? (
          <Tooltip content="Fold to icons">
            <Button variant="ghost" size="icon" aria-label="Fold overview to icons" onClick={() => setRail(true)}><PanelRightClose size={16} /></Button>
          </Tooltip>
        ) : (
          <Tooltip content="Close">
            <Button variant="ghost" size="icon" aria-label="Close overview" onClick={closePanel}><X size={16} /></Button>
          </Tooltip>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
        <section aria-label="Needs you">
          {items.length === 0
            ? <p className="px-1 pb-1 text-hint text-muted">All caught up.</p>
            : <ul className="space-y-2">{items.map((it) => <li key={it.key}><NeedsCard item={it} covering={!inline} /></li>)}</ul>}
        </section>

        <section aria-labelledby="overview-bots" className="mt-6">
          <SectionLabel as="h2" id="overview-bots" count={live.length} className="mb-1 px-1">Bots</SectionLabel>
          {shown.length === 0
            ? <p className="px-1 text-hint text-muted">No active bots.</p>
            : <ul>{shown.map((b) => <li key={b.id}><BotLine bot={b} status={statusOf(b.id)} /></li>)}</ul>}
          {paused > 0 && (
            <button type="button" className="mt-1 rounded-xs px-1 text-hint text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-expanded={showPaused} onClick={() => setShowPaused((v) => !v)}>
              {showPaused ? 'Hide paused' : 'Show paused (' + paused + ')'}
            </button>
          )}
        </section>

        {project && room && (
          <section aria-label="More about this project" className="mt-5 border-t border-line pt-3">
            <div role="group" aria-label="More" className="flex gap-1.5">
              {PANES.map((p) => <IconRailButton key={p.id} icon={p.icon} label={p.label} pressed={pane === p.id} onClick={() => setPane(pane === p.id ? null : p.id)} />)}
            </div>
            {pane && <MorePane pane={pane} project={project} room={room} />}
          </section>
        )}
      </div>
    </aside>
  );
}

/** A project's bots are its room's members, or its own list while it has no room. */
function useMembersOf(room: Room | null | undefined, project: ProjectInfo | null): Bot[] {
  const bots = useStore((s) => s.bots);
  const ids = room?.memberIds ?? project?.memberIds ?? [];
  return ids.map((id) => botById(bots, id)).filter((b): b is Bot => !!b);
}

/** Next, Rooms or Done: a few lines from current.md, or the rooms to jump to. Plain text only. */
function MorePane({ pane, project, room }: { pane: Pane; project: ProjectInfo; room: Room }) {
  const overview = useOverview(project.slug);
  const rooms = useStore((s) => s.rooms);
  const unread = useStore((s) => s.unread);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const closePage = useStore((s) => s.closePage);
  const title = PANES.find((p) => p.id === pane)!.label;
  const quiet = (text: string) => <p className="text-hint text-muted">{text}</p>;
  // The project's room, then a one-on-one chat with each of its bots.
  const dms = room.memberIds.flatMap((id) => rooms.filter((r) => r.kind === 'dm' && r.memberIds[0] === id));
  return (
    <div role="region" aria-label={title} className="mt-3 rounded-lg bg-card2 p-3">
      <h3 className="mb-2 text-label text-muted">{title}</h3>
      {pane === 'next' && (overview === undefined ? quiet('Loading…') : overview?.next ? <p className="text-ui [overflow-wrap:anywhere]">{overview.next}</p> : quiet('Nothing under Next in current.md.'))}
      {pane === 'done' && (overview === undefined ? quiet('Loading…') : overview?.done.length
        ? <ul className="space-y-1.5">{[...overview.done].reverse().map((d, i) => (
            <li key={i} className="flex gap-2 text-ui [overflow-wrap:anywhere]"><CheckCheck size={13} aria-hidden className="mt-1 shrink-0 text-dim" />{d}</li>
          ))}</ul>
        : quiet('Nothing under Done in current.md.'))}
      {pane === 'rooms' && (
        <ul className="-mx-1.5">
          {[room, ...dms].map((r) => (
            <li key={r.id}>
              <button type="button" aria-current={r.id === room.id ? 'page' : undefined} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-ui hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-[current=page]:font-medium pointer-coarse:min-h-11" onClick={() => { closePage(); setActiveRoom(r.id); }}>
                <span aria-hidden className="w-3 shrink-0 text-center text-dim">{r.kind === 'group' ? '#' : '@'}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{r.name}</span>
                {(unread[r.id] ?? 0) > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-accent"><span className="sr-only">{unread[r.id]} unread</span></span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One bot: face with its state ring, name, and what it is doing. Opens its page, like the header's faces. */
function BotLine({ bot, status }: { bot: Bot; status: BotStatus }) {
  const openPage = useStore((s) => s.openPage);
  const sub = status === 'idle' ? bot.title || '@' + bot.handle : STATUS_LABEL[status];
  const tone = status === 'needs_you' ? 'text-needs' : status === 'error' ? 'text-bad' : status === 'idle' || status === 'paused' || status === 'waiting_on_bot' ? 'text-muted' : 'text-ok';
  return (
    <button type="button" className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title={'Open ' + bot.name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: bot.id, tab: 'memory' })}>
      <Avatar bot={bot} {...avatarStatus(status)} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium [overflow-wrap:anywhere]">{bot.name}</span>
        <span className={cn('block truncate text-hint', tone)} title={sub}>{sub}</span>
      </span>
    </button>
  );
}

/**
 * A card waiting on the owner, shaped like the chat's approval card: the same header, then Review (which opens the
 * chat at the full card) and Deny only where the inbox allows it. Workflow and limit cards are answered on their
 * own buttons, so they come in whole.
 */
function NeedsCard({ item, covering }: { item: InboxItem; covering: boolean }) {
  if (item.workflowCard) return <WorkflowApprovalCardView card={item.workflowCard} className="w-full" />;
  if (item.failoverCard) return <FailoverCardView card={item.failoverCard} className="w-full" />;
  return <ReviewCard item={item} covering={covering} />;
}

function ReviewCard({ item, covering }: { item: InboxItem; covering: boolean }) {
  const bot = useStore((s) => botById(s.bots, item.botId));
  const error = useStore((s) => (item.approvalId ? s.approvalErrors[item.approvalId] : undefined));
  const messages = useStore((s) => (item.roomId ? s.messages[item.roomId] : undefined));
  const decide = useStore((s) => s.decide);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const closePage = useStore((s) => s.closePage);
  const closePanel = useStore((s) => s.closePanel);
  const Icon = KIND_ICON[item.kind];
  const age = fmtAge(item.since, Date.now());
  const words = item.approval ? cardWords(item.approval) : null;
  const summary = item.approval ? (words ? words.main : fmtInput(item.approval.toolInput)).replace(/\s+/g, ' ').trim().slice(0, 160) : '';

  const review = () => {
    if (!item.roomId) return;
    const messageId = item.kind === 'approval'
      ? messages?.find((m) => m.kind === 'approval' && (m.payload as ApprovalPayload | null)?.approvalId === item.approvalId)?.id
      : item.key.slice(item.key.indexOf(':') + 1);
    closePage();
    setActiveRoom(item.roomId);
    // Over the window on a phone: get out of the way so the card can be seen.
    if (covering) closePanel();
    if (messageId) revealMessage(messageId);
  };

  return (
    <ActionCard edge="needs" className="bg-card">
      {/* Worded like the chat's approval card ("Needs your OK" and the tool), so the two read as the same thing. */}
      <ActionCardHeader compact icon={<Icon size={15} aria-hidden className="shrink-0 text-needs" />} meta={<>
        {item.approval && <span className="min-w-0 truncate font-mono text-hint text-muted">{item.approval.toolName}</span>}
        {age && <span className="ml-auto shrink-0 pl-2 text-hint tabular-nums text-muted">{age}</span>}
      </>}>
        <span className="shrink-0 font-medium">{item.kind === 'approval' ? 'Needs your OK' : item.title}</span>
      </ActionCardHeader>
      <div className="px-4 pt-1 text-hint text-muted">
        {bot && <span className="text-fg">@{bot.handle}</span>}
        {summary && <p className="mt-0.5 line-clamp-2 [overflow-wrap:anywhere]">{summary}</p>}
        {item.detail && <p className="mt-0.5 line-clamp-2 [overflow-wrap:anywhere]">{item.detail}</p>}
        {error && <p role="alert" className="mt-1 text-bad">{error}</p>}
      </div>
      <ActionCardActions className="mt-3 pb-3">
        <Button size="sm" variant="primary" className="touch-target" onClick={review}>Review</Button>
        {item.approvalId && item.canDeny && <Button size="sm" variant="danger" className="touch-target" onClick={() => decide(item.approvalId!, 'deny')}>Deny</Button>}
      </ActionCardActions>
    </ActionCard>
  );
}
