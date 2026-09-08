import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  PanelRightOpen, Send, Square, Users, Settings2, Check, ShieldAlert, ArrowRightLeft, Clock, Info, Monitor,
  FileText, Pencil, Terminal, Globe, Search, Zap, MousePointer2, ChevronDown,
} from 'lucide-react';
import type { ApprovalPayload, Bot, HandoffPayload, Message, RoutinePayload, ToolPayload } from '@pocketrocket/shared';
import { useStore, selectActiveRoom, botById } from '../store';
import { Avatar, Badge, Button, cn, fmtTime, fmtUsd } from './ui';

export function ChatPane() {
  const room = useStore(selectActiveRoom);
  const bots = useStore((s) => s.bots);
  const botStates = useStore((s) => s.botStates);
  const panelOpen = useStore((s) => s.panelOpen);
  const openPanel = useStore((s) => s.openPanel);
  const openDialog = useStore((s) => s.openDialog);
  const usage = useStore((s) => s.usage);

  if (!room) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ink text-2xl text-ink-fg">⚡</div>
        <div>
          <div className="text-[17px] font-semibold tracking-tight">Your team is empty</div>
          <div className="mt-1 max-w-[38ch] text-[13.5px] text-muted">Create a bot with a focused role, message it directly, or put a few in a group chat and let them hand work to each other.</div>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => openDialog({ kind: 'bot', bot: null })}>Create a bot</Button>
          <Button onClick={() => openDialog({ kind: 'room', room: null })}>New group chat</Button>
        </div>
      </div>
    );
  }

  const members = room.memberIds.map((id) => botById(bots, id)).filter((b): b is Bot => !!b);
  const roomCost = members.reduce((acc, b) => acc + (usage[b.id + ':' + room.id]?.costUsd ?? 0), 0);
  const working = members.filter((m) => ['thinking', 'working', 'blocked', 'waiting'].includes(botStates[m.id] ?? 'idle'));

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 px-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold tracking-tight">{room.kind === 'group' ? '# ' : ''}{room.name}</span>
            {room.coordinatorBotId && <Badge tone="accent">coordinator @{botById(bots, room.coordinatorBotId)?.handle}</Badge>}
          </div>
          <div className="truncate text-[12px] text-muted">
            {room.kind === 'dm' ? members[0]?.title || '@' + members[0]?.handle : members.map((m) => '@' + m.handle).join('  ')}
            {working.length > 0 && <span className="ml-2 text-ok">{working.length} working</span>}
            {roomCost > 0 && <span className="ml-2 text-dim">≈{fmtUsd(roomCost)} of plan usage</span>}
          </div>
        </div>
        <div className="flex -space-x-2">
          {members.slice(0, 6).map((m) => <span key={m.id} className="rounded-full ring-2 ring-panel"><Avatar bot={m} state={botStates[m.id]} size={26} /></span>)}
        </div>
        {room.kind === 'group' && (
          <Button variant="ghost" size="icon" title="Edit room" onClick={() => openDialog({ kind: 'room', room })}><Users size={16} /></Button>
        )}
        {room.kind === 'dm' && members[0] && (
          <Button variant="ghost" size="icon" title="Bot settings" onClick={() => openDialog({ kind: 'bot', bot: members[0] })}><Settings2 size={16} /></Button>
        )}
        <Button variant="ghost" size="icon" title="Computer screen" onClick={() => openPanel('screen')}><Monitor size={16} /></Button>
        {!panelOpen && (
          <Button variant="ghost" size="icon" title="Open side panel" onClick={() => openPanel('memory')}><PanelRightOpen size={16} /></Button>
        )}
      </header>
      <Transcript roomId={room.id} />
      <Composer members={members} />
    </>
  );
}

