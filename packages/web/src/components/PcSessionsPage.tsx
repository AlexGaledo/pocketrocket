// PC sessions: Claude Code sessions mirrored from the owner's PC, read-only. A list grouped by repo opens a
// transcript. The list refreshes (debounced) and the open transcript appends when the hub sends
// `pc_session_updated`. Nothing here sends anything back to Claude Code; the only write is deleting the mirror.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Play, Trash2, Upload } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../lib/api';
import {
  PC_ENTRY_PAGE, groupSessions, mergeEntries, mergeSessions, nextBefore, onPcSessionUpdated, repoOptions, sessionTitle,
  type PcSeqEntry, type PcSessionDetail, type PcSessionSummary,
} from '../lib/pcSessions';
import { PcRunForm, usePcStart, usePcStatus } from './PcRunForm';
import { canResume, resumeBody } from '../lib/pcRun';
import { linksOf } from '../lib/projectRepos';
import { SyncPanel } from './PcSyncPanel';
import { Badge, Banner, Button, Input, Select, Skeleton, SkeletonGroup, Tooltip, cn, confirmAction } from './ui';
import { FleetHeader, PageBody } from './FleetPages';
import { MirrorEmptyState, SessionGroups, TranscriptEntries } from './PcSessionViews';

export function PcSessionsPage() {
  const focus = useStore((s) => s.pcSessionFocus);
  const [openId, setOpenId] = useState<string | null>(focus);
  // A job log link asks for a transcript; take it once.
  useEffect(() => {
    if (!focus) return;
    setOpenId(focus);
    useStore.setState({ pcSessionFocus: null });
  }, [focus]);
  // Leaving a transcript returns to the list with its search and scroll intact, so the list stays mounted behind it.
  return (
    <>
      <div className={cn('flex min-h-0 flex-1 flex-col', openId && 'hidden')} inert={!!openId}><SessionList onOpen={setOpenId} /></div>
      {openId && <SessionView key={openId} id={openId} onOpen={setOpenId} onBack={() => setOpenId(null)} />}
    </>
  );
}

// ---- list ----

