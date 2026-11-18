// Bridge P6: move a mirrored PC session to the VPS (same conversation) and pull it back. Same approval rule as the
// other PC actions: the click in a password-signed-in browser plus the PC's own Run/Refuse dialog. Presentational
// pieces (MoveRows, VpsComposer, MoveSummary) take plain props so every disabled reason renders in a test.
import { useEffect, useId, useState } from 'react';
import { CloudUpload, CornerDownLeft, GitBranch, Loader2, Send } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../lib/api';
import { JOB_STATUS, PC_PROMPT_MAX, jobActive, promptOk, statusLabel } from '../lib/pcRun';
import {
  appliedNote, continueBlockedReason, jobRepos, moveBadge, moveBlockedReason, moveBody, moveRepoReason, moveResultOf,
  pullBlockedReason, pullBody, pullConfirmText, pullResultOf, roomChoices, continueBody,
  type PcJobWithMove, type PcSessionMove,
} from '../lib/pcMove';
import { fmtBytes, type PcSessionLink, type ProjectRepo } from '../lib/projectRepos';
import { usePcStart } from './PcRunForm';
import { Badge, Banner, Button, Field, Label, Select, Textarea, confirmAction } from './ui';

export function MoveBadge({ s }: { s: object }) {
  const b = moveBadge(s);
  return b ? <Badge tone={b.tone}>{b.label}</Badge> : null;
}

// ---- Move to VPS ----

export interface MoveRowsProps {
  links: PcSessionLink[];
  /** project slug -> its repo list; a project missing here has not loaded or is gone. */
  repos: Record<string, ProjectRepo[] | undefined>;
  /** PC offline / not signed in, or null. */
  pcBlocked: string | null;
  /** Rooms that could own the VPS turns. More than one shows a picker. */
  rooms: Array<{ id: string; name: string }>;
  room: string;
  onRoom: (id: string) => void;
  busy?: boolean;
  onMove: () => void;
}