function Transcript({ roomId }: { roomId: string }) {
  const messages = useStore((s) => s.messages[roomId]);
  const streaming = useStore((s) => s.streaming);
  const bots = useStore((s) => s.bots);
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  const streams = useMemo(() => Object.entries(streaming).filter(([, v]) => v.roomId === roomId && v.text), [streaming, roomId]);

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages, streams, stick]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const groups = useMemo(() => groupMessages(messages ?? []), [messages]);

  return (
    <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mx-auto flex max-w-[760px] flex-col gap-5">
        {!messages?.length && <div className="py-12 text-center text-[13px] text-muted">Nothing here yet. Say what you need.</div>}
        {groups.map((g) => (
          <MessageGroup key={g.key} group={g} bots={bots} />
        ))}
        {streams.map(([turnId, s]) => {
          const bot = botById(bots, s.botId);
          return bot ? (
            <div key={turnId} className="flex gap-3 pr-10">
              <Avatar bot={bot} size={30} state="thinking" />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-baseline gap-2"><span className="text-[13.5px] font-semibold">{bot.name}</span><span className="text-[11px] text-dim">typing</span></div>
                <div className="md text-[14px] leading-relaxed text-fg/80"><Markdown text={s.text} bots={bots} /><span className="caret" /></div>
              </div>
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}

interface Group { key: string; authorType: Message['authorType']; authorId: string | null; items: Message[] }
function groupMessages(msgs: Message[]): Group[] {
  const out: Group[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    const solo = m.kind === 'system' || m.kind === 'routine';
    const lastSolo = last && (last.items[0].kind === 'system' || last.items[0].kind === 'routine');
    if (!solo && last && !lastSolo && last.authorType === m.authorType && last.authorId === m.authorId && m.createdAt - last.items[last.items.length - 1].createdAt < 5 * 60_000) {
      last.items.push(m);
    } else out.push({ key: m.id, authorType: m.authorType, authorId: m.authorId, items: [m] });
  }
  return out;
}

/** Within a group, consecutive tool messages fold into one trace strip. */
type Segment = { kind: 'trace'; items: Message[] } | { kind: 'one'; item: Message };
function segments(items: Message[]): Segment[] {
  const out: Segment[] = [];
  for (const m of items) {
    const last = out[out.length - 1];
    if (m.kind === 'tool') {
      if (last && last.kind === 'trace') last.items.push(m);
      else out.push({ kind: 'trace', items: [m] });
    } else out.push({ kind: 'one', item: m });
  }
  return out;
}

function MessageGroup({ group, bots }: { group: Group; bots: Bot[] }) {
  const first = group.items[0];
  if (first.kind === 'system' || first.kind === 'routine') return <SystemLine m={first} bots={bots} />;
  const bot = group.authorType === 'bot' || group.authorType === 'system' ? botById(bots, group.authorId) : undefined;
  if (group.authorType === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5 pl-16">
        {group.items.map((m) => (
          <div key={m.id} className="md max-w-[85%] rounded-[20px] rounded-br-md bg-user px-4 py-2.5 text-[14px] leading-relaxed"><Markdown text={m.text} bots={bots} /></div>
        ))}
        <span className="pr-1 text-[11px] text-dim">{fmtTime(first.createdAt)}</span>
      </div>
    );
  }
  return (
    <div className="flex gap-3 pr-10">
      {bot ? <Avatar bot={bot} size={30} /> : <div className="h-[30px] w-[30px] rounded-full bg-card2" />}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[13.5px] font-semibold">{bot?.name ?? 'Bot'}</span>
          <span className="text-[11px] text-dim">{fmtTime(first.createdAt)}</span>
        </div>
        <div className="flex flex-col gap-2">
          {segments(group.items).map((seg) =>
            seg.kind === 'trace' ? <Trace key={seg.items[0].id} items={seg.items} /> : <Item key={seg.item.id} m={seg.item} bots={bots} />,
          )}
        </div>
      </div>
    </div>
  );
}

function Item({ m, bots }: { m: Message; bots: Bot[] }) {
  switch (m.kind) {
    case 'approval': return <ApprovalCard m={m} />;
    case 'handoff': return <HandoffCard m={m} bots={bots} />;
    default:
      return <div className="md text-[14px] leading-relaxed"><Markdown text={m.text} bots={bots} /></div>;
  }
}

function SystemLine({ m, bots }: { m: Message; bots: Bot[] }) {
  const isRoutine = m.kind === 'routine';
  const p = m.payload as RoutinePayload | null;
  return (
    <div className="mx-auto flex w-full max-w-[640px] items-start gap-2 rounded-full bg-card2/70 px-4 py-1.5 text-[12px] text-muted">
      {isRoutine ? <Clock size={14} className="mt-0.5 shrink-0 text-accent" /> : <Info size={14} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">
        {isRoutine && p && <span className="mr-2 font-medium text-fg">Routine: {p.name}</span>}
        <span className="whitespace-pre-wrap"><Markdown text={m.text} bots={bots} /></span>
      </div>
      <span className="text-[11px] text-dim">{fmtTime(m.createdAt)}</span>
    </div>
  );
}

// ---------- trace strip: compact tool chips, expand one at a time ----------

function toolMeta(p: ToolPayload): { icon: React.ReactNode; label: string; target: string } {
  const i = (p.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const base = (v: string) => v.split(/[\\/]/).pop() ?? v;
  const n = p.name;
  if (n.startsWith('mcp__pocketrocket__desktop_')) return { icon: <MousePointer2 size={12} />, label: n.replace('mcp__pocketrocket__desktop_', 'desktop '), target: s('command') || s('keys') || s('text') || (i.x !== undefined ? i.x + ',' + i.y : '') };
  if (n.startsWith('mcp__pocketrocket__')) return { icon: <Zap size={12} />, label: n.replace('mcp__pocketrocket__', ''), target: s('to_bot') ? '@' + s('to_bot').replace(/^@/, '') : s('handle') || s('name') || s('text').slice(0, 40) };
  if (n.startsWith('mcp__browser__')) return { icon: <Globe size={12} />, label: n.replace('mcp__browser__browser_', 'web '), target: s('url') ? s('url').replace(/^https?:\/\//, '').slice(0, 40) : s('text') || s('element')?.slice(0, 30) || '' };
  switch (n) {
    case 'Read': return { icon: <FileText size={12} />, label: 'Read', target: base(s('file_path')) };
    case 'Write': return { icon: <Pencil size={12} />, label: 'Write', target: base(s('file_path')) };
    case 'Edit': case 'MultiEdit': return { icon: <Pencil size={12} />, label: 'Edit', target: base(s('file_path')) };
    case 'Bash': return { icon: <Terminal size={12} />, label: 'Run', target: s('command').slice(0, 44) };
    case 'Glob': case 'Grep': return { icon: <Search size={12} />, label: n === 'Glob' ? 'Find' : 'Search', target: s('pattern').slice(0, 40) };
    case 'WebSearch': return { icon: <Globe size={12} />, label: 'Search web', target: s('query').slice(0, 40) };
    case 'WebFetch': return { icon: <Globe size={12} />, label: 'Fetch', target: s('url').replace(/^https?:\/\//, '').slice(0, 40) };
    case 'ToolSearch': return { icon: <Search size={12} />, label: 'Load tools', target: '' };
    default: return { icon: <Zap size={12} />, label: n, target: '' };
  }
}

function Trace({ items }: { items: Message[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((m) => m.id === openId);
  const running = items.filter((m) => !(m.payload as ToolPayload).done).length;
  const errors = items.filter((m) => (m.payload as ToolPayload).isError).length;
  return (
    <div className="max-w-[680px]">
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((m) => {
          const p = m.payload as ToolPayload;
          const meta = toolMeta(p);
          const isOpen = m.id === openId;
          return (
            <button
              key={m.id}
              onClick={() => setOpenId(isOpen ? null : m.id)}
              className={cn(
                'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-2.5 font-mono text-[12px]',
                p.isError ? 'bg-bad/10 text-bad' : 'bg-card2 text-fg',
                !p.done && 'chip-running',
                isOpen && 'ring-2 ring-accent/40',
              )}
              title={p.name}
            >
              <span className={cn('shrink-0', p.isError ? 'text-bad' : 'text-muted')}>{meta.icon}</span>
              <span className="shrink-0">{meta.label}</span>
              {meta.target && <span className="truncate text-muted">{meta.target}</span>}
              {p.done && !p.isError && <Check size={12} className="shrink-0 text-ok" />}
            </button>
          );
        })}
        <span className="ml-1 text-[11.5px] text-dim">
          {running ? running + ' running' : items.length + (items.length === 1 ? ' step' : ' steps')}{errors ? ', ' + errors + ' failed' : ''}
        </span>
      </div>
      {open && <TraceDetail m={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function TraceDetail({ m, onClose }: { m: Message; onClose: () => void }) {
  const p = m.payload as ToolPayload;
  return (
    <div className="mt-2 overflow-hidden rounded-2xl bg-card2/60 text-[12px]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono font-medium">{p.name.replace('mcp__pocketrocket__', '').replace('mcp__browser__', 'browser: ')}</span>
        {p.isError ? <Badge tone="bad">failed</Badge> : p.done ? <Badge tone="ok">done</Badge> : <Badge tone="accent">running</Badge>}
        <button className="ml-auto text-muted hover:text-fg" onClick={onClose} aria-label="Collapse"><ChevronDown size={14} /></button>
      </div>
      <div className="grid gap-0 md:grid-cols-2">
        <div className="min-w-0 p-3 pt-0">
          <div className="mb-1 text-[11.5px] text-muted">Input</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed">{fmtInput(p.input)}</pre>
        </div>
        <div className="min-w-0 p-3 pt-0">
          <div className="mb-1 text-[11.5px] text-muted">Output</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-muted">{p.output === undefined ? (p.done ? '(empty)' : 'Waiting…') : p.output || '(empty)'}</pre>
        </div>
      </div>
    </div>
  );
}

function fmtInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.command === 'string' && Object.keys(i).length <= 2) return i.command;
  return JSON.stringify(i, null, 2);
}

// ---------- approval + handoff ----------

function ApprovalCard({ m }: { m: Message }) {
  const p = m.payload as ApprovalPayload;
  const decide = useStore((s) => s.decide);
  const pending = p.status === 'pending';
  const outcome = p.status === 'allow' ? 'Allowed once' : p.status === 'always' ? 'Allowed for this session' : p.status === 'deny' ? 'Denied' : p.status === 'timeout' ? 'Timed out, denied' : null;
  return (
    <div className={cn('max-w-[640px] overflow-hidden rounded-2xl bg-panel shadow-[var(--shadow-lg)] ring-1', p.danger ? 'ring-bad/40' : pending ? 'ring-warn/40' : 'ring-line')}>
      <div className="flex items-center gap-2 px-4 pt-3 text-[13px]">
        <ShieldAlert size={15} className={p.danger ? 'text-bad' : pending ? 'text-warn' : 'text-muted'} />
        <span className="font-medium">{p.danger ? 'Risky action needs your OK' : 'Needs your OK'}</span>
        <span className="font-mono text-[12px] text-muted">{p.toolName}</span>
        {outcome && <span className="ml-auto text-[12px] text-muted">{outcome}</span>}
      </div>
      <div className="px-4 py-1.5 text-[12.5px] text-muted">{p.reason}</div>
      <pre className="mx-4 mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-card2 p-2.5 font-mono text-[11.5px]">{fmtInput(p.toolInput)}</pre>
      {pending && (
        <div className="flex gap-2 px-4 pb-4">
          <Button size="sm" variant="primary" onClick={() => decide(p.approvalId, 'allow')}>Allow once</Button>
          <Button size="sm" onClick={() => decide(p.approvalId, 'always')}>Allow for this session</Button>
          <Button size="sm" variant="danger" onClick={() => decide(p.approvalId, 'deny')}>Deny</Button>
        </div>
      )}
    </div>
  );
}

function HandoffCard({ m, bots }: { m: Message; bots: Bot[] }) {
  const p = m.payload as HandoffPayload;
  const to = botById(bots, p.toBotId);
  return (
    <div className="max-w-[640px] rounded-2xl bg-accent/8 p-3.5 text-[13px]">
      <div className="mb-1 flex items-center gap-2 font-medium"><ArrowRightLeft size={14} className="text-accent" /> Handed to {to ? to.avatar + ' ' + to.name : p.toBotId}</div>
      <div className="md"><Markdown text={p.task} bots={bots} /></div>
      {p.context && <div className="mt-2 whitespace-pre-wrap pt-2 text-[12.5px] text-muted">{p.context}</div>}
    </div>
  );
}

function Markdown({ text, bots }: { text: string; bots: Bot[] }) {
  const handles = useMemo(() => new Set(bots.map((b) => b.handle.toLowerCase())), [bots]);
  const t = useMemo(() => text.replace(/(^|[^\w@])@([a-z0-9_-]{2,24})\b/gi, (all, pre, h) => (handles.has(h.toLowerCase()) ? pre + '**@' + h + '**' : all)), [text, handles]);
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{t}</ReactMarkdown>;
}

// ---------- composer: the floating pill ----------

function Composer({ members }: { members: Bot[] }) {
  const sendMessage = useStore((s) => s.sendMessage);
  const interrupt = useStore((s) => s.interrupt);
  const streaming = useStore((s) => s.streaming);
  const roomId = useStore((s) => s.activeRoomId);
  const room = useStore(selectActiveRoom);
  const [text, setText] = useState('');
  const [mentionIdx, setMentionIdx] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const activeTurns = Object.entries(streaming).filter(([, v]) => v.roomId === roomId);
  const mentionQuery = useMemo(() => {
    const m = text.slice(0, ref.current?.selectionStart ?? text.length).match(/(?:^|\s)@([a-z0-9_-]*)$/i);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  const suggestions = mentionQuery !== null ? members.filter((b) => b.handle.toLowerCase().startsWith(mentionQuery)).slice(0, 6) : [];

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
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); insertMention(suggestions[mentionIdx] ?? suggestions[0]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  useEffect(() => setMentionIdx(0), [mentionQuery]);

  const hint = room?.kind === 'group'
    ? '@mention a bot' + (room.coordinatorBotId ? ', or just ask the room' : '')
    : 'Message ' + (members[0]?.name ?? '');

  return (
    <div className="relative shrink-0 px-6 pb-5 pt-2">
      <div className="relative mx-auto max-w-[760px]">
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 w-[320px] rounded-2xl bg-panel p-1.5 shadow-[var(--shadow-lg)]">
            {suggestions.map((b, i) => (
              <div key={b.id} className={cn('flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-[13px]', i === mentionIdx && 'bg-card2')} onMouseDown={(e) => { e.preventDefault(); insertMention(b); }}>
                <span>{b.avatar}</span><span className="font-medium">@{b.handle}</span><span className="truncate text-[12px] text-muted">{b.title || b.name}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-[26px] bg-panel p-2 pl-5 shadow-[var(--shadow-lg)] ring-1 ring-line/60 focus-within:ring-accent/50">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            placeholder={hint}
            className="max-h-48 flex-1 resize-none bg-transparent py-2 text-[14.5px] placeholder:text-dim"
          />
          {activeTurns.length > 0 && (
            <Button variant="ghost" size="icon" title="Stop running bots" onClick={() => activeTurns.forEach(([t]) => interrupt(t))}><Square size={15} className="text-bad" /></Button>
          )}
          <Button variant="primary" size="icon" className="h-9 w-9" title="Send (Enter)" onClick={submit} disabled={!text.trim()}><Send size={15} /></Button>
        </div>
      </div>
    </div>
  );
}
