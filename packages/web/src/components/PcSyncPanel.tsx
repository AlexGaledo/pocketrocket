// Bridge P5: "Sync to VPS / push wip branch" for a mirrored session that belongs to a project repo. The click is the
// approval (same rule as Continue on PC), the PC snapshots the working tree without touching it, scans it for secrets,
// and pushes a wip branch or sends a bundle. Client repos and sync "none" are disabled with the reason shown.
import { useEffect, useState } from 'react';
import { GitBranch, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { JOB_STATUS, jobActive, statusLabel } from '../lib/pcRun';
import {
  fmtBytes, syncActionLabel, syncBlockedReason, syncBody, syncResultOf,
  type PcJobWithSync, type PcSessionLink, type ProjectRepo,
} from '../lib/projectRepos';
import { usePcStart } from './PcRunForm';
import { Badge, Banner, Button } from './ui';

/** What a sync job did: where it went and what the pre-push scan said. Plain text only; the PC's findings are untrusted. */
export function SyncSummary({ j }: { j: PcJobWithSync }) {
  const r = syncResultOf(j);
  const repo = j.sync?.project && j.sync.repo ? j.sync.project + ' / ' + j.sync.repo : null;
  const mode = r?.mode ?? j.sync?.mode;
  if (!repo && !r) return null;
  return (
    <div className="mt-1 space-y-1.5 text-hint">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        {repo && <span className="font-mono text-fg">{repo}</span>}
        {mode && <Badge>{mode === 'bundle' ? 'Bundle to VPS' : 'wip branch'}</Badge>}
        {r?.branch && <span className="inline-flex min-w-0 items-center gap-1 font-mono"><GitBranch size={11} aria-hidden className="shrink-0" /><span className="truncate">{r.branch}</span></span>}
        {r?.commit && <span className="font-mono" title={r.commit}>{r.commit.slice(0, 8)}</span>}
        {r?.bundleBytes != null && <span>{fmtBytes(r.bundleBytes)}</span>}
      </div>
      {r && (r.scan.blocked ? (
        <div role="group" aria-label="Pre-push scan" className="rounded-lg bg-bad/10 px-3 py-2 ring-1 ring-bad/40">
          <p className="flex items-center gap-1.5 font-medium text-bad"><ShieldAlert size={13} aria-hidden /> Nothing was pushed: the scan found secrets or key files</p>
          <ul className="mt-1 space-y-0.5 font-mono text-fg [overflow-wrap:anywhere]">
            {r.scan.findings.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-ok"><ShieldCheck size={13} aria-hidden /> Scan clean</p>
      ))}
    </div>
  );
}

export interface SyncRowsProps {
  links: PcSessionLink[];
  /** project slug -> its repo list; a project missing here has not loaded or is gone. */
  repos: Record<string, ProjectRepo[] | undefined>;
  /** PC offline / not signed in, or null. */
  blocked: string | null;
  busy?: boolean;
  onSync: (l: PcSessionLink) => void;
}

/** One row per linked repo. Presentational so every disabled reason can be rendered in a test. */
export function SyncRows({ links, repos, blocked, busy, onSync }: SyncRowsProps) {
  return (
    <ul className="space-y-2">
      {links.map((l) => {
        const repo = repos[l.project]?.find((r) => r.name === l.repo);
        const loaded = repos[l.project] !== undefined;
        const reason = loaded ? syncBlockedReason(repo, blocked) : 'Checking the repo settings…';
        const id = 'sync-' + l.project + '-' + l.repo;
        return (
          <li key={l.project + '/' + l.repo} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="min-w-0 flex-1 basis-40">
              <div className="truncate font-mono text-ui">{l.project} / {l.repo}</div>
              {reason && <p id={id} className="text-hint leading-snug text-muted">{reason}</p>}
            </div>
            <Button size="sm" variant="primary" disabled={!!reason || busy} aria-describedby={reason ? id : undefined} onClick={() => onSync(l)}>
              <Upload size={13} aria-hidden /> {busy ? 'Sending' : syncActionLabel(repo)}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** The panel under a transcript: loads each linked project's repo list, starts the job, follows it live. */
export function SyncPanel({ sessionId, links, blocked, onOpenLog }: { sessionId: string; links: PcSessionLink[]; blocked: string | null; onOpenLog?: () => void }) {
  const [repos, setRepos] = useState<Record<string, ProjectRepo[] | undefined>>({});
  const run = usePcStart();
  const projects = [...new Set(links.map((l) => l.project))].join('\n');
  useEffect(() => {
    let alive = true;
    for (const slug of projects.split('\n')) {
      api.projects.repos(slug).then((f) => alive && setRepos((c) => ({ ...c, [slug]: f.repos })), () => alive && setRepos((c) => ({ ...c, [slug]: [] })));
    }
    return () => { alive = false; };
  }, [projects]);
  const job = run.job as PcJobWithSync | null;
  return (
    <div className="space-y-3">
      <SyncRows links={links} repos={repos} blocked={blocked} busy={run.busy || (!!job && jobActive(job.status))} onSync={(l) => void run.start(syncBody(sessionId, l))} />
      <p className="text-hint text-muted">Your PC copies this session's files without touching your working folder, checks them for secrets, then pushes. It still asks before it runs.</p>
      {run.error && <Banner tone="error">{run.error}</Banner>}
      {job && (
        <div role="status" className="rounded-lg bg-card2/60 px-3 py-2 text-ui ring-1 ring-line">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={JOB_STATUS[job.status]?.tone ?? 'muted'}>{statusLabel(job.status)}</Badge>
            <span className="min-w-0 flex-1 truncate text-hint text-muted">{jobActive(job.status) ? 'Following this job live.' : job.error ?? 'Finished.'}</span>
            {onOpenLog && <Button size="sm" variant="ghost" onClick={onOpenLog}>Open job log</Button>}
          </div>
          <SyncSummary j={job} />
        </div>
      )}
    </div>
  );
}
