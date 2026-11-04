import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRightLeft, Check, ChevronDown, Clock, Info, Monitor, Send, Settings2, ShieldAlert, Square, Users, Zap } from 'lucide-react';
import { CHAT_MODELS, MODELS } from '@pocketrocket/shared';
import { RocketMark } from './RocketMark';
import type { ApprovalPayload, Bot, HandoffPayload, HandoffResultPayload, Message, Room, RoutinePayload, TakeoverPayload } from '@pocketrocket/shared';
import type { Approvals, TriggerPayload } from '@pocketrocket/shared';
import { useStore, selectActiveRoom, botById } from '../store';
import { api } from '../lib/api';
import { Avatar, Badge, Button, DialogCloseButton, DialogShell, DialogTitle, Menu, MenuContent, RoomAvatar, UserAvatar, cn, fmtTime } from './ui';
import { Markdown } from './Markdown';
import { RuleOffer, TakeoverCard } from './ComputerControl';
import { WorkLine, fmtInput, isStep } from './WorkLine';
import { avatarStatus, isWorking, useBotStatus } from '../lib/botStatus';
import { selectScreenSize } from '../lib/screenView';
import { useMediaUrl } from '../lib/media';

export function ChatPane() {
  const room = useStore(selectActiveRoom);
  const bots = useStore((s) => s.bots);
  const { statusOf } = useBotStatus();
  const panelOpen = useStore((s) => s.panelOpen);
  const openScreen = useStore((s) => s.openScreen);
  const closePanel = useStore((s) => s.closePanel);
  const openPage = useStore((s) => s.openPage);
  const screenSize = useStore(selectScreenSize);
  const openDialog = useStore((s) => s.openDialog);
  const helloReceived = useStore((s) => s.helloReceived);
  const control = useStore((s) => s.control);
  // P9: a paired phone may not create or edit bots and rooms (the hub answers 403), so it is not offered.
  const device = useStore((s) => s.device);

  if (!room && !helloReceived) {
    // Until the hub's hello arrives there is no telling whether the team is empty, so claim nothing.
    return (
      <div role="status" aria-label="Connecting" className="flex h-full flex-col gap-5 px-6 py-8">
        <div className="mx-auto flex w-full max-w-[var(--page-max)] flex-col gap-5 motion-safe:animate-pulse">
          {[64, 40, 52].map((w, i) => (
            <div key={i} className="flex gap-3">
              <div className="h-[30px] w-[30px] shrink-0 rounded-full bg-card2" />
              <div className="flex flex-1 flex-col gap-2 pt-1">
                <div className="h-3 w-24 rounded-full bg-card2" />
                <div className="h-3 rounded-full bg-card2" style={{ width: w + '%' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!room && bots.length > 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div>
          <div className="text-title-sm">Pick a bot to start</div>
        </div>
        {!device && <Button onClick={() => openDialog({ kind: 'room', room: null })}>New group chat</Button>}
      </div>
    );
  }

  if (!room) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <RocketMark size={56} />
        <div>
          <div className="text-title-sm">Your team is empty</div>
          <div className="mt-1 max-w-[38ch] text-ui text-muted">Create a bot, then message it.</div>
        </div>
        {device ? (
          <div className="max-w-[38ch] text-ui text-muted">Create bots on the desktop app.</div>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => openDialog({ kind: 'bot', bot: null })}>Create a bot</Button>
            <Button onClick={() => openDialog({ kind: 'room', room: null })}>New group chat</Button>
          </div>
        )}
      </div>
    );
  }

  const members = room.memberIds.map((id) => botById(bots, id)).filter((b): b is Bot => !!b);
  const working = members.filter((m) => isWorking(statusOf(m.id)));
  const needs = members.filter((m) => statusOf(m.id) === 'needs_you').length;
  // P2: in a group, say which bots' screens the user holds or paused.
  const held = room.kind === 'group' ? members.filter((m) => (control[m.id]?.control ?? 'agent') !== 'agent') : [];

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 px-5">
        {room.kind === 'group' && <RoomAvatar room={room} size={30} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {room.kind === 'dm' && members[0]
              ? <button type="button" className="min-w-24 truncate rounded-xs text-left text-body font-semibold hover:underline" title={'Open ' + members[0].name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: members[0].id, tab: 'memory' })}>{room.name}</button>
              : room.kind === 'group' && !device
                ? <button type="button" className="min-w-24 truncate rounded-xs text-left text-body font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title="Group details" onClick={() => openDialog({ kind: 'room', room })}>{room.name}</button>
                : <span className="min-w-24 truncate text-body font-semibold">{room.name}</span>}
            <span className="flex min-w-0 items-center gap-2 overflow-hidden @max-[640px]:hidden">
              {room.coordinatorBotId && <Badge tone="accent">coordinator @{botById(bots, room.coordinatorBotId)?.handle}</Badge>}
              {held.map((m) => <Badge key={m.id} tone="warn">@{m.handle} {control[m.id]?.control === 'paused' ? 'paused' : 'screen: you'}</Badge>)}
            </span>
          </div>
          <div className="truncate text-hint text-muted">
            {room.kind === 'dm' ? members[0]?.title || '@' + members[0]?.handle : members.map((m) => '@' + m.handle).join('  ')}
            {needs > 0 && <span className="ml-2 text-warn">{room.kind === 'dm' ? 'Needs you' : needs + (needs === 1 ? ' needs you' : ' need you')}</span>}
            {working.length > 0 && <span className="ml-2 text-ok">{working.length} working</span>}
          </div>
        </div>
        {/* A narrow group header has the group's own picture, and the sidebar lists its bots: the name keeps the room. */}
        <div className={cn('flex shrink-0 -space-x-2', room.kind === 'group' && '@max-[480px]:hidden')}>
          {members.slice(0, HEADER_AVATARS).map((m) => (
            <button key={m.id} type="button" className="rounded-full ring-2 ring-bg" aria-label={'Open ' + m.name + "'s page"} title={'Open ' + m.name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: m.id, tab: 'memory' })}>
              <Avatar bot={m} {...avatarStatus(statusOf(m.id))} size={26} />
            </button>
          ))}
          {members.length > HEADER_AVATARS && (
            <span className="flex h-[26px] items-center rounded-full bg-card2 px-1.5 text-hint text-muted ring-2 ring-bg" title={members.slice(HEADER_AVATARS).map((m) => m.name).join(', ')}>+{members.length - HEADER_AVATARS}</span>
          )}
        </div>
        {room.kind === 'group' && !device && (
          <Button variant="ghost" size="icon" title="Group details" aria-label="Group details" onClick={() => openDialog({ kind: 'room', room })}><Users size={16} /></Button>
        )}
        {room.kind === 'dm' && members[0] && (
          <Button variant="ghost" size="icon" title="Memory, skills and automations" aria-label={'Open ' + members[0].name + "'s page"} onClick={() => openPage({ kind: 'bot', botId: members[0].id, tab: 'memory' })}><Settings2 size={16} /></Button>
        )}
        {screenSize !== 'focus' && (
          <Button variant="ghost" size="icon" title={panelOpen ? 'Hide screen' : 'Watch screen'} aria-label="Screen" aria-pressed={panelOpen} onClick={() => (panelOpen ? closePanel() : openScreen())}><Monitor size={16} /></Button>
        )}
      </header>
      {/* Keyed so scroll state and the paging bookkeeping start fresh in every room. */}
      <Transcript key={room.id} roomId={room.id} />
      <Composer members={members} />
    </>
  );
}