function SessionList({ onOpen }: { onOpen: (id: string) => void }) {
  const [sessions, setSessions] = useState<PcSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [repo, setRepo] = useState('');
  const [repos, setRepos] = useState<string[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // `keep` merges into what is shown (a live refresh), otherwise the list starts over (a new search or filter).
  const load = useCallback((keep: boolean) => {
    const n = ++seq.current;
    api.pcSessions.list({ q: debouncedQ, repo }).then(({ sessions: page }) => {
      if (n !== seq.current) return;
      setSessions((cur) => (keep && cur ? mergeSessions(cur, page) : page));
      if (!keep) setBefore(nextBefore(page, page.length));
      setRepos((cur) => [...new Set([...cur, ...repoOptions(page)])].sort((a, b) => a.localeCompare(b)));
      setError(null);
    }, (e: Error) => { if (n === seq.current) setError(e.message); });
  }, [debouncedQ, repo]);

  useEffect(() => { load(false); }, [load]);

  // Entries arrive in bursts; one refetch per quiet second and a half is plenty for a list.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onPcSessionUpdated(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => load(true), 1500);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [load]);

  const more = async () => {
    if (before === null) return;
    setMoreBusy(true);
    try {
      const { sessions: page } = await api.pcSessions.list({ q: debouncedQ, repo, before });
      setSessions((cur) => mergeSessions(cur ?? [], page));
      setBefore(nextBefore(page, page.length) ?? null);
    } catch (e) { setError((e as Error).message); } finally { setMoreBusy(false); }
  };

  const groups = groupSessions(sessions ?? []);
  const filtered = !!debouncedQ.trim() || !!repo;
  return (
    <>
      <FleetHeader title="PC sessions" sub="Claude Code on your PC, read-only" />
      <PageBody>
        <div className="mb-4 flex flex-wrap gap-2 px-3">
          <Input aria-label="Search sessions" type="search" className="min-w-40 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, folder or repo" />
          <Select aria-label="Filter by repo" className="w-44 max-sm:w-full" value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">All repos</option>
            {(repo && !repos.includes(repo) ? [...repos, repo] : repos).map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </div>
        {error && <Banner tone="error" className="mx-3 mb-3" action={<Button size="sm" onClick={() => load(false)}>Retry</Button>}>{error}</Banner>}
        {sessions === null && !error && (
          <SkeletonGroup label="Loading sessions…" className="space-y-2 px-3"><Skeleton className="h-16 w-full rounded-lg" /><Skeleton className="h-16 w-full rounded-lg" /></SkeletonGroup>
        )}
        {sessions?.length === 0 && <MirrorEmptyState filtered={filtered} />}
        <SessionGroups groups={groups} onOpen={onOpen} />
        {before !== null && (
          <div className="mt-2 flex justify-center">
            <Button onClick={() => void more()} disabled={moreBusy}>{moreBusy ? 'Loading…' : 'Load more'}</Button>
          </div>
        )}
      </PageBody>
    </>
  );
}

// ---- transcript ----

function SessionView({ id, onOpen, onBack }: { id: string; onOpen: (id: string) => void; onBack: () => void }) {
  const toast = useStore((s) => s.toast);
  const [detail, setDetail] = useState<PcSessionDetail | null>(null);
  const [entries, setEntries] = useState<PcSeqEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const openDialog = useStore((s) => s.openDialog);
  const { blocked } = usePcStatus();
  const run = usePcStart();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(false);
  const lastSeq = useRef(0);
  const inFlight = useRef(false);

  const fetchPage = useCallback(async (after: number) => {
    const r = await api.pcSessions.entries(id, after, PC_ENTRY_PAGE);
    setEntries((cur) => mergeEntries(cur ?? [], r.entries));
    setMore(r.more);
    const last = r.entries[r.entries.length - 1];
    if (last) lastSeq.current = Math.max(lastSeq.current, last.seq);
    return r;
  }, [id]);

  useEffect(() => {
    api.pcSessions.get(id).then(setDetail, (e: Error) => setError(e.message));
    fetchPage(0).catch((e: Error) => setError(e.message));
  }, [id, fetchPage]);

  // New entries while the reader is at the bottom: append and keep following. Mid-transcript, only the header refreshes.
  const moreRef = useRef(false);
  moreRef.current = more;
  useEffect(() => onPcSessionUpdated((ev) => {
    if (ev.id !== id && ev.id.split(':')[0] !== id) return;
    api.pcSessions.get(id).then(setDetail, () => undefined);
    if (ev.id !== id || moreRef.current || inFlight.current) return;
    inFlight.current = true;
    fetchPage(lastSeq.current).catch(() => undefined).finally(() => { inFlight.current = false; });
  }), [id, fetchPage]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadMore = async () => {
    setMoreBusy(true);
    try { await fetchPage(lastSeq.current); } catch (e) { toast((e as Error).message, true); } finally { setMoreBusy(false); }
  };

  const remove = async () => {
    const kids = detail?.children.length ?? 0;
    const ok = await confirmAction({
      title: 'Delete this mirrored session?',
      body: 'This removes the copy PocketRocket keeps' + (kids ? ' and its ' + kids + ' subagent ' + (kids === 1 ? 'session' : 'sessions') : '') + '. The files on your PC are not touched, and a session that is still active is mirrored again.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try { await api.pcSessions.remove(id); onBack(); } catch (e) { toast((e as Error).message, true); }
  };

  const links = detail ? linksOf(detail) : [];
  const where = detail ? [detail.repo?.name, detail.repo?.branch].filter(Boolean).join(' · ') : '';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-5 max-md:pl-14">
        <Tooltip content="Back to sessions"><Button variant="ghost" size="icon" aria-label="Back to sessions" onClick={onBack}><ArrowLeft size={16} /></Button></Tooltip>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-body font-semibold">
            <span className="truncate">{detail ? sessionTitle(detail) : 'Session'}</span>
            {detail?.status === 'live' && <Badge tone="ok">Live</Badge>}
          </h1>
          <div className="truncate text-hint text-muted">{[where || detail?.cwd, ...links.map((l) => l.project + '/' + l.repo)].filter(Boolean).join(' · ') || ' '}</div>
        </div>
        {links.length > 0 && (
          <Button size="sm" variant="outline" aria-expanded={syncOpen} aria-controls="sync-to-vps" onClick={() => { setSyncOpen((o) => !o); setComposeOpen(false); }}>
            <Upload size={13} aria-hidden /> <span className="max-sm:sr-only">Sync</span>
          </Button>
        )}
        {canResume(id) && (
          <Button size="sm" variant={composeOpen ? 'outline' : 'primary'} aria-expanded={composeOpen} aria-controls="continue-on-pc" onClick={() => { setComposeOpen((o) => !o); setSyncOpen(false); }}>
            <Play size={13} aria-hidden /> Continue on PC
          </Button>
        )}
        <Tooltip content="Delete the mirrored copy"><Button variant="ghost" size="icon" aria-label="Delete mirrored session" onClick={() => void remove()}><Trash2 size={15} /></Button></Tooltip>
      </header>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-6">
        <div className="mx-auto w-full max-w-[var(--page-max)] px-3">
          {detail && detail.children.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-hint text-muted">
              Subagents:
              {detail.children.map((c) => <Button key={c.id} size="sm" onClick={() => onOpen(c.id)}>{sessionTitle(c)}</Button>)}
            </div>
          )}
          {error && <Banner tone="error" className="mb-3">{error}</Banner>}
          {entries === null && !error && (
            <SkeletonGroup label="Loading transcript…" className="space-y-3"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-16 w-full" /></SkeletonGroup>
          )}
          {entries && <TranscriptEntries entries={entries} truncated={!!detail?.truncated && !more} />}
          {more && <div className="mt-3 flex justify-center"><Button onClick={() => void loadMore()} disabled={moreBusy}>{moreBusy ? 'Loading…' : 'Load more'}</Button></div>}
        </div>
      </div>
      {syncOpen && links.length > 0 && (
        <section id="sync-to-vps" aria-label="Sync to VPS" className="shrink-0 border-t border-line px-5 py-3">
          <div className="mx-auto w-full max-w-[var(--page-max)]">
            <SyncPanel sessionId={id} links={links} blocked={blocked} onOpenLog={() => openDialog({ kind: 'settings', section: 'pc-runner' })} />
          </div>
        </section>
      )}
      {composeOpen && canResume(id) && (
        <section id="continue-on-pc" aria-label="Continue on PC" className="shrink-0 border-t border-line px-5 py-3">
          <div className="mx-auto w-full max-w-[var(--page-max)]">
            <PcRunForm
              blocked={blocked}
              prompt={prompt}
              onPrompt={setPrompt}
              submitLabel="Send to PC"
              busy={run.busy}
              placeholder="What should Claude do next in this session?"
              error={run.error}
              job={run.job}
              onOpenLog={() => openDialog({ kind: 'settings', section: 'pc-runner' })}
              onSubmit={() => { void run.start(resumeBody(id, prompt)).then((ok) => ok && setPrompt('')); }}
            />
          </div>
        </section>
      )}
    </div>
  );
}