export function MoveRows({ links, repos, pcBlocked, rooms, room, onRoom, busy, onMove }: MoveRowsProps) {
  const id = useId();
  const reason = moveBlockedReason({ links, repos, pcBlocked });
  return (
    <div className="space-y-3">
      {links.length > 0 && (
        <ul className="space-y-1.5" aria-label="Repos that move with this session">
          {links.map((l) => {
            const loaded = repos[l.project] !== undefined;
            const why = loaded ? moveRepoReason(repos[l.project]?.find((r) => r.name === l.repo)) : null;
            return (
              <li key={l.project + '/' + l.repo} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="truncate font-mono text-ui">{l.project} / {l.repo}</span>
                {why && <span className="min-w-0 flex-1 basis-48 text-hint leading-snug text-muted">{why}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {rooms.length > 1 && (
        <Field>
          <Label htmlFor={id + '-room'}>Chat that follows the VPS turns</Label>
          <Select id={id + '-room'} className="max-w-72" value={room} onChange={(e) => onRoom(e.target.value)}>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      )}
      {reason && <p id={id + '-why'} className="text-hint leading-snug text-muted">{reason}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="primary" disabled={!!reason || busy} aria-describedby={reason ? id + '-why' : undefined} onClick={onMove}>
          <CloudUpload size={13} aria-hidden /> {busy ? 'Sending' : 'Move to VPS'}
        </Button>
        <span className="text-hint text-muted">Same conversation, continued on the server. Your PC checks for secrets and still asks first.</span>
      </div>
    </div>
  );
}

function JobStatus({ job, onOpenLog }: { job: PcJobWithMove; onOpenLog?: () => void }) {
  return (
    <div role="status" className="rounded-lg bg-card2/60 px-3 py-2 text-ui ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={JOB_STATUS[job.status]?.tone ?? 'muted'}>{statusLabel(job.status)}</Badge>
        <span className="min-w-0 flex-1 truncate text-hint text-muted">{jobActive(job.status) ? 'Following this job live.' : job.error ?? 'Finished.'}</span>
        {onOpenLog && <Button size="sm" variant="ghost" onClick={onOpenLog}>Open job log</Button>}
      </div>
      <MoveSummary j={job} />
    </div>
  );
}

/** Panel under the transcript of a session that still lives on the PC. */
export function MovePanel({ sessionId, links, pcBlocked, onOpenLog }: { sessionId: string; links: PcSessionLink[]; pcBlocked: string | null; onOpenLog?: () => void }) {
  const rooms = useStore((s) => s.rooms);
  const [repos, setRepos] = useState<Record<string, ProjectRepo[] | undefined>>({});
  const [project, setProject] = useState<{ roomId: string | null; memberIds: string[] } | undefined>();
  const [room, setRoom] = useState('');
  const run = usePcStart();
  const slugs = [...new Set(links.map((l) => l.project))].join('\n');
  useEffect(() => {
    let alive = true;
    for (const slug of slugs.split('\n').filter(Boolean)) {
      api.projects.repos(slug).then((f) => alive && setRepos((c) => ({ ...c, [slug]: f.repos })), () => alive && setRepos((c) => ({ ...c, [slug]: [] })));
    }
    // The room belongs to the first linked project; a move across projects uses that one's chat.
    api.projects.list().then((l) => alive && setProject(l.find((p) => p.slug === slugs.split('\n')[0])), () => undefined);
    return () => { alive = false; };
  }, [slugs]);
  const choices = roomChoices(project, rooms);
  const picked = choices.some((c) => c.id === room) ? room : choices[0]?.id ?? '';
  const job = run.job as PcJobWithMove | null;
  return (
    <div className="space-y-3">
      <MoveRows
        links={links}
        repos={repos}
        pcBlocked={pcBlocked}
        rooms={choices}
        room={picked}
        onRoom={setRoom}
        busy={run.busy || (!!job && jobActive(job.status))}
        onMove={() => void run.start(moveBody(sessionId, choices.length > 1 ? picked : null))}
      />
      {run.error && <Banner tone="error">{run.error}</Banner>}
      {job && <JobStatus job={job} onOpenLog={onOpenLog} />}
    </div>
  );
}

// ---- Continue on VPS / Pull back ----

export interface VpsComposerProps {
  move: PcSessionMove;
  signedIn: boolean;
  /** PC offline / not signed in (for Pull back), or null. */
  pcBlocked: string | null;
  prompt: string;
  onPrompt: (v: string) => void;
  onSend: () => void;
  sending?: boolean;
  error?: string | null;
  onPull: () => void;
  pulling?: boolean;
}

/** One turn at a time: the box locks while a turn runs and the status line says so. */
export function VpsComposer(p: VpsComposerProps) {
  const id = useId();
  const sendWhy = continueBlockedReason(p.move, p.signedIn);
  const pullWhy = pullBlockedReason(p.move, p.pcBlocked);
  const transit = p.move.state === 'moving' || p.move.state === 'pulling';
  const canSend = !sendWhy && !transit && !p.sending && promptOk(p.prompt);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canSend) p.onSend(); }}>
      <div role="status" className="flex flex-wrap items-center gap-2 text-hint text-muted">
        {p.move.turnRunning || p.sending ? (
          <><Loader2 size={13} aria-hidden className="shrink-0" /><span className="text-fg">A turn is running on the VPS…</span></>
        ) : transit ? (
          <span>{p.move.state === 'moving' ? 'Waiting for your PC to finish moving this session.' : 'Waiting for your PC to pull this session back.'}</span>
        ) : (
          <span>This session lives on the VPS. Nothing runs on your PC until you pull it back.</span>
        )}
      </div>
      <Field>
        <Label htmlFor={id + '-prompt'}>Continue on VPS</Label>
        <Textarea
          id={id + '-prompt'}
          rows={3}
          maxLength={PC_PROMPT_MAX}
          value={p.prompt}
          disabled={!!sendWhy || transit}
          aria-describedby={sendWhy ? id + '-why' : undefined}
          placeholder="What should Claude do next on the server?"
          onChange={(e) => p.onPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) { e.preventDefault(); p.onSend(); } }}
        />
      </Field>
      {sendWhy && <p id={id + '-why'} className="text-hint leading-snug text-muted">{sendWhy}</p>}
      {p.error && <Banner tone="error">{p.error}</Banner>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" variant="primary" disabled={!canSend}><Send size={13} aria-hidden /> {p.sending ? 'Sending' : 'Send turn'}</Button>
        <Button variant="outline" disabled={!!pullWhy || transit || p.pulling} aria-describedby={pullWhy ? id + '-pull' : undefined} onClick={p.onPull}>
          <CornerDownLeft size={13} aria-hidden /> Pull back
        </Button>
        <span className="text-hint text-muted">Ctrl+Enter sends.</span>
      </div>
      {pullWhy && !transit && <p id={id + '-pull'} className="text-hint leading-snug text-muted">{pullWhy}</p>}
    </form>
  );
}

/** The panel for a session that is on the VPS (or on its way). `onChanged` refetches the session header. */
export function VpsPanel({ sessionId, move, signedIn, pcBlocked, onChanged, onOpenLog }: {
  sessionId: string; move: PcSessionMove; signedIn: boolean; pcBlocked: string | null; onChanged: () => void; onOpenLog?: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = usePcStart();
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api.pcSessions.continue(sessionId, continueBody(prompt));
      setPrompt('');
      onChanged();
    } catch (e) { setError((e as Error).message); } finally { setSending(false); }
  };
  const pull = async () => {
    const ok = await confirmAction({
      title: 'Pull this session back to your PC?',
      body: pullConfirmText(move),
      confirmLabel: 'Pull back',
    });
    if (!ok) return;
    if (await run.start(pullBody(sessionId))) onChanged(); else toast('Could not start the pull', true);
  };
  const job = run.job as PcJobWithMove | null;
  return (
    <div className="space-y-3">
      <VpsComposer
        move={move} signedIn={signedIn} pcBlocked={pcBlocked} prompt={prompt} onPrompt={setPrompt}
        onSend={() => void send()} sending={sending} error={error ?? run.error} onPull={() => void pull()} pulling={run.busy}
      />
      {job && <JobStatus job={job} onOpenLog={onOpenLog} />}
    </div>
  );
}

// ---- job log ----

/** What a move or pull job did, per repo. Plain text only: the PC's report is untrusted. */
export function MoveSummary({ j }: { j: PcJobWithMove }) {
  const pull = (j.mode as string) === 'pull';
  const r = pull ? pullResultOf(j) : moveResultOf(j);
  const asked = jobRepos(j);
  if (!asked.length && !r) return null;
  return (
    <div className="mt-1 space-y-1.5 text-hint">
      {!r && <div className="font-mono text-fg">{asked.join(', ')}</div>}
      {r && (
        <ul aria-label={pull ? 'Pulled repos' : 'Moved repos'} className="space-y-1">
          {r.repos.map((x) => (
            <li key={x.repo} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
              <span className="font-mono text-fg">{x.repo}</span>
              {x.branch && <span className="inline-flex min-w-0 items-center gap-1 font-mono"><GitBranch size={11} aria-hidden className="shrink-0" /><span className="truncate">{x.branch}</span></span>}
              <span className="font-mono" title={x.commit}>{x.commit.slice(0, 8)}</span>
              {x.applied !== undefined && <Badge tone={x.applied ? 'ok' : 'warn'}>{x.applied ? 'Applied' : 'Not applied'}</Badge>}
              {appliedNote(x) && <span className="basis-full">{appliedNote(x)}</span>}
            </li>
          ))}
        </ul>
      )}
      {r && <p className="text-muted">Session file {fmtBytes(r.sessionBytes)}</p>}
    </div>
  );
}
