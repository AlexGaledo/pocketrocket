import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import { MAX_QUEUE_EDIT_CHARS, QUEUE_PREVIEW_CHARS } from '@pocketrocket/shared';
import type { Bot, LaneQueue, QueueItem } from '@pocketrocket/shared';
import { useStore } from '../store';
import { countWords, editRefusalText, itemSource, roomLanes } from '../lib/queue';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Textarea, cn, confirmAction } from './ui';

/**
 * Queue controls (02 task 2.4): one chip per bot with messages waiting in this room (`@ada · 2 queued`), above the
 * composer. A chip opens a popover listing that bot's waiting items, each with Edit and Cancel, plus Pause queue and
 * Send now. This is the one place with queue buttons: bubbles in the transcript only say "Queued". A paused queue reads
 * "Queue paused", never "Paused", which is the screen takeover's word. No motion of its own.
 */
export function QueueChips({ roomId, members, textarea }: { roomId: string; members: Bot[]; textarea: React.RefObject<HTMLTextAreaElement | null> }) {
  const queues = useStore((s) => s.queues);
  const lanes = useMemo(() => roomLanes(queues, roomId, members.map((m) => m.id)), [queues, roomId, members]);
  if (!lanes.length) return null;
  return (
    // At 360px the row scrolls sideways inside its own box; the padding keeps the focus rings inside it.
    <div role="group" aria-label="Waiting messages" className="-mx-1 mb-1 flex gap-1.5 overflow-x-auto p-1">
      {lanes.map((q) => {
        const bot = members.find((m) => m.id === q.botId);
        return bot ? <LaneChip key={q.botId} q={q} bot={bot} bots={members} textarea={textarea} /> : null;
      })}
    </div>
  );
}

function LaneChip({ q, bot, bots, textarea }: { q: LaneQueue; bot: Bot; bots: Bot[]; textarea: React.RefObject<HTMLTextAreaElement | null> }) {
  const queuePause = useStore((s) => s.queuePause);
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  // Lifted here so Escape in the editor leaves the editor, not the whole popover.
  const [editingId, setEditingId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const n = q.items.length;

  const resume = async () => {
    const why = await queuePause(q.roomId, q.botId, false);
    if (why) toast("Couldn't resume " + bot.name + "'s queue: " + why, true);
  };
  /** Back to the chip after a dialog, or to the composer when the chip has gone (its last item left the queue). */
  const refocus = () => {
    if (trigger.current?.isConnected) trigger.current.focus();
    else textarea.current?.focus();
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditingId(null); }}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className={cn(
              'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full pl-2.5 pr-2 text-hint ring-1 pointer-coarse:h-9',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              q.paused ? 'bg-warn/12 text-warn ring-warn/30 hover:bg-warn/15' : 'bg-card2 text-muted ring-line hover:text-fg',
            )}
          >
            <Clock size={12} aria-hidden />
            {/* The visible words are the name (speech input users say what they see); the hidden part says whose queue. */}
            <span className="sr-only">Queue for </span>
            <span className="font-medium">@{bot.handle}</span>
            {n > 0 && <span>· {n} queued</span>}
            {q.paused && <span>· Queue paused</span>}
            <ChevronDown size={12} aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80"
          aria-label={'Waiting for ' + bot.name}
          onEscapeKeyDown={(e) => { if (editingId) { e.preventDefault(); setEditingId(null); } }}
        >
          <LanePanel q={q} bot={bot} bots={bots} editingId={editingId} setEditingId={setEditingId} close={() => { setOpen(false); setEditingId(null); }} refocus={refocus} />
        </PopoverContent>
      </Popover>
      {q.paused && (
        <Button size="sm" variant="ghost" className="rounded-full pointer-coarse:h-9" aria-label={'Resume ' + bot.name + "'s queue"} onClick={() => void resume()}>Resume</Button>
      )}
    </div>
  );
}