/** A room can hold 10 bots; past this the header says +N, so the name and buttons keep their width. */
const HEADER_AVATARS = 4;

function Transcript({ roomId }: { roomId: string }) {
  const messages = useStore((s) => s.messages[roomId]);
  const loaded = useStore((s) => !!s.loaded[roomId]);
  const history = useStore((s) => s.history[roomId]);
  const loadOlder = useStore((s) => s.loadOlder);
  const streaming = useStore((s) => s.streaming);
  const bots = useStore((s) => s.bots);
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  // What arrived below while the user was reading further up; drives the jump button.
  const [unseen, setUnseen] = useState<'messages' | 'approval' | 'takeover' | null>(null);

  const streams = useMemo(() => Object.entries(streaming).filter(([, v]) => v.roomId === roomId && v.text), [streaming, roomId]);

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages, streams, stick]);
  useEffect(() => { if (stick) setUnseen(null); }, [stick]);

  // New messages land at the end of the list; older pages land at the start. Only the former count as unseen.
  const lastId = messages?.[messages.length - 1]?.id;
  const seenLastId = useRef(lastId);
  useEffect(() => {
    const prev = seenLastId.current;
    seenLastId.current = lastId;
    if (stick || !prev || !messages || lastId === prev) return;
    const at = messages.findIndex((m) => m.id === prev);
    // The user's own messages are not news to them.
    const fresh = at >= 0 ? messages.slice(at + 1).filter((m) => m.authorType !== 'user') : [];
    if (!fresh.length) return;
    const approval = fresh.some((m) => m.kind === 'approval' && (m.payload as ApprovalPayload).status === 'pending');
    const takeover = fresh.some((m) => m.kind === 'takeover' && (m.payload as TakeoverPayload).status === 'waiting');
    // Something the user must answer is never downgraded to "New messages".
    setUnseen((u) => (approval || u === 'approval' ? 'approval' : takeover || u === 'takeover' ? 'takeover' : 'messages'));
  }, [lastId]);

  // Keep the reader's place when an older page is prepended: shift by exactly the height it added.
  // The scroller opts out of the browser's own scroll anchoring so the two never adjust twice.
  const oldestId = messages?.[0]?.id;
  const lastOldestId = useRef(oldestId);
  const lastHeight = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (lastOldestId.current && oldestId !== lastOldestId.current && !stick) el.scrollTop += el.scrollHeight - lastHeight.current;
    lastOldestId.current = oldestId;
    lastHeight.current = el.scrollHeight;
  });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    // Heights also change without a render here (a tool chip expanding), so re-measure on every scroll.
    lastHeight.current = el.scrollHeight;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (el.scrollTop < 200 && el.scrollHeight > el.clientHeight) void loadOlder(roomId);
  };

  const jumpToBottom = () => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    setStick(true);
  };

  const groups = useMemo(() => groupMessages(messages ?? []), [messages]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {history?.loading && (
        // Overlaid rather than in the flow, so it appearing does not push the transcript down.
        <div role="status" className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-panel px-3 py-1 text-hint text-muted shadow-[var(--shadow-overlay)]">Loading…</div>
      )}
      <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 py-4 [overflow-anchor:none]">
        <div className="mx-auto flex max-w-[var(--page-max)] flex-col gap-6">
          {!messages?.length && (
            loaded
              ? <div className="py-12 text-center text-ui text-muted">Nothing here yet. Say what you need.</div>
              : <div role="status" className="py-12 text-center text-ui text-dim">Loading…</div>
          )}
          {groups.map((g) => (
            <MessageGroup key={g.key} group={g} bots={bots} />
          ))}
          {streams.map(([turnId, s]) => {
            const bot = botById(bots, s.botId);
            return bot ? (
              <div key={turnId} className="flex gap-3 pr-10 @max-[560px]:pr-2">
                <Avatar bot={bot} size={30} state="thinking" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-baseline gap-2"><span className="text-ui font-medium">{bot.name}</span><span className="text-hint text-dim">typing</span></div>
                  <div className="md text-body text-fg/80"><RichText text={s.text} bots={bots} /><span className="caret" /></div>
                </div>
              </div>
            ) : null;
          })}
        </div>
      </div>
      {unseen && (
        <button
          type="button"
          onClick={jumpToBottom}
          className={cn(
            'absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-md px-3.5 py-1.5 text-label shadow-[var(--shadow-overlay)] ring-1',
            unseen === 'messages' ? 'bg-panel text-fg ring-line' : 'bg-panel text-warn ring-warn/40',
          )}
        >
          <ArrowDown size={14} aria-hidden /> {unseen === 'approval' ? 'Approval waiting' : unseen === 'takeover' ? 'Needs you' : 'New messages'}
        </button>
      )}
    </div>
  );
}

