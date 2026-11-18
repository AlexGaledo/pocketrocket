// Bridge P5: the repo list of one project (Settings > Projects). A repo is a name and a remote URL; the PC finds the
// checkout itself, so no path of yours is typed or stored here. Sync mode says how a PC session's work reaches the VPS.
import { useEffect, useId, useState } from 'react';
import { GitBranch, Plus, Trash2, X } from 'lucide-react';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import {
  SYNC_LABEL, emptyRepo, hasErrors, reposBody, validateRepos,
  type ProjectRepo, type RepoIssue, type RepoSyncMode,
} from '../../lib/projectRepos';
import { Button, Field, Input, Label, Select, Switch, Tooltip, confirmAction } from '../ui';
import { InlineError } from './parts';

const SYNC_HELP: Record<RepoSyncMode, string> = {
  none: 'Nothing leaves your PC.',
  'wip-branch': 'Pushes the session as a wip/ branch on the remote. Never a protected branch.',
  bundle: 'Sends a git bundle to the hub, which fetches it into the VPS copy on a wip/ branch.',
};

export interface ReposFormProps {
  repos: ProjectRepo[];
  onChange: (next: ProjectRepo[]) => void;
  /** Local validation plus nothing else; shown inline under the field it belongs to. */
  issues: RepoIssue[];
  /** Show every issue, also for fields still empty (after a save attempt). */
  attempted?: boolean;
  /** The hub's own message when the PUT is refused. */
  serverError?: string | null;
  busy?: boolean;
  dirty?: boolean;
  onSave: () => void;
  /** Asks first; defaults to the in-app confirm dialog. */
  onRemove?: (index: number) => void;
}

/** Presentational, so a test renders the same markup the screen does. */
export function ReposForm(p: ReposFormProps) {
  const set = (i: number, patch: Partial<ProjectRepo>) => p.onChange(p.repos.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const shown = (i: number, field: RepoIssue['field']) => {
    const r = p.repos[i];
    const empty = field === 'name' ? !r.name.trim() : field === 'remote' ? !r.remote.trim() : false;
    return p.issues.filter((x) => x.index === i && x.field === field && (p.attempted || !empty));
  };
  const blocked = hasErrors(p.issues);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!blocked && !p.busy) p.onSave(); }}>
      {p.repos.length === 0 && <p className="text-hint leading-snug text-muted">No repos yet. Add the ones your sessions work in so they can be linked and synced.</p>}
      {p.repos.map((r, i) => (
        <RepoRow key={i} r={r} i={i} set={set} onRemove={() => p.onRemove?.(i)} name={shown(i, 'name')} remote={shown(i, 'remote')} vps={shown(i, 'vps')} prot={shown(i, 'protected')} />
      ))}
      {p.serverError && <InlineError>{p.serverError}</InlineError>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => p.onChange([...p.repos, emptyRepo()])}><Plus size={14} aria-hidden /> Add repo</Button>
        <Button type="submit" variant="primary" disabled={p.busy || !p.dirty || (p.attempted && blocked)}>{p.busy ? 'Saving' : 'Save repos'}</Button>
        {blocked && p.attempted && <span role="status" className="text-hint text-bad">Fix the highlighted fields first.</span>}
      </div>
    </form>
  );
}

function Issues({ id, list }: { id: string; list: RepoIssue[] }) {
  if (!list.length) return null;
  return (
    <ul id={id} className="mt-1 space-y-0.5">
      {list.map((x) => <li key={x.message} className={x.level === 'error' ? 'text-hint leading-snug text-bad' : 'text-hint leading-snug text-warn'}>{x.message}</li>)}
    </ul>
  );
}