function LanePanel({ q, bot, bots, editingId, setEditingId, close, refocus }: {
  q: LaneQueue; bot: Bot; bots: Bot[]; editingId: string | null; setEditingId: (id: string | null) => void; close: () => void; refocus: () => void;
}) {
  const queueCancel = useStore((s) => s.queueCancel);
  const queueSendNow = useStore((s) => s.queueSendNow);
  const queuePause = useStore((s) => s.queuePause);
  const toast = useStore((s) => s.toast);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The item being edited left the queue (the bot took it in) before Save: say so instead of silently closing.
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (editingId && !q.items.some((i) => i.journalId === editingId)) { setEditingId(null); setLost(true); }
  }, [editingId, q.items, setEditingId]);
  const n = q.items.length;
  const name = (id: string) => bots.find((b) => b.id === id)?.name;

  const togglePause = async () => {
    setBusy(true);
    const why = await queuePause(q.roomId, q.botId, !q.paused);
    setBusy(false);
    setError(why);
  };
  const cancel = async (item: QueueItem) => {
    // The popover sits above dialogs, so it closes before the question opens; focus comes back to the chip after.
    close();
    const ok = await confirmAction({
      title: 'Cancel this message?',
      body: bot.name + " won't read it. It stays in the chat.",
      confirmLabel: 'Cancel message',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (ok) {
      const why = await queueCancel(q.roomId, item.journalId);
      if (why) toast("Couldn't cancel it: " + why, true);
    }
    refocus();
  };
  const sendNow = async () => {
    close();
    // Only a running turn is interrupted. With none (a paused queue), Send now just resumes and runs the queue.
    if (q.running) {
      const ok = await confirmAction({
        title: 'Stop ' + bot.name + ' and send now?',
        body: bot.name + ' stops the reply it is working on, and unfinished work may be lost. Then it reads the ' + countWords(n) + ' waiting. To stop without sending, use Stop.',
        confirmLabel: 'Stop and send now',
        danger: true,
      });
      if (!ok) { refocus(); return; }
    }
    const why = await queueSendNow(q.roomId, q.botId);
    if (why) toast("Couldn't send now: " + why, true);
    refocus();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-ui font-medium">Waiting for {bot.name}</h3>
        {q.paused && <Badge tone="warn">Queue paused</Badge>}
      </div>
      <p className="text-hint text-muted">
        {n === 0 ? 'Nothing is waiting.' : n === 1 ? bot.name + ' reads this in its next turn.' : bot.name + ' reads these together in its next turn.'}
        {q.paused ? ' Nothing new starts until you resume.' : ''}
      </p>
      {lost && <p role="status" className="text-hint text-muted">{bot.name} started on that message before you saved, so it was not changed.</p>}
      {n > 0 && (
        <ol aria-label={'Waiting for ' + bot.name} className="-mx-1 flex max-h-[45dvh] flex-col gap-1.5 overflow-y-auto px-1 py-0.5">
          {q.items.map((item) => (
            <QueueRow
              key={item.journalId}
              item={item}
              roomId={q.roomId}
              source={itemSource(item, name)}
              editing={editingId === item.journalId}
              onEdit={() => { setLost(false); setEditingId(item.journalId); }}
              onDone={() => setEditingId(null)}
              onCancel={() => void cancel(item)}
            />
          ))}
        </ol>
      )}
      {error && <p role="alert" className="text-hint text-bad">{error}</p>}
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-2.5">
        <Button size="sm" disabled={busy} onClick={() => void togglePause()}>
          {q.paused ? 'Resume queue' : 'Pause queue'}
        </Button>
        {n > 0 && (
          <Button size="sm" variant="primary" onClick={() => void sendNow()}>{q.running ? 'Send now…' : 'Send now'}</Button>
        )}
      </div>
    </div>
  );
}

function QueueRow({ item, roomId, source, editing, onEdit, onDone, onCancel }: {
  item: QueueItem; roomId: string; source: string | null; editing: boolean; onEdit: () => void; onDone: () => void; onCancel: () => void;
}) {
  const previewId = useId();
  // The preview is cut at QUEUE_PREVIEW_CHARS; editing needs the whole text, which the loaded transcript has.
  const full = useStore((s) => (item.messageId ? s.messages[roomId]?.find((m) => m.id === item.messageId)?.text : undefined));
  const truncated = full === undefined && item.preview.length >= QUEUE_PREVIEW_CHARS;
  const refusal = editRefusalText(item) ?? (item.editable && truncated ? "Can't edit here: the full message isn't loaded. Scroll up to it and try again." : null);
  const canEdit = item.editable && !truncated;
  return (
    <li className="rounded-lg bg-card2 px-3 py-2">
      {source && <div className="text-hint text-muted">{source}</div>}
      {editing ? (
        <QueueEditor item={item} roomId={roomId} initial={full ?? item.preview} onDone={onDone} />
      ) : (
        <>
          <p id={previewId} className="line-clamp-4 whitespace-pre-wrap break-words text-ui">
            {item.preview || <span className="text-muted">(no text)</span>}
          </p>
          {refusal && <p className="mt-1 text-hint text-muted">{refusal}</p>}
          {(canEdit || item.cancellable) && (
            <div className="mt-1 flex justify-end gap-1">
              {canEdit && <Button size="sm" variant="ghost" aria-describedby={previewId} onClick={onEdit}>Edit</Button>}
              {item.cancellable && <Button size="sm" variant="ghost" aria-label="Cancel this message" aria-describedby={previewId} onClick={onCancel}>Cancel…</Button>}
            </div>
          )}
        </>
      )}
    </li>
  );
}

function QueueEditor({ item, roomId, initial, onDone }: { item: QueueItem; roomId: string; initial: string; onDone: () => void }) {
  const queueEdit = useStore((s) => s.queueEdit);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // It can stop being editable while open (a bot read it): the hub's reason replaces the Save button's promise.
  const refusal = editRefusalText(item);
  const save = async () => {
    if (!draft.trim() || saving || refusal) return;
    if (draft.trim() === initial.trim()) { onDone(); return; }
    setSaving(true);
    const why = await queueEdit(roomId, item.journalId, draft.trim());
    setSaving(false);
    if (why) setError(why);
    else onDone();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        autoFocus
        rows={3}
        value={draft}
        maxLength={MAX_QUEUE_EDIT_CHARS}
        aria-label="Edit your queued message"
        aria-keyshortcuts="Control+Enter"
        className="max-h-[30dvh] bg-panel"
        onChange={(e) => { setDraft(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
        }}
      />
      {(error || refusal) && <p role="alert" className="text-hint text-bad">{refusal ?? error}</p>}
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onDone}>Keep as is</Button>
        <Button size="sm" variant="primary" disabled={!draft.trim() || saving || !!refusal} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
