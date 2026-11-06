/**
 * Settings › PC runner. The owner's Windows PC runs Claude Code jobs a bot asked for and the owner approved on a
 * card. Here: whether the PC is paired and online, the folders it allows, a new pairing token (shown once, never
 * stored), the kill switch, and the log of jobs with their output.
 *
 * The output is redacted and capped by the hub. It is rendered as text in a <pre>, never as markdown or HTML.
 * Desktop only: the hub refuses a paired phone on every /api/pc-runner route, and the dialog hides the section.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, KeyRound, Power, RefreshCw, TriangleAlert } from 'lucide-react';
import type { PcJobStatus, PcRunnerJob, PcRunnerStatus } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { Badge, Button, cn, confirmAction, fmtUsd } from '../ui';
import { Card, Group, InlineError, Private, SectionHeader } from './parts';

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 36) return h + ' h ago';
  return new Date(ts).toLocaleDateString();
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  return m < 60 ? m + ' min ' + (s % 60) + ' s' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}

const STATUS: Record<PcJobStatus, { label: string; tone: 'muted' | 'ok' | 'warn' | 'bad' | 'accent' }> = {
  pending_approval: { label: 'Waiting for you', tone: 'warn' },
  queued: { label: 'Queued', tone: 'muted' },
  claimed: { label: 'Picked up', tone: 'accent' },
  running: { label: 'Running', tone: 'accent' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  refused: { label: 'Refused on PC', tone: 'warn' },
  expired: { label: 'Expired', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export function PcRunnerSection({ onOpenSecurity }: { onOpenSecurity: () => void }) {
  const rev = useStore((s) => s.pcRunnerRev);
  const [status, setStatus] = useState<PcRunnerStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PcRunnerJob[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  // Jobs can only be allowed from a password-signed-in browser, so with no password nothing can ever run.
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  useEffect(() => {
    api.auth.status().then((r) => setPasswordSet(r.passwordSet), () => undefined);
  }, []);

  const load = useCallback(() => {
    api.pcRunner.status().then((s) => { setStatus(s); setStatusError(null); }, (e: Error) => setStatusError(e.message));
    api.pcRunner.jobs(50).then((j) => { setJobs(j); setJobsError(null); }, (e: Error) => setJobsError(e.message));
  }, []);
  // Every job or pairing change arrives as `pc-runner.changed`. "Online" lapses without one (no heartbeat for
  // 30 s), so the status is also re-read every 30 s while this section is open.
  useEffect(load, [load, rev]);
  useEffect(() => {
    const t = setInterval(() => api.pcRunner.status().then(setStatus, () => undefined), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <SectionHeader title="PC runner" description="Bots can ask your PC to run Claude Code in folders it allows. Every job needs your OK." />
      {passwordSet === false && (
        <div role="note" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warn/10 p-3.5 text-ui ring-1 ring-warn/30">
          <TriangleAlert size={15} aria-hidden className="shrink-0 text-warn" />
          <p className="min-w-[12rem] flex-1 leading-snug">Set a password before using the PC runner. Jobs can only be approved from a signed-in browser.</p>
          <Button size="sm" onClick={onOpenSecurity}>Open Security</Button>
        </div>
      )}
      <StatusGroup status={status} error={statusError} onChanged={load} />
      <JobsGroup jobs={jobs} error={jobsError} onRefresh={load} />
    </>
  );
}

// ---------- status, pairing, kill switch ----------

function StatusGroup({ status, error, onChanged }: { status: PcRunnerStatus | null; error: string | null; onChanged: () => void }) {
  const toast = useStore((s) => s.toast);
  // The fresh token lives in this component's state only: gone when the section closes, never in the store.
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mint = async () => {
    if (status?.paired && !(await confirmAction({
      title: 'Make a new pairing token?',
      body: 'The current token stops working at once. A job the PC is running now is dropped. You will need to paste the new token into the PC helper.',
      confirmLabel: 'New token',
    }))) return;
    setBusy(true);
    try {
      setToken((await api.pcRunner.mintToken()).token);
      onChanged();
    } catch (e) {
      toast("Couldn't make a token: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!(await confirmAction({
      title: 'Turn off the PC runner?',
      body: 'The hub forgets the PC and cancels every job that is waiting or running. To use it again, pair the PC with a new token.',
      confirmLabel: 'Turn off',
      danger: true,
    }))) return;
    setBusy(true);
    try {
      const r = await api.pcRunner.turnOff();
      setToken(null);
      toast('PC runner turned off' + (r.cancelled ? ', ' + r.cancelled + (r.cancelled === 1 ? ' job' : ' jobs') + ' cancelled' : ''));
      onChanged();
    } catch (e) {
      toast("Couldn't turn it off: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const paired = !!status?.paired;
  const state = !status ? null : !paired ? 'Not paired' : status.online ? 'Online' : 'Offline';
  return (
    <Group title="Your PC">
      <Card>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
          {/* The min width makes the buttons wrap under the state on a phone instead of squeezing it. */}
          <div className="min-w-[12rem] flex-1">
            <div className="flex items-center gap-2 text-ui font-medium" role="status">
              {state && (
                <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', status?.online ? 'bg-ok' : paired ? 'bg-warn' : 'bg-dim')} />
              )}
              {state ?? 'Loading…'}
            </div>
            {paired && <div className="mt-0.5 text-hint text-muted">Last seen {ago(status!.lastSeenAt)}</div>}
            {status && !paired && (
              <p className="mt-0.5 max-w-[46ch] text-hint leading-snug text-muted">Make a token, then paste it into the PocketRocket helper on your PC.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={paired ? 'outline' : 'primary'} onClick={() => void mint()} disabled={busy || !status}>
              <KeyRound size={13} aria-hidden /> {paired ? 'New pairing token' : 'Make a pairing token'}
            </Button>
            {paired && (
              <Button size="sm" variant="danger" onClick={() => void turnOff()} disabled={busy}>
                <Power size={13} aria-hidden /> Turn off
              </Button>
            )}
          </div>
        </div>

        {paired && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="text-hint text-muted">Allowed folders</div>
            {status!.folders.length ? (
              <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Allowed folders">
                {status!.folders.map((f) => (
                  <li key={f} className="rounded-full bg-card2 px-2 py-0.5 font-mono text-hint ring-1 ring-line">{f}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-hint text-muted">None yet. The PC reports them when it connects.</p>
            )}
          </div>
        )}

        {token && (
          <div className="mt-3 rounded-md bg-warn/10 p-3 ring-1 ring-warn/30">
            <div className="text-ui font-medium text-fg">New pairing token</div>
            <p className="mt-0.5 text-hint leading-snug text-muted">
              Shown once. Copy it into the helper on your PC now. It replaces the old token, which no longer works.
            </p>
            <div className="mt-2 rounded-md bg-card px-2.5 py-1.5 text-ui ring-1 ring-line">
              <Private value={token} display={token.slice(0, 4) + '••••••••••••'} label="pairing token" />
            </div>
            <div className="mt-2">
              <Button size="sm" variant="ghost" onClick={() => setToken(null)}>Done</Button>
            </div>
          </div>
        )}
        {error && <InlineError>{error}</InlineError>}
      </Card>
    </Group>
  );
}

// ---------- the job log ----------

function JobsGroup({ jobs, error, onRefresh }: { jobs: PcRunnerJob[] | null; error: string | null; onRefresh: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Group title="Jobs" aside={<Button size="sm" variant="ghost" onClick={onRefresh}><RefreshCw size={13} aria-hidden /> Refresh</Button>}>
      <Card className="py-2">
        {error && <InlineError>{"Couldn't load jobs: " + error}</InlineError>}
        {!error && !jobs && <p className="py-2 text-ui text-muted">Loading…</p>}
        {jobs && jobs.length === 0 && (
          <p className="py-2 text-ui text-muted">No jobs yet. When a bot asks to run something on your PC, it shows here.</p>
        )}
        {jobs && jobs.length > 0 && (
          <ul className="divide-y divide-line">
            {jobs.map((j) => <JobRow key={j.id} j={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} />)}
          </ul>
        )}
      </Card>
    </Group>
  );
}

function JobRow({ j, open, onToggle }: { j: PcRunnerJob; open: boolean; onToggle: () => void }) {
  const s = STATUS[j.status];
  const meta = [
    j.room.name ?? '(deleted chat)',
    ago(j.createdAt),
    j.durationMs !== null ? fmtDuration(j.durationMs) : null,
    j.costUsd !== null ? fmtUsd(j.costUsd) : null,
  ].filter(Boolean).join(' · ');
  const detailId = 'pc-job-' + j.id;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailId}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-md px-2 py-2.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight size={14} aria-hidden className={cn('mt-1 shrink-0 text-muted', open && 'rotate-90')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui">
            <Badge tone={s.tone}>{s.label}</Badge>
            <span className="font-mono text-hint">@{j.bot.handle ?? 'deleted-bot'}</span>
            <span className="font-mono text-hint text-muted">{j.folder}</span>
          </div>
          <div className="mt-1 truncate text-ui">{j.prompt.split('\n')[0]}</div>
          <div className="mt-0.5 text-hint text-muted">{meta}</div>
        </div>
      </button>
      {open && <JobDetail id={detailId} j={j} />}
    </li>
  );
}

function JobDetail({ id, j }: { id: string; j: PcRunnerJob }) {
  const times = [
    'Asked ' + new Date(j.createdAt).toLocaleString(),
    j.startedAt ? 'started ' + new Date(j.startedAt).toLocaleTimeString() : null,
    j.finishedAt ? 'finished ' + new Date(j.finishedAt).toLocaleTimeString() : null,
  ].filter(Boolean).join(', ');
  const box = 'mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card p-2.5 font-mono text-hint leading-relaxed ring-1 ring-line';
  return (
    <div id={id} className="pb-3 pl-6">
      <div className="text-hint text-muted">{times}</div>
      <div className="mt-2 text-hint font-medium text-fg">Prompt</div>
      <pre className={box} tabIndex={0} aria-label="Job prompt">{j.prompt}</pre>
      {j.error && (
        <p className="mt-2 text-hint text-muted"><span className="font-medium text-fg">Why it stopped:</span> {j.error}</p>
      )}
      {j.refusedLocally && <p className="mt-2 text-hint text-muted">You declined this job on the PC.</p>}
      {j.output !== null && (
        <>
          <div className="mt-2 text-hint font-medium text-fg">Output</div>
          {/* Plain text on purpose: the PC's output is untrusted, so it is never rendered as markdown or HTML. */}
          <pre className={box} tabIndex={0} aria-label="Job output">{j.output || '(no output)'}</pre>
        </>
      )}
    </div>
  );
}