function RepoRow({ r, i, set, onRemove, name, remote, vps, prot }: {
  r: ProjectRepo; i: number; set: (i: number, patch: Partial<ProjectRepo>) => void; onRemove: () => void;
  name: RepoIssue[]; remote: RepoIssue[]; vps: RepoIssue[]; prot: RepoIssue[];
}) {
  const id = useId();
  const bad = (l: RepoIssue[]) => l.some((x) => x.level === 'error');
  return (
    <fieldset className="min-w-0 rounded-xl bg-card2/50 p-3 ring-1 ring-line">
      <legend className="sr-only">Repo {i + 1}{r.name ? ': ' + r.name : ''}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <Label>Name</Label>
          <Input value={r.name} maxLength={41} spellCheck={false} placeholder="app" className="font-mono" aria-invalid={bad(name)} aria-describedby={name.length ? id + '-name' : undefined} onChange={(e) => set(i, { name: e.target.value })} />
          <Issues id={id + '-name'} list={name} />
        </Field>
        <Field>
          <Label>Sync</Label>
          <Select value={r.sync} aria-describedby={id + '-sync'} onChange={(e) => set(i, { sync: e.target.value as RepoSyncMode })}>
            {(Object.keys(SYNC_LABEL) as RepoSyncMode[]).map((m) => <option key={m} value={m}>{m === 'none' ? 'Off' : SYNC_LABEL[m]}</option>)}
          </Select>
          <p id={id + '-sync'} className="mt-1 text-hint leading-snug text-muted">{SYNC_HELP[r.sync]}</p>
        </Field>
        <Field className="sm:col-span-2">
          <Label>Remote URL</Label>
          <Input value={r.remote} spellCheck={false} autoCapitalize="off" placeholder="git@github.com:org/app.git" className="font-mono" aria-invalid={bad(remote)} aria-describedby={remote.length ? id + '-remote' : undefined} onChange={(e) => set(i, { remote: e.target.value })} />
          <Issues id={id + '-remote'} list={remote} />
        </Field>
        <Field className="sm:col-span-2">
          <Label hint="optional">VPS folder</Label>
          <Input value={r.vps ?? ''} spellCheck={false} placeholder={'repos/' + (r.name.trim() || 'name')} className="font-mono" aria-invalid={bad(vps)} aria-describedby={vps.length ? id + '-vps' : undefined} onChange={(e) => set(i, { vps: e.target.value })} />
          <Issues id={id + '-vps'} list={vps} />
        </Field>
        <div className="sm:col-span-2">
          <Label>Protected branches</Label>
          <BranchChips value={r.protected} onChange={(protectedBranches) => set(i, { protected: protectedBranches })} describedBy={prot.length ? id + '-prot' : undefined} />
          <p className="mt-1 text-hint leading-snug text-muted">main and master are always protected. Bots cannot push to these from here.</p>
          <Issues id={id + '-prot'} list={prot} />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <label className="flex min-w-0 items-center gap-3 text-ui">
          <Switch checked={r.client} onChange={(client) => set(i, { client })} aria-label={'Client repo: ' + (r.name || 'repo ' + (i + 1))} />
          <span className="min-w-0">
            Client repo
            <span className="block text-hint leading-snug text-muted">Stays on your PC and is never synced, unless the server runs bot tools in a sandbox (Settings, Security).</span>
          </span>
        </label>
        <Tooltip content="Remove this repo"><Button variant="ghost" size="icon" aria-label={'Remove ' + (r.name || 'repo ' + (i + 1))} onClick={onRemove}><Trash2 size={15} /></Button></Tooltip>
      </div>
    </fieldset>
  );
}

function BranchChips({ value, onChange, describedBy }: { value: string[]; onChange: (v: string[]) => void; describedBy?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const b = draft.trim().replace(/,$/, '');
    if (b && !value.includes(b)) onChange([...value, b]);
    setDraft('');
  };
  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {value.map((b) => (
            <li key={b} className="inline-flex max-w-full items-center gap-1 rounded-full bg-card2 py-0.5 pl-2.5 pr-1 font-mono text-hint ring-1 ring-line">
              <GitBranch size={11} aria-hidden className="shrink-0 text-muted" />
              <span className="min-w-0 truncate">{b}</span>
              <button type="button" aria-label={'Remove branch ' + b} onClick={() => onChange(value.filter((x) => x !== b))} className="flex h-5 w-5 items-center justify-center rounded-full text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <X size={11} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        aria-label="Add a protected branch"
        aria-describedby={describedBy}
        value={draft}
        spellCheck={false}
        placeholder="staging, then Enter"
        className="font-mono"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

/** Loads one project's list, validates as you edit, and saves the whole list in one PUT. */
export function ReposEditor({ slug }: { slug: string }) {
  const toast = useStore((s) => s.toast);
  const [repos, setRepos] = useState<ProjectRepo[] | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.projects.repos(slug).then((f) => { if (alive) { setRepos(f.repos); setSaved(JSON.stringify(f.repos)); } }, (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [slug]);

  if (!repos) return error ? <InlineError>{error}</InlineError> : <p className="text-hint text-muted">Loading repos…</p>;

  const issues = validateRepos(repos);
  const save = async () => {
    setAttempted(true);
    if (hasErrors(issues)) return;
    setBusy(true);
    setError(null);
    try {
      const f = await api.projects.setRepos(slug, reposBody(repos));
      setRepos(f.repos);
      setSaved(JSON.stringify(f.repos));
      setAttempted(false);
      toast('Repos saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (i: number) => {
    const r = repos[i];
    const ok = await confirmAction({
      title: 'Remove ' + (r.name.trim() || 'this repo') + '?',
      body: 'Sessions stop being linked to it and it can no longer be synced. Nothing on your PC or the VPS is deleted. Save to apply.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) setRepos(repos.filter((_, j) => j !== i));
  };
  return (
    <ReposForm
      repos={repos}
      onChange={setRepos}
      issues={issues}
      attempted={attempted}
      serverError={error}
      busy={busy}
      dirty={JSON.stringify(repos) !== saved}
      onSave={() => void save()}
      onRemove={(i) => void remove(i)}
    />
  );
}
