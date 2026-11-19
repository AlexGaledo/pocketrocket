// Bridge P4: start a run on the owner's PC from the app. One form, two uses: "Continue on PC" under a mirrored
// transcript (resume that session) and "Run on PC" in Settings > PC runner (a new run in an allowed folder).
// The click is the approval, so it only works from a password-signed-in browser; the hub's 403 / 409 are the
// real gate and their message is shown as-is. The PC still asks before it runs anything.
import { useCallback, useEffect, useId, useState } from 'react';
import { Play } from 'lucide-react';
import type { PcRunnerStatus } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { PC_PROMPT_MAX, jobActive, pcBlockedReason, promptOk, statusLabel, JOB_STATUS, type PcJobRequest, type PcJobView } from '../lib/pcRun';
import { Badge, Banner, Button, Field, Label, Select, Textarea } from './ui';

export interface PcRunFormProps {
  /** Why starting is blocked (offline, not signed in), or null. Shown as a hint and disables the controls. */
  blocked: string | null;
  prompt: string;
  onPrompt: (v: string) => void;
  submitLabel: string;
  busy?: boolean;
  onSubmit: () => void;
  /** New-run mode: the runner's allowed folder names and the chosen one. */
  folders?: string[];
  folder?: string;
  onFolder?: (v: string) => void;
  placeholder?: string;
  error?: string | null;
  job?: PcJobView | null;
  onOpenLog?: () => void;
}

/** Presentational, so the disabled states render the same in a test as on screen. */
export function PcRunForm(p: PcRunFormProps) {
  const id = useId();
  const needsFolder = !!p.folders;
  const noFolders = needsFolder && p.folders!.length === 0;
  const off = !!p.blocked || noFolders;
  const hint = p.blocked ?? (noFolders ? 'Your PC has not reported any allowed folders yet.' : null);
  const canSend = !off && !p.busy && promptOk(p.prompt) && (!needsFolder || !!p.folder);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canSend) p.onSubmit(); }}>
      {needsFolder && (
        <Field>
          <Label htmlFor={id + '-folder'}>Folder</Label>
          <Select id={id + '-folder'} value={p.folder ?? ''} disabled={off} onChange={(e) => p.onFolder?.(e.target.value)}>
            {p.folders!.map((f) => <option key={f} value={f}>{f}</option>)}
          </Select>
        </Field>
      )}
      <Field>
        <Label htmlFor={id + '-prompt'}>Prompt</Label>
        <Textarea
          id={id + '-prompt'}
          rows={3}
          maxLength={PC_PROMPT_MAX}
          value={p.prompt}
          disabled={off}
          aria-describedby={hint ? id + '-hint' : undefined}
          placeholder={p.placeholder}
          onChange={(e) => p.onPrompt(e.target.value)}
        />
      </Field>
      {hint && <p id={id + '-hint'} className="text-hint leading-snug text-muted">{hint}</p>}
      {p.error && <Banner tone="error">{p.error}</Banner>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" variant="primary" disabled={!canSend}><Play size={13} aria-hidden /> {p.busy ? 'Sending' : p.submitLabel}</Button>
        <span className="text-hint text-muted">Your PC will still ask before it runs.</span>
      </div>
      {p.job && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-card2/60 px-3 py-2 text-ui ring-1 ring-line">
          <Badge tone={JOB_STATUS[p.job.status]?.tone ?? 'muted'}>{statusLabel(p.job.status)}</Badge>
          <span className="min-w-0 flex-1 truncate text-hint text-muted">
            {jobActive(p.job.status) ? 'Following this job live.' : p.job.error ?? 'Finished.'}
          </span>
          {p.onOpenLog && <Button size="sm" variant="ghost" onClick={p.onOpenLog}>Open job log</Button>}
        </div>
      )}
    </form>
  );
}

/** Runner status (refetched on every pc-runner.changed) plus whether this browser holds a password session. */
export function usePcStatus() {
  const rev = useStore((s) => s.pcRunnerRev);
  const signedIn = useStore((s) => s.signedIn);
  const [status, setStatus] = useState<PcRunnerStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api.pcRunner.status().then((s) => alive && setStatus(s), () => undefined);
    return () => { alive = false; };
  }, [rev]);
  return { status, signedIn, blocked: pcBlockedReason({ status, signedIn }) };
}

/** Sends the request, then follows that job through `pc-runner.changed`. */
export function usePcStart() {
  const rev = useStore((s) => s.pcRunnerRev);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<PcJobView | null>(null);
  const jobId = job?.id;
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    api.pcRunner.job(jobId).then((j) => alive && setJob(j), () => undefined);
    return () => { alive = false; };
  }, [jobId, rev]);
  const start = useCallback(async (body: PcJobRequest): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setJob(await api.pcRunner.start(body));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, job, start };
}
