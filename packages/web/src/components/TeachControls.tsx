// P6: Teach / Done on a bot's Screen, and the list of its recordings with Distill.
// One accent (the primary action is the ink button), no new motion: the recording indicator is a static dot.
import { useCallback, useEffect, useId, useState } from 'react';
import { Circle, Trash2 } from 'lucide-react';
import type { Bot, RecorderStatus, RecordingInfo } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from '../lib/api';
import { Badge, Button, Input } from './ui';

const fmtWhen = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The recorder state for a bot: the last `recorder.state` event, else one GET. */
function useRecorder(botId: string): RecorderStatus | null {
  const live = useStore((s) => s.recorder[botId]);
  const [fetched, setFetched] = useState<RecorderStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api.teach.status(botId).then((s) => alive && setFetched(s)).catch(() => alive && setFetched(null));
    return () => { alive = false; };
  }, [botId]);
  return live ?? fetched;
}

export function TeachBar({ bot }: { bot: Bot }) {
  const toast = useStore((s) => s.toast);
  const st = useRecorder(bot.id);
  const [asking, setAsking] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [listRev, setListRev] = useState(0);
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
    } catch (e) {
      toast("Couldn't start recording: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const done = async () => {
    setBusy(true);
    try {
      const r = await api.teach.stop(bot.id);
      useStore.setState((cur) => ({ recorder: { ...cur.recorder, [bot.id]: r.status } }));
      if (r.recording) toast('Recording saved (' + r.recording.events + ' steps). Distill it into a skill below.');
      setListRev((n) => n + 1);
    } catch (e) {
      toast("Couldn't stop recording: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 pb-2 text-xs">
      {rec ? (
        <div className="flex items-center gap-2 rounded-2xl bg-card2/60 px-3 py-2">
          <Circle aria-hidden size={10} className="shrink-0 fill-bad text-bad" />
          <span className="min-w-0 flex-1" role="status" aria-live="polite">
            <span className="font-medium text-fg">Recording</span>
            <span className="text-muted"> · {rec.events} {rec.events === 1 ? 'step' : 'steps'} · {rec.frames} {rec.frames === 1 ? 'screenshot' : 'screenshots'}</span>
            {rec.capped.length > 0 && <span className="text-warn"> · limit reached ({rec.capped.join(', ')})</span>}
          </span>
          <Button size="sm" variant="primary" onClick={done} disabled={busy}>Done</Button>
        </div>
      ) : asking ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-card2/60 p-2">
          <label htmlFor={titleId} className="text-muted">What will you show {bot.name}? (optional)</label>
          <Input id={titleId} value={title} maxLength={120} placeholder="e.g. Download last month's invoices" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void start(); if (e.key === 'Escape') setAsking(false); }} autoFocus />
          <p className="text-dim">You get control of the computer while recording. Clicks, typing and page changes are saved on this server; passwords, card numbers and one-time codes are not, and no screenshot is kept while one is on screen.</p>
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start recording'}</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setAsking(true)} title={'Show ' + bot.name + ' how to do a task; it becomes a skill after your review'}>Teach</Button>
          <span className="text-dim">Show {bot.name} a task once; it can become a skill.</span>
        </div>
      )}
      <RecordingList bot={bot} rev={listRev} recordingId={rec?.id ?? null} />
    </div>
  );
}

function RecordingList({ bot, rev, recordingId }: { bot: Bot; rev: number; recordingId: string | null }) {
  const toast = useStore((s) => s.toast);
  const openPanel = useStore((s) => s.openPanel);
  const [list, setList] = useState<RecordingInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setList(await api.teach.recordings(bot.id)); } catch { /* hub unreachable: keep the last list */ }
  }, [bot.id]);
  useEffect(() => { void load(); }, [load, rev, recordingId]);
  const done = list.filter((r) => r.state === 'stopped');
  if (!done.length) return null;

  const distill = async (r: RecordingInfo) => {
    setBusy(r.id);
    try {
      const out = await api.teach.distill(bot.id, r.id);
      toast(out.version
        ? 'Proposed version ' + out.version.version + ' of "' + out.skill.name + '". Review it in Skills.'
        : 'Proposed the skill "' + out.skill.name + '". Review it in Skills.');
      openPanel('skills', bot.id);
    } catch (e) {
      toast("Couldn't distill: " + (e as Error).message, true);
    } finally {
      setBusy(null);
      void load();
    }
  };
  const remove = async (r: RecordingInfo) => {
    if (!confirm('Delete this recording and its screenshots?')) return;
    try { await api.teach.remove(bot.id, r.id); } catch (e) { toast((e as Error).message, true); }
    void load();
  };

  return (
    <details className="rounded-2xl bg-card2/60 px-3 py-2">
      <summary className="cursor-pointer select-none text-muted">Recordings ({done.length})</summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {done.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-fg">{r.title || 'Untitled recording'}</div>
              <div className="text-dim">
                {fmtWhen(r.startedAt)} · {r.events} steps · {r.frames} shots{r.framesDropped ? ' (' + r.framesDropped + ' withheld)' : ''}
                {r.error ? ' · ' + r.error : ''}
              </div>
            </div>
            {r.capped.length > 0 && <Badge tone="warn">limit</Badge>}
            {r.skillId && <Badge>distilled</Badge>}
            <Button size="sm" onClick={() => void distill(r)} disabled={busy !== null} title="Write a skill from this recording (Sonnet, up to $0.25); it waits for your review">
              {busy === r.id ? 'Distilling…' : r.skillId ? 'Distill again' : 'Distill'}
            </Button>
            <Button size="icon" variant="ghost" aria-label={'Delete recording ' + (r.title || fmtWhen(r.startedAt))} title="Delete recording" onClick={() => void remove(r)}><Trash2 size={13} /></Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
