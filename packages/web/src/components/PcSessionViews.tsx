// The read-only pieces of the PC sessions view: the grouped list rows, the empty state and the transcript.
// No store or network in here, so they render on their own (and in tests).
import { useState } from 'react';
import { ChevronRight, Monitor } from 'lucide-react';
import { relativeTime, sessionTitle, toolRowLabel, type PcSeqEntry, type PcSessionSummary, type SessionGroup } from '../lib/pcSessions';
import { linksOf } from '../lib/projectRepos';
import { moveBadge } from '../lib/pcMove';
import { Badge, Banner, EmptyState, cn } from './ui';
import { getJson, setJson } from '../lib/persist';
import { MoveBadge } from './PcMovePanel';
import { Markdown } from './Markdown';

/** How to turn the mirror on. Shown when there is nothing to list. */
export function MirrorEmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) return <EmptyState icon={<Monitor size={18} />} title="No sessions match">Try a different search or repo.</EmptyState>;
  return (
    <EmptyState icon={<Monitor size={18} />} title="No Claude Code sessions yet">
      Sessions appear here once the PC helper is ON and mirroring is enabled (it is by default). Turn the helper on in Settings, then
      use Claude Code on your PC as usual. See "Mirror your Claude Code sessions" in the README.
    </EmptyState>
  );
}

/** The grouped list itself, split out so it renders without the network. */
const COLLAPSED_KEY = 'pc-sessions.collapsed-groups';
const isKeys = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Repo groups fold open and closed; which ones are folded is remembered in this browser. */
export function SessionGroups({ groups, onOpen, now }: { groups: SessionGroup[]; onOpen: (id: string) => void; now?: number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(getJson(COLLAPSED_KEY, isKeys, [])));
  const save = (next: Set<string>) => { setCollapsed(next); setJson(COLLAPSED_KEY, [...next]); };
  const toggle = (key: string) => { const next = new Set(collapsed); if (next.has(key)) next.delete(key); else next.add(key); save(next); };
  const allFolded = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  return (
    <div className="space-y-3">
      {groups.length > 1 && (
        <div className="flex justify-end px-3">
          <button
            type="button"
            onClick={() => save(allFolded ? new Set() : new Set(groups.map((g) => g.key)))}
            className="rounded-md px-2 py-0.5 text-hint text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {allFolded ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      )}
      {groups.map((g) => {
        const open = !collapsed.has(g.key);
        const id = 'grp-' + g.key;
        return (
          <section key={g.key} aria-label={g.label}>
            <h2 className="px-1">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => toggle(g.key)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-label text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ChevronRight size={14} aria-hidden className={cn('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                <span className="shrink-0 text-hint text-muted">{g.nodes.length}</span>
              </button>
            </h2>
            <ul id={id} hidden={!open} className="mt-1">
              {g.nodes.map((n) => (
                <li key={n.session.id}>
                  <SessionRow s={n.session} onOpen={onOpen} now={now} />
                  {n.children.length > 0 && <Subagents parent={n.session} kids={n.children} onOpen={onOpen} now={now} />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function SessionRow({ s, onOpen, now, nested }: { s: PcSessionSummary; onOpen: (id: string) => void; now?: number; nested?: boolean }) {
  const live = s.status === 'live';
  const where = [s.repo?.name, s.repo?.branch].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={() => onOpen(s.id)}
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {/* Running: a solid green dot with a soft ping. Idle: a hollow grey ring. The words are in the right column. */}
      <span aria-hidden className="relative mt-1.5 flex h-2 w-2 shrink-0 items-center justify-center">
        {live
          ? <><span className="absolute h-2 w-2 rounded-full bg-ok opacity-60 motion-safe:animate-ping" /><span className="relative h-2 w-2 rounded-full bg-ok" /></>
          : <span className="h-2 w-2 rounded-full border border-dim" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-ui', nested ? 'text-muted' : 'text-fg')}>{sessionTitle(s)}</span>
        {where && <span className="block truncate text-hint text-muted">{where}</span>}
        {s.cwd && <span className="block truncate font-mono text-hint text-dim" title={s.cwd}>{s.cwd}</span>}
        {(moveBadge(s) || linksOf(s).length > 0) && (
          <span className="mt-1 flex flex-wrap gap-1">
            <MoveBadge s={s} />
            {linksOf(s).map((l) => <Badge key={l.project + '/' + l.repo} tone="accent">{l.project} / {l.repo}</Badge>)}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-hint text-muted">
        {live
          ? <span className="font-medium text-ok">Running</span>
          : <span>Idle · {relativeTime(s.lastAt, now)}</span>}
        <span>{s.entryCount} {s.entryCount === 1 ? 'entry' : 'entries'}</span>
      </span>
    </button>
  );
}

function Subagents({ parent, kids, onOpen, now }: { parent: PcSessionSummary; kids: PcSessionSummary[]; onOpen: (id: string) => void; now?: number }) {
  const [open, setOpen] = useState(false);
  const id = 'sub-' + parent.id;
  return (
    <div className="ml-7">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-2 py-0.5 text-hint text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight size={12} aria-hidden className={cn(open && 'rotate-90')} />
        {kids.length} subagent {kids.length === 1 ? 'session' : 'sessions'}
      </button>
      <ul id={id} hidden={!open} className="border-l border-line">
        {kids.map((k) => <li key={k.id}><SessionRow s={k} onOpen={onOpen} now={now} nested /></li>)}
      </ul>
    </div>
  );
}

/** The read-only transcript. Tool calls and results are collapsed rows; open one to see its text. */
export function TranscriptEntries({ entries, truncated }: { entries: PcSeqEntry[]; truncated?: boolean }) {
  return (
    <div className="space-y-2.5">
      {entries.length === 0 && <p className="py-6 text-center text-ui text-muted">Nothing mirrored for this session yet.</p>}
      {entries.map((e) => <EntryView key={e.seq} e={e} />)}
      {truncated && (
        <Banner tone="info" title="This session was cut short">
          It is larger than the mirror keeps, so later messages are not shown here. The full session is still on your PC.
        </Banner>
      )}
    </div>
  );
}

function EntryView({ e }: { e: PcSeqEntry }) {
  switch (e.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-full whitespace-pre-wrap rounded-xl rounded-br-xs bg-user px-4 py-2.5 text-body [overflow-wrap:anywhere]">{e.text}</div>
        </div>
      );
    case 'assistant':
      return <div className="md max-w-full text-body"><Markdown>{e.text}</Markdown></div>;
    case 'summary':
      return (
        <section aria-label="Conversation summary" className="my-3 rounded-2xl border border-dashed border-line bg-card2/40 px-4 py-3">
          <div className="text-label text-muted">Earlier conversation, summarised</div>
          <p className="mt-1 whitespace-pre-wrap text-ui text-fg [overflow-wrap:anywhere]">{e.text}</p>
        </section>
      );
    default: {
      const bad = !!e.isError;
      return (
        <details className="group">
          <summary
            className={cn(
              'flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-hint ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden',
              bad ? 'bg-bad/10 text-bad ring-bad/40' : 'bg-card2/40 text-muted ring-line hover:text-fg',
            )}
          >
            <ChevronRight size={12} aria-hidden className="shrink-0 group-open:rotate-90" />
            <span className="min-w-0 flex-1 truncate">{toolRowLabel(e)}</span>
            {e.kind === 'tool_result' && <span className="shrink-0">{bad ? 'error' : 'result'}</span>}
          </summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-card2 px-3 py-2 font-mono text-hint text-fg [overflow-wrap:anywhere]">{e.text || '(empty)'}</pre>
        </details>
      );
    }
  }
}
