// P6: Teach and the recordings on a bot's page (Computer tab), and the Done bar on its screen while recording.
// One accent (the primary action is the ink button), no new motion: the recording indicator is a static dot.
import { useCallback, useEffect, useId, useState } from 'react';
import { Circle, Trash2 } from 'lucide-react';
import type { Bot, RecorderStatus, RecordingInfo } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { Badge, Button, Input, confirmAction } from './ui';

const fmtWhen = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The recorder state for a bot: the last `recorder.state` event, else one GET. */
export function useRecorder(botId: string): RecorderStatus | null {
  const live = useStore((s) => s.recorder[botId]);
  const [fetched, setFetched] = useState<RecorderStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api.teach.status(botId).then((s) => alive && setFetched(s)).catch(() => alive && setFetched(null));
    return () => { alive = false; };
  }, [botId]);
  return live ?? fetched;
}

/** On the screen for as long as a recording runs. Done hands control back; the skill is made from the Bot page. */
export function RecordingBar({ bot, recording }: { bot: Bot; recording: RecordingInfo }) {
  const toast = useStore((s) => s.toast);
  const openPage = useStore((s) => s.openPage);
  const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    try {
      const r = await api.teach.stop(bot.id);
      useStore.setState((cur) => ({ recorder: { ...cur.recorder, [bot.id]: r.status } }));
      if (r.recording) {
        toast('Saved ' + r.recording.events + ' steps.', false, { action: { label: 'Make a skill', run: () => openPage({ kind: 'bot', botId: bot.id, tab: 'computer' }) } });
      }
    } catch (e) {
      toast("Couldn't stop recording: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-lg bg-card2/60 px-3 py-2">
      <Circle aria-hidden size={10} className="shrink-0 fill-bad text-bad" />
      <span className="min-w-0 flex-1" role="status" aria-live="polite">
        <span className="font-medium text-fg">Recording</span>
        <span className="text-muted"> · {recording.events} {recording.events === 1 ? 'step' : 'steps'} · {recording.frames} {recording.frames === 1 ? 'screenshot' : 'screenshots'}</span>
        {recording.capped.length > 0 && <span className="text-warn"> · limit reached ({recording.capped.join(', ')})</span>}
      </span>
      <Button size="sm" variant="primary" onClick={done} disabled={busy}>Done</Button>
    </div>
  );
}

export function TeachBar({ bot }: { bot: Bot }) {
  const toast = useStore((s) => s.toast);
  const st = useRecorder(bot.id);
  const [asking, setAsking] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  if (!st?.available) return null;
  const rec = st.active;

  const start = async () => {
    setBusy(true);
    try {
      const s = await api.teach.start(bot.id, title.trim() || undefined);
      useStore.setState((cur) => ({ recorder: { ...cur.recorder, [bot.id]: s } }));
      setAsking(false);
      setTitle('');
      // The hub has given the user control, so the screen is about to fill the pane: leave the page for it.
      useStore.getState().closePage();
    } catch (e) {
      toast("Couldn't start recording: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 pb-2 text-hint">
      {rec ? (
        <p className="rounded-lg bg-card2/60 px-3 py-2 text-muted">Recording. Press Done on its screen when you finish.</p>
      ) : asking ? (
        <div className="flex flex-col gap-2 rounded-lg bg-card2/60 p-2">
          <label htmlFor={titleId} className="text-muted">What will you show {bot.name}? (optional)</label>
          <Input id={titleId} value={title} maxLength={120} placeholder="e.g. Download last month's invoices" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void start(); if (e.key === 'Escape') setAsking(false); }} autoFocus />
          <p className="text-dim" title="You control the screen while recording. Clicks, typing and page changes are saved on this server. No screenshot is kept while a detected secret field is on screen.">Typing is saved. Detected secret fields are skipped.</p>
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start recording'}</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" title="Show it once. You review the skill." onClick={() => setAsking(true)}>Teach</Button>
          <span className="min-w-0 text-dim @max-[420px]:hidden">Show it once. You review the skill.</span>
        </div>
      )}
      <RecordingList bot={bot} recordingId={rec?.id ?? null} />
    </div>
  );
}

function RecordingList({ bot, recordingId }: { bot: Bot; recordingId: string | null }) {
  const toast = useStore((s) => s.toast);
  const openPage = useStore((s) => s.openPage);
  const [list, setList] = useState<RecordingInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setList(await api.teach.recordings(bot.id)); } catch { /* hub unreachable: keep the last list */ }
  }, [bot.id]);
  useEffect(() => { void load(); }, [load, recordingId]);
  const done = list.filter((r) => r.state === 'stopped');
  if (!done.length) return null;

  const distill = async (r: RecordingInfo) => {
    setBusy(r.id);
    try {
      const out = await api.teach.distill(bot.id, r.id);
      toast(out.version
        ? 'New version of ' + out.skill.name + '. Review it here.'
        : 'New skill ' + out.skill.name + '. Review it here.');
      openPage({ kind: 'bot', botId: bot.id, tab: 'skills' });
    } catch (e) {
      toast("Couldn't make the skill: " + (e as Error).message, true);
    } finally {
      setBusy(null);
      void load();
    }
  };
  const remove = async (r: RecordingInfo) => {
    if (!(await confirmAction({ title: 'Delete this recording?', body: 'Its screenshots are deleted too.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.teach.remove(bot.id, r.id); } catch (e) { toast((e as Error).message, true); }
    void load();
  };

  return (
    <details className="rounded-lg bg-card2/60 px-3 py-2">
      <summary className="cursor-pointer select-none text-muted">Recordings ({done.length})</summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {done.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="min-w-0 basis-full">
              <div className="truncate font-medium text-fg">{r.title || 'Untitled recording'}</div>
              <div className="text-dim">
                {fmtWhen(r.startedAt)} · {r.events} steps · {r.frames} shots{r.framesDropped ? ' (' + r.framesDropped + ' withheld)' : ''}
                {r.error ? ' · ' + r.error : ''}
              </div>
            </div>
            {r.capped.length > 0 && <Badge tone="warn">limit</Badge>}
            {r.skillId && <Badge>skill made</Badge>}
            <Button size="sm" className="ml-auto" onClick={() => void distill(r)} disabled={busy !== null}>
              {busy === r.id ? 'Making…' : (r.skillId ? 'Remake' : 'Make skill') + ' · max $0.25'}
            </Button>
            <Button size="icon" variant="ghost" aria-label={'Delete recording ' + (r.title || fmtWhen(r.startedAt))} title="Delete recording" onClick={() => void remove(r)}><Trash2 size={13} /></Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