interface Group { key: string; authorType: Message['authorType']; authorId: string | null; items: Message[] }
function groupMessages(msgs: Message[]): Group[] {
  const out: Group[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    const solo = m.kind === 'system' || m.kind === 'routine' || m.kind === 'trigger';
    const lastSolo = last && (last.items[0].kind === 'system' || last.items[0].kind === 'routine' || last.items[0].kind === 'trigger');
    const prev = last?.items[last.items.length - 1];
    // A long pause starts a new group, except inside one turn: a bot on a slow page is still on the same job.
    const together = prev && (m.createdAt - prev.createdAt < 5 * 60_000 || (m.turnId !== null && m.turnId === prev.turnId));
    if (!solo && last && !lastSolo && last.authorType === m.authorType && last.authorId === m.authorId && together) {
      last.items.push(m);
    } else out.push({ key: m.id, authorType: m.authorType, authorId: m.authorId, items: [m] });
  }
  return out;
}

type Segment = { kind: 'work'; key: string; items: Message[]; startedAt: number; endedAt: number } | { kind: 'one'; item: Message };

/**
 * One work line per turn, first in the turn, and then what the user came for. Text that a later step and a later
 * text both follow is narration, so it folds; the last text of a turn always stays out, because a bot often answers
 * first and then saves to memory. Cards are never tools, so they stay out too.
 */
function segments(items: Message[]): Segment[] {
  const out: Segment[] = [];
  for (let start = 0; start < items.length;) {
    let end = start + 1;
    while (end < items.length && items[end].turnId === items[start].turnId) end++;
    const turn = items.slice(start, end);
    const folds = (m: Message, i: number) => isStep(m) || (m.kind === 'text' && turn.slice(i + 1).some(isStep) && turn.slice(i + 1).some((x) => x.kind === 'text'));
    const work = turn.filter(folds);
    if (work.some(isStep)) out.push({ kind: 'work', key: 'work-' + work[0].id, items: work, startedAt: turn[0].createdAt, endedAt: turn[turn.length - 1].createdAt });
    for (const [i, m] of turn.entries()) if (!folds(m, i) && m.kind !== 'tool') out.push({ kind: 'one', item: m });
    start = end;
  }
  return out;
}

function MessageGroup({ group, bots }: { group: Group; bots: Bot[] }) {
  const first = group.items[0];
  const userName = useStore((s) => s.settings.userName);
  const userAvatar = useStore((s) => s.settings.userAvatar);
  if (first.kind === 'trigger') return <TriggerLine m={first} bots={bots} />;
  if (first.kind === 'system' || first.kind === 'routine') return <SystemLine m={first} bots={bots} />;
  const bot = group.authorType === 'bot' || group.authorType === 'system' ? botById(bots, group.authorId) : undefined;
  if (group.authorType === 'user') {
    return (
      <div className="flex justify-end gap-3 pl-16 @max-[560px]:pl-6">
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5">
          {group.items.map((m) => (
            <div key={m.id} className="md max-w-[85%] rounded-xl rounded-br-xs bg-user px-4 py-2.5 text-body">
              <RichText text={m.text} bots={bots} />
              {m.attachments?.length ? <Attachments refs={m.attachments} /> : null}
            </div>
          ))}
          <span className="pr-1 text-hint text-dim">{fmtTime(first.createdAt)}</span>
        </div>
        <UserAvatar name={userName} avatar={userAvatar} size={30} />
      </div>
    );
  }
  return (
    <div className="flex gap-3 pr-10 @max-[560px]:pr-2">
      {bot ? <Avatar bot={bot} size={30} /> : <div className="h-[30px] w-[30px] rounded-full bg-card2" />}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-ui font-medium">{bot?.name ?? 'Bot'}</span>
          <span className="text-hint text-dim">{fmtTime(first.createdAt)}</span>
        </div>
        <div className="flex flex-col gap-2">
          {segments(group.items).map((seg) =>
            seg.kind === 'work' ? <WorkLine key={seg.key} items={seg.items} startedAt={seg.startedAt} endedAt={seg.endedAt} /> : (
              <div key={seg.item.id} className="flex flex-col gap-1">
                <Item m={seg.item} bots={bots} />
                {chipAfter(group.items, seg.item) && <ModelChip m={seg.item} />}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function Item({ m, bots }: { m: Message; bots: Bot[] }) {
  switch (m.kind) {
    case 'approval': return <ApprovalCard m={m} />;
    case 'takeover': return <TakeoverCard m={m} />;
    case 'handoff': return <HandoffCard m={m} bots={bots} />;
    default: {
      // A bot outside this chat reporting back: its work is in its own chat.
      const work = m.kind === 'text' ? (m.payload as HandoffResultPayload | null)?.workRoomId : undefined;
      return (
        <div className="md text-body">
          <RichText text={m.text} bots={bots} />
          {m.attachments?.length ? <Attachments refs={m.attachments} /> : null}
          {work && <OpenChat roomId={work} />}
        </div>
      );
    }
  }
}

function OpenChat({ roomId }: { roomId: string }) {
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const exists = useStore((s) => s.rooms.some((r) => r.id === roomId));
  return exists ? <button type="button" className="touch-target rounded-xs text-hint text-muted underline hover:text-fg" onClick={() => setActiveRoom(roomId)}>Open its chat</button> : null;
}

function SystemLine({ m, bots }: { m: Message; bots: Bot[] }) {
  const isRoutine = m.kind === 'routine';
  const p = m.payload as RoutinePayload | null;
  return (
    // rounded-lg, not a pill: routine output and notes often run to several lines of markdown.
    <div className="mx-auto flex w-full max-w-[640px] items-start gap-2 rounded-lg bg-card2/70 px-4 py-1.5 text-hint text-muted">
      {isRoutine ? <Clock size={14} className="mt-0.5 shrink-0 text-accent" /> : <Info size={14} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">
        {isRoutine && p && <div className="font-medium text-fg">Schedule: {p.name}</div>}
        <div className="md whitespace-pre-wrap"><RichText text={m.text} bots={bots} /></div>
      </div>
      <span className="text-hint text-dim">{fmtTime(m.createdAt)}</span>
    </div>
  );
}

/**
 * P5: a trigger fired. The bot's instructions show as usual; the outside event (third-party text, fenced as
 * untrusted data by the hub) is folded away and shown as plain text, never as markdown.
 */
const EVENT_PREAMBLE = '\n\nThe block below is content from an external sender';
function TriggerLine({ m, bots }: { m: Message; bots: Bot[] }) {
  const p = m.payload as TriggerPayload | null;
  const cut = m.text.indexOf(EVENT_PREAMBLE);
  const head = (cut >= 0 ? m.text.slice(0, cut) : m.text).replace(/^\[Trigger "[^"]*"\]\s*/, '');
  const event = cut >= 0 ? m.text.slice(cut + 2) : '';
  return (
    <div className="mx-auto flex w-full max-w-[640px] items-start gap-2 rounded-lg bg-card2/70 px-4 py-1.5 text-hint text-muted">
      <Zap size={14} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">Trigger{p ? ': ' + p.name : ''}{p && !p.eventId ? ' (sample)' : ''}</div>
        <div className="md whitespace-pre-wrap"><RichText text={head} bots={bots} /></div>
        {event && (
          <details className="mt-1">
            <summary className="cursor-pointer select-none text-hint text-dim hover:text-fg">Event (untrusted)</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-card px-2 py-1.5 font-mono text-hint text-muted ring-1 ring-line">{event}</pre>
          </details>
        )}
      </div>
      <span className="text-hint text-dim">{fmtTime(m.createdAt)}</span>
    </div>
  );
}

// ---------- approval + handoff ----------

/** A hand-off or routing card reads as words: the whole task, or the exact line. Anything unexpected stays raw. */
function cardWords(p: ApprovalPayload): { main: string; more?: string } | null {
  const input = (p.toolInput ?? {}) as Record<string, unknown>;
  const [main, more] = p.toolName === 'handoff' ? [input.task, input.context] : [input.line, input.reason];
  if (typeof main !== 'string' || !main) return null;
  return { main, more: typeof more === 'string' && more ? more : undefined };
}

function ApprovalCard({ m }: { m: Message }) {
  const p = m.payload as ApprovalPayload;
  const decide = useStore((s) => s.decide);
  const bots = useStore((s) => s.bots);
  // P2: answering here may lead to a rule offer. Only here and now: a transcript reloaded later does not re-offer.
  const [answered, setAnswered] = useState(false);
  const pending = p.status === 'pending';
  const device = useStore((s) => s.device);
  // These two are yes or no, once. A "yes" to a hand-off covers the pair, as a rule the hub records and Settings lists.
  const handoff = p.toolName === 'handoff';
  const proposal = p.toolName === 'propose_routing_change';
  const yesOrNo = handoff || proposal;
  const words = yesOrNo ? cardWords(p) : null;
  const outcome = p.status === 'allow' ? (handoff ? 'Sent' : proposal ? 'Added' : 'Allowed once') : p.status === 'always' ? 'Allowed for this session' : p.status === 'deny' ? (handoff ? 'Kept here' : proposal ? 'Not added' : 'Denied') : p.status === 'timeout' ? 'Timed out, denied' : p.status === 'expired' ? 'Expired after restart. Ask the bot to retry.' : null;
  return (
    <div className={cn('max-w-[640px] overflow-hidden rounded-lg ring-1', p.danger ? 'ring-bad/40' : pending ? 'ring-warn/40' : 'ring-line')}>
      <div className="flex items-center gap-2 px-4 pt-3 text-ui">
        <ShieldAlert size={15} className={p.danger ? 'text-bad' : pending ? 'text-warn' : 'text-muted'} />
        <span className="font-medium">{handoff ? 'Pass this to another bot?' : proposal ? 'Add a routing rule?' : p.danger ? 'Risky action needs your OK' : 'Needs your OK'}</span>
        {!yesOrNo && <span className="font-mono text-hint text-muted">{p.toolName}</span>}
        {outcome && <span className="ml-auto text-hint text-muted">{outcome}</span>}
      </div>
      <div className="px-4 py-1.5 text-ui text-muted">{p.reason}</div>
      {pending && p.parked && <div className="px-4 pb-1.5 text-ui text-warn">Run paused until you answer.</div>}
      {words ? (
        <div className="mx-4 mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card2 p-2.5 text-ui">
          {words.main}
          {words.more && <div className="mt-1.5 text-muted">{words.more}</div>}
        </div>
      ) : (
        <pre className="mx-4 mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-card2 p-2.5 font-mono text-hint">{fmtInput(p.toolInput)}</pre>
      )}
      {pending && (
        // P9: wraps on a phone, and touch targets grow to 44px (`.touch-target` in index.css).
        <div className="flex flex-wrap gap-2 px-4 pb-4">
          <Button size="sm" variant="primary" className="touch-target" onClick={() => { setAnswered(true); decide(p.approvalId, 'allow'); }}>{handoff ? 'Send it' : proposal ? 'Add it' : 'Allow once'}</Button>
          {/* A paired device answers once; the hub refuses a standing grant from one (and approval rules). */}
          {!device && !yesOrNo && <Button size="sm" className="touch-target" onClick={() => { setAnswered(true); decide(p.approvalId, 'always'); }}>Allow for this session</Button>}
          <Button size="sm" variant={yesOrNo ? 'outline' : 'danger'} className="touch-target" onClick={() => decide(p.approvalId, 'deny')}>{handoff ? 'Keep it here' : proposal ? 'Leave it out' : 'Deny'}</Button>
          {device && !yesOrNo && <span className="basis-full text-hint text-muted">Session-wide allow is desktop only.</span>}
        </div>
      )}
      {answered && !device && !yesOrNo && (p.status === 'allow' || p.status === 'always') && <RuleOffer p={p} botId={m.authorId} botName={botById(bots, m.authorId)?.name ?? 'this bot'} />}
    </div>
  );
}

/** One line in the chat. The whole task and its context fold out of it. */
function HandoffCard({ m, bots }: { m: Message; bots: Bot[] }) {
  const p = m.payload as HandoffPayload;
  const to = botById(bots, p.toBotId);
  return (
    <div className="max-w-[640px] text-ui text-muted">
      <details>
        <summary className="flex min-w-0 cursor-pointer select-none items-center gap-2 rounded-xs [&::-webkit-details-marker]:hidden">
          <ArrowRightLeft size={14} aria-hidden className="shrink-0 text-accent" />
          <span className="min-w-0 truncate"><span className="font-medium text-fg">Passed to {to ? to.name : p.toBotId}:</span> {p.task.split('\n')[0]}</span>
        </summary>
        <div className="md mt-1.5 pl-[22px]"><RichText text={p.task} bots={bots} /></div>
        {p.context && <div className="mt-2 whitespace-pre-wrap pl-[22px]">{p.context}</div>}
      </details>
      {p.workRoomId && <div className="pl-[22px]"><OpenChat roomId={p.workRoomId} /></div>}
    </div>
  );
}

/** Chat markdown: @handles of known bots come out bold, links go through the shared safe renderer. */
function RichText({ text, bots }: { text: string; bots: Bot[] }) {
  const handles = useMemo(() => new Set(bots.map((b) => b.handle.toLowerCase())), [bots]);
  const t = useMemo(() => text.replace(/(^|[^\w@])@([a-z0-9_-]{2,24})\b/gi, (all, pre, h) => (handles.has(h.toLowerCase()) ? pre + '**@' + h + '**' : all)), [text, handles]);
  return <Markdown>{t}</Markdown>;
}

// ---------- image attachments ----------

/** Thumbnails for a message's attached pictures, each opening full-size on click. */
function Attachments({ refs }: { refs: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="mt-1 flex flex-wrap gap-2">
        {refs.map((ref) => <AttachmentImage key={ref} mediaRef={ref} onOpen={() => setOpen(ref)} />)}
      </div>
      {open && <ImageLightbox mediaRef={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function AttachmentImage({ mediaRef, onOpen }: { mediaRef: string; onOpen: () => void }) {
  const url = useMediaUrl(mediaRef);
  if (!url) return <div className="h-32 w-32 animate-pulse rounded-md bg-card2" aria-hidden />;
  return (
    <button type="button" onClick={onOpen} className="block overflow-hidden rounded-md ring-1 ring-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <img src={url} alt="Attached picture" className="max-h-64 max-w-full object-contain" />
    </button>
  );
}

function ImageLightbox({ mediaRef, onClose }: { mediaRef: string; onClose: () => void }) {
  const url = useMediaUrl(mediaRef);
  return (
    <DialogShell open onOpenChange={(o) => !o && onClose()} className="max-h-[92vh] max-w-[92vw] overflow-hidden bg-transparent p-0 shadow-none">
      <DialogTitle className="sr-only">Attached picture</DialogTitle>
      {url && <img src={url} alt="Attached picture" className="block max-h-[92vh] max-w-[92vw] rounded-lg object-contain" />}
      <div className="absolute right-2 top-2"><DialogCloseButton /></div>
    </DialogShell>
  );
}

// ---------- composer: the floating pill ----------

function Composer({ members }: { members: Bot[] }) {
  const sendMessage = useStore((s) => s.sendMessage);
  const interrupt = useStore((s) => s.interrupt);
  const streaming = useStore((s) => s.streaming);
  const roomId = useStore((s) => s.activeRoomId);
  const room = useStore(selectActiveRoom);
  const control = useStore((s) => s.control);
  // Hidden on a paired phone, and on a provider whose models the picker's options do not name.
  const showPicker = useStore((s) => !s.device && s.settings.provider === 'claude');
  // A paired phone may not change settings, and the hub would refuse it.
  const showPermissions = useStore((s) => !s.device);
  const [text, setText] = useState('');
  const [mentionIdx, setMentionIdx] = useState(0);
  // Escape hides the popup for the @word being typed; typing on reopens it.
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grows with the text like a chat app's composer usually does, instead of stopping at a fixed line
  // count: tall on a tall screen, never past a third of the viewport, scrollable past that.
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    const cap = Math.round(window.innerHeight / 3);
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, cap) + 'px';
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
  };
  useLayoutEffect(resize, [text]);
  // The cap is a third of the window, so rotating a tablet or resizing the window should move it too.
  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const activeTurns = Object.entries(streaming).filter(([, v]) => v.roomId === roomId);
  const mentionQuery = useMemo(() => {
    const m = text.slice(0, ref.current?.selectionStart ?? text.length).match(/(?:^|\s)@([a-z0-9_-]*)$/i);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  const suggestions = mentionQuery !== null && !mentionDismissed ? members.filter((b) => b.handle.toLowerCase().startsWith(mentionQuery)).slice(0, 6) : [];

  const insertMention = (b: Bot) => {
    const pos = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, pos).replace(/@[a-z0-9_-]*$/i, '@' + b.handle + ' ');
    setText(before + text.slice(pos));
    setTimeout(() => ref.current?.focus(), 0);
  };
  const submit = () => {
    if (!text.trim()) return;
    sendMessage(text.trim());
    setText('');
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While an IME is composing (Japanese, Chinese, Korean…), Enter confirms the candidate; it must not send.
    // Safari reports the confirming keydown after composition ends, recognisable only by keyCode 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (suggestions.length) {
      if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); insertMention(suggestions[mentionIdx] ?? suggestions[0]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  useEffect(() => { setMentionIdx(0); setMentionDismissed(false); }, [mentionQuery]);

  // A bot asking for a login makes replying here the natural move, and the chat goes to the model and the transcript.
  const secretsHint = members.some((m) => control[m.id]?.takeover) ? 'Type secrets on its screen, not here' : null;
  // Messages wait in the bot's queue for the turn to end, so say that rather than let typing look ignored.
  const hint = secretsHint ?? (room?.kind === 'group'
    ? (room.coordinatorBotId ? 'Ask here, or @mention a bot' : '@mention a bot')
    : activeTurns.length ? (members[0]?.name ?? 'The bot') + ' reads this when it finishes'
    : 'Message ' + (members[0]?.name ?? ''));

  return (
    <div className="relative shrink-0 px-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
      <div className="relative mx-auto max-w-[var(--page-max)]">
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 w-[320px] max-w-full rounded-xl bg-panel p-1.5 shadow-[var(--shadow)]">
            {suggestions.map((b, i) => (
              <div key={b.id} className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-ui', i === mentionIdx && 'bg-active')} onMouseDown={(e) => { e.preventDefault(); insertMention(b); }}>
                <span aria-hidden><Avatar bot={b} size={20} /></span><span className="font-medium">@{b.handle}</span><span className="truncate text-hint text-muted">{b.title || b.name}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1 rounded-composer bg-panel p-2 pl-4 sm:pl-5 shadow-[var(--shadow)] ring-1 ring-line/60 focus-within:ring-accent">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={hint}
            aria-label={room?.kind === 'group' ? 'Message #' + room.name : 'Message ' + (members[0]?.name ?? '')}
            aria-description={secretsHint ?? undefined}
            // Height is set in JS, up to a third of the viewport (see the effect above); resize-none because
            // the drag handle a free-form textarea gets would fight that. A long placeholder wraps in a
            // narrow composer, and must not lose its second line. It can be a safety note.
            className={cn('w-full resize-none bg-transparent pt-1.5 pb-1 text-body placeholder:text-dim focus-visible:outline-none', !text && hint.length > 24 && '@max-[480px]:min-h-[64px]')}
          />
          <div className="flex items-center justify-end gap-1.5">
            {showPermissions && <PermissionPicker textarea={ref} />}
            {showPicker && room && <ModelPicker room={room} members={members} busy={activeTurns.length > 0} textarea={ref} />}
            {activeTurns.length > 0 && (
              <Button variant="ghost" size="icon" title="Stop running bots" onClick={() => activeTurns.forEach(([t]) => interrupt(t))}><Square size={15} className="text-bad" /></Button>
            )}
            <Button variant="primary" size="icon" className="h-9 w-9" title="Send (Enter)" onClick={submit} disabled={!text.trim()}><Send size={15} /></Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- the permission picker, by the model picker ----------
const PERMISSIONS: { id: Approvals; label: string; note: string }[] = [
  { id: 'read-only', label: 'Read only', note: 'Bots look around. Every write is refused.' },
  { id: 'ask', label: 'Approval', note: 'Risky actions show a card first.' },
  { id: 'bypass', label: 'Full permission', note: 'No cards. Bots run everything.' },
];

/**
 * How much all bots may do. Unlike the model beside it, this is one hub-wide setting, not a per-chat one, so the
 * menu says so. Same second step as Settings before approvals go off. A level the server pins comes back as an
 * error from updateSettings, which rolls back and says why.
 */
function PermissionPicker({ textarea }: { textarea: React.RefObject<HTMLTextAreaElement | null> }) {
  const current = useStore((s) => s.settings.approvals);
  const updateSettings = useStore((s) => s.updateSettings);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = async (next: Approvals) => {
    setSaving(true);
    await updateSettings({ approvals: next });
    setSaving(false);
    setConfirming(false);
  };
  const choose = (next: string) => {
    if (next === current) return;
    if (next === 'bypass') return setConfirming(true);
    void save(next as Approvals);
  };
  const label = PERMISSIONS.find((p) => p.id === current)?.label ?? current;
  const row = 'flex cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-ui outline-none data-[highlighted]:bg-hover';
  return (
    <>
      {confirming && (
        <span role="alert" className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-hint text-warn">
          <ShieldAlert size={14} aria-hidden className="shrink-0" />
          <span>Hidden web instructions could run commands here.</span>
          <Button variant="ghost" autoFocus disabled={saving} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="danger" disabled={saving} onClick={() => void save('bypass')}>{saving ? 'Saving…' : 'Allow all'}</Button>
        </span>
      )}
      <Menu.Root>
        <Menu.Trigger
          aria-label={'Permission level for all bots: ' + label}
          className={cn(
            'touch-target flex h-8 min-w-0 items-center gap-1 rounded-md pl-2.5 pr-2 text-ui hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            current === 'bypass' ? 'text-warn' : 'text-muted hover:text-fg',
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown size={14} aria-hidden className="shrink-0" />
        </Menu.Trigger>
        <Menu.Portal>
          <MenuContent
            side="top"
            align="end"
            className="w-[min(280px,calc(100vw-1.5rem))]"
            onCloseAutoFocus={(e) => { if (!confirming && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); textarea.current?.focus(); } }}
          >
            <p className="px-2.5 py-1 text-hint text-muted">Applies to all bots and chats</p>
            <Menu.RadioGroup value={current} onValueChange={choose}>
              {PERMISSIONS.map((p) => (
                <Menu.RadioItem key={p.id} value={p.id} className={row}>
                  <span className="min-w-0 flex-1">
                    <span className="block">{p.label}</span>
                    <span className="block text-hint text-muted">{p.note}</span>
                  </span>
                  <Menu.ItemIndicator className="shrink-0 text-accent"><Check size={16} aria-hidden /></Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </MenuContent>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}

// ---------- the model picker, by Send ----------
/**
 * This chat's model. It is stored on the chat, never on the bot, so schedules and hand-offs keep each bot's own model.
 * A pick stays until changed. Choosing what the bot already uses clears the pick rather than storing a copy of it.
 */
function ModelPicker({ room, members, busy, textarea }: { room: Room; members: Bot[]; busy: boolean; textarea: React.RefObject<HTMLTextAreaElement | null> }) {
  const providers = useStore((s) => s.providers);
  const toast = useStore((s) => s.toast);
  // Beside the picker, not a toast: a toast sits on top of Send, the next thing the user reaches for.
  const [applies, setApplies] = useState(false);
  useEffect(() => {
    if (!applies) return;
    const t = setTimeout(() => setApplies(false), 4000);
    return () => clearTimeout(t);
  }, [applies]);
  const nameOf = (id: string) => CHAT_MODELS.find((m) => m.id === id)?.label
    ?? (providers?.providers.flatMap((p) => p.models).find((m) => m.id === id)?.label ?? MODELS.find((m) => m.id === id)?.label ?? id).replace(/\s*\(.*\)\s*$/, '');
  const own = [...new Set(members.map((m) => m.model))];
  const ownId = own.length === 1 ? own[0] : null;
  const ownListed = !!ownId && CHAT_MODELS.some((m) => m.id === ownId);
  const defaultName = ownId ? nameOf(ownId) : 'Bot models';
  const current = room.chatModel ? nameOf(room.chatModel) : defaultName;
  const value = room.chatModel ?? (ownListed ? ownId : '');

  const choose = async (next: string) => {
    try {
      const saved = await api.rooms.setModel(room.id, !next || next === ownId ? null : next);
      useStore.setState((s) => ({ rooms: s.rooms.map((r) => (r.id === saved.id ? saved : r)) }));
      if (busy) setApplies(true);
    } catch (e) {
      toast("Couldn't change the model: " + (e as Error).message, true);
    }
  };
  const row = 'flex cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-ui outline-none data-[highlighted]:bg-hover';
  const item = (id: string, label: string, note: string) => (
    <Menu.RadioItem key={id || 'own'} value={id} className={row}>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        <span className="block text-hint text-muted">{note}</span>
      </span>
      <Menu.ItemIndicator className="shrink-0 text-accent"><Check size={16} aria-hidden /></Menu.ItemIndicator>
    </Menu.RadioItem>
  );
  return (
    <>
    <span role="status" className="min-w-0 truncate text-hint text-muted">{applies && 'From the next reply'}</span>
    <Menu.Root>
      <Menu.Trigger
        aria-label={'Model for this chat: ' + current}
        className="touch-target flex h-8 min-w-0 max-w-[11rem] items-center gap-1 rounded-md pl-2.5 pr-2 text-ui text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-hover data-[state=open]:text-fg"
      >
        <span className="truncate">{current}</span>
        <ChevronDown size={14} aria-hidden className="shrink-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <MenuContent
          side="top"
          align="end"
          className="w-[min(280px,calc(100vw-1.5rem))]"
          // Back to typing, except on touch, where focusing the box would bring the keyboard back up.
          onCloseAutoFocus={(e) => { if (window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); textarea.current?.focus(); } }}
        >
          <Menu.RadioGroup value={value ?? ''} onValueChange={(v) => void choose(v)}>
            {CHAT_MODELS.map((m) => item(m.id, m.label, m.note))}
            {/* Only when the bots' own setting is not one of the four, so there is still a way back to it. */}
            {!ownListed && item('', defaultName, ownId ? "This bot's setting" : "Each bot's setting")}
          </Menu.RadioGroup>
        </MenuContent>
      </Menu.Portal>
    </Menu.Root>
    </>
  );
}

// ---------- P8: model chip ----------
/**
 * One chip per bot turn: on the last text message of a turn (or of the part of it that ran on one model, when
 * the router escalated a retry), so a long multi-message reply is not stamped on every paragraph.
 */
function chipAfter(items: Message[], m: Message): boolean {
  if (m.kind !== 'text' || !m.model) return false;
  const rest = items.slice(items.indexOf(m) + 1);
  return !rest.some((x) => x.kind === 'text' && x.turnId === m.turnId && x.model === m.model);
}

/** Which model wrote this, and why. Muted and mono like the other metadata; static, no motion. */
function ModelChip({ m }: { m: Message }) {
  const providers = useStore((s) => s.providers);
  const id = m.model ?? '';
  const known = providers?.providers.flatMap((p) => p.models).find((x) => x.id === id)?.label ?? MODELS.find((x) => x.id === id)?.label;
  // "Sonnet 5 (default)" reads as a claim about this turn; the chip only names the model.
  const label = (known ?? id).replace(/\s*\(.*\)\s*$/, '');
  const auto = m.modelReason?.startsWith('Auto:');
  const reason = m.modelReason ?? '';
  return (
    <span
      title={reason || undefined}
      className="inline-flex w-fit max-w-full items-center gap-1 truncate rounded-xs bg-card2 px-2 py-0.5 font-mono text-hint text-muted"
    >
      {auto && <span aria-hidden>auto ·</span>}
      {label}
      {reason && <span className="sr-only">. Model choice: {reason}</span>}
    </span>
  );
}
